import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HistoryIndex } from '../history-index.js';

function fixture() {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-history-index-'));
 const source=path.join(root,'memory','history');
 fs.mkdirSync(source,{recursive:true});
 const index=new HistoryIndex(path.join(root,'cache','history-index.sqlite'));
 return {root,source,index,write(name,value){const p=path.join(source,name);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,value);},close(){index.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('historical daily and weekly archive search: source paths and no prompt ingestion',async()=>{
 const t=fixture();
 try{
  t.write('daily/2026/2026-09-25.md','# PageLingo 翻译决策\n因为质量不稳定，放弃本地 2B 翻译模型，采用 Bergamot 与 API 方案。');
  t.write('weekly/2026/weekly-summary-2026-09-21~2026-09-27.md','# PageLingo 周记\n翻译质量回归后改为先处理嵌套结构。');
  t.write('server_config.md','# 此文件不会被索引\nserver-secret-phrase');
  t.write('notes.json','{"leak":"unexpected"}');
  const rows=await t.index.search(t.root,'PageLingo 翻译',{semantic:false});
  assert(rows.length>=1);
  assert(rows.every(item=>item.source.reviewed===false&&item.source.path.startsWith('memory/history/')));
  assert(rows.some(item=>item.source.path.endsWith('2026-09-25.md')));
  assert.equal((await t.index.search(t.root,'server-secret-phrase',{semantic:false})).length,0);
  assert.equal(t.index.status(t.root).files,2);
 }finally{t.close();}
});
test('incremental indexing avoids unchanged writes, updates modifications and removes deleted files',async()=>{
 const t=fixture();
 try{
  t.write('daily/2026/2026-10-01.md','# 测试\n旧项目甲乙丙丁以及长期计划的记录。');
  assert.equal(t.index.sync(t.root).updated,1);
  assert.equal(t.index.sync(t.root).updated,0);
  assert.equal((await t.index.search(t.root,'旧项目甲乙',{semantic:false})).length,1);
  t.write('daily/2026/2026-10-01.md','# 测试\n新计划甲乙丙丁以及长期计划的记录。');
  assert.equal((await t.index.search(t.root,'新计划甲乙',{semantic:false})).length,1);
  assert.equal((await t.index.search(t.root,'旧项目甲乙',{semantic:false})).length,0);
  fs.unlinkSync(path.join(t.source,'daily/2026/2026-10-01.md'));
  assert.equal((await t.index.search(t.root,'新计划甲乙',{semantic:false})).length,0);
  assert.equal(t.index.status(t.root).files,0);
 }finally{t.close();}
});
test('sensitive lines, scripts and nonstandard markdown are excluded before indexing',async()=>{
 const t=fixture();
 try{
  t.write('daily/2026/2026-10-02.md','# 业务回顾\n正常事项：完成业务回顾说明。\n密码：highly-unsafe-secret-value\n账号: 123456789012345\n\`\`\`sh\nnever-index-shell-script\n\`\`\`');
  t.write('server_config.md','# 登录口令\nVERY_PRIVATE_STRING');
  t.index.sync(t.root);
  const db=t.index.open();
  const rows=db.prepare('SELECT body FROM history_chunks').all().map(x=>x.body).join('\n');
  assert.match(rows,/业务回顾/);
  assert.doesNotMatch(rows,/highly-unsafe|123456789012345|never-index-shell-script|VERY_PRIVATE_STRING/);
 }finally{t.close();}
});
test('semantic provider is only invoked during explicit searches when configured',async()=>{
 const t=fixture();
 try{
  t.write('daily/2026/2026-09-15.md','# 翻译\nPageLingo 原型使用 Bergamot 翻译并检测嵌套标签质量。');
  let calls=0;
  const vectors={selection:()=>({fingerprint:'t1',provider:{embed:async({texts})=>{calls++;return texts.map(x=>[x.includes('PageLingo')?1:0.5,1]);}}})};
  const config={embeddingProvider:'test',embeddingModel:'test'};
  t.index.sync(t.root);
  assert.equal(calls,0);
  await t.index.search(t.root,'PageLingo',{vectorIndex:vectors,config});
  assert.equal(calls,1);
  const before=calls;
  await t.index.search(t.root,'PageLingo',{semantic:false,vectorIndex:vectors,config});
  assert.equal(calls,before);
 }finally{t.close();}
});
