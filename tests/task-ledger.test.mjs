import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {TaskLedger} from '../task-ledger.js';

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-task-ledger-')),db=new DatabaseSync(path.join(dir,'state.sqlite'));
 const ledger=new TaskLedger(db),scope='owner-workspace';
 const source=(sessionId,seq,time,text)=>({sessionId,seq,time:Date.parse(time),text});
 const event=(task,source,status,project='PageLingo',matchId='',aliases=[])=>({
  task,project,status,matchId,aliases,confidence:.95,
  source:{sessionId:source.sessionId,seq:source.seq,quote:source.text}
 });
 return {ledger,scope,source,event,close(){db.close();fs.rmSync(dir,{recursive:true,force:true})}};
}
test('natural language aliases connect the same subtask without a user-supplied key',()=>{
 const f=fixture();try{
  const a=f.source('A',1,'2026-10-10T08:00:00Z','PageLingo 那个嵌套标签的问题，帮我修一下。');
  const first=f.event('嵌套标签问题',a,'requested');
  assert.equal(f.ledger.ingest(f.scope,[first],[a]).accepted,1);
  const id=f.ledger.suggest(f.scope)[0].id;
  const b=f.source('B',2,'2026-10-12T08:00:00Z','翻译插件的标签错位问题已经修好了。');
  const result=f.ledger.ingest(f.scope,[f.event('标签错位问题',b,'completed','PageLingo',id,['翻译插件标签错位'])],[b]);
  assert.equal(result.linked,1);
  const rows=f.ledger.search(f.scope,'PageLingo 标签错位修好了吗');
  assert.equal(rows.length,1);
  assert.equal(rows[0].status,'completed');
  assert.equal(rows[0].history.length,2);
  assert.equal(rows[0].history[1].status,'requested');
 }finally{f.close();}
});
test('other feature in same project cannot hijack old task',()=>{
 const f=fixture();try{
  const a=f.source('A',1,'2026-10-10T08:00:00Z','PageLingo 嵌套标签问题，修一下。');
  f.ledger.ingest(f.scope,[f.event('嵌套标签问题',a,'requested')],[a]);
  const id=f.ledger.suggest(f.scope)[0].id;
  const b=f.source('A',2,'2026-10-11T08:00:00Z','图片翻译问题已经修好了。');
  f.ledger.ingest(f.scope,[f.event('图片翻译问题',b,'completed','PageLingo',id)],[b]);
  assert.equal(f.ledger.suggest(f.scope).length,2);
 }finally{f.close();}
});
test('a conditional command and fake quote never create a completion event',()=>{
 const f=fixture();try{
  const a=f.source('A',1,'2026-10-10T08:00:00Z','嵌套 bug 修好了就跑回归，然后合并。');
  const bad=f.event('嵌套 bug 修复',a,'completed');
  assert.equal(f.ledger.ingest(f.scope,[bad],[a]).accepted,0);
  assert.equal(f.ledger.suggest(f.scope).length,0);
  assert.equal(f.ledger.ingest(f.scope,[{...bad,source:{...bad.source,quote:'已完成并测试通过'}}],[a]).accepted,0);
 }finally{f.close();}
});
test('out-of-order updates do not roll back completed tasks; replay is idempotent',()=>{
 const f=fixture();try{
  const later=f.source('A',9,'2026-10-12T08:00:00Z','PageLingo 嵌套标签已修复。');
  const item=f.event('嵌套标签修复',later,'completed');
  assert.equal(f.ledger.ingest(f.scope,[item],[later]).accepted,1);
  const earlier=f.source('A',3,'2026-10-09T08:00:00Z','PageLingo 嵌套标签正在排查。');
  const id=f.ledger.suggest(f.scope)[0].id;
  assert.equal(f.ledger.ingest(f.scope,[f.event('嵌套标签修复',earlier,'in_progress','PageLingo',id)],[earlier]).linked,1);
  assert.equal(f.ledger.ingest(f.scope,[item],[later]).accepted,0);
  assert.equal(f.ledger.suggest(f.scope)[0].status,'completed');
 }finally{f.close();}
});
test('same language across different projects remains separated and uncertain task does not force a merge',()=>{
 const f=fixture();try{
  const a=f.source('A',1,'2026-10-11T08:00:00Z','PageLingo 标签错位修一下。');
  f.ledger.ingest(f.scope,[f.event('标签错位修复',a,'requested')],[a]);
  const id=f.ledger.suggest(f.scope)[0].id;
  const b=f.source('B',2,'2026-10-12T08:00:00Z','DSH 标签错位已经解决。');
  f.ledger.ingest(f.scope,[f.event('标签错位修复',b,'completed','DSH',id)],[b]);
  assert.equal(f.ledger.suggest(f.scope).length,2);
 }finally{f.close();}
});
test('forget session revokes its evidence and recomputes state',()=>{
 const f=fixture();try{
  const a=f.source('A',1,'2026-10-10T08:00:00Z','PageLingo 嵌套标签正在排查。');
  f.ledger.ingest(f.scope,[f.event('嵌套标签问题',a,'in_progress')],[a]);
  const id=f.ledger.suggest(f.scope)[0].id;
  const b=f.source('B',2,'2026-10-11T08:00:00Z','PageLingo 嵌套标签已经修好了。');
  f.ledger.ingest(f.scope,[f.event('嵌套标签问题',b,'completed','PageLingo',id)],[b]);
  f.ledger.forgetSession(f.scope,'B');
  assert.deepEqual(f.ledger.search(f.scope,'PageLingo 嵌套标签修完了吗'),[],'a forgotten source can taint task aliases, so we erase the whole identity');
  f.ledger.forgetSession(f.scope,'A');
  assert.deepEqual(f.ledger.suggest(f.scope),[]);
 }finally{f.close();}
});

test('revoked task source cannot be searched and unrelated hallucinated names are ignored',()=>{
 const f=fixture();try{
  const a=f.source('owner',2,'2026-10-10T08:00:00Z','PageLingo 的嵌套标签修一下。');
  const valid=f.event('嵌套标签问题',a,'requested');
  const invented=f.event('数据库删除生产表',a,'requested','PageLingo');
  const stats=f.ledger.ingest(f.scope,[valid,invented],[a]);
  assert.equal(stats.accepted,1);assert.equal(stats.skipped,1);
  assert.equal(f.ledger.search(f.scope,'PageLingo 嵌套标签进度',{authorized:()=>false}).length,0);
 }finally{f.close();}
});
test('successful unit tests alone cannot mark full project implementation complete',()=>{
 const f=fixture();try{
  const s=f.source('owner',2,'2026-10-12T08:00:00Z','PageLingo 标签模块单元测试通过，但尚未上线。');
  assert.equal(f.ledger.ingest(f.scope,[f.event('标签模块开发',s,'completed')],[s]).accepted,0);
 }finally{f.close();}
});

test('a channel-sourced task remains private if its channel binding later disappears',()=>{
 const f=fixture();try{
  const s={...f.source('owner-channel',5,'2026-10-11T08:00:00Z','PageLingo 嵌套标签已经修好了。'),channel:true};
  assert.equal(f.ledger.ingest(f.scope,[f.event('嵌套标签问题',s,'completed')],[s]).accepted,1);
  let needed=false;
  assert.equal(f.ledger.search(f.scope,'PageLingo 嵌套标签修复',{authorized:(_session,ownerRequired)=>{needed=ownerRequired;return false;}}).length,0);
  assert.equal(needed,true);
  assert.equal(f.ledger.search(f.scope,'PageLingo 嵌套标签修复',{authorized:(_session,ownerRequired)=>ownerRequired}).length,1);
 }finally{f.close();}
});
test('a task candidate from a revoked source cannot be used as a hidden match during ingestion',()=>{
 const f=fixture();try{
  const a=f.source('old',1,'2026-10-10T08:00:00Z','PageLingo 嵌套标签问题修一下。');
  f.ledger.ingest(f.scope,[f.event('嵌套标签问题',a,'requested')],[a]);
  const privateId=f.ledger.suggest(f.scope)[0].id;
  const b=f.source('new',2,'2026-10-12T08:00:00Z','PageLingo 嵌套标签问题已经修好了。');
  const r=f.ledger.ingest(f.scope,[f.event('嵌套标签问题',b,'completed','PageLingo',privateId)],[b],{knownIds:[]});
  assert.equal(r.linked,0);
  assert.equal(f.ledger.suggest(f.scope).length,2);
 }finally{f.close();}
});

test('two unrelated tasks in one project share a stable project ID but keep different task IDs',()=>{
 const f=fixture();try{
  const a=f.source('A',1,'2026-10-10T08:00:00Z','PageLingo 嵌套标签修一下。');
  const b=f.source('A',2,'2026-10-11T08:00:00Z','PageLingo 图片翻译问题修一下。');
  f.ledger.ingest(f.scope,[f.event('嵌套标签问题',a,'requested')],[a]);
  f.ledger.ingest(f.scope,[f.event('图片翻译问题',b,'requested')],[b]);
  const rows=f.ledger.suggest(f.scope);
  assert.equal(rows.length,2);
  assert.notEqual(rows[0].id,rows[1].id);
  assert.match(rows[0].projectId,/^project-[a-f0-9]{20}$/);
  assert.equal(rows[0].projectId,rows[1].projectId);
 }finally{f.close();}
});
test('project ID is different across projects and isolated by workspace',()=>{
 const f=fixture();try{
  const a=f.source('A',1,'2026-10-10T08:00:00Z','PageLingo 嵌套标签修一下。');
  const b=f.source('B',2,'2026-10-10T08:00:00Z','DSH 嵌套标签修一下。');
  f.ledger.ingest(f.scope,[f.event('嵌套标签问题',a,'requested')],[a]);
  f.ledger.ingest(f.scope,[f.event('嵌套标签问题',b,'requested','DSH')],[b]);
  assert.notEqual(...f.ledger.suggest(f.scope).map(x=>x.projectId));
  f.ledger.ingest('another-workspace',[f.event('嵌套标签问题',a,'requested')],[a]);
  assert.notEqual(f.ledger.suggest('another-workspace')[0].projectId,f.ledger.suggest(f.scope).find(x=>x.project==='PageLingo').projectId);
 }finally{f.close();}
});
