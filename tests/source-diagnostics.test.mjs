import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Memory,localDay} from '../memory.js';
import {schema} from '../config.js';

function prepare({verified=true,time=Date.now(),surfaceOp='append',messageType='user/message',body='Discord 聊天中的重要项目决策'}={}){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-discord-memory-'));
 const config={...schema.defaults,agentPreset:'agent',timeZone:'Asia/Shanghai',incremental:true};
 const events=[{seq:0,time,type:messageType,surfaceOp,data:{content:[{type:'text',text:body}],source:{kind:'channel'}}}];
 const ctx={dshHomePath:(...parts)=>path.join(cwd,'home',...parts),
  get:(name)=>name==='channelCore'?{trustedMemorySession:()=>verified}:undefined,
  sessionQuery:{
   async listSessions(){return [{header:{id:'session-discord',cwd,origin:'discord'}}];},
   async observeSession(){return {events,inheritedEventCount:0,[Symbol.dispose](){}};}
  }};
 const memory=new Memory(path.join(cwd,'state.sqlite'),ctx,()=>config);
 return {cwd,memory,events,config,async close(){await memory.close();fs.rmSync(cwd,{recursive:true,force:true});}};
}

test('verified Discord owner messages are accepted by Dream daily regardless of preset',async()=>{
 const h=prepare();
 try{
  const stats={};
  const msgs=await h.memory.collect(h.cwd,undefined,{kind:'daily',day:localDay(Date.now(),'Asia/Shanghai'),diagnostics:stats});
  assert.equal(msgs.length,1);
  assert.equal(stats.workspaceSessions,1);
  assert.equal(stats.untrustedChannels,0);
 }finally{await h.close();}
});
test('unverified Discord messages remain excluded and a manual run explains identity rejection',async()=>{
 const h=prepare({verified:false});
 try{
  const r=await h.memory.run(h.cwd,'daily');
  assert.equal(r.empty,true);
  assert.equal(r.emptyReason,'channel-untrusted');
  assert.match(r.message,/主人身份/);
  assert.equal(r.sourceDiagnostics.untrustedChannels,1);
 }finally{await h.close();}
});
test('yesterday Discord messages are not silently described as missing conversations',async()=>{
 const h=prepare({time:Date.now()-36*3600000});
 try{
  const r=await h.memory.run(h.cwd,'daily');
  assert.equal(r.empty,true);
  assert.equal(r.emptyReason,'outside-day');
  assert.match(r.message,/不在本次日期范围/);
  assert.equal(r.sourceDiagnostics.dateExcluded,1);
 }finally{await h.close();}
});
test('non-user events have a separate diagnostic reason',async()=>{
 const h=prepare({messageType:'user/message',surfaceOp:'replace'});
 try{
  const r=await h.memory.run(h.cwd,'daily');
  assert.equal(r.empty,true);
  assert.equal(r.emptyReason,'not-user-input');
  assert.equal(r.sourceDiagnostics.otherMessage,1);
 }finally{await h.close();}
});

test('already processed Discord messages explain incremental deduplication',async()=>{
 const h=prepare();
 try{
  h.memory.db.prepare('INSERT INTO memory_processed_sources(scope,kind,session,seq,processed_at) VALUES(?,?,?,?,?)')
   .run(h.memory.scope(h.cwd),'daily','session-discord',0,Date.now());
  const r=await h.memory.run(h.cwd,'daily');
  assert.equal(r.emptyReason,'already-processed');
  assert.match(r.message,/增量模式/);
 }finally{await h.close();}
});
