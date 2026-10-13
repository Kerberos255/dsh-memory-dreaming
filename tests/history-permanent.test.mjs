import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { HistoryArchive } from '../history-archive.js';
import { HistoryIndex } from '../history-index.js';
import { WeeklyArchives } from '../weekly-archive.js';
const sum=s=>createHash('sha256').update(s).digest('hex');
function fixture(now=Date.parse('2026-10-13T00:00:00Z')){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-permanent-'));
 const archive=new HistoryArchive({now:()=>now});
 const index=new HistoryIndex(path.join(root,'index','history.sqlite'));
 const write=(name,value)=>{
  const target=path.join(root,name);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,value);
  return target;
 };
 return{root,archive,index,write,close(){index.close();fs.rmSync(root,{recursive:true,force:true});}};
}
test('active weekly, current daily and imported archive all share one lookup',async()=>{
 const t=fixture();
 try{
  t.write('memory/2026-10-12.md','# 当日记录\n讨论 OpenClaw 和 dsh-memory 的兼容方案。');
  t.write('memory/weekly/2026-10-05_2026-10-11.md','# 周记\n这周完成 Discord 用户交互修复和渠道验收。');
  t.write('memory/history/daily/2026/2026-09-20--a13db180f219.md','# 旧版日志\n飞书渠道曾经处理过 CardKit 卡片。');
  t.write('memory/history/weekly/2025/2025-10-01_2025-10-07.md','# 历史周记\n当时建立了日记持久化计划。');
  t.write('memory/history/daily/2025/2025-10-02.md','# 永久日记\n这天记录了深夜任务调度排查。');
  const state=t.index.sync(t.root);
  assert.equal(state.scanned,5);
  for(const [keyword,expected] of [['OpenClaw','memory/2026-10-12.md'],['Discord','memory/weekly/2026-10-05_2026-10-11.md'],['CardKit','memory/history/daily/2026/2026-09-20--a13db180f219.md'],['持久化','memory/history/weekly/2025/2025-10-01_2025-10-07.md'],['调度排查','memory/history/daily/2025/2025-10-02.md']]){
   const rows=await t.index.search(t.root,keyword,{semantic:false});
   assert(rows.some(row=>row.source.path===expected),keyword);
   assert(rows.every(row=>row.source.reviewed===false));
  }
 }finally{t.close();}
});
test('year-old week creates a verified, non-destructive snapshot and search deduplicates copies',async()=>{
 const t=fixture(),text='# 周记\n长期记忆讨论 OpenClaw 迁移与计划方案。';
 try {
  const old=t.write('memory/weekly/2025-01-06_2025-01-12.md',text);
  fs.utimesSync(old,new Date('2025-02-01T00:00:00Z'),new Date('2025-02-01T00:00:00Z'));
  t.write('memory/weekly/2026-10-06_2026-10-12.md','# 新周记\n近期新内容不会提前归档。');
  assert.equal(t.archive.plan(t.root,{days:365}).eligible,1);
  const result=t.archive.snapshot(t.root,{days:365});
  assert.equal(result.copied,1);
  assert.equal(fs.readFileSync(path.join(t.root,'memory/weekly/2025-01-06_2025-01-12.md'),'utf8'),text);
  assert.equal(fs.readFileSync(path.join(t.root,'memory/history/weekly/2025/2025-01-06_2025-01-12.md'),'utf8'),text);
  assert.equal(t.archive.snapshot(t.root,{days:365}).copied,0);
  t.index.sync(t.root);
  const rows=await t.index.search(t.root,'OpenClaw',{semantic:false});
  assert.equal(rows.length,1,'original and archive must not appear twice');
  assert.equal(rows[0].source.path,'memory/history/weekly/2025/2025-01-06_2025-01-12.md');
 }finally{t.close();}
});
test('permanent daily is secured before 14-day temporary cleanup',()=>{
 const t=fixture();
 const db=new DatabaseSync(':memory:');
 try {
  const daily='<!-- dsh-memory:daily-2025-01-06 -->\n# 2025-01-06\n\n已记录问题修复与验收。\n<!-- /dsh-memory:daily-2025-01-06 -->\n';
  const backup='memory/.archive/daily/2025-01-06.md';
  t.write(backup,daily);
  const weekly=new WeeklyArchives(db);
  weekly.preserveDaily=(cwd,entry,body)=>t.archive.preserveDaily(cwd,entry.day,body,entry.hash);
  db.prepare("INSERT INTO memory_weekly_archives(scope,cwd,week_start,week_end,report_path,report_hash,entries,state,retention_until) VALUES(?,?,?,?,?,?,?,'archived',?)")
    .run('test',t.root,'2025-01-06','2025-01-12','memory/weekly/2025-01-06_2025-01-12.md','hash',JSON.stringify([{day:'2025-01-06',backup,hash:sum(daily)}]),Date.now()-1);
  weekly.clean(t.root,'test');
  assert.equal(fs.existsSync(path.join(t.root,backup)),false);
  assert.equal(fs.readFileSync(path.join(t.root,'memory/history/daily/2025/2025-01-06.md'),'utf8'),daily);
  assert.equal(db.prepare('SELECT state FROM memory_weekly_archives').get().state,'purged');
 }finally{db.close();t.close();}
});
test('permanent history collision never purges the only verified temporary backup',()=>{
 const t=fixture();
 const db=new DatabaseSync(':memory:');
 try {
  const daily='<!-- dsh-memory:daily-2025-01-06 -->\n# 2025-01-06\n\n完整的一段记忆。\n<!-- /dsh-memory:daily-2025-01-06 -->\n';
  const backup='memory/.archive/daily/2025-01-06.md';
  t.write(backup,daily);
  t.write('memory/history/daily/2025/2025-01-06.md','人为不同内容：不允许覆盖');
  const weekly=new WeeklyArchives(db);
  weekly.preserveDaily=(cwd,entry,body)=>t.archive.preserveDaily(cwd,entry.day,body,entry.hash);
  db.prepare("INSERT INTO memory_weekly_archives(scope,cwd,week_start,week_end,report_path,report_hash,entries,state,retention_until) VALUES(?,?,?,?,?,?,?,'archived',?)")
    .run('test',t.root,'2025-01-06','2025-01-12','memory/weekly/2025-01-06_2025-01-12.md','hash',JSON.stringify([{day:'2025-01-06',backup,hash:sum(daily)}]),Date.now()-1);
  weekly.clean(t.root,'test');
  assert.equal(fs.readFileSync(path.join(t.root,backup),'utf8'),daily);
  assert.equal(db.prepare('SELECT state FROM memory_weekly_archives').get().state,'archived');
  assert.match(db.prepare('SELECT note FROM memory_weekly_archives').get().note,/保留/);
 }finally{db.close();t.close();}
});
test('non-markdown, symlink escape and unrelated files cannot enter archive index',()=>{
 const t=fixture();
 try{
  t.write('memory/history/weekly/2025/server_config.md','# sensitive-config-not-indexable');
  t.write('memory/history/weekly/2025/tmp.json','{"secret":"do not index"}');
  t.index.sync(t.root);
  assert.equal(t.index.status(t.root).files,0);
 }finally{t.close();}
});

test('monthly archives and curated markdown notes index without admitting unsafe config files',async()=>{
 const t=fixture();
 try{
  t.write('memory/history/monthly/2026/2026-03.md','# 月度档案\n天气模块修复的详细步骤，并记录解决过程与后续注意事项。\n'+'x'.repeat(270000));
  t.write('memory/history/notes/设备：技术指南.md','# 智能家居的技术参考\nMIoT 音箱服务结构和动作说明。');
  t.write('memory/history/notes/server_config.md','# 不能索引的配置\ncredential-secret-material');
  t.write('memory/history/notes/README.md','# 不能索引的索引\nnotsearchable');
  const status=t.index.sync(t.root);
  assert.equal(status.scanned,2);
  const month=await t.index.search(t.root,'天气模块修复',{semantic:false});
  assert(month.some(row=>row.source.path==='memory/history/monthly/2026/2026-03.md'));
  assert(month.some(row=>row.source.date==='2026-03'));
  const note=await t.index.search(t.root,'MIoT',{semantic:false});
  assert(note.some(row=>row.source.path==='memory/history/notes/设备：技术指南.md'));
  assert.equal((await t.index.search(t.root,'credential-secret-material',{semantic:false})).length,0);
  assert.equal((await t.index.search(t.root,'notsearchable',{semantic:false})).length,0);
 }finally{t.close();}
});
