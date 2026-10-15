
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {attachAutoRecall} from '../recall-context.js';

test('agent prompt hook injects only a small trusted published section and revalidates repeated steps',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-recall-assembly-'));
 let listener,registered=0,reads=0,visible=true;
 const events=[{type:'user/message',data:{content:[{type:'text',text:'PageLingo 翻译'}]}}];
 const agent={session:{id:'local-session',header:{cwd:root,agentPreset:'agent'},surface:{nodes:[0]},eventAt:i=>events[i]},
  ctx:{inject(names,callback){assert.deepEqual(names,['systemPrompt']);callback({
    effect(fn){const dispose=fn();if(dispose)assert.equal(typeof dispose,'function')},
    systemPrompt:{section(o){registered++;assert.equal(o.name,'memory:trusted-recall');return()=>{};}},
    on(event,handler){assert.equal(event,'system-prompt/assemble');listener=handler;}
  });}}};
 const config={enabled:true,recall:true,autoRecall:true,agentPreset:'agent',workspace:root,autoRecallMaxItems:3,autoRecallMaxChars:1200};
 const owner={configFile:{value:config,revision:1},memory:{recalledCandidates(){reads++;return visible?[{
   id:'p1',text:'PageLingo 采用 Bergamot 和 API 翻译',topic:'PageLingo 翻译',tags:['PageLingo'],confirmed:12345,sources:[{sessionId:'old-session',seq:42}]
 }]:[];}}};
 const original={sections:[{name:'memory:trusted-recall',text:''},{name:'base',text:'Preserve original'}]};
 try{
  attachAutoRecall(agent,owner,{get:()=>null});
  assert.equal(registered,1);
  const result=await listener(null,{agent},async()=>original);
  assert.match(result.sections[0].text,/PageLingo/);
  assert.match(result.sections[0].text,/old-session#42/);
  assert.equal(result.sections[1].text,'Preserve original');
  assert.equal(original.sections[0].text,'');
  visible=false; // A fact removed from MEMORY.md must disappear even for the same query.
  const refreshed=await listener(null,{agent},async()=>original);
  assert.equal(refreshed.sections[0].text,'');
  assert(reads>=2,'every assemble rechecks published facts and permissions');
  owner.configFile.value={...config,autoRecall:false};
  owner.configFile.revision++;
  const disabled=await listener(null,{agent},async()=>original);
  assert.equal(disabled.sections[0].text,'');
 }finally{fs.rmSync(root,{recursive:true,force:true})}
});

test('assembly without target section does not change unrelated prompt carriers',async()=>{
 let callback;
 const agent={ctx:{inject(_keys,fn){fn({effect:fn=>fn(),systemPrompt:{section:()=>()=>{}},on:(_event,fn)=>callback=fn})}}};
 attachAutoRecall(agent,{configFile:{value:{}},memory:{}},{get:()=>null});
 const assembly={sections:[{name:'other',text:'untouched'}]};
 assert.equal(await callback(null,{agent},async()=>assembly),assembly);
});

test('status question automatically injects dated task observations but never promotes them to verified facts',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-task-recall-'));
 let listener,visible=true;
 const query='PageLingo 嵌套标签修好了吗';
 const agent={session:{id:'local-session',header:{cwd:root,agentPreset:'agent'},
  surface:{nodes:[0]},eventAt:()=>({type:'user/message',data:{content:[{type:'text',text:query}]}})},
  ctx:{inject(_names,callback){callback({
   effect:fn=>fn(),systemPrompt:{section:()=>()=>{}},on:(_event,fn)=>listener=fn
  });}}};
 const config={enabled:true,recall:true,autoRecall:true,taskTracking:true,
  agentPreset:'agent',workspace:root,autoRecallMaxItems:3,autoRecallMaxChars:1200};
 const owner={configFile:{value:config,revision:1},memory:{
  recalledCandidates:()=>[],
  taskSearch:()=>visible?[{project:'PageLingo',task:'嵌套标签问题',status:'completed',
   history:[{time:Date.parse('2026-10-12T00:00:00Z'),sessionId:'owner',seq:12,quote:'PageLingo 嵌套标签已经修好了。'}]}]:[]
 }};
 const assembly={sections:[{name:'memory:trusted-recall',text:''}]};
 try{
  attachAutoRecall(agent,owner,{get:()=>null});
  const text=(await listener(null,{agent},async()=>assembly)).sections[0].text;
  assert.match(text,/历史观察/);assert.match(text,/PageLingo/);
  assert.match(text,/并非实时完成证明/);assert.match(text,/owner#12/);
  visible=false;
  assert.equal((await listener(null,{agent},async()=>assembly)).sections[0].text,'');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
