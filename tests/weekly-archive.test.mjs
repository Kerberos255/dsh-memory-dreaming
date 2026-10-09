import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WeeklyArchives, previousWeek, shiftDay, weeklyPath } from '../weekly-archive.js';

const period=previousWeek('2026-10-12'),dates=['2026-10-05','2026-10-08'];
function fixture(checkpoint=()=>{}){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-public-weekly-'));
 const db=new DatabaseSync(path.join(cwd,'state.sqlite'));
 const archive=new WeeklyArchives(db,checkpoint),scope='fixture';
 const mk=(relative,body)=>{const file=path.join(cwd,...relative.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);return file;};
 const diary=(day,body='合成日记')=>mk('memory/'+day+'.md','<!-- dsh-memory:daily-'+day+' -->\n## '+day+'\n\n'+body+'\n<!-- /dsh-memory:daily-'+day+' -->\n');
 const report=weeklyPath(period);
 const publish=()=>mk(report,'# 合成周记\n\n已验证来源覆盖。');
 const backup=day=>path.join(cwd,'memory','.archive','daily',day+'.md');
 const original=day=>path.join(cwd,'memory',day+'.md');
 return {cwd,db,archive,scope,diary,publish,backup,original,report,close(){db.close();fs.rmSync(cwd,{recursive:true,force:true});}};
}
test('completed-week selection respects Monday-Sunday and year boundaries',()=>{
 assert.equal(period.start,'2026-10-05');assert.equal(period.end,'2026-10-11');
 assert.equal(previousWeek('2027-01-04').start,'2026-12-28');
 assert.equal(shiftDay('2026-10-01',-1),'2026-09-30');
 assert.throws(()=>shiftDay('2026-02-30',1),/日期无效/);
});
test('weekly report must exist and all daily files must be plugin-owned before archival',()=>{
 const f=fixture();try{
  f.diary(dates[0]);const entries=[f.archive.inspectDaily(f.cwd,dates[0])];
  assert.throws(()=>f.archive.prepare(f.cwd,f.scope,period,f.report,entries),/尚未成功写入/);
  f.publish();
  fs.appendFileSync(f.original(dates[0]),'用户手写内容');
  assert.throws(()=>f.archive.prepare(f.cwd,f.scope,period,f.report,entries),/发生变化/);
  assert(fs.existsSync(f.original(dates[0])));
 }finally{f.close();}
});
test('journaled move preserves report and 14-day backup, and replay is idempotent',()=>{
 const f=fixture();try{
  const entries=dates.map(day=>{f.diary(day);return f.archive.inspectDaily(f.cwd,day);});
  f.publish();
  const row=f.archive.prepare(f.cwd,f.scope,period,f.report,entries);
  f.archive.resume(f.cwd,row);
  assert.equal(f.archive.get(f.scope,period.start).state,'archived');
  assert(f.archive.get(f.scope,period.start).retention_until>Date.now()+13*86400000);
  for(const day of dates){assert(!fs.existsSync(f.original(day)));assert(fs.existsSync(f.backup(day)));}
  f.archive.resume(f.cwd,f.archive.get(f.scope,period.start));
  assert.equal(f.archive.get(f.scope,period.start).state,'archived');
 }finally{f.close();}
});
test('incomplete archive resumes without model and never deletes modified backup',()=>{
 let calls=0;const f=fixture(stage=>{if(stage==='weekly-daily-moved'&&++calls===1)throw Error('simulated restart');});
 try{
  const entries=dates.map(day=>{f.diary(day);return f.archive.inspectDaily(f.cwd,day);});
  f.publish();const row=f.archive.prepare(f.cwd,f.scope,period,f.report,entries);
  assert.throws(()=>f.archive.resume(f.cwd,row),/simulated restart/);
  f.archive.recoverAll({acquire:()=>()=>{}});
  assert.equal(f.archive.get(f.scope,period.start).state,'archived');
  f.db.prepare('UPDATE memory_weekly_archives SET retention_until=0').run();
  fs.appendFileSync(f.backup(dates[0]),'用户加注');
  f.archive.clean(f.cwd,f.scope);
  assert(fs.existsSync(f.backup(dates[0])));assert(fs.existsSync(f.backup(dates[1])));
  assert.match(f.archive.get(f.scope,period.start).note,/人工修改/);
 }finally{f.close();}
});
