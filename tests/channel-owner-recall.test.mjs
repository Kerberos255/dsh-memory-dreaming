import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {authorizedRecallScope,recallForSession} from '../recall-context.js';
import {ownerChannelAuthorized,channelSessionIds} from '../source-boundary.js';
import {schema} from '../config.js';

test('verified owner channel can auto-recall from the same workspace; groups/others cannot',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-owner-recall-'));
 fs.mkdirSync(path.join(cwd,'channel-core'));
 const db=new DatabaseSync(path.join(cwd,'channel-core','state.sqlite'));
 db.exec('CREATE TABLE bindings(session_id TEXT);CREATE TABLE receipts(session_id TEXT)');
 for(const session of ['owner-discord','owner-feishu','group','stranger'])db.prepare('INSERT INTO bindings VALUES(?)').run(session);
 db.close();
 const liveDb=new DatabaseSync(path.join(cwd,'channel-core','state.sqlite'),{readOnly:true});
 try{
  const conf={...schema.defaults,enabled:true,recall:true,ownerIdentityId:'my-owner',agentPreset:'agent',workspace:cwd};
  const channel={store:{db:liveDb},trustedMemorySession(id,owner){return ['owner-discord','owner-feishu'].includes(id)&&owner==='my-owner'}};
  const ctx={dshHomePath:(...parts)=>path.join(cwd,...parts),get:name=>name==='channelCore'?channel:name==='sessionProjections'?{stateOf:()=> 'agent'}:null};
  const fact={id:'x',text:'PageLingo 继续使用 Bergamot',topic:'PageLingo',tags:['PageLingo'],sources:[{sessionId:'known',seq:3}],confirmed:1};
  for(const id of ['owner-discord','owner-feishu']){
   const session={id,header:{cwd,agentPreset:'agent'},surface:{nodes:[0]},eventAt:()=>({type:'user/message',data:{content:[{type:'text',text:'PageLingo'}]}})};
   assert.equal(authorizedRecallScope(session,ctx,conf),true);
   assert.equal(recallForSession({recalledCandidates:()=>[fact]},ctx,session,conf)[0]?.id,'x');
  }
  for(const id of ['group','stranger']){
   const session={id,header:{cwd,agentPreset:'agent'}};
   assert.equal(authorizedRecallScope(session,ctx,conf),false);
  }
  assert.equal(ownerChannelAuthorized(ctx,'owner-discord',{...conf,ownerIdentityId:''}),false);
  assert.equal(channelSessionIds(ctx).has('owner-discord'),true);
  const writer=new DatabaseSync(path.join(cwd,'channel-core','state.sqlite'));
  writer.prepare('DELETE FROM bindings WHERE session_id=?').run('owner-discord');
  writer.close();
  assert.equal(channelSessionIds(ctx).has('owner-discord'),false,'live connection must not cache old bindings');
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
