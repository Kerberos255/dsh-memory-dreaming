
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {attachAutoRecall} from '../recall-context.js';

test('agent prompt hook injects only a small trusted published section and caches repeated steps',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-recall-assembly-'));
 let listener,registered=0,reads=0;
 const events=[{type:'user/message',data:{content:[{type:'text',text:'PageLingo 翻译'}]}}];
 const agent={session:{id:'local-session',header:{cwd:root,agentPreset:'agent'},surface:{nodes:[0]},eventAt:i=>events[i]},
  ctx:{inject(names,callback){assert.deepEqual(names,['systemPrompt']);callback({
    effect(fn){const dispose=fn();if(dispose)assert.equal(typeof dispose,'function')},
    systemPrompt:{section(o){registered++;assert.equal(o.name,'memory:trusted-recall');return()=>{};}},
    on(event,handler){assert.equal(event,'system-prompt/assemble');listener=handler;}
  });}}};
 const config={enabled:true,recall:true,autoRecall:true,agentPreset:'agent',workspace:root,autoRecallMaxItems:3,autoRecallMaxChars:1200};
 const owner={configFile:{value:config,revision:1},memory:{recalledCandidates(){reads++;return [{
   id:'p1',text:'PageLingo 采用 Bergamot 和 API 翻译',topic:'PageLingo 翻译',tags:['PageLingo'],confirmed:12345,sources:[{sessionId:'old-session',seq:42}]
 }];}}};
 const original={sections:[{name:'memory:trusted-recall',text:''},{name:'base',text:'Preserve original'}]};
 try{
  attachAutoRecall(agent,owner,{get:()=>null});
  assert.equal(registered,1);
  const result=await listener(null,{agent},async()=>original);
  assert.match(result.sections[0].text,/PageLingo/);
  assert.match(result.sections[0].text,/old-session#42/);
  assert.equal(result.sections[1].text,'Preserve original');
  assert.equal(original.sections[0].text,'');
  await listener(null,{agent},async()=>original);
  assert.equal(reads,1);
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
