import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryIndex } from '../history-index.js';
import { needsStatusTimeline,statusTimeline } from '../status-timeline.js';

function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-temporal-'));
 const index=new HistoryIndex(path.join(root,'cache','history.sqlite'));
 return {root,index,write(relative,body){
  const file=path.join(root,...relative.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);
 },close(){index.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('completion after an older in-progress diary appears first, without promoting history as current truth',()=>{
 const f=fixture();
 try{
  f.write('memory/history/daily/2026/2026-10-10.md','# PageLingo 翻译路由\nPageLingo 翻译路由优化进行中，还没有完成。');
  f.write('memory/history/daily/2026/2026-10-12.md','# PageLingo 翻译路由\nPageLingo 翻译路由优化已完成，测试通过。');
  const rows=f.index.timeline(f.root,'PageLingo 翻译路由做好了吗？');
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(x=>x.state),['completed','incomplete']);
  assert.deepEqual(rows.map(x=>x.date),['2026-10-12','2026-10-10']);
  assert(rows.every(x=>x.sourceType==='historical-unverified'&&x.path.startsWith('memory/history/')));
 }finally{f.close();}
});
test('same project different feature never closes the target task',()=>{
 const f=fixture();
 try{
  f.write('memory/2026-10-10.md','# PageLingo\nPageLingo 翻译路由优化进行中。');
  f.write('memory/2026-10-12.md','# PageLingo\nPageLingo 浏览器图标优化已完成。');
  const rows=f.index.timeline(f.root,'PageLingo 翻译路由做好了吗');
  assert.deepEqual(rows.map(x=>x.state),['incomplete']);
 }finally{f.close();}
});
test('a generic successful test does not imply the full named task is done',()=>{
 const f=fixture();
 try{
  f.write('memory/2026-10-10.md','# DSH LCM\nDSH LCM 压缩正在排查。');
  f.write('memory/2026-10-12.md','# DSH\nDSH LCM 单元测试通过，但还未完成发布。');
  const rows=f.index.timeline(f.root,'DSH LCM 现在做好了吗');
  assert(rows.some(x=>x.state==='incomplete'));
  assert(!rows.some(x=>x.state==='completed'));
 }finally{f.close();}
});
test('weekly evidence is ordered by period end and labeled as a week not a precise event day',()=>{
 const rows=statusTimeline('PageLingo 翻译路由完成了吗',[
  {id:2,filename:'memory/weekly/2026-10-05_2026-10-11.md',title:'PageLingo',line:1,body:'PageLingo 翻译路由已完成部署。'},
  {id:1,filename:'memory/2026-10-07.md',title:'PageLingo',line:1,body:'PageLingo 翻译路由进行中。'},
 ]);
 assert.equal(rows[0].date,'2026-10-11');assert.equal(rows[0].precision,'week');
});
test('non-status requests and project-only status questions leave original ranking untouched',()=>{
 assert.equal(needsStatusTimeline('PageLingo 的翻译路线是什么'),false);
 const rows=[{id:1,filename:'memory/2026-10-11.md',title:'PageLingo',line:1,body:'PageLingo 翻译路由已完成。'}];
 assert.deepEqual(statusTimeline('PageLingo 的架构是什么',rows),[]);
 assert.deepEqual(statusTimeline('PageLingo 现在怎么样',rows),[]);
});
test('historical source modification deletes stale evidence on incremental index refresh',()=>{
 const f=fixture();
 try{
  f.write('memory/2026-10-10.md','# PageLingo\nPageLingo 翻译路由进行中。');
  assert.equal(f.index.timeline(f.root,'PageLingo 翻译路由完成了吗')[0]?.state,'incomplete');
  f.write('memory/2026-10-10.md','# PageLingo\nPageLingo 翻译路由已完成。');
  assert.equal(f.index.timeline(f.root,'PageLingo 翻译路由完成了吗')[0]?.state,'completed');
 }finally{f.close();}
});
