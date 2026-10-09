import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {lexicalScore,selectTrustedRecall,rankMemoryMatches,latestUserQuery,isUntrustedChannel,authorizedRecallScope,renderTrustedRecall,recallForSession} from '../recall-context.js';

const facts=[
 {id:'pagelingo',text:'PageLingo 的翻译模块现在采用 Bergamot 与 API 两路架构',topic:'pagelingo-architecture',tags:['PageLingo'],confirmed:1000,sources:[{sessionId:'old-p',seq:33}]},
 {id:'dsh',text:'DSH 渠道已把 Discord 和飞书合到 Core',topic:'dsh-channel',tags:['DSH'],confirmed:2000,sources:[{sessionId:'old-d',seq:90}]},
 {id:'other',text:'养了一只可爱的边牧',topic:'pet',tags:['边牧'],confirmed:3000,sources:[{sessionId:'old-q',seq:2}]}
];
test('keyword ranks matching published facts and excludes unrelated memories',()=>{
 assert(lexicalScore('PageLingo 翻译',facts[0])>lexicalScore('PageLingo 翻译',facts[1]));
 const found=selectTrustedRecall('上次 PageLingo 翻译架构',facts);
 assert.deepEqual(found.map(x=>x.id),['pagelingo']);
 assert.equal(found[0].source[0].sessionId,'old-p');
});
test('small bounded recall and no raw transcript injection',()=>{
 const found=selectTrustedRecall('DSH Discord 飞书',facts,{maxItems:1,maxChars:1200});
 assert.equal(found.length,1);assert.equal(found[0].id,'dsh');
 assert(!renderTrustedRecall(found).includes('user/message'));
 assert.deepEqual(selectTrustedRecall('',facts),[]);
 assert.deepEqual(selectTrustedRecall('DSH',facts,{maxChars:10}),[]);
});
test('latest user message is extracted from current native session surface',()=>{
 const events=[{type:'user/message',data:{content:[{type:'text',text:'之前 PageLingo 的架构？'}]}},{type:'assistant/message',data:{}},{type:'user/message',data:{content:[{type:'text',text:'DSH Discord 怎么样'}]}}];
 const session={surface:{nodes:[0,1,2]},eventAt:i=>events[i]};
 assert.equal(latestUserQuery(session),'DSH Discord 怎么样');
});
test('channel session cannot auto recall another person shared workspace memories',()=>{
 const ctx={get:name=>name==='channelCore'?{store:{db:{prepare:sql=>({get:id=>id==='channel-1'?{yes:1}:null})}}}:name==='sessionProjections'?{stateOf:()=> 'agent'}:null};
 const session={id:'channel-1',header:{cwd:process.cwd(),agentPreset:'agent'}};
 assert.equal(isUntrustedChannel(ctx,session),true);
 assert.equal(authorizedRecallScope(session,ctx,{enabled:true,recall:true,autoRecall:true,agentPreset:'agent',workspace:''}),false);
});
test('non-channel scope is same-workspace across presets, opt-in and idempotently sourced',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-memory-recall-'));
 try{
  const session={id:'desktop',header:{cwd:dir,agentPreset:'agent'},surface:{nodes:[0]},eventAt:()=>({type:'user/message',data:{content:[{type:'text',text:'PageLingo 翻译'}]}})};
  const ctx={get:()=>null};
  const cfg={enabled:true,recall:true,autoRecall:true,agentPreset:'agent',workspace:dir,autoRecallMaxItems:3,autoRecallMaxChars:1200};
  assert.equal(authorizedRecallScope(session,ctx,cfg),true);
  assert.equal(recallForSession({recalledCandidates:()=>facts},ctx,session,cfg)[0].id,'pagelingo');
  assert.equal(authorizedRecallScope(session,ctx,{...cfg,autoRecall:false}),false);
  assert.equal(authorizedRecallScope(session,ctx,{...cfg,agentPreset:'other'}),true,'preset does not partition a trusted workspace');
  const second=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-memory-recall-'));
  try{assert.equal(authorizedRecallScope(session,ctx,{...cfg,workspace:second}),false);}
  finally{fs.rmSync(second,{recursive:true,force:true});}
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('hybrid score really reranks semantic result, ignores low-confidence similarity',()=>{
 const rows=rankMemoryMatches('云端向量连接',facts,[{id:'other',score:0.95},{id:'pagelingo',score:0.12}],5);
 assert(rows.some(row=>row.item.id==='other'));
 assert(!rows.some(row=>row.item.id==='pagelingo'&&row.vector>0));
 assert(rows.every((row,i)=>i===0||rows[i-1].score>=row.score));
 const keyword=rankMemoryMatches('PageLingo 翻译',facts,[],5);
 assert.equal(keyword[0].item.id,'pagelingo');
});
