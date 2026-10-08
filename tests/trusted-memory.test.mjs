import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Memory } from '../memory.js';
import { schema } from '../config.js';

test('empty publication file skips metadata and provenance lookups',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-no-published-'));
 try{
  const mock={db:{prepare(){throw new Error('DB must not be queried without MEMORY.md');}},scope(){throw new Error('scope not required');}};
  assert.deepEqual(Memory.prototype.recalledCandidates.call(mock,root),[]);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('old published facts remain recallable, pending flood cannot suppress them',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-recall-promoted-'));
 const id='old-stable',text='用户喜欢保持 PageLingo 的简洁架构';
 const published='-'+text,entry='<!-- dsh-memory:'+id+' -->\n'+published+'\n<!-- /dsh-memory:'+id+' -->';
 fs.writeFileSync(path.join(root,'MEMORY.md'),entry+'\n');
 const rows=[{id,state:'promoted',published,text,tags:'["PageLingo"]',confirmed:Date.now()-365*86400000}];
 let forgotten=[];
 const mock={
  getConfig:()=>({...schema.defaults,maxCandidates:1,candidateDays:7}),
  ctx:{dshHomePath:()=>path.join(root,'missing-channel.sqlite')},
  scope:()=> 'scope',
  sources:()=>[{sessionId:'verified-old',seq:9}],
  candidates:()=>{throw Error('pending candidate list must not be used')},
  db:{prepare(sql){return {get(){if(sql.includes('FROM memory_fact_versions'))return undefined;throw Error('unexpected get '+sql)},all(...args){if(sql.includes('FROM forgotten'))return forgotten;if(sql.includes('FROM candidates')){assert.match(sql,/state='promoted'/);return rows;}throw Error('unexpected query')}}}}
 };
 try{
   assert.equal(Memory.prototype.recalledCandidates.call(mock,root)[0].id,id);
   forgotten=[{session:'verified-old'}];
   assert.deepEqual(Memory.prototype.recalledCandidates.call(mock,root),[]);
   forgotten=[];
   fs.writeFileSync(path.join(root,'MEMORY.md'),'Externally deleted the memory block');
   assert.deepEqual(Memory.prototype.recalledCandidates.call(mock,root),[]);
 }finally{fs.rmSync(root,{force:true,recursive:true});}
});
test('legacy memory schema reads new optional auto recall defaults without changing scheduled jobs',()=>{
 const before={...schema.defaults};
 delete before.autoRecall;delete before.autoRecallMaxItems;delete before.autoRecallMaxChars;
 const updated=schema.validate(before);
 assert.equal(updated.automatic,before.automatic);
 assert.equal(updated.autoRecall,true);
 assert.equal(updated.autoRecallMaxItems,3);
 assert.equal(updated.autoRecallMaxChars,1200);
 assert.throws(()=>schema.validate({...updated,autoRecallMaxItems:0}));
 assert.throws(()=>schema.validate({...updated,autoRecallMaxChars:8000}));
});
