import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { absent, digest, readBounded, safePath, scopeId } from './workspace-io.js';

const fileHash = value => value === null ? null : digest(value);
const exists = filename => { try { fs.lstatSync(filename); return true; } catch (error) { if (absent(error)) return false; throw error; } };

// Each workspace/preset holds its own OS-released SQLite lease while a model
// run is active. Opening another reader must not interrupt a live run.
export class MemoryRunLeases {
 constructor(filename,db){this.filename=filename;this.db=db;}
 acquire(scope){
  if(!/^[a-f0-9]{64}$/.test(scope))throw new Error('记忆任务范围无效');
  const lease=new DatabaseSync(this.filename+'.run-'+scope+'.sqlite');lease.exec('PRAGMA busy_timeout=0');
  try{lease.exec('BEGIN IMMEDIATE');}catch(error){lease.close();if(error.errcode===5||/database is locked/.test(error.message))throw new Error('该工作区正在其他进程整理记忆');throw error;}
  return()=>{try{lease.exec('ROLLBACK');}finally{lease.close();}};
 }
 recover(){
  for(const {scope} of this.db.prepare("SELECT DISTINCT scope FROM runs WHERE state='running'").all()){
   let release;try{release=this.acquire(scope);}catch(error){if(/其他进程/.test(error.message))continue;throw error;}
   try{this.db.prepare("UPDATE runs SET state='interrupted',ended=? WHERE scope=? AND state='running'").run(Date.now(),scope);}finally{release();}
  }
 }
}

export class MemoryCommits {
 constructor(db, leasePath, io, checkpoint = () => {}) {
  this.db=db;this.io=io;this.checkpoint=checkpoint;this.lease=new DatabaseSync(leasePath);this.lease.exec('PRAGMA busy_timeout=0');
  db.exec(`PRAGMA synchronous=FULL;
   CREATE TABLE IF NOT EXISTS memory_commits(id TEXT PRIMARY KEY,scope TEXT NOT NULL,cwd TEXT NOT NULL,preset TEXT NOT NULL,state TEXT NOT NULL,committed INTEGER NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,fileKey TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,error TEXT);
   CREATE INDEX IF NOT EXISTS memory_commit_scope ON memory_commits(scope,updated);
   CREATE TABLE IF NOT EXISTS memory_commit_targets(target TEXT PRIMARY KEY,operation TEXT NOT NULL);`);
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 leaseOperation(fn,busy=()=>{throw new Error('另一进程正在写入记忆，请稍后重试');}){
  try{this.lease.exec('BEGIN IMMEDIATE');}catch(error){if(error.errcode===5||/database is locked/.test(error.message))return busy();throw error;}
  try{return fn();}finally{this.lease.exec('ROLLBACK');}
 }
 locations(spec){
  if(fs.realpathSync(spec.cwd)!==spec.cwd||scopeId(spec.cwd,spec.preset)!==spec.scope)throw new Error('记忆工作区范围发生变化');
  if(!/^[a-f0-9-]{36}$/.test(spec.id)||!Number.isSafeInteger(spec.maxBytes)||spec.maxBytes<1||spec.maxBytes>1048576)throw new Error('记忆提交记录无效');
  const filename=safePath(spec.cwd,spec.relative),temp=safePath(spec.cwd,spec.relative+'.dsh-memory-'+spec.id+'.tmp');return{filename,temp};
 }
 row(id,cwd){const row=this.db.prepare('SELECT * FROM memory_commits WHERE id=? AND cwd=?').get(id,fs.realpathSync(cwd));if(!row)throw new Error('恢复记录不存在或属于其他工作区');return row;}
 view(row){const spec=JSON.parse(row.payload);return{id:row.id,kind:spec.meta.kind,file:spec.relative,preset:row.preset,state:row.state,committed:!!row.committed,created:row.created,error:row.error};}
 rows(cwd){return this.db.prepare('SELECT * FROM memory_commits WHERE cwd=? ORDER BY updated DESC LIMIT 100').all(fs.realpathSync(cwd)).map(row=>this.view(row));}
 inspect(cwd,id){const row=this.row(id,cwd),spec=JSON.parse(row.payload),{filename,temp}=this.locations(spec);return{...this.view(row),before:spec.before,after:spec.after,current:readBounded(filename,spec.maxBytes),temp:exists(temp)?readBounded(temp,spec.maxBytes):null};}
 review(id){this.db.prepare("UPDATE memory_commits SET state='needs-review',updated=?,error=? WHERE id=?").run(Date.now(),'文件或候选已变化，现有内容已保留；请查看差异后重新核对或放弃本次操作。',id);}
 clear(id){this.transaction(()=>{this.db.prepare('DELETE FROM memory_commit_targets WHERE operation=?').run(id);this.db.prepare('DELETE FROM memory_commits WHERE id=?').run(id);});}
 cleanup(spec,temp){
  if(!exists(temp))return true;const info=fs.lstatSync(temp);if(info.isSymbolicLink()||!info.isFile()||info.size>spec.maxBytes)return false;
  const text=readBounded(temp,spec.maxBytes);if(text!==''&&fileHash(text)!==spec.afterHash)return false;fs.unlinkSync(temp);return true;
 }
 settle(row,spec){
  this.transaction(()=>{
   this.io.validate(spec);this.io.commit(spec);
   this.db.prepare("UPDATE memory_commits SET committed=1,state='committed',updated=?,error=NULL WHERE id=? AND committed=0").run(Date.now(),row.id);
   this.db.prepare('DELETE FROM memory_commit_targets WHERE operation=?').run(row.id);
  });
 }
 reconcile(row){
  const spec=JSON.parse(row.payload),{filename,temp}=this.locations(spec);
  if(row.committed){if(!this.cleanup(spec,temp))throw new Error('暂存文件被修改');this.clear(row.id);this.io.after?.(spec);return;}
  const current=fileHash(readBounded(filename,spec.maxBytes));
  if(current===spec.afterHash){this.settle(row,spec);if(!this.cleanup(spec,temp))throw new Error('暂存文件被修改');this.clear(row.id);this.io.after?.(spec);}
  else if(current===spec.beforeHash){if(!this.cleanup(spec,temp))throw new Error('暂存文件被修改');this.clear(row.id);}
  else throw new Error('文件被外部修改');
 }
 recover(cwd){
  this.leaseOperation(()=>{
   const rows=this.db.prepare('SELECT * FROM memory_commits'+(cwd?' WHERE cwd=?':'')).all(...cwd?[fs.realpathSync(cwd)]:[]);
   for(const row of rows)try{this.reconcile(row);}catch{this.review(row.id);}
  },()=>{});return cwd?this.rows(cwd):undefined;
 }
 discard(cwd,id,confirmation){
  if(confirmation!==id)throw new Error('请明确确认要放弃的写入');
  return this.leaseOperation(()=>{const row=this.row(id,cwd);if(row.committed)throw new Error('记录已提交，请重新核对暂存文件');const spec=JSON.parse(row.payload),{temp}=this.locations(spec);
   if(!this.cleanup(spec,temp))throw new Error('暂存文件有外部改动，请先另存需要保留的内容');this.clear(id);return{discarded:true,preservedCurrentFile:true};});
 }
 write(value){return this.leaseOperation(()=>{
  const id=randomUUID(),beforeHash=fileHash(value.before),afterHash=fileHash(value.after),spec={...value,id,cwd:fs.realpathSync(value.cwd),beforeHash,afterHash},locations=this.locations(spec);if(Buffer.byteLength(spec.after)>spec.maxBytes)throw new Error('记忆文件超过大小限制');
  if(fileHash(readBounded(locations.filename,spec.maxBytes))!==beforeHash)throw new Error('文件已在外部修改，请重新读取后确认');
  this.transaction(()=>{this.io.validate(spec);this.db.prepare("INSERT INTO memory_commits VALUES(?,?,?,?,'prepared',0,?,?,?, ?,NULL)").run(id,spec.scope,spec.cwd,spec.preset,Date.now(),Date.now(),locations.filename.toLocaleLowerCase('en-US'),JSON.stringify(spec));for(const target of spec.meta.targets??[])this.db.prepare('INSERT INTO memory_commit_targets VALUES(?,?)').run(target.id,id);});
  try{
   this.checkpoint('intent');if(exists(locations.filename+'.dsh-lock'))throw new Error('文件正在写入，请稍后重试');
   const fd=fs.openSync(locations.temp,'wx',0o600);try{fs.fsyncSync(fd);this.checkpoint('temp-created');fs.writeFileSync(fd,spec.after);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   this.checkpoint('staged');if(fileHash(readBounded(locations.filename,spec.maxBytes))!==beforeHash)throw new Error('文件已在外部修改，请重新读取后确认');
   fs.renameSync(locations.temp,locations.filename);this.checkpoint('published');const row=this.row(id,spec.cwd);this.settle(row,spec);this.checkpoint('committed');
   if(this.cleanup(spec,locations.temp))this.clear(id);else this.review(id);this.io.after?.(spec);return{path:spec.relative,hash:afterHash};
  }catch(error){const row=this.db.prepare('SELECT * FROM memory_commits WHERE id=?').get(id);if(row)try{this.reconcile(row);}catch{this.review(id);}throw error;}
 });}
 close(){this.lease.close();}
}
