import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startManualMemory} from '../manual-run.js';
import {maintenanceSession} from '../workflows.js';

function harness(){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-memory-manual-'));
 const config={agentPreset:'agent',timeZone:'Asia/Shanghai'};
 const sid=maintenanceSession(cwd,'agent'),calls=[],records=[],errors=[];
 const registry={archivedSessionIds:[],list(){return[{id:'workspace-fixture',path:cwd}]},async unarchiveSession(id){this.archivedSessionIds=this.archivedSessionIds.filter(x=>x!==id);calls.push(['unarchive',id]);}};
 const ctx={get(key){return key==='workspaceRegistry'?registry:null;},sessionQuery:{async observeSession(){return{header:{title:'Existing maintenance title'},events:[],[Symbol.dispose](){}};}}};
 const memory={getConfig:()=>config,scope:()=>cwd,running:new Map()};
 let busy=false;
 const ledger={hasActive:()=>busy,admitManual:id=>calls.push(['admitted',id]),queueManual(_cwd,preset,kind,id,prompt,day){assert.equal(preset,'agent');assert.equal(_cwd,cwd);busy=true;const entry={id,kind,prompt,day};records.push(entry);return entry;},set:(id,state,note)=>errors.push({id,state,note})};
 const controller={async create(request){calls.push(['create',request]);return {sessionId:sid};},async prompt(request,signal){
  // Match the official DSH Session Controller: signal is a required second argument.
  signal.throwIfAborted();calls.push(['prompt',request,signal]);return{accepted:true};
 }};
 const start=(kind='daily',options={})=>startManualMemory(memory,ledger,ctx,controller,cwd,kind,{signal:new AbortController().signal,...options});
 return{cwd,config,sid,ledger,controller,calls,records,errors,registry,memory,start,close(){fs.rmSync(cwd,{recursive:true,force:true});}};
}

test('manual memory is admitted to same native Session as schedules, not memory.run directly',async()=>{
 const h=harness();
 try{
  const result=await h.start('daily',{day:'2026-10-09'});
  assert.equal(result.started,true);assert.equal(result.sessionId,h.sid);
  assert.equal(h.calls.length,3);
  assert.deepEqual(h.calls[0][1],{sessionId:h.sid,workspaceId:'workspace-fixture',agentPreset:'agent'});
  const request=h.calls[1][1];
  assert.equal(request.sessionId,h.sid);assert.match(request.content[0].text,/手动记忆整理/);
  assert.match(request.content[0].text,/kind=daily/);
  assert.equal(h.records[0].prompt,request.content[0].text);
  assert.equal(request.requestId,h.records[0].id);
  assert.equal(request.mode,'queue');
  assert(h.calls[1][2] instanceof AbortSignal,'native prompt receives caller AbortSignal as second positional argument');
  await assert.rejects(h.start('dream'),/已有记忆整理任务/);
 }finally{h.close();}
});

test('manual request restores a previously archived managed Session before native admission',async()=>{
 const h=harness();
 try{
  h.registry.archivedSessionIds=[h.sid,'other-session'];
  await h.start('dream');
  assert.deepEqual(h.calls.map(x=>x[0]),['create','unarchive','prompt','admitted']);
  assert.deepEqual(h.registry.archivedSessionIds,['other-session']);
 }finally{h.close();}
});

test('a rejected native prompt is recorded as failed, not presented as a running memory job',async()=>{
 const h=harness();
 try{
  h.controller.prompt=async()=>{throw Error('native agent busy');};
  await assert.rejects(h.start('weekly'),/native agent busy/);
  assert.equal(h.errors[0].state,'failed');
  assert.match(h.errors[0].note,/投递至原生 Session 失败/);
 }finally{h.close();}
});

test('no native Session service means no direct LLM or memory execution',async()=>{
 const h=harness();
 try{
  await assert.rejects(startManualMemory(h.memory,h.ledger,{...h, get:()=>null},null,h.cwd,'dream',{}),/接口尚未就绪/);
  assert.equal(h.records.length,0);
 }finally{h.close();}
});

test('aborted manual admission never calls native create or prompt or records a workflow',async()=>{
 const h=harness();
 try{
  const abort=new AbortController();abort.abort();
  await assert.rejects(h.start('daily',{signal:abort.signal}));
  assert.equal(h.calls.length,0);
  assert.equal(h.records.length,0);
 }finally{h.close();}
});

test('manual admission forwards the identical caller signal to native Session prompt',async()=>{
 const h=harness();
 try{
  const abort=new AbortController();
  await h.start('dream',{signal:abort.signal,day:'2026-10-09'});
  const prompt=h.calls.find(([name])=>name==='prompt');
  assert.equal(prompt[2],abort.signal);
 }finally{h.close();}
});
