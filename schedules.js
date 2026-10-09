import { randomUUID } from 'node:crypto';
import { digest, workspace, scopeId } from './workspace-io.js';
import { maintenanceSession, workflowKinds } from './workflows.js';
import { ensureMaintenanceSession } from './session-setup.js';

const labels={daily:'每日记忆',dream:'梦境整理',weekly:'每周记忆复查'};
const legacyPrompt=kind=>`[dsh-memory-workflow:${kind}]\n这是一项 Dream 插件的受管记忆任务，不是文件或环境修复任务。只调用一次 memory_dream 工具（kind=${kind}），从原生会话整理记忆，然后报告返回结果。严禁执行命令、运行 skills、扫描或修复工作区、申请提升权限；若 memory_dream 不可用，直接报告错误并停止，不能用其他工具替代。没有新材料不创建空文件。`;
const expectedRecord=task=>{const {sessionId,status,lastDelivery,...record}=task;return record;};
const zone=value=>new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;
const nativeShape=task=>({title:task.title,prompt:task.prompt,kind:task.kind,time:task.time,timeZone:task.timeZone,...task.kind==='weekly'?{weekdays:task.weekdays}:{}});
const requestedShape=request=>{const rule=request.weekly??request.daily;return{title:request.title,prompt:request.prompt,kind:request.weekly?'weekly':'daily',time:rule.time.length===8?rule.time+'.000':rule.time,timeZone:zone(rule.time_zone),...request.weekly?{weekdays:rule.weekdays}:{}};};
const fingerprint=value=>digest(JSON.stringify(value));
export class MemorySchedules {
 constructor(memory,ctx,checkpoint=()=>{},ledger) {
  this.memory=memory;this.db=memory.db;this.ctx=ctx;this.checkpoint=checkpoint;this.ledger=ledger;
  this.db.exec(`CREATE TABLE IF NOT EXISTS memory_templates(id TEXT PRIMARY KEY,scope TEXT NOT NULL,session TEXT NOT NULL,cwd TEXT NOT NULL,preset TEXT NOT NULL,kind TEXT NOT NULL,token TEXT NOT NULL,task TEXT,request TEXT NOT NULL,native TEXT,state TEXT NOT NULL,note TEXT,baseline TEXT NOT NULL);`);
  this.db.exec(`CREATE TABLE IF NOT EXISTS memory_schedule_history(task TEXT PRIMARY KEY,template TEXT NOT NULL,checked INTEGER NOT NULL,incomplete INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_schedule_receipts(template TEXT NOT NULL,task TEXT NOT NULL,message TEXT NOT NULL,occurrence TEXT NOT NULL,delivered TEXT NOT NULL,PRIMARY KEY(task,message));
   CREATE TABLE IF NOT EXISTS memory_schedule_bindings(scope TEXT PRIMARY KEY,session TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS memory_schedule_sessions(session TEXT PRIMARY KEY,scope TEXT NOT NULL);`);
 }
 /** The active maintenance session survives restarts; archived generations remain trusted only for history. */
 sessionId(cwd,preset=this.memory.getConfig().agentPreset){
  const scope=scopeId(cwd,preset),known=this.db.prepare('SELECT session FROM memory_schedule_bindings WHERE scope=?').get(scope);
  if(known)return known.session;
  const previous=this.db.prepare('SELECT session FROM memory_templates WHERE scope=? ORDER BY kind LIMIT 1').get(scope)?.session;
  const session=previous??maintenanceSession(cwd,preset);
  this.memory.commits.transaction(()=>{
   this.db.prepare('INSERT OR IGNORE INTO memory_schedule_bindings VALUES(?,?)').run(scope,session);
   this.db.prepare('INSERT OR IGNORE INTO memory_schedule_sessions VALUES(?,?)').run(session,scope);
  });
  return this.db.prepare('SELECT session FROM memory_schedule_bindings WHERE scope=?').get(scope).session;
 }
 archivedBindings(){return this.db.prepare('SELECT session FROM memory_schedule_bindings').all().map(row=>row.session);}
 /** Repair only a proven archive or a missing previously established Session.
  * Never repair a task manually deleted from a still-existing Session. */
 async rotateArchived(schedule,cwd,preset,signal){
  const scope=scopeId(cwd,preset),session=this.sessionId(cwd,preset);
  const registry=this.ctx.get?.('workspaceRegistry')??this.ctx.workspaceRegistry;
  const archived=!!registry?.archivedSessionIds?.includes(session);
  let missing=false;
  if(!archived&&typeof this.ctx.sessionQuery?.observeSession==='function'
   &&this.db.prepare('SELECT 1 FROM memory_templates WHERE scope=? AND session=? LIMIT 1').get(scope,session)){
   let observation;
   try{observation=await this.ctx.sessionQuery.observeSession(session,{signal});}
   catch(error){if(error?.code!=='SESSION_QUERY_SESSION_NOT_FOUND')throw error;missing=true;}
   finally{observation?.[Symbol.dispose]?.();}
  }
  if(!archived&&!missing)return session;
  signal?.throwIfAborted();
  const stillActive=(await schedule.catalog()).some(task=>task.sessionId===session&&task.status==='active');
  if(stillActive)throw new Error('旧维护会话已归档或不存在，等待原生 Schedule 停止其任务后接棒；不会并行创建重复定时任务。');
  const replacement=maintenanceSession(cwd,preset)+'-'+randomUUID();
  this.memory.commits.transaction(()=>{
   // The binding is a journal: a crash after this commit restarts on the new ID.
   this.db.prepare('INSERT OR IGNORE INTO memory_schedule_sessions VALUES(?,?)').run(session,scope);
   this.db.prepare('INSERT INTO memory_schedule_sessions VALUES(?,?)').run(replacement,scope);
   this.db.prepare('UPDATE memory_schedule_bindings SET session=? WHERE scope=? AND session=?').run(replacement,scope,session);
   this.db.prepare("UPDATE memory_templates SET session=?,task=NULL,native=NULL,state='new',note=NULL,baseline='[]' WHERE scope=? AND session=?").run(replacement,scope,session);
  });
  return replacement;
 }
 rows(cwd,preset=this.memory.getConfig().agentPreset){return this.db.prepare('SELECT id,kind,task,state,note FROM memory_templates WHERE scope=? ORDER BY kind').all(scopeId(cwd,preset)).map(row=>({...row,receipts:this.db.prepare('SELECT COUNT(*) AS n FROM memory_schedule_receipts WHERE template=?').get(row.id).n,historyIncomplete:!!this.db.prepare('SELECT 1 FROM memory_schedule_history WHERE template=? AND incomplete=1').get(row.id)}));}
 counts(cwd,preset){const where=cwd?' WHERE scope=?':'',args=cwd?[scopeId(cwd,preset)]:[];return Object.fromEntries(this.db.prepare('SELECT state,COUNT(*) AS count FROM memory_templates'+where+' GROUP BY state').all(...args).map(row=>[row.state,row.count]));}
 owns(task){if(this.db.prepare('SELECT 1 FROM memory_templates WHERE session=? AND task=?').get(task.sessionId,task.id))return true;return this.db.prepare('SELECT token,kind FROM memory_templates WHERE session=?').all(task.sessionId).some(row=>task.prompt===this.prompt(row.kind,row.token));}
 prompt(kind,token){return legacyPrompt(kind).replace('\n','\n[dsh-memory-template:'+token+']\n');}
 request(config,kind,token){const time=config[kind==='daily'?'dailyTime':kind==='dream'?'dreamTime':'weeklyTime'];return{title:labels[kind],prompt:this.prompt(kind,token),...kind==='weekly'?{weekly:{time,time_zone:config.timeZone,weekdays:[config.weeklyDay]}}:{daily:{time,time_zone:config.timeZone}}};}
 review(row,note){this.db.prepare("UPDATE memory_templates SET state='needs-review',note=? WHERE id=?").run(note,row.id);}
 async capture(schedule,row,task){
  const records=[];let before,incomplete=false;
  for(let page=0;page<2;page++){
   const value=await schedule.history({sessionId:row.session,id:task.id,limit:100,...before?{before}:{}});if(value.code)throw new Error('原生投递记录已变化，请重新核对。');
   records.push(...value.records);incomplete||=!!(value.earlierRecordsUnavailable||value.earlierRecordsPruned||(page===1&&value.nextBefore));if(!value.nextBefore)break;before=value.nextBefore;
  }
  this.memory.commits.transaction(()=>{for(const record of records){if(typeof record.messageId!=='string'||!record.messageId||!Number.isFinite(Date.parse(record.scheduledAt))||!Number.isFinite(Date.parse(record.deliveredAt)))throw new Error('原生投递记录格式无效。');this.db.prepare('INSERT OR IGNORE INTO memory_schedule_receipts VALUES(?,?,?,?,?)').run(row.id,task.id,record.messageId,record.scheduledAt,record.deliveredAt);}this.db.prepare('INSERT OR REPLACE INTO memory_schedule_history VALUES(?,?,?,?)').run(task.id,row.id,Date.now(),Number(incomplete));this.checkpoint('template-history-saved');});
  this.ledger?.history(row,records.map(record=>({task:task.id,message:record.messageId,kind:row.kind,occurrence:record.scheduledAt,timeZone:task.timeZone})));
 }
 async adoptLegacy(schedule,signal){
  if(!this.ctx.sessionQuery?.observeSession)return;
  for(const task of await schedule.catalog()){
   const kind=workflowKinds.find(kind=>task.prompt===legacyPrompt(kind)&&task.title===labels[kind]);if(!kind||this.owns(task))continue;
   let observation;try{observation=await this.ctx.sessionQuery.observeSession(task.sessionId,{signal});signal?.throwIfAborted();const header=observation.header,preset=observation.projections?.values.agentPreset;
    if(!header?.cwd||header.parentSession||header.origin==='subagent'||typeof preset!=='string'||header.id!==maintenanceSession(header.cwd,preset))continue;
    const scope=scopeId(header.cwd,preset),id=digest(scope+'\0'+kind),token=randomUUID();
    const request={title:task.title,prompt:this.prompt(kind,token),...task.kind==='weekly'?{weekly:{time:task.time,time_zone:task.timeZone,weekdays:task.weekdays}}:{daily:{time:task.time,time_zone:task.timeZone}}};
    this.db.prepare("INSERT OR IGNORE INTO memory_templates VALUES(?,?,?,?,?,?,?,?,?,?,'ready',NULL,?)").run(id,scope,task.sessionId,header.cwd,preset,kind,token,task.id,JSON.stringify(request),fingerprint(nativeShape(task)),JSON.stringify([]));
   }catch{signal?.throwIfAborted();}finally{observation?.[Symbol.dispose]?.();}
  }
 }
 async retire(schedule,row,signal,valid=()=>true){
  if(!valid())return;
  const catalog=await schedule.catalog(),owned=catalog.filter(task=>task.sessionId===row.session&&(task.id===row.task||task.prompt===this.prompt(row.kind,row.token)));
  if(row.state==='removed'&&!owned.length)return;
  if(row.task===null&&['creating','needs-review'].includes(row.state)) {
   const baseline=new Set(JSON.parse(row.baseline)),unknown=catalog.filter(task=>task.sessionId===row.session&&!baseline.has(task.id)&&!owned.includes(task)&&!this.owns(task));
   if(unknown.length){this.review(row,'创建结果有外部变化，现有任务保留待核对；没有新建副本。');return;}
  }
  for(const task of owned)await this.capture(schedule,row,task);
  if(!valid())return;
  this.db.prepare("UPDATE memory_templates SET state='deleting',note=NULL WHERE id=?").run(row.id);this.checkpoint('template-delete-intent');
  for(const task of owned){signal?.throwIfAborted();if(!valid())return;await schedule.delete({sessionId:row.session,id:task.id},signal);this.checkpoint('template-native-deleted');}
  this.db.prepare("UPDATE memory_templates SET task=NULL,native=NULL,state='removed',note=NULL WHERE id=?").run(row.id);this.checkpoint('template-delete-mapped');
 }
 async reconcile(schedule,controller,config,signal,valid=()=>true){
  signal?.throwIfAborted();await this.adoptLegacy(schedule,signal);if(!valid())return;let cwd,session,scope;
  if(config.enabled&&config.automatic){cwd=await workspace(this.ctx,config,signal);scope=scopeId(cwd,config.agentPreset);session=await this.rotateArchived(schedule,cwd,config.agentPreset,signal);}
  for(const row of this.db.prepare('SELECT * FROM memory_templates').all()){if(!valid())return;if(!scope||row.scope!==scope)await this.retire(schedule,row,signal,valid);}
  if(!scope)return;
  if(!valid())return;await ensureMaintenanceSession(this.ctx,controller,{sessionId:session,cwd,preset:config.agentPreset,signal});
  for(const kind of workflowKinds){
   signal?.throwIfAborted();if(!valid())return;const id=digest(scope+'\0'+kind);let row=this.db.prepare('SELECT * FROM memory_templates WHERE id=?').get(id);
   if(!row){const token=randomUUID(),request=this.request(config,kind,token),catalog=await schedule.catalog();this.db.prepare("INSERT INTO memory_templates VALUES(?,?,?,?,?,?,?,NULL,?,NULL,'new',NULL,?)").run(id,scope,session,cwd,config.agentPreset,kind,token,JSON.stringify(request),JSON.stringify(catalog.filter(task=>task.sessionId===session).map(task=>task.id)));row=this.db.prepare('SELECT * FROM memory_templates WHERE id=?').get(id);}
   const desired=this.request(config,kind,row.token),wanted=fingerprint(requestedShape(desired)),catalog=await schedule.catalog(),tagged=catalog.filter(task=>task.sessionId===session&&task.prompt===this.prompt(kind,row.token));
   let task=tagged.find(task=>task.id===row.task)??tagged[0]??catalog.find(task=>task.sessionId===session&&task.id===row.task);
   if(!task&&!row.task&&row.state==='new')task=catalog.find(task=>task.sessionId===session&&task.prompt===legacyPrompt(kind)&&task.title===labels[kind]);
   if(!task&&!row.task&&['creating','needs-review'].includes(row.state)){
    const baseline=new Set(JSON.parse(row.baseline)),unknown=catalog.filter(task=>task.sessionId===session&&!baseline.has(task.id)&&!this.owns(task));
    if(unknown.length){this.review(row,'创建结果有外部变化，现有任务保留待核对；没有新建副本。');continue;}
   }
   if(!task&&row.task&&['ready','updating','needs-review'].includes(row.state)){this.review(row,'原生任务已删除，记录保留；如需恢复，请关闭并重新开启自动归档。');continue;}
   if(!task){
    this.db.prepare("UPDATE memory_templates SET task=NULL,request=?,state='creating',note=NULL,baseline=? WHERE id=?").run(JSON.stringify(desired),JSON.stringify(catalog.filter(task=>task.sessionId===session).map(task=>task.id)),id);this.checkpoint('template-create-intent');
    if(!valid())return;task={...await schedule.create(session,desired,signal),sessionId:session,status:'active'};this.checkpoint('template-native-created');
   }else{
    const current=fingerprint(nativeShape(task)),previous=fingerprint(requestedShape(JSON.parse(row.request))),legacy=task.prompt===legacyPrompt(kind)&&task.title===labels[kind];
    if(current!==wanted&&current!==(row.native??previous)&&!legacy){this.review(row,'任务已在原生设置中修改，现有内容保留；请核对模板配置。');continue;}
    if(task.status!=='active'){this.review(row,'原生任务已停用，现有状态保留；请在原生自动任务页核对。');continue;}
    if(current!==wanted){
     this.db.prepare("UPDATE memory_templates SET task=?,native=?,request=?,state='updating',note=NULL WHERE id=?").run(task.id,current,JSON.stringify(desired),id);this.checkpoint('template-update-intent');
     const ruleChanged=JSON.stringify({...nativeShape(task),title:undefined,prompt:undefined})!==JSON.stringify({...requestedShape(desired),title:undefined,prompt:undefined}),change=desired.weekly?{kind:'weekly',weekly:desired.weekly}:{kind:'daily',daily:desired.daily};
     if(!valid())return;const updated=await schedule.update({sessionId:session,id:task.id,expected:expectedRecord(task),title:desired.title,prompt:desired.prompt,...ruleChanged?{change}:{}},signal);if(updated.code){this.review(row,'任务在保存前变化，请刷新后核对。');continue;}task={...updated.record,sessionId:session,status:'active'};this.checkpoint('template-native-updated');
    }
   }
   await this.capture(schedule,row,task);
   this.db.prepare("UPDATE memory_templates SET task=?,native=?,request=?,state='ready',note=NULL WHERE id=?").run(task.id,fingerprint(nativeShape(task)),JSON.stringify(desired),id);this.checkpoint('template-mapped');
   for(const duplicate of tagged)if(duplicate.id!==task.id){await this.capture(schedule,row,duplicate);await schedule.delete({sessionId:session,id:duplicate.id},signal);this.checkpoint('template-duplicate-deleted');}
  }
 }
 async stop(schedule,signal){for(const row of this.db.prepare('SELECT * FROM memory_templates').all())await this.retire(schedule,row,signal);}
}
