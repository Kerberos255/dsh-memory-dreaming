import fs from 'node:fs';
import { digest, readBounded, safePath, scopeId } from './workspace-io.js';
import { shiftDay } from './weekly-archive.js';

export const workflowKinds = ['daily', 'dream', 'weekly'];
const active = ['delivered', 'running', 'awaiting-user', 'awaiting-approval', 'interrupted', 'needs-review'];
const terminal = ['completed', 'cancelled', 'failed'];
const textOf = message => (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
const kindOf = prompt => typeof prompt === 'string' ? /^\[dsh-memory-workflow:(daily|dream|weekly)\](?:\r?\n|$)/.exec(prompt)?.[1] : undefined;
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const maintenanceSession = (cwd,preset) => 'session-dsh-memory-' + scopeId(cwd,preset).slice(0,32);
/** Only the matching native prompt receipt can activate this manual workflow. */
export const manualPrompt=(kind,requestId,day)=>`[dsh-memory-manual:${requestId}]
这是用户在 Dream 设置页明确发起的手动记忆整理。只调用一次 memory_dream（kind=${kind}，day=${day}），整理当前工作区经验证的真实会话，写入正式记忆产物，不是 draftOnly。不要执行其他工具、命令或技能，也不要申请提升权限。无新材料则报告空结果。`;


// Decode only the official Schedule envelope, never a tag in ordinary user prose.
export function deliveries(message) {
 if(message?.source?.kind !== 'schedule') return [];
 const text=textOf(message); if(text.length>262144) return [];
 let records;
 try {
  if(text.startsWith('[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: ')) records=JSON.parse(text.split('\n').slice(2).join('\n').slice('reminders_json: '.length));
  else if(text.startsWith('[SCHEDULE REMINDER]\nThis is a scheduled message from the user\n')) {
   const lines=text.split('\n');records=[{schedule_id:JSON.parse(lines[2].slice('schedule_id_json: '.length)),occurrence_at:lines[3].slice('occurrence_at: '.length),reminder_prompt:JSON.parse(lines.slice(4).join('\n').slice('reminder_prompt_json: '.length))}];
  } else return [];
 } catch {return [];}
 if(!Array.isArray(records)||records.length>100) return [];
 return records.flatMap(row => {const kind=kindOf(row?.reminder_prompt);return kind&&typeof row.schedule_id==='string'&&/^schedule-[a-f0-9-]{36}$/.test(row.schedule_id)&&instant(row.occurrence_at)?[{task:row.schedule_id,occurrence:row.occurrence_at,kind}]:[];});
}

export class WorkflowLedger {
 constructor(memory,ctx,checkpoint=()=>{}) {
  this.memory=memory;this.db=memory.db;this.ctx=ctx;this.checkpoint=checkpoint;this.recovery=null;this.closed=false;
  this.db.exec('CREATE TABLE IF NOT EXISTS workflows(id TEXT PRIMARY KEY,session TEXT NOT NULL,kind TEXT NOT NULL,turn INTEGER,state TEXT NOT NULL,updated INTEGER NOT NULL,run TEXT,result TEXT);');
  for(const [name,type] of Object.entries({scope:'TEXT',cwd:'TEXT',preset:'TEXT',task:'TEXT',occurrence:'TEXT',message:'TEXT',seq:'INTEGER',endSeq:'INTEGER',note:'TEXT',timeZone:'TEXT',historyOnly:'INTEGER NOT NULL DEFAULT 0',origin:"TEXT NOT NULL DEFAULT 'scheduled'",prompt:'TEXT',requestedDay:'TEXT'})) if(!this.db.prepare('PRAGMA table_info(workflows)').all().some(row=>row.name===name)) this.db.exec('ALTER TABLE workflows ADD COLUMN '+name+' '+type);
  this.db.exec(`CREATE INDEX IF NOT EXISTS workflow_scope ON workflows(scope,updated);
   CREATE TABLE IF NOT EXISTS workflow_messages(session TEXT NOT NULL,message TEXT NOT NULL,workflow TEXT NOT NULL,turn INTEGER,PRIMARY KEY(session,message,workflow));
   CREATE TABLE IF NOT EXISTS workflow_cursors(session TEXT PRIMARY KEY,scope TEXT NOT NULL,preset TEXT NOT NULL,seq INTEGER NOT NULL,turn INTEGER,inbox TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS workflow_tools(session TEXT NOT NULL,call TEXT NOT NULL,turn INTEGER NOT NULL,name TEXT NOT NULL,kind TEXT,PRIMARY KEY(session,call));
   CREATE TABLE IF NOT EXISTS workflow_waits(session TEXT NOT NULL,call TEXT NOT NULL,workflow TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'open',PRIMARY KEY(session,call,workflow));`);
 }
 identity(header,preset) {
  if(!header?.cwd||header.parentSession||header.origin==='subagent'||typeof preset!=='string') return null;
  try {const cwd=fs.realpathSync(header.cwd),scope=scopeId(cwd,preset);
   const bound=this.db.prepare('SELECT scope FROM memory_schedule_sessions WHERE session=?').get(header.id);
   const oldId=header.id===maintenanceSession(cwd,preset);
   return (bound?.scope===scope||oldId)?{session:header.id,cwd,preset,scope}:null;
  } catch {return null;}
 }
 transaction(fn){return this.memory.commits.transaction(fn);}
 history(identity,records){this.transaction(()=>{for(const record of records){if(!instant(record.occurrence))continue;const id=this.receipt(identity,record.message,record);this.db.prepare("UPDATE workflows SET state='needs-review',historyOnly=1,note=? WHERE id=? AND seq IS NULL AND turn IS NULL AND state='delivered'").run('原生投递摘要已保存；执行状态需核对会话记录。',id);}});}
 cursor(identity){return this.db.prepare('SELECT * FROM workflow_cursors WHERE session=?').get(identity.session)??{...identity,seq:-1,turn:null,inbox:JSON.stringify({'next-turn':[],'next-step':[]})};}
 rows(cwd,preset=this.memory.getConfig().agentPreset){return this.db.prepare('SELECT * FROM workflows WHERE scope=? ORDER BY updated DESC LIMIT 30').all(scopeId(cwd,preset)).map(row=>({...row,result:row.result?JSON.parse(row.result):null}));}
 counts(cwd,preset){const where=cwd?' WHERE scope=?':' WHERE scope IS NOT NULL',args=cwd?[scopeId(cwd,preset)]:[];return Object.fromEntries(this.db.prepare('SELECT state,COUNT(*) AS count FROM workflows'+where+' GROUP BY state').all(...args).map(row=>[row.state,row.count]));}
 hasActive(cwd,preset=this.memory.getConfig().agentPreset){
  return !!this.db.prepare("SELECT 1 FROM workflows WHERE scope=? AND state IN ('submitting','delivered','running','awaiting-user','awaiting-approval') AND updated>? LIMIT 1").get(scopeId(cwd,preset),Date.now()-1800000);
 }
 queueManual(cwd,preset,kind,requestId,prompt,day,timeZone,sessionId=maintenanceSession(cwd,preset)){
  if(!workflowKinds.includes(kind)||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!requestId||!prompt)throw new Error('手动任务格式无效');
  const scope=scopeId(cwd,preset),id=digest(JSON.stringify([scope,'manual',requestId])),session=sessionId;
  if(!this.identity({id:session,cwd},preset))throw new Error('维护 Session 未经 Dream 绑定核验');
  const now=Date.now();
  this.transaction(()=>{
   if(this.hasActive(cwd,preset))throw new Error('该工作区已有记忆整理任务，请等待完成后再试');
   this.db.prepare("INSERT INTO workflows(id,session,kind,state,updated,scope,cwd,preset,task,occurrence,message,timeZone,origin,prompt,requestedDay,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id,session,kind,'submitting',now,scope,cwd,preset,'manual:'+requestId,new Date(now).toISOString(),requestId,timeZone,'manual',prompt,day,'正在提交到原生维护 Session');
  });
  return{id,session,kind};
 }
 admitManual(id){
  this.db.prepare("UPDATE workflows SET state='delivered',note='已入原生 Session 队列，等待执行',updated=? WHERE id=? AND origin='manual' AND state='submitting'").run(Date.now(),id);
 }
 /** Native identity + requestId + exact text are required; copied user text cannot forge a manual receipt. */
 linkManual(identity,message,turn=null,seq=null){
  if(message?.source?.kind!=='user'||typeof message.source.rpcId!=='string'||!message.id)return;
  const row=this.db.prepare("SELECT * FROM workflows WHERE session=? AND scope=? AND origin='manual' AND task=?").get(identity.session,identity.scope,'manual:'+message.source.rpcId);
  if(!row||textOf(message)!==row.prompt)return;
  this.db.prepare('INSERT INTO workflow_messages(session,message,workflow,turn) VALUES(?,?,?,?) ON CONFLICT(session,message,workflow) DO UPDATE SET turn=COALESCE(excluded.turn,turn)')
   .run(identity.session,message.id,row.id,turn);
  this.db.prepare("UPDATE workflows SET message=?,seq=COALESCE(seq,?),turn=COALESCE(turn,?),state=CASE WHEN ? IS NULL THEN state WHEN state IN ('submitting','delivered') THEN 'running' ELSE state END,updated=?,note=CASE WHEN ? IS NULL THEN note ELSE NULL END WHERE id=?")
   .run(message.id,seq,turn,turn,Date.now(),turn,row.id);
 }
 manualStatus(cwd,preset=this.memory.getConfig().agentPreset){
  const row=this.db.prepare("SELECT * FROM workflows WHERE scope=? AND origin='manual' ORDER BY updated DESC LIMIT 1").get(scopeId(cwd,preset));
  if(!row)return null;
  const job=this.result(row),value=job?.value;
  return{kind:row.kind,state:row.state,sessionId:row.session,workflow:row.id,
   message:row.note??value?.error??value?.message??(row.state==='completed'?'记忆整理已完成':'原生维护 Session 正在处理任务'),
   empty:!!value?.empty,deduplicated:!!value?.deduplicated,artifacts:(value?.artifacts??[]).map(item=>item.path)};
 }

 receipt(identity,message,record,seq=null,turn=null) {
  const id=digest(JSON.stringify([identity.scope,record.kind,record.occurrence])),now=Date.now();
  this.db.prepare(`INSERT OR IGNORE INTO workflows(id,session,kind,turn,state,updated,scope,cwd,preset,task,occurrence,message,seq,timeZone) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,identity.session,record.kind,turn,turn===null?'delivered':'running',now,identity.scope,identity.cwd,identity.preset,record.task,record.occurrence,message,seq,record.timeZone??this.memory.getConfig().timeZone);
  if(seq!==null||turn!==null)this.db.prepare("UPDATE workflows SET state=?,historyOnly=0,note=NULL WHERE id=? AND historyOnly=1 AND state='needs-review'").run(turn===null?'delivered':'running',id);
  this.db.prepare('INSERT INTO workflow_messages VALUES(?,?,?,?) ON CONFLICT(session,message,workflow) DO UPDATE SET turn=COALESCE(excluded.turn,turn)').run(identity.session,message,id,turn);
  this.db.prepare('UPDATE workflows SET seq=COALESCE(seq,?),turn=COALESCE(turn,?) WHERE id=?').run(seq,turn,id);
  // Retain legacy rows as audit; transfer only a native-proven matching message.
  const legacy=this.db.prepare('SELECT * FROM workflows WHERE scope IS NULL AND id=?').get(identity.session+':'+message+':'+record.kind);
  if(legacy){this.db.prepare('UPDATE workflows SET run=COALESCE(run,?),result=COALESCE(result,?) WHERE id=?').run(legacy.run,legacy.result,id);this.db.prepare("UPDATE workflows SET state='legacy-reconciled',note=? WHERE id=?").run('已由原生投递核对到 '+id,legacy.id);}
  return id;
 }
 claim(identity,message,turn) {
  if(!identity||!Number.isSafeInteger(turn)) return;
  this.transaction(()=>{this.linkManual(identity,message,turn);for(const record of deliveries(message)){const id=this.receipt(identity,message.id,record,null,turn);this.db.prepare("UPDATE workflows SET turn=?,state='running',updated=? WHERE id=? AND state='delivered'").run(turn,Date.now(),id);}this.resumeReply(identity,message,turn);});
 }
 resumeReply(identity,message,turn){
  if(message?.source?.kind!=='user-question-reply') return;
  for(const wait of this.db.prepare("SELECT workflow FROM workflow_waits WHERE session=? AND call=? AND kind='question'").all(identity.session,message.source.callId)) {
   this.db.prepare('INSERT OR REPLACE INTO workflow_messages VALUES(?,?,?,?)').run(identity.session,message.id,wait.workflow,turn);
   this.db.prepare("UPDATE workflows SET turn=?,state='running',endSeq=NULL,note=NULL,updated=? WHERE id=? AND state='awaiting-user'").run(turn,Date.now(),wait.workflow);
   this.db.prepare("UPDATE workflow_waits SET state='resolved' WHERE session=? AND call=? AND workflow=?").run(identity.session,message.source.callId,wait.workflow);
  }
 }
 forTurn(session,turn,kind){return this.db.prepare('SELECT DISTINCT w.* FROM workflows w JOIN workflow_messages m ON m.workflow=w.id WHERE m.session=? AND m.turn=?'+(kind?' AND w.kind=?':'')+' ORDER BY w.occurrence').all(session,turn,...kind?[kind]:[]);}
 current(session,kind){const cursor=this.db.prepare('SELECT turn FROM workflow_cursors WHERE session=?').get(session);return cursor?.turn===null||cursor?.turn===undefined?[]:this.forTurn(session,cursor.turn,kind);}
 event(identity,event){
  if(!identity||!Number.isSafeInteger(event.seq)) return;
  this.transaction(()=>{
   const cursor=this.cursor(identity);if(cursor.scope!==identity.scope) throw new Error('自动任务会话范围发生变化');if(event.seq<=cursor.seq) return;
   if(event.seq!==cursor.seq+1) throw new Error('自动任务事件存在缺口，需要核对原生会话');
   this.fold(identity,event,cursor);
   this.db.prepare('INSERT OR REPLACE INTO workflow_cursors VALUES(?,?,?,?,?,?)').run(identity.session,identity.scope,identity.preset,event.seq,cursor.turn,cursor.inbox);
   this.checkpoint('workflow-event');
  });
 }
 fold(identity,event,cursor){
  const data=event.data,session=identity.session;
  if(event.type==='turn/start')cursor.turn=data.turn;
  else if(event.type==='agent/inbox/spliced'){
   const inbox=JSON.parse(cursor.inbox),queue=inbox[data.target];if(!queue)throw new Error('未知原生输入队列');const removed=queue.splice(data.start,data.removedCount??0,...data.inserted.map(message=>message.id));
   for(const message of data.inserted){this.linkManual(identity,message,null,event.seq);for(const record of deliveries(message))this.receipt(identity,message.id,record,event.seq);}
   if(data.outcome==='canceled')for(const message of removed)this.db.prepare("UPDATE workflows SET state='cancelled',note=?,updated=? WHERE id IN (SELECT workflow FROM workflow_messages WHERE session=? AND message=?) AND state='delivered'").run('原生队列已取消，任务尚未执行。',Date.now(),session,message);
   // Native claim persists the removal before emitting inbox/claimed. Recover that gap.
   if(data.outcome===undefined&&cursor.turn!==null)for(const message of removed){this.db.prepare('UPDATE workflow_messages SET turn=? WHERE session=? AND message=?').run(cursor.turn,session,message);this.db.prepare("UPDATE workflows SET turn=?,state='running',updated=? WHERE id IN (SELECT workflow FROM workflow_messages WHERE session=? AND message=?) AND state='delivered'").run(cursor.turn,Date.now(),session,message);}
   cursor.inbox=JSON.stringify(inbox);
  }else if(event.type==='user/message'){
   this.linkManual(identity,data,cursor.turn,event.seq);
   for(const record of deliveries(data)){const id=this.receipt(identity,data.id,record,event.seq,cursor.turn);if(cursor.turn!==null)this.db.prepare("UPDATE workflows SET turn=?,state='running',updated=? WHERE id=? AND state='delivered'").run(cursor.turn,Date.now(),id);}
   if(cursor.turn!==null)this.resumeReply(identity,data,cursor.turn);
  }else if(event.type==='tool/call'){
   let kind;try{kind=JSON.parse(data.arguments).kind??'dream';}catch{}
   this.db.prepare('INSERT OR REPLACE INTO workflow_tools VALUES(?,?,?,?,?)').run(session,data.callId,data.turn,data.name,workflowKinds.includes(kind)?kind:null);
   if(data.name==='ask_user_question')for(const row of this.forTurn(session,data.turn)){this.db.prepare('INSERT OR REPLACE INTO workflow_waits(session,call,workflow,kind) VALUES(?,?,?,?)').run(session,data.callId,row.id,'question');if(!terminal.includes(row.state))this.set(row.id,'awaiting-user');}
  }else if(event.type==='tool/result'){
   const call=this.db.prepare('SELECT * FROM workflow_tools WHERE session=? AND call=?').get(session,data.message.toolCallId??data.message.source?.callId);
   if(call?.name==='memory_dream'&&!data.message.isError){let result;try{result=JSON.parse(textOf(data.message));}catch{}if(result?.id)this.record(session,call.turn,call.kind,result);}
   if(call?.name==='ask_user_question'){let value;try{value=JSON.parse(textOf(data.message));}catch{}const pending=value?.pending===true&&!data.message.isError,unknown=data.error?.code==='TOOL_OUTCOME_UNKNOWN';this.db.prepare('UPDATE workflow_waits SET state=? WHERE session=? AND call=?').run(pending?'continued':unknown?'unknown':'resolved',session,call.call);for(const row of this.forTurn(session,call.turn))if(row.state==='awaiting-user'&&!pending&&!unknown)this.set(row.id,'running');}
  }else if(event.type==='approval/asked'){
   for(const row of this.forTurn(session,cursor.turn)){this.db.prepare('INSERT OR REPLACE INTO workflow_waits(session,call,workflow,kind) VALUES(?,?,?,?)').run(session,data.id,row.id,'approval');if(!terminal.includes(row.state))this.set(row.id,'awaiting-approval');}
  }else if(event.type==='approval/decided'){
   for(const {workflow} of this.db.prepare("SELECT workflow FROM workflow_waits WHERE session=? AND call=? AND kind='approval'").all(session,data.id))if(this.db.prepare('SELECT state FROM workflows WHERE id=?').get(workflow)?.state==='awaiting-approval')this.set(workflow,'running');this.db.prepare("UPDATE workflow_waits SET state='resolved' WHERE session=? AND call=? AND kind='approval'").run(session,data.id);
  }else if(event.type==='turn/end'){
   for(const row of this.forTurn(session,data.turn))if(!terminal.includes(row.state))this.finish(row,data.reason?.kind,event.seq);
   if(cursor.turn===data.turn)cursor.turn=null;
  }
 }
 set(id,state,note=null,result){this.db.prepare('UPDATE workflows SET state=?,note=?,updated=?,result=COALESCE(?,result) WHERE id=?').run(state,note,Date.now(),result?JSON.stringify(result):null,id);}
 bind(id,run){const row=this.db.prepare('SELECT * FROM workflows WHERE id=?').get(id),job=this.db.prepare('SELECT * FROM runs WHERE id=?').get(run);if(!row||!job||row.scope!==job.scope||row.kind!==job.kind||row.run)throw new Error('自动任务运行记录已变化');this.db.prepare('UPDATE workflows SET run=?,updated=? WHERE id=?').run(run,Date.now(),id);this.checkpoint('workflow-run-linked');}
 record(session,turn,kind,result){
  const job=this.db.prepare('SELECT * FROM runs WHERE id=?').get(result.id);if(!job||job.kind!==kind)return;
  for(const row of this.forTurn(session,turn,kind))if(row.scope===job.scope&&!row.run)this.db.prepare('UPDATE workflows SET run=?,result=?,updated=? WHERE id=?').run(job.id,job.result,Date.now(),row.id);
 }
 result(row){const job=row.run?this.db.prepare('SELECT * FROM runs WHERE id=? AND scope=? AND kind=?').get(row.run,row.scope,row.kind):null;return job?{...job,value:job.result?JSON.parse(job.result):null}:null;}
 verifyResult(row){
  const job=this.result(row);if(job?.state!=='completed'||job.value?.state!=='completed')throw new Error('没有已完成的记忆运行记录。');
  if(job.value.empty||job.value.draftOnly)return job.value;
  for(const artifact of job.value.artifacts??[]){if(typeof artifact.path!=='string'||typeof artifact.hash!=='string')throw new Error('产物记录缺少校验值。');const current=readBounded(safePath(row.cwd,artifact.path),1048576),latest=this.db.prepare('SELECT afterHash FROM artifacts WHERE scope=? AND path=? ORDER BY id DESC LIMIT 1').get(row.scope,artifact.path);if(current===null||digest(current)!==(latest?.afterHash??artifact.hash))throw new Error('已提交的记忆产物缺失或出现外部修改。');}
  return job.value;
 }
 finish(row,reason,seq){
  this.db.prepare('UPDATE workflows SET endSeq=? WHERE id=?').run(seq,row.id);
  const job=this.result(row);
  if(job?.state==='failed'){this.set(row.id,'failed',job.value?.error??'记忆整理调用失败');return;}
  if(reason==='aborted'){this.set(row.id,'cancelled','原生轮次已取消。');return;}
  if(reason==='interrupted'||reason==='forked'){this.set(row.id,'interrupted','原生轮次已中断；不会自动重跑记忆作业。');return;}
  if(!['completed','stop'].includes(reason)){this.set(row.id,'failed','原生轮次未成功完成：'+(reason??'unknown'));return;}
  if(this.db.prepare("SELECT 1 FROM workflow_waits WHERE workflow=? AND kind='question' AND state='continued'").get(row.id)){this.set(row.id,'awaiting-user','原生问题仍待回答，回复后继续原任务。');return;}
  if(this.db.prepare("SELECT 1 FROM workflow_waits WHERE workflow=? AND kind='question' AND state='unknown'").get(row.id)){this.set(row.id,'needs-review','提问结果未写入；请核对原生问题状态。');return;}
  try{const result=this.verifyResult(row);this.set(row.id,'completed',null,{...result,turnReason:reason});}catch(error){this.set(row.id,row.run?'needs-review':'failed',error.message);}
 }
 cached(row){
  const job=this.result(row);if(!job)return null;
  if(job.state==='completed'){try{return{...this.verifyResult(row),deduplicated:true,workflow:row.id};}catch(error){this.set(row.id,'needs-review',error.message);return{state:'needs-review',workflow:row.id,artifacts:job.value?.artifacts??[],message:error.message};}}
  return{id:job.id,state:job.state==='running'?'running':'interrupted',artifacts:job.value?.artifacts??[],workflow:row.id,message:'该次计划已有运行记录；请核对原生会话与产物，未自动重跑模型。'};
 }
 async run(cwd,kind,exec,options){
  const rows=this.current(exec.agent.session.id,kind);if(!rows.length)return this.memory.run(cwd,kind,{...options,sourceSessionId:exec.agent.session.id,draftOnly:true});
  const results=[];for(const row of rows.filter(row=>row.state!=='cancelled')){const cached=this.cached(row);if(cached){results.push(cached);continue;}if(['interrupted','needs-review','cancelled','failed'].includes(row.state)){results.push({state:row.state,workflow:row.id,artifacts:[],message:row.note});continue;}
   const scheduledDay=new Intl.DateTimeFormat('en-CA',{timeZone:row.timeZone??this.memory.getConfig().timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(row.occurrence));
   const day=row.origin==='manual'?row.requestedDay:kind==='daily'?shiftDay(scheduledDay,-1):scheduledDay;
   const result=await this.memory.run(cwd,kind,{...options,day,timeZone:row.timeZone??this.memory.getConfig().timeZone,onStart:id=>this.bind(row.id,id)});results.push(result);
  }return results.length===1?results[0]:results.length?{...results.at(-1),results}:{state:'cancelled',artifacts:[],message:'自动归档已关闭。'};
 }
 async recover(signal){
  if(this.recovery)return this.recovery;
  const task=(async()=>{
   const records=await this.ctx.sessionQuery.listSessions(signal);signal?.throwIfAborted();
   for(const record of records){if(!/^session-dsh-memory-[a-f0-9]{32}(?:-[a-f0-9-]{36})?$/.test(record.header?.id))continue;
    let observation;try{observation=await this.ctx.sessionQuery.observeSession(record.header.id,{signal});signal?.throwIfAborted();const identity=this.identity(observation.header,observation.projections?.values.agentPreset);if(!identity){this.db.prepare("UPDATE workflows SET state='needs-review',note=? WHERE session=? AND state IN ('delivered','running','awaiting-user','awaiting-approval','interrupted')").run('原生工作区或预设范围不匹配，保留记录待核对。',record.header.id);continue;}
     for(const event of observation.events){if(event.seq<(observation.inheritedEventCount??0))continue;this.event(identity,event);}
     const questions=observation.projections?.values.userQuestions?.questions?.active??observation.projections?.values.userQuestions?.active??[],continued=new Set(questions.map(row=>row.callId));
     const live=this.ctx.get?.('agents')?.get(identity.session)?.status==='running';
     for(const row of this.db.prepare("SELECT * FROM workflows WHERE session=? AND scope=? AND state IN ('running','awaiting-user','awaiting-approval','interrupted','needs-review')").all(identity.session,identity.scope)){
      const waits=this.db.prepare("SELECT call FROM workflow_waits WHERE workflow=? AND kind='question'").all(row.id);
      if(waits.some(wait=>continued.has(wait.call))){this.set(row.id,'awaiting-user','原生问题仍待回答，回复后继续原任务。');continue;}
      if(row.endSeq!==null){const end=observation.events.find(event=>event.seq===row.endSeq&&event.type==='turn/end');if(end)this.transaction(()=>this.finish(row,end.data.reason?.kind,end.seq));}
      else if(!live&&!row.historyOnly)this.set(row.id,'interrupted','会话记录在执行中结束；已有产物保留，未自动重跑模型。');
     }
    }catch(error){signal?.throwIfAborted();this.db.prepare("UPDATE workflows SET state='needs-review',note=? WHERE session=? AND state NOT IN ('completed','cancelled','failed','legacy-reconciled')").run('原生会话暂不可核对；现有记录保留。',record.header.id);}finally{observation?.[Symbol.dispose]?.();}
   }
   return{checked:true};
  })();this.recovery=task;try{return await task;}finally{if(this.recovery===task)this.recovery=null;}
 }
 close(){this.closed=true;}
}
