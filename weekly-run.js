import { completeWorkspaceMemory } from './memory-batches.js';
import { dailyPath,previousWeek,weeklyPath } from './weekly-archive.js';
import { digest } from './workspace-io.js';

/** Completes the previous calendar week using DAILY reports as the summarization input.
 * Session messages are queried separately for strictly provenance-checked candidate facts.
 * Journaled archiving is the very last operation; failures keep original diaries.
 */
export async function runWeeklyArchive(memory,cwd,{day,signal,agent,id,scope,timeZone,redact}){
 const period=previousWeek(day),relative=weeklyPath(period),archives=memory.weeklyArchives;
 const previous=archives.get(scope,period.start);
 if(previous){
  if(previous.state==='prepared')archives.resume(cwd,previous);
  const current=archives.get(scope,period.start);
  if(!['archived','purged'].includes(current.state))throw new Error('上周归档有待核对记录：'+(current.note??current.state));
  const file=memory.weeklyArchives.readReport(cwd,current);
  if(file===null)throw new Error('已归档的周记文件不存在，禁止声称归档成功');
  return{sources:[],result:{id,state:'completed',deduplicated:true,staged:0,rejected:0,promoted:0,
   artifacts:[{path:relative,hash:current.report_hash}],weekStart:period.start,weekEnd:period.end,
   archivedDays:JSON.parse(current.entries).length,backupRetentionDays:14}};
 }
 const entries=[],daysWithoutMessages=[];let backfilled=0,backfillCalls=0,staged=0,rejected=0;
 for(const date of period.dates){
  signal?.throwIfAborted();
  let entry=archives.inspectDaily(cwd,date);
  if(!entry){
   const sources=await memory.collect(cwd,signal,{day:date,kind:'daily',includeProcessed:true,timeZone});
   if(!sources.length){
    if(memory.db.prepare('SELECT 1 FROM artifacts WHERE scope=? AND path=? LIMIT 1').get(scope,dailyPath(date)))
     throw new Error(date+' 曾生成过日记但文件已丢失，而且无法从当前来源补齐；请先核对，所有旧日记保留');
    daysWithoutMessages.push(date);continue;
   }
   const filled=await memory.completion(cwd,'daily',sources,signal,agent);
   if(!filled.daily?.trim())throw new Error(date+' 有消息但补齐日记未产生有效内容；原日记仍保留');
   const artifact=memory.artifact(cwd,dailyPath(date),'daily-'+date,'## '+date+'\n\n'+redact(filled.daily),1048576,id);
   if(!artifact)throw new Error(date+' 日记补齐提交失败');
   backfilled++;backfillCalls+=filled.batchCount;
   for(const fact of filled.facts)try{const result=memory.stage(cwd,fact,filled.sources);if(result.id)staged++;else rejected++;}catch{rejected++;}
   entry=archives.inspectDaily(cwd,date);
  }
  if(!entry)throw new Error(date+' 日记补齐后未找到');
  entries.push(entry);
 }
 if(!entries.length)return{sources:[],result:{id,state:'completed',empty:true,artifacts:[],weekStart:period.start,
  weekEnd:period.end,daysWithoutMessages,message:'上一整周没有可归档的日记'}};
 const synthetic=entries.map(entry=>({sessionId:'diary:'+entry.day,seq:0,
  time:Date.parse(entry.day+'T12:00:00.000Z'),text:entry.text}));
 const weekly=await completeWorkspaceMemory({ctx:memory.ctx,config:memory.getConfig(),cwd,kind:'weekly',
  sources:synthetic,signal,agent,redact,summaryOnly:true});
 if(!weekly.weekly?.trim())throw new Error('周记模型输出为空；不删除原日记');
 const coverage='## 日期覆盖\n'+period.dates.map(date=>'- '+date+
  (entries.some(entry=>entry.day===date)?'：已读取日记':'：当天无符合条件的用户消息')).join('\n');
 const body='# '+period.start+' — '+period.end+' 周记\n\n'+coverage+'\n\n'+redact(weekly.weekly);
 const artifact=memory.artifact(cwd,relative,'weekly-'+period.start+'-'+period.end,body,1048576,id);
 if(!artifact)throw new Error('周记没有成功提交；原日记保留');
 // Weekly facts must cite ORIGINAL native messages; never turn synthetic diary IDs into fact sources.
 const originalSources=await memory.collect(cwd,signal,{kind:'weekly',weekly:true,day:period.end,timeZone});
 let candidateCalls=0;
 if(originalSources.length){
  const extracted=await memory.completion(cwd,'weekly',originalSources,signal,agent);
  candidateCalls=extracted.batchCount;
  for(const fact of extracted.facts)try{const result=memory.stage(cwd,fact,extracted.sources);if(result.id)staged++;else rejected++;}catch{rejected++;}
 }
 let promoted=0;
 if(memory.getConfig().autoPromote)for(const candidate of memory.candidates(cwd)){
  if(candidate.state!=='pending'||candidate.conflict||candidate.expired||candidate.confidence<memory.getConfig().minConfidence||
   candidate.observations<memory.getConfig().minObservations)continue;
  try{await memory.approve(cwd,candidate.id,candidate.id,signal,id);promoted++;}catch{signal?.throwIfAborted();rejected++;}
 }
 // A dedicated SQLite journal and full-file hashes cover crashes between individual renames.
 const row=archives.prepare(cwd,scope,period,relative,entries);
 archives.resume(cwd,row);
 return{sources:originalSources,result:{id,state:'completed',artifacts:[artifact],
  inputKey:digest(JSON.stringify([scope,'week',period.start,entries.map(e=>[e.day,e.hash])])),
  weekStart:period.start,weekEnd:period.end,archivedDays:entries.length,daysWithoutMessages,
  backfilled,backupRetentionDays:14,staged,rejected,promoted,sourceCount:originalSources.length,
  sessionCount:new Set(originalSources.map(s=>s.sessionId)).size,
  batchCount:backfillCalls+weekly.batchCount+candidateCalls,model:weekly.model}};
}
