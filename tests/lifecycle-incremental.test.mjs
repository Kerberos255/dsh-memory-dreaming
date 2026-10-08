import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {Memory} from '../memory.js';
import {schema} from '../config.js';
import {initLifecycle,publishVersion,forgetVersion,versionOf,reviewStatus,memoryTopics} from '../lifecycle.js';
import {channelSessionIds,publicMemorySourceAllowed} from '../source-boundary.js';

test('fact revision timeline supersedes an old topic and retains its origin',()=>{
 const db=new DatabaseSync(':memory:');initLifecycle(db);
 const older={id:'a',topic:'project-router',confirmed:100,created:80};
 const newer={id:'b',topic:'project-router',confirmed:300,created:250};
 publishVersion(db,'scope',older,[],150);
 publishVersion(db,'scope',newer,[older],400);
 const a=versionOf(db,'scope',older),b=versionOf(db,'scope',newer);
 assert.equal(a.validUntil,400);
 assert.equal(a.supersededBy,'b');
 assert.equal(b.validUntil,null);
 assert.deepEqual(b.supersedes,['a']);
 assert.equal(reviewStatus(b,180,500).reviewDue,false);
 assert.equal(reviewStatus(b,30,400+31*86400000).reviewDue,true);
 forgetVersion(db,'scope','b',600);
 assert.equal(versionOf(db,'scope',newer).reason,'forgotten');
 assert.equal(versionOf(db,'scope',newer).validUntil,600);
 db.close();
});

test('topic navigation is a bounded view, not another raw transcript',()=>{
 const facts=[
  {id:'a',topic:'PageLingo',text:'Bergamot 与 API 两条翻译路线',confirmed:3},
  {id:'b',topic:'PageLingo',text:'未启用本地 2B 模型',confirmed:5},
  {id:'c',topic:'DSH',text:'合并 Discord/Feishu Channel Core',confirmed:6},
 ];
 const topics=memoryTopics(facts,{maxEntries:1});
 assert.equal(topics.length,2);
 assert.equal(topics.find(x=>x.topic==='PageLingo').count,2);
 assert.equal(topics.find(x=>x.topic==='PageLingo').examples.length,1);
});

test('channel provenance survives plugin unloading, and rejects workspace-shared private data',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-channel-provenance-'));
 const directory=path.join(root,'channel-core');fs.mkdirSync(directory);
 const db=new DatabaseSync(path.join(directory,'state.sqlite'));
 db.exec('CREATE TABLE bindings(session_id TEXT);CREATE TABLE receipts(session_id TEXT)');
 db.prepare('INSERT INTO receipts VALUES(?)').run('discord-old-session');
 db.prepare('INSERT INTO bindings VALUES(?)').run('feishu-active-session');
 db.close();
 try{
  const ctx={dshHomePath:(...parts)=>path.join(root,...parts)};
  const ids=channelSessionIds(ctx);
  assert(ids.has('discord-old-session'));
  assert(ids.has('feishu-active-session'));
  assert.equal(publicMemorySourceAllowed('discord-old-session',ids,{}),false);
  assert.equal(publicMemorySourceAllowed('unlinked',ids,{origin:'feishu'}),false);
  assert.equal(publicMemorySourceAllowed('local',ids,{origin:'desktop'}),true);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('incremental Dream processes only accepted events; failed run leaves cursor unchanged',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-dream-incremental-'));
 const config={...schema.defaults,automatic:false,incremental:true};
 let events=[{
   seq:0,type:'user/message',surfaceOp:'append',time:Date.now(),
   data:{content:[{type:'text',text:'项目继续使用 Bergamot 和 API'}]}
 }];
 const ctx={
  dshHomePath:(...parts)=>path.join(root,'dsh-home',...parts),
  sessionQuery:{
   listSessions:async()=>[{header:{id:'session-A',cwd:root,agentPreset:'agent'}}],
   observeSession:async()=>({header:{id:'session-A',cwd:root},projections:{values:{agentPreset:'agent'}},
     events,inheritedEventCount:0,[Symbol.dispose](){} })
  }
 };
 const memory=new Memory(path.join(root,'state.sqlite'),ctx,()=>config);
 const seen=[];
 memory.completion=async(_cwd,kind,sources)=>{seen.push(sources.map(x=>x.seq));return {facts:[],sources,dream:''};};
 try{
  const first=await memory.run(root,'dream',{day:'2026-10-08'});
  assert.equal(first.state,'completed');
  assert.deepEqual(seen,[[0]]);
  assert.equal(memory.db.prepare('SELECT COUNT(*) as n FROM memory_processed_sources').get().n,1);
  const second=await memory.run(root,'dream',{day:'2026-10-08'});
  assert.equal(second.empty,true);
  assert.deepEqual(seen,[[0]]);
  events=[...events,{...events[0],seq:1,data:{content:[{type:'text',text:'新版增加了词语检索'}]}}];
  memory.completion=async()=>{throw Error('model unavailable');};
  await assert.rejects(memory.run(root,'dream',{day:'2026-10-08'}),/model unavailable/);
  assert.equal(memory.db.prepare('SELECT COUNT(*) as n FROM memory_processed_sources').get().n,1);
  memory.completion=async(_cwd,kind,sources)=>{seen.push(sources.map(x=>x.seq));return{facts:[],sources,dream:''};};
  await memory.run(root,'dream',{day:'2026-10-08'});
  assert.deepEqual(seen,[[0],[1]]);
  assert.equal(memory.db.prepare('SELECT COUNT(*) as n FROM memory_processed_sources').get().n,2);
 }finally{await memory.close();fs.rmSync(root,{recursive:true,force:true});}
});
