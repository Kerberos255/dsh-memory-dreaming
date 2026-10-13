import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {recallForSessionHybrid,freshCachedRecall} from '../recall-context.js';

const make=({query='why stop using the small offline translator?',mode='fallback',facts,onSearch}={})=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-semantic-recall-'));
 const rows=facts??[
  {id:'project',text:'PageLingo abandoned local 2B models because translation quality was insufficient; it now uses Bergamot or remote API.',topic:'pagelingo',tags:['PageLingo'],confirmed:100,sources:[{sessionId:'owner-old',seq:12}]},
  {id:'pet',text:'Our dog enjoys playing fetch.',topic:'dog',tags:['pet'],confirmed:101,sources:[{sessionId:'owner-dog',seq:4}]}
 ];
 const config={enabled:true,recall:true,autoRecall:true,autoRecallMode:mode,embeddingProvider:'stub',embeddingModel:'stub',vectorStore:'sqlite',agentPreset:'agent',workspace:dir,autoRecallMaxItems:3,autoRecallMaxChars:1200};
 const session={id:'desktop',header:{cwd:dir,agentPreset:'agent'},surface:{nodes:[0]},eventAt:()=>({type:'user/message',data:{content:[{type:'text',text:query}]}})};
 const ctx={get:()=>null};let hits=0;
 const memory={scope:()=>dir,recalledCandidates:()=>rows,
  vectorIndex:{search:async (...args)=>{hits++;return await (onSearch?.(...args)??[]);}}};
 return {dir,config,session,ctx,memory,get hits(){return hits},close(){fs.rmSync(dir,{recursive:true,force:true})}};
};
test('paraphrase finds published source-backed fact with semantic fallback',async()=>{
 const env=make({onSearch:()=>[{id:'project',score:.93},{id:'pet',score:.29}]});
 try{const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);
  assert.equal(env.hits,1);assert.deepEqual(rows.map(x=>x.id),['project']);assert.deepEqual(rows[0].source,[{sessionId:'owner-old',seq:12}]);
 }finally{env.close();}
});
test('keyword mode never makes an embedding request',async()=>{
 const env=make({mode:'keyword',query:'PageLingo Bergamot',onSearch:()=>{throw Error('Must not call network')}});
 try{const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);assert.equal(env.hits,0);assert.equal(rows[0].id,'project');}
 finally{env.close();}
});
test('fallback skips semantic search when keyword result is already strong',async()=>{
 const env=make({query:'PageLingo translation Bergamot 2B',onSearch:()=>{throw Error('Unexpected semantic call')}});
 try{await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);assert.equal(env.hits,0);}
 finally{env.close();}
});
test('hybrid always evaluates semantic ranking even for lexical match',async()=>{
 const env=make({mode:'hybrid',query:'PageLingo translation Bergamot 2B',onSearch:()=>[{id:'project',score:.89}]});
 try{const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);assert.equal(env.hits,1);assert.equal(rows[0].id,'project');}
 finally{env.close();}
});
test('low similarity cannot inject irrelevant memories; item and char budget remain hard caps',async()=>{
 const env=make({onSearch:()=>[{id:'pet',score:.57},{id:'project',score:.91}]});
 try{env.config.autoRecallMaxItems=1;env.config.autoRecallMaxChars=300;
  const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);
  assert.deepEqual(rows.map(x=>x.id),['project']);assert(rows[0].text.length+90<=300);
 }finally{env.close();}
});
test('embedding failure falls back to lexical results',async()=>{
 const env=make({query:'PageLingo translate',onSearch:()=>{throw Error('provider offline')}});
 try{const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);assert.equal(rows[0].id,'project');}
 finally{env.close();}
});
test('forgetting or replacement while provider is pending invalidates semantic candidates',async()=>{
 const env=make({onSearch:async()=>{env.memory.recalledCandidates=()=>[];return [{id:'project',score:.99}]}});
 try{const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);assert.deepEqual(rows,[]);}
 finally{env.close();}
});
test('unauthorized channel is rejected before embeddings run',async()=>{
 const env=make({onSearch:()=>{throw Error('must not call')}});
 try{env.session.header.origin='feishu';const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);
  assert.deepEqual(rows,[]);assert.equal(env.hits,0);
 }finally{env.close();}
});
test('no published sources and overdue memories never trigger semantic injection',async()=>{
 const env=make({facts:[{id:'stale',text:'old fact',topic:'stale',tags:[],sources:[{sessionId:'x',seq:1}],reviewDue:true}],onSearch:()=>[{id:'stale',score:.98}]});
 try{assert.deepEqual(await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config),[]);assert.equal(env.hits,0);}
 finally{env.close();}
});
test('timeout automatically returns lexical result and aborts request',async()=>{
 let cancelled=false;
 const env=make({query:'PageLingo translate',onSearch:(scope,query,facts,config,n,signal)=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{cancelled=true;reject(signal.reason)}, {once:true});})});
 try{const start=Date.now(),rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);
  assert.equal(rows[0]?.id,'project');assert.equal(cancelled,true);assert(Date.now()-start>=1400&&Date.now()-start<2700);
 }finally{env.close();}
});

test('cached rows are re-read from published facts and are invalidated by forgetting',async()=>{
 const env=make({onSearch:()=>[{id:'project',score:.93}]});
 try{
  const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);
  assert.equal(freshCachedRecall(env.memory,env.ctx,env.session,env.config,rows)?.length,1);
  env.memory.recalledCandidates=()=>[];
  assert.equal(freshCachedRecall(env.memory,env.ctx,env.session,env.config,rows),null);
 }finally{env.close();}
});
test('cache cannot bypass channel authorization or outdated review',async()=>{
 const env=make({onSearch:()=>[{id:'project',score:.93}]});
 try{
  const rows=await recallForSessionHybrid(env.memory,env.ctx,env.session,env.config);
  env.session.header.origin='discord';
  assert.equal(freshCachedRecall(env.memory,env.ctx,env.session,env.config,rows),null);
  env.session.header.origin='desktop';env.memory.recalledCandidates=()=>[{...rows[0],reviewDue:true}];
  assert.equal(freshCachedRecall(env.memory,env.ctx,env.session,env.config,rows),null);
 }finally{env.close();}
});
