import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {authorizedRecallScope,recallForSession} from '../recall-context.js';
import {ownerChannelAuthorized,channelSessionIds} from '../source-boundary.js';
import {schema} from '../config.js';
// Host-dependent Memory is imported only when the integration test runs.

test('verified owner DMs and durable groups auto-recall from the same workspace; strangers cannot',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-owner-recall-'));
 fs.mkdirSync(path.join(cwd,'channel-core'));
 const db=new DatabaseSync(path.join(cwd,'channel-core','state.sqlite'));
 db.exec('CREATE TABLE bindings(session_id TEXT);CREATE TABLE receipts(session_id TEXT);CREATE TABLE archived_dm_sessions(session_id TEXT, record TEXT, created_at INTEGER)');
 db.prepare('INSERT INTO archived_dm_sessions VALUES(?,?,?)').run('archived-owner','{}',Date.now());
 for(const session of ['owner-discord','owner-feishu','group','stranger'])db.prepare('INSERT INTO bindings VALUES(?)').run(session);
 db.close();
 const liveDb=new DatabaseSync(path.join(cwd,'channel-core','state.sqlite'),{readOnly:true});
 try{
  const conf={...schema.defaults,enabled:true,recall:true,ownerIdentityId:'my-owner',agentPreset:'agent',workspace:cwd};
  const channel={store:{db:liveDb},trustedMemorySession(id,owner){return ['owner-discord','owner-feishu'].includes(id)&&owner==='my-owner'},sharedGroupMemorySession:id=>id==='group'};
  const ctx={dshHomePath:(...parts)=>path.join(cwd,...parts),get:name=>name==='channelCore'?channel:name==='sessionProjections'?{stateOf:()=> 'agent'}:null};
  const fact={id:'x',text:'PageLingo 继续使用 Bergamot',topic:'PageLingo',tags:['PageLingo'],sources:[{sessionId:'known',seq:3}],confirmed:1};
  for(const id of ['owner-discord','owner-feishu','group']){
   const session={id,header:{cwd,agentPreset:'agent'},surface:{nodes:[0]},eventAt:()=>({type:'user/message',data:{content:[{type:'text',text:'PageLingo'}]}})};
   assert.equal(authorizedRecallScope(session,ctx,conf),true);
   assert.equal(recallForSession({recalledCandidates:()=>[fact]},ctx,session,conf)[0]?.id,'x');
  }
  for(const id of ['stranger']){
   const session={id,header:{cwd,agentPreset:'agent'}};
   assert.equal(authorizedRecallScope(session,ctx,conf),false);
  }
  assert.equal(ownerChannelAuthorized(ctx,'owner-discord',{...conf,ownerIdentityId:''}),false);
  assert.equal(ownerChannelAuthorized(ctx,'group',{...conf,ownerIdentityId:''}),true,'group sharing is independent of owner DM identity');
  assert.equal(ownerChannelAuthorized(ctx,'stranger',conf),false);
  assert.equal(channelSessionIds(ctx).has('owner-discord'),true);
  assert.equal(channelSessionIds(ctx).has('archived-owner'),true,'archived channel session remains private without active binding or receipts');
  const writer=new DatabaseSync(path.join(cwd,'channel-core','state.sqlite'));
  writer.prepare('DELETE FROM bindings WHERE session_id=?').run('owner-discord');
  writer.close();
  assert.equal(channelSessionIds(ctx).has('owner-discord'),false,'live connection must not cache old bindings');
  assert.equal(channelSessionIds(ctx).has('archived-owner'),true,'historic channel provenance survives binding removal');
 }finally{liveDb.close();fs.rmSync(cwd,{force:true,recursive:true});}
});

test('identity settings are opt-in, validated, and do not enable background Dream',()=>{
 const original={...schema.defaults};delete original.ownerIdentityId;delete original.incremental;delete original.memoryReviewDays;
 const updated=schema.validate(original);
 assert.equal(updated.ownerIdentityId,'owner');assert.equal(updated.incremental,true);
 assert.equal(updated.automatic,original.automatic);
 assert.equal(updated.memoryReviewDays,180);
 assert.equal(schema.validate({...updated,ownerIdentityId:'my-owner'}).ownerIdentityId,'my-owner');
 assert.throws(()=>schema.validate({...updated,ownerIdentityId:'bad owner id'}));
});

test('settings no longer ask for a second channel owner identity',(t)=>{
 const config=JSON.parse(fs.readFileSync(new URL('../config.example.json',import.meta.url),'utf8'));
 const sharedPages=new URL("../../_shared/plugin-settings/pages.json",import.meta.url);
 if(fs.existsSync(sharedPages)){
  const pages=JSON.parse(fs.readFileSync(sharedPages,'utf8'));
  const fields=pages['dsh-memory-dreaming'].fields;
  assert.equal(fields.filter(row=>row.key==='ownerIdentityId').length,0);
 }else t.diagnostic('Shared settings UI generator is tested in the monorepo; standalone plugin checks effective defaults.');
 assert.equal(config.ownerIdentityId,'owner','generated example must not accidentally disable owner recognition');
 assert.equal(schema.validate(config).ownerIdentityId,'owner','effective default stays compatible with Channel Core');
 assert.equal(schema.validate({...config,ownerIdentityId:'custom-owner'}).ownerIdentityId,'custom-owner','existing advanced identity mappings remain valid');
});

test('draft collection accepts group input but not unverified private chat',async(t)=>{
 let Memory;
 try{({Memory}=await import('../memory.js'));}
 catch(error){if(error.code==='ERR_MODULE_NOT_FOUND'){t.skip('Native DSH peer services not installed in standalone CI');return;}throw error;}
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-group-memory-'));
 const folder=path.join(cwd,'channel-core');fs.mkdirSync(folder);
 const db=new DatabaseSync(path.join(folder,'state.sqlite'));
 try{
  db.exec('CREATE TABLE bindings(session_id TEXT);CREATE TABLE receipts(session_id TEXT);CREATE TABLE archived_dm_sessions(session_id TEXT)');
  for(const id of ['group','stranger','owner'])db.prepare('INSERT INTO bindings VALUES(?)').run(id);
  const core={store:{db},sharedGroupMemorySession:id=>id==='group',trustedMemorySession:(id,owner)=>id==='owner'&&owner==='owner'};
  const sessions=['group','stranger','owner'].map(id=>({header:{id,cwd,origin:'discord'}}));
  const event=id=>({seq:1,time:Date.now(),type:'user/message',surfaceOp:'append',data:{content:[{type:'text',text:'Example from '+id}]}});
  const ctx={
   get:name=>name==='channelCore'?core:null,
   dshHomePath:(...p)=>path.join(cwd,...p),
   sessionQuery:{
    listSessions:async()=>sessions,
    observeSession:async id=>({events:[event(id)],inheritedEventCount:0,[Symbol.dispose]() {}}),
   },
  };
  const mock={ctx,getConfig:()=>({...schema.defaults,incremental:false,candidateDays:7}),scope:()=> 'scope',db:{prepare:()=>({get:()=>null})}};
  const sources=await Memory.prototype.collect.call(mock,cwd,undefined,{kind:'daily'});
  assert.deepEqual(sources.map(item=>item.sessionId).sort(),['group','owner']);
  assert(sources.find(item=>item.sessionId==='group')?.channel);
 }finally{db.close();fs.rmSync(cwd,{force:true,recursive:true});}
});
