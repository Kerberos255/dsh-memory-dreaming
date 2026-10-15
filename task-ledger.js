import { randomUUID,createHash } from 'node:crypto';

/** Bounded, source-backed task ledger.  Current state is a view of the newest
 * user observation, never a verified build/deployment claim. */
const norm=s=>String(s??'').normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\s\p{P}\p{S}]+/gu,'');
const makeProjectId=(scope,project)=>norm(project)?'project-'+createHash('sha256').update(scope+'\u0000'+norm(project)).digest('hex').slice(0,20):'';
const aliasSet=s=>new Set((String(s??'').normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{Script=Han}]+|[a-z0-9_.-]{3,}/gu)??[]).flatMap(x=>{
 if(!/[\p{Script=Han}]/u.test(x))return [x];
 return x.length<=2?[x]:Array.from({length:x.length-1},(_,i)=>x.slice(i,i+2));
}).filter(x=>x.length>=2));
const NON_DISTINCT=new Set(['翻译','功能','问题','优化','修复','测试','开发','插件','版本','项目','任务','完成','通过','目前','状态','怎么样','有没有','是不是','现在','已经','那个','之前','昨天','今天','代码','一个','继续','一下','进行','处理','重新','应该','我们','这个']);
function overlap(a,b){
 const left=[...aliasSet(a)].filter(x=>!NON_DISTINCT.has(x)),right=aliasSet(b);
 return left.filter(x=>right.has(x)).length;
}
function classifyQuote(quote,status){
 const text=String(quote??'');
 if(text.length<4||text.length>200||/^(?:假设|示例|比如)/u.test(text))return null;
 // Conditional instructions and future wishes are not evidence that an action occurred.
 const conditional=/(?:如果|假如|要是|等到|等.*?之后|完成后|修好[了后]?[就再]|(?:再|然后)合并|好[了就]再)/u.test(text);
 if(status==='completed'&&(conditional||!/(?:已(?:经)?(?:完成|解决|修好|修复|上线|发布|合并)|修好了|解决了|完成了|验收通过)/u.test(text)))return null;
 if(status==='cancelled'&&!/(?:已取消|取消了|不做了|放弃了|决定放弃|停止开发)/u.test(text))return null;
 if(status==='reopened'&&!/(?:重新开始|重新打开|重新处理|重新排查|又出问题|再次出现|回归失败|又坏了)/u.test(text))return null;
 if(status==='in_progress'&&!/(?:正在|进行中|还在|开始处理|着手|开发中|排查中)/u.test(text))return null;
 if(status==='blocked'&&!/(?:阻塞|卡住|受阻|无法继续|等.*?才能|缺少.*?导致)/u.test(text))return null;
 if(status==='requested'&&!/(?:修一下|改一下|看看|检查|麻烦|请|帮|需要|要做|加上|支持|实现|计划|准备|希望)/u.test(text))return null;
 return ['requested','in_progress','blocked','completed','cancelled','reopened'].includes(status)?status:null;
}
const sensitive=/(?:sk-[\w-]{12,}|(?:api[_ -]?key|secret|password|token|密码|密钥|账号|身份证|手机号)\s*[:=：]|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\d[ -]?){12,19})/iu;
export class TaskLedger{
 constructor(db){this.db=db;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_tasks(
   id TEXT PRIMARY KEY,scope TEXT NOT NULL,project TEXT NOT NULL,project_id TEXT NOT NULL DEFAULT '',title TEXT NOT NULL,
   aliases TEXT NOT NULL, status TEXT NOT NULL, status_at INTEGER NOT NULL,
   session TEXT NOT NULL, seq INTEGER NOT NULL,confidence REAL NOT NULL,
   created INTEGER NOT NULL, updated INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS memory_tasks_scope ON memory_tasks(scope,updated DESC);
  CREATE TABLE IF NOT EXISTS memory_task_events(
   id TEXT PRIMARY KEY,scope TEXT NOT NULL,task TEXT NOT NULL,
   session TEXT NOT NULL,seq INTEGER NOT NULL,time INTEGER NOT NULL,
   quote TEXT NOT NULL,status TEXT NOT NULL,created INTEGER NOT NULL,
   owner_required INTEGER NOT NULL DEFAULT 0,
   UNIQUE(scope,task,session,seq,status,quote)
  );
  CREATE INDEX IF NOT EXISTS memory_task_event_lookup ON memory_task_events(scope,task,time DESC);`);
  if(!db.prepare('PRAGMA table_info(memory_task_events)').all().some(col=>col.name==='owner_required'))db.exec('ALTER TABLE memory_task_events ADD COLUMN owner_required INTEGER NOT NULL DEFAULT 0');
  if(!db.prepare('PRAGMA table_info(memory_tasks)').all().some(col=>col.name==='project_id'))db.exec("ALTER TABLE memory_tasks ADD COLUMN project_id TEXT NOT NULL DEFAULT ''");
  const fill=db.prepare("UPDATE memory_tasks SET project_id=? WHERE id=? AND project_id=''");
  for(const row of db.prepare("SELECT id,scope,project FROM memory_tasks WHERE project_id=''").all())fill.run(makeProjectId(row.scope,row.project),row.id);
 }
 suggest(scope,limit=30){
  return this.db.prepare('SELECT id,project,project_id AS projectId,title,aliases,status FROM memory_tasks WHERE scope=? ORDER BY updated DESC LIMIT ?').all(scope,limit)
   .map(x=>({...x,aliases:JSON.parse(x.aliases).slice(0,5)}));
 }
 /** A model match is only a hint. Project and task feature must also match.
  * If ambiguous, do not merge; mark the new entry unlinked. */
 resolve(scope,event,known){
  const project=norm(event.project), title=norm(event.task);
  const options=known.filter(item=>{
   const names=[item.title,...item.aliases].join(' ');
   const projectCompatible=!project||!norm(item.project)||project===norm(item.project);
   return projectCompatible&&overlap(event.task,names)>0;
  });
  const proposed=options.find(item=>item.id===event.matchId);
  if(proposed&&options.length>1&&!project)return null; // ambiguous without an explicit project
  if(proposed&&event.confidence>=.88
     &&(overlap(event.task,[proposed.title,...proposed.aliases].join(' '))>=2
       ||(overlap(event.task,[proposed.title,...proposed.aliases].join(' '))>=1
          &&(project&&project===norm(proposed.project)))))return proposed;
  // Exact normalized title + project is deterministic; do not guess from a shared project alone.
  const exact=options.filter(item=>norm(item.title)===title&&norm(item.project)===project);
  return exact.length===1?exact[0]:null;
 }
 /** Mutations are tied to already-filtered session sources and exact quotes.
  * A single response can contain multiple different tasks. Replays are idempotent. */
 ingest(scope,events,sources,{allow=true,knownIds=null}={}){
  if(!allow||!Array.isArray(events)||!events.length)return {accepted:0,skipped:0,linked:0};
  const known=this.suggest(scope,250).filter(row=>!knownIds||knownIds.includes(row.id)),sourceMap=new Map(sources.map(s=>[s.sessionId+'#'+s.seq,s]));
  let accepted=0,skipped=0,linked=0;
  this.db.exec('BEGIN IMMEDIATE');
  try{
   for(const event of events.slice(0,100)){
    const src=sourceMap.get(event?.source?.sessionId+'#'+event?.source?.seq);
    if(!src||!Number.isSafeInteger(src.time)||typeof event.task!=='string'||event.task.trim().length<4||event.task.length>120
      ||typeof event.project!=='string'||event.project.length>100
      ||typeof event.source?.quote!=='string'||!src.text.includes(event.source.quote)
      ||!Number.isFinite(event.confidence)||event.confidence<.7||event.confidence>1
      ||/\[凭证已隐藏\]/u.test(event.source.quote)||/\[凭证已隐藏\]/u.test(event.task+event.project)
      ||sensitive.test(event.source.quote)||sensitive.test(event.task+event.project)
      ||(Array.isArray(event.aliases)&&event.aliases.some(x=>typeof x!=='string'||sensitive.test(x)))){
      skipped++;continue;
    }
    const status=classifyQuote(event.source.quote,event.status);
    const knownReference=known.find(x=>x.id===event.matchId);
    const contextual=knownReference&&event.confidence>=.88&&overlap(event.task,[knownReference.title,...knownReference.aliases].join(' '))>=1;
    if(!status||(!contextual&&overlap(event.task,src.text)<1)){skipped++;continue;}
    let row=this.resolve(scope,event,known);
    // A different task must not inherit the old item's status.
    if(!row){
      const count=this.db.prepare('SELECT COUNT(*) n FROM memory_tasks WHERE scope=?').get(scope).n;
      if(count>=1000){skipped++;continue;}
      const id=randomUUID(),now=Date.now();
      this.db.prepare('INSERT INTO memory_tasks(id,scope,project,project_id,title,aliases,status,status_at,session,seq,confidence,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
       .run(id,scope,event.project.trim(),makeProjectId(scope,event.project),event.task.trim(),JSON.stringify([]),status,src.time,src.sessionId,src.seq,event.confidence,now,now);
      row={id,project:event.project.trim(),projectId:makeProjectId(scope,event.project),title:event.task.trim(),aliases:[],status};
      known.push(row);
    }
    const info=this.db.prepare('INSERT OR IGNORE INTO memory_task_events(id,scope,task,session,seq,time,quote,status,created,owner_required) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(),scope,row.id,src.sessionId,src.seq,src.time,event.source.quote,status,Date.now(),src.channel?1:0);
    if(!info.changes){continue;}
    accepted++;if(knownReference?.id===row.id)linked++;
    const aliases=new Set([...row.aliases,event.task.trim(),...(Array.isArray(event.aliases)?event.aliases:[])]
      .filter(x=>typeof x==='string'&&x.length>=4&&x.length<=100&&overlap(x,event.task)>0).slice(0,16));
    this.db.prepare('DELETE FROM memory_task_events WHERE scope=? AND task=? AND id NOT IN (SELECT id FROM memory_task_events WHERE scope=? AND task=? ORDER BY time DESC,seq DESC,id DESC LIMIT 60)').run(scope,row.id,scope,row.id);
    const latest=this.db.prepare('SELECT * FROM memory_task_events WHERE scope=? AND task=? ORDER BY time DESC,seq DESC,id DESC LIMIT 1').get(scope,row.id);
    this.db.prepare('UPDATE memory_tasks SET aliases=?,status=?,status_at=?,session=?,seq=?,confidence=?,updated=? WHERE scope=? AND id=?')
      .run(JSON.stringify([...aliases].slice(0,12)),latest.status,latest.time,latest.session,latest.seq,event.confidence,Date.now(),scope,row.id);
    row.aliases=[...aliases];row.status=latest.status;
   }
   this.db.exec('COMMIT');
  }catch(err){this.db.exec('ROLLBACK');throw err;}
  return {accepted,skipped,linked};
 }
 /** Current observations and full trace, scoped by workspace and checked again
  * at the caller boundary for channel ownership and forgotten sessions. */
 search(scope,query,{limit=4,authorized=()=>true}={}){
  const items=this.suggest(scope,120);
  const ranked=items.map(item=>{
   const evidence=[item.project,item.title,...item.aliases].join(' ');
   const projectMatch=norm(query).includes(norm(item.project))&&norm(item.project).length>=3;
   const score=overlap(query,[item.title,...item.aliases].join(' '))+(projectMatch?1:0);
   return {item,score};
  }).filter(x=>x.score>=2).sort((a,b)=>b.score-a.score||b.item.status.localeCompare(a.item.status)).slice(0,limit*3);
  const results=[];
  for(const {item,score}of ranked){
   const all=this.db.prepare('SELECT session,seq,time,quote,status,owner_required FROM memory_task_events WHERE scope=? AND task=? ORDER BY time DESC,seq DESC LIMIT 60').all(scope,item.id);
   if(all.some(x=>!authorized(x.session,!!x.owner_required)))continue; // fail closed if any contributing source is revoked
   const events=all.slice(0,8).map(x=>({sessionId:x.session,seq:x.seq,time:x.time,status:x.status,quote:x.quote}));
   if(!events.length)continue;
   const latest=events[0];
   results.push({taskId:item.id,projectId:item.projectId,project:item.project,task:item.title,status:latest.status,updatedAt:latest.time,
    statusBasis:'user-statement-unverified',confidence:item.confidence,score,history:events});
   if(results.length>=limit)break;
  }
  return results;
 }
 forgetSession(scope,session){
  this.db.exec('BEGIN IMMEDIATE');
  try{
   // Task names and aliases can themselves carry private content. If any source
   // is forgotten, erase its entire task identity rather than retain a tainted alias.
   const tasks=this.db.prepare('SELECT DISTINCT task FROM memory_task_events WHERE scope=? AND session=?').all(scope,session).map(x=>x.task);
   for(const id of tasks){
    this.db.prepare('DELETE FROM memory_task_events WHERE scope=? AND task=?').run(scope,id);
    this.db.prepare('DELETE FROM memory_tasks WHERE scope=? AND id=?').run(scope,id);
   }
   this.db.exec('COMMIT');
  }catch(err){this.db.exec('ROLLBACK');throw err;}
 }
}
