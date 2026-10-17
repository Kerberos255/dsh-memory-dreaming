import {digest,readBounded,safePath} from './workspace-io.js';
import {shiftDay} from './weekly-archive.js';

// Dream reads derived daily memory, not a second raw transcript scan.
// Cursor keys are content hashes, so an edited daily report is handled as new input.
const MAX_DAILY_BYTES=65536;
const WINDOW_DAYS=30;
const PER_RUN_DAYS=7;
const DAY=/^20\d\d-\d\d-\d\d$/;
export function collectDreamDiaries(db,cwd,scope,day,{limit=PER_RUN_DAYS,days=WINDOW_DAYS,signal}={}){
 if(!DAY.test(day)||!Number.isSafeInteger(limit)||limit<1||limit>31)throw new Error('Dream 日记增量范围无效');
 const cursor=db.prepare('SELECT hash FROM memory_dream_diaries WHERE scope=? AND day=?');
 const entries=[];
 for(let i=days-1;i>=0;i--){
  signal?.throwIfAborted();
  const date=shiftDay(day,-i);
  const targets=['memory/'+date+'.md','memory/.archive/daily/'+date+'.md','memory/history/daily/'+date.slice(0,4)+'/'+date+'.md'];
  let candidate=null;
  for(const relative of targets){
   const text=readBounded(safePath(cwd,relative),MAX_DAILY_BYTES);
   if(text===null)continue;
   const start='<!-- dsh-memory:daily-'+date+' -->\n',end='\n<!-- /dsh-memory:daily-'+date+' -->';
   if(!text.startsWith(start)||!text.trimEnd().endsWith(end.trimEnd()))
    throw new Error('每日记忆存在非受管内容或标记异常，Dream 不会擅自读取：'+relative);
   const endAt=text.lastIndexOf(end);
   if(endAt<start.length)throw new Error('日记受管结束标记异常：'+relative);
   const summary=text.slice(start.length,endAt).trim();
   if(!summary)throw new Error('每日记忆内容为空：'+relative);
   const hash=digest(summary);
   if(candidate&&candidate.hash!==hash)throw new Error('每日记忆正文与归档副本不一致：'+date);
   candidate={day:date,hash,text:summary,relative};
  }
  if(!candidate||cursor.get(scope,date)?.hash===candidate.hash)continue;
  entries.push(candidate);
  if(entries.length===limit)break;
 }
 return entries;
}
export function initDreamDiaries(db){
 db.exec(`CREATE TABLE IF NOT EXISTS memory_dream_diaries (
   scope TEXT NOT NULL,day TEXT NOT NULL,hash TEXT NOT NULL,processed INTEGER NOT NULL,
   PRIMARY KEY(scope,day));
 CREATE TABLE IF NOT EXISTS memory_dream_batch_cache (
   scope TEXT NOT NULL,key TEXT NOT NULL,payload TEXT NOT NULL,digest TEXT NOT NULL,created INTEGER NOT NULL,
   PRIMARY KEY(scope,key));`);
}
export function finishDreamDiaries(db,scope,entries){
 const stmt=db.prepare('INSERT INTO memory_dream_diaries(scope,day,hash,processed) VALUES(?,?,?,?) ON CONFLICT(scope,day) DO UPDATE SET hash=excluded.hash,processed=excluded.processed');
 for(const e of entries)stmt.run(scope,e.day,e.hash,Date.now());
}
export function dreamBatchCache(db,scope){
 const valid=value=>value&&typeof value==='object'&&Array.isArray(value.facts)&&value.facts.length===0
  &&typeof value.dream==='string'&&value.dream.length<=12000;
 return{
  get(key){
   const row=db.prepare('SELECT payload,digest,created FROM memory_dream_batch_cache WHERE scope=? AND key=?').get(scope,key);
   if(!row)return null;
   if(row.created<Date.now()-7*86400000||digest(row.payload)!==row.digest)return null;
   let result;try{result=JSON.parse(row.payload)}catch{return null;}
   return valid(result)?result:null;
  },
  put(key,result){
   if(!valid(result))return;
   const payload=JSON.stringify({facts:[],dream:result.dream,daily:'',weekly:'',taskEvents:[]});
   if(Buffer.byteLength(payload)>131072)return;
   db.prepare('INSERT OR REPLACE INTO memory_dream_batch_cache VALUES(?,?,?,?,?)').run(scope,key,payload,digest(payload),Date.now());
   db.prepare('DELETE FROM memory_dream_batch_cache WHERE created<?').run(Date.now()-7*86400000);
   db.prepare('DELETE FROM memory_dream_batch_cache WHERE rowid IN (SELECT rowid FROM memory_dream_batch_cache WHERE scope=? ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 64)').run(scope);
  }
 };
}
