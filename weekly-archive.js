import fs from 'node:fs';
import { digest,readBounded,safePath,ownedDirectory } from './workspace-io.js';

const DAY=/^\d{4}-\d{2}-\d{2}$/;
const DAY_MS=86400000;
export function shiftDay(day,offset){
 if(!DAY.test(day)||!Number.isInteger(offset)||Math.abs(offset)>3700)throw new Error('记忆归档日期无效');
 const date=new Date(day+'T12:00:00.000Z');
 if(!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day)throw new Error('记忆归档日期无效');
 date.setUTCDate(date.getUTCDate()+offset);
 return date.toISOString().slice(0,10);
}
/** The most recently COMPLETED Monday-Sunday period, never an unfinished week. */
export function previousWeek(day){
 const weekday=new Date(day+'T12:00:00.000Z').getUTCDay();
 const end=shiftDay(day,-(weekday===0?7:weekday));
 const start=shiftDay(end,-6);
 return {start,end,dates:Array.from({length:7},(_,i)=>shiftDay(start,i))};
}
export const weeklyPath=({start,end})=>'memory/weekly/'+start+'_'+end+'.md';
export const dailyPath=day=>'memory/'+day+'.md';
const backupPath=day=>'memory/.archive/daily/'+day+'.md';
const fileHash=content=>digest(content);
function onlyManagedDaily(text,day){
 const start='<!-- dsh-memory:daily-'+day+' -->\n',end='\n<!-- /dsh-memory:daily-'+day+' -->\n';
 return text.startsWith(start)&&text.endsWith(end)&&text.slice(start.length,-end.length).trim().length>0;
}
/** Journaled same-volume moves; no model call is permitted during recovery. */
export class WeeklyArchives {
 constructor(db,checkpoint=()=>{}){
  this.db=db;this.checkpoint=checkpoint;
  db.exec(`CREATE TABLE IF NOT EXISTS memory_weekly_archives (
   scope TEXT NOT NULL,cwd TEXT NOT NULL,week_start TEXT NOT NULL,week_end TEXT NOT NULL,
   report_path TEXT NOT NULL,report_hash TEXT NOT NULL,entries TEXT NOT NULL,
   state TEXT NOT NULL,archived INTEGER,retention_until INTEGER,
   note TEXT,PRIMARY KEY(scope,week_start));`);
 }
 get(scope,start){return this.db.prepare('SELECT * FROM memory_weekly_archives WHERE scope=? AND week_start=?').get(scope,start);}
 readReport(cwd,row){
  const text=readBounded(safePath(cwd,row.report_path),1048576);
  if(text===null||fileHash(text)!==row.report_hash)throw new Error('周归档产物已被人工修改或丢失：'+row.report_path);
  return text;
 }
 inspectDaily(cwd,day){
  const relative=dailyPath(day),body=readBounded(safePath(cwd,relative),1048576);
  if(body===null)return null;
  if(!onlyManagedDaily(body,day))throw new Error(relative+' 含人工内容或受管标记异常，禁止自动移动；请先核对');
  return {day,relative,backup:backupPath(day),hash:fileHash(body),text:body};
 }
 /** The summary is committed with MemoryCommits BEFORE this method is called. */
 prepare(cwd,scope,period,report,entries){
  if(!entries.length)throw new Error('没有可归档的每日记忆');
  const reportBody=readBounded(safePath(cwd,report),1048576);
  if(!reportBody?.trim())throw new Error('周记尚未成功写入，不能归档每日记忆');
  const payload=entries.map(({day,relative,backup,hash})=>({day,relative,backup,hash}));
  if(payload.some(row=>!onlyManagedDaily(readBounded(safePath(cwd,row.relative),1048576)??'',row.day)))throw new Error('日记在写入周记后发生变化，禁止归档');
  const data={scope,period,report,hash:fileHash(reportBody),payload};
  const existing=this.get(scope,period.start);
  if(existing){
   if(existing.report_hash!==data.hash||existing.report_path!==report||existing.entries!==JSON.stringify(payload))
    throw new Error('周归档记录已存在但原始日记或周记发生变化，须人工核对');
   return existing;
  }
  this.db.prepare('INSERT INTO memory_weekly_archives(scope,cwd,week_start,week_end,report_path,report_hash,entries,state) VALUES(?,?,?,?,?,?,?,?)')
   .run(scope,fs.realpathSync(cwd),period.start,period.end,report,data.hash,JSON.stringify(payload),'prepared');
  this.checkpoint('weekly-journal-prepared');
  return this.get(scope,period.start);
 }
 resume(cwd,row){
  if(!['prepared','archived'].includes(row.state))return;
  if(row.state==='archived')return;
  const report=readBounded(safePath(cwd,row.report_path),1048576);
  if(report===null||fileHash(report)!==row.report_hash)throw new Error('已写入周记发生变化，暂停日记归档：'+row.report_path);
  for(const entry of JSON.parse(row.entries)){
   const source=safePath(cwd,entry.relative),destination=safePath(cwd,entry.backup);
   const original=readBounded(source,1048576),backup=readBounded(destination,1048576);
   if(backup!==null){
    if(fileHash(backup)!==entry.hash||original!==null)throw new Error('日记归档目的地冲突：'+entry.backup);
    continue;
   }
   if(original===null||fileHash(original)!==entry.hash||!onlyManagedDaily(original,entry.day))
    throw new Error('原始日记已修改或消失，暂停归档：'+entry.relative);
   ownedDirectory(cwd,'memory/.archive/daily');
   // Same-volume rename is atomic; the durable journal knows both possible locations.
   fs.renameSync(source,destination);
   this.checkpoint('weekly-daily-moved');
  }
  const now=Date.now();
  this.db.prepare("UPDATE memory_weekly_archives SET state='archived',archived=?,retention_until=?,note=NULL WHERE scope=? AND week_start=? AND state='prepared'")
   .run(now,now+14*DAY_MS,row.scope,row.week_start);
  this.checkpoint('weekly-archived');
 }
 recoverAll(runLeases){
  for(const row of this.db.prepare("SELECT * FROM memory_weekly_archives WHERE state='prepared' ORDER BY week_start").all()){
   let release;
   try{release=runLeases.acquire(row.scope);this.resume(row.cwd,row);}
   catch(error){
    if(/其他进程/.test(String(error.message)))continue; // never race a live publisher
    this.db.prepare('UPDATE memory_weekly_archives SET note=? WHERE scope=? AND week_start=?').run(String(error.message).slice(0,500),row.scope,row.week_start);
   }finally{release?.();}
  }
 }
 recover(cwd,scope){
  for(const row of this.db.prepare("SELECT * FROM memory_weekly_archives WHERE scope=? AND state='prepared' ORDER BY week_start").all(scope))
   this.resume(cwd,row);
 }
 clean(cwd,scope){
  const rows=this.db.prepare("SELECT * FROM memory_weekly_archives WHERE scope=? AND state='archived' AND retention_until<=?").all(scope,Date.now());
  for(const row of rows){
   const entries=JSON.parse(row.entries);
   // Validate every file before removing any. User edits are never deleted.
   let intact=true;
   for(const entry of entries){
    const body=readBounded(safePath(cwd,entry.backup),1048576);
    if(body!==null&&fileHash(body)!==entry.hash){intact=false;break;}
   }
   if(!intact){this.db.prepare("UPDATE memory_weekly_archives SET note='归档备份有人工修改，未清理' WHERE scope=? AND week_start=?").run(scope,row.week_start);continue;}
   for(const entry of entries){
    const filename=safePath(cwd,entry.backup),body=readBounded(filename,1048576);
    if(body!==null)fs.unlinkSync(filename);
   }
   this.db.prepare("UPDATE memory_weekly_archives SET state='purged',note=NULL WHERE scope=? AND week_start=?").run(scope,row.week_start);
  }
 }
}
