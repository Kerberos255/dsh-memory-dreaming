import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {ownerChannelAuthorized} from '../source-boundary.js';
import {authorizedRecallScope,recallForSession} from '../recall-context.js';

test('durable group origin grants scoped recall while private strangers remain isolated',()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-public-group-recall-'));
 const db=new DatabaseSync(':memory:');
 try{
  db.exec('CREATE TABLE bindings(session_id TEXT,kind TEXT);CREATE TABLE receipts(session_id TEXT)');
  for(const [id,kind] of [['group','group'],['stranger','dm'],['owner-dm','dm']])
   db.prepare('INSERT INTO bindings VALUES(?,?)').run(id,kind);
  const core={
   store:{db},
   sharedGroupMemorySession:id=>db.prepare("SELECT 1 FROM bindings WHERE session_id=? AND kind='group'").get(id)!==undefined,
   trustedMemorySession:(id,owner)=>id==='owner-dm'&&owner==='owner',
  };
  const ctx={
   dshHomePath:(...parts)=>path.join(cwd,...parts),
   get:name=>name==='channelCore'?core:name==='sessionProjections'?{stateOf:()=> 'agent'}:null,
  };
  const config={enabled:true,recall:true,autoRecall:true,ownerIdentityId:'owner',agentPreset:'agent',workspace:cwd,autoRecallMaxItems:3,autoRecallMaxChars:1200};
  const makeSession=id=>({
   id,header:{cwd,agentPreset:'agent'},
   surface:{nodes:[0]},eventAt:()=>({type:'user/message',data:{content:[{type:'text',text:'example topic'}]}}),
  });
  const fact={id:'published',text:'Example topic is retained',topic:'example topic',tags:['example'],sources:[{sessionId:'known',seq:3}],confirmed:1};
  for(const id of ['group','owner-dm']){
   assert.equal(ownerChannelAuthorized(ctx,id,config),true);
   assert.equal(authorizedRecallScope(makeSession(id),ctx,config),true);
   assert.equal(recallForSession({recalledCandidates:()=>[fact]},ctx,makeSession(id),config)[0]?.id,'published');
  }
  assert.equal(ownerChannelAuthorized(ctx,'stranger',config),false);
  assert.equal(authorizedRecallScope(makeSession('stranger'),ctx,config),false);
  assert.equal(authorizedRecallScope(makeSession('group'),ctx,{...config,workspace:os.tmpdir()}),false);
  db.prepare("UPDATE bindings SET kind='dm' WHERE session_id='group'").run();
  assert.equal(ownerChannelAuthorized(ctx,'group',config),false,'revoked binding must lose permission immediately');
  assert.equal(authorizedRecallScope(makeSession('group'),ctx,config),false);
 }finally{db.close();fs.rmSync(cwd,{force:true,recursive:true});}
});
