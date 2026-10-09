import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {completeWorkspaceMemory} from '../memory-batches.js';
import {Memory,withinMemoryWorkspace} from '../memory.js';
import {schema} from '../config.js';
import {withOpenCodeSessionHeader} from '../../../tooling/sdk/node_modules/@earendil-works/pi-ai/dist/providers/opencode-headers.js';

function setup(){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-memory-batch-'));
 const calls=[];
 const ctx={
  tokenMeter:{estimateMessage(msg){return Math.max(1,Math.ceil(JSON.stringify(msg).length/4));}},
  llm:{
   async resolveModelInfo(){return {context:{contextWindow:20000}};},
   async *stream(req){
    const inputs=JSON.parse(req.messages.at(-1).content[0].text).sources;
    calls.push({sourceIds:inputs.map(x=>x.sessionId),seqs:inputs.map(x=>x.seq),maxTokens:req.maxTokens});
    yield {type:'text-delta',index:0,text:JSON.stringify({
     facts:[],daily:'记录 '+inputs.length+' 条用户消息',dream:'已整理项目决策',weekly:'本周有进展'
    })};
    yield {type:'finish',reason:{kind:'stop'}};
   }
  }
 };
 const cfg={...schema.defaults,modelProvider:'provider',model:'summarizer',maxSessions:2,maxInputTokens:12000};
 return{cwd,ctx,cfg,calls,close(){fs.rmSync(cwd,{recursive:true,force:true});}};
}
test('workplace sessions across presets and descendants can share memory without sibling leakage',()=>{
 const h=setup();
 try{
  const child=path.join(h.cwd,'subdir');fs.mkdirSync(child);
  const sibling=h.cwd+'-other';fs.mkdirSync(sibling);
  assert.equal(withinMemoryWorkspace(h.cwd,child),true);
  assert.equal(withinMemoryWorkspace(h.cwd,h.cwd),true);
  assert.equal(withinMemoryWorkspace(h.cwd,sibling),false);
  fs.rmSync(sibling,{recursive:true,force:true});
 }finally{h.close();}
});
test('all eligible inputs span multiple sessions/batches without silent loss',async()=>{
 const h=setup();
 try{
  const sources=Array.from({length:75},(_,i)=>({sessionId:'session-'+Math.floor(i/15),seq:i,time:Date.now()+i,text:'项目记录 '+i}));
  const result=await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources,redact:x=>x});
  assert.equal(result.sourceCount,75);
  assert.equal(result.sessionCount,5);
  assert.equal(result.sources.length,75);
  assert(result.batchCount>1);
  const seqs=h.calls.flatMap(c=>c.seqs).sort((a,b)=>a-b);
  assert.deepEqual(seqs,Array.from({length:75},(_,i)=>i));
  assert.equal(new Set(seqs).size,75);
  assert.equal(h.calls.every(c=>new Set(c.sourceIds).size<=h.cfg.maxSessions),true);
  assert.match(result.daily,/分段/);
 }finally{h.close();}
});
test('model output cap retries smaller batches rather than reporting global failure',async()=>{
 const h=setup();
 try{
  h.ctx.llm.stream=async function*(req){
   const inputs=JSON.parse(req.messages.at(-1).content[0].text).sources;
   h.calls.push({seqs:inputs.map(x=>x.seq)});
   if(inputs.length>1){yield{type:'finish',reason:{kind:'max-tokens'}};return;}
   yield{type:'text-delta',index:0,text:JSON.stringify({facts:[],daily:'成功',dream:'',weekly:''})};
   yield{type:'finish',reason:{kind:'stop'}};
  };
  const sources=[0,1,2].map(i=>({sessionId:'session-a',seq:i,time:i,text:'决策'}));
  const r=await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources,redact:x=>x});
  assert.equal(r.sourceCount,3);
  assert(h.calls.length>3);
 }finally{h.close();}
});
test('single-item truncation produces actionable error rather than a generic message',async()=>{
 const h=setup();
 try{
  h.ctx.llm.stream=async function*(){yield{type:'finish',reason:{kind:'max-tokens'}};};
  const sources=[{sessionId:'session-a',seq:5,time:5,text:'text'}];
  await assert.rejects(completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources,redact:x=>x}),/4096 → 8192 → 16384 tokens/);
 }finally{h.close();}
});
test('source range scans all matching sessions, not a fixed 30/60-message cap',async()=>{
 const h=setup();
 const cfg={...h.cfg,maxSessions:1,incremental:false};
 const sessionNames=['session-a','session-b'];
 const ctx={
  dshHomePath:(...part)=>path.join(h.cwd,'home',...part),
  sessionQuery:{
   async listSessions(){return sessionNames.map(id=>({header:{id,cwd:h.cwd,origin:'desktop'}}));},
   async observeSession(id){return{
    events:Array.from({length:65},(_,seq)=>({seq,time:Date.now()+seq,type:'user/message',surfaceOp:'append',data:{content:[{type:'text',text:id+' '+seq}]}})),
    inheritedEventCount:0, [Symbol.dispose](){}
   };}
  }
 };
 const mem=new Memory(path.join(h.cwd,'state.sqlite'),ctx,()=>cfg);
 try{
  const sources=await mem.collect(h.cwd,undefined,{kind:'dream'});
  assert.equal(sources.length,130);
  assert.equal(new Set(sources.map(x=>x.sessionId)).size,2);
 }finally{await mem.close();h.close();}
});

test('a later batch failure never reports complete coverage',async()=>{
 const h=setup();
 try{
  let calls=0;h.ctx.llm.stream=async function*(req){
   calls++;
   if(calls===2){yield{type:'finish',reason:{kind:'error'}};return;}
   yield{type:'text-delta',index:0,text:JSON.stringify({facts:[],daily:'partial',dream:'',weekly:''})};
   yield{type:'finish',reason:{kind:'stop'}};
  };
  const sources=Array.from({length:13},(_,i)=>({sessionId:'session-a',seq:i,time:i,text:'项目消息 '+i}));
  await assert.rejects(completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources,redact:x=>x}),/模型适配器返回失败/);
  assert.equal(calls,2);
 }finally{h.close();}
});

test('OpenCode Go adapter attaches the required session header',()=>{
 const capture={streamSimple:(_model,_context,options)=>options,stream:(_model,_context,options)=>options};
 const wrapper=withOpenCodeSessionHeader(capture);
 assert.equal(wrapper.streamSimple(null,null,{}).headers,undefined);
 const output=wrapper.streamSimple(null,null,{sessionId:'session-memory-test'});
 assert.equal(output.headers['x-opencode-session'],'session-memory-test');
});
test('Dream manual UI calls have stable workspace-scoped session identity',async()=>{
 const h=setup(),observed=[];
 try{
  const original=h.ctx.llm.stream;
  h.ctx.llm.stream=function(req){observed.push({sessionId:req.sessionId,purpose:req.purpose});return original.call(this,req);};
  const sources=[{sessionId:'source-session',seq:1,time:1,text:'稳定项目决定'}];
  await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources,redact:x=>x});
  await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources,redact:x=>x});
  assert.equal(observed.length,2);
  assert.match(observed[0].sessionId,/^dsh-memory-[a-f0-9]{32}-daily$/);
  assert.equal(observed[0].sessionId,observed[1].sessionId);
  assert.equal(observed[0].purpose,'memory-dreaming');
 }finally{h.close();}
});
test('Dream scheduled Agent calls use actual session identity',async()=>{
 const h=setup();let seen=null;
 try{
  const original=h.ctx.llm.stream;
  h.ctx.llm.stream=function(req){seen=req.sessionId;return original.call(this,req);};
  const agent={session:{id:'session-dsh-memory-live',requestHeader:()=>({config:{provider:'provider',model:'summarizer'}})}};
  await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'dream',sources:[{sessionId:'source',seq:1,time:1,text:'用户决定'}],agent,redact:x=>x});
  assert.equal(seen,agent.session.id);
 }finally{h.close();}
});

test('adaptive budget retries one source 4096 → 8192 → 16384 and publishes only the final JSON',async()=>{
 const h=setup(),caps=[];
 try{
  h.ctx.llm.stream=async function*(req){
   caps.push(req.maxTokens);
   if(req.maxTokens<16384){yield{type:'finish',reason:{kind:'max-tokens'}};return;}
   yield{type:'text-delta',index:0,text:JSON.stringify({facts:[],daily:'最终完整报告',dream:'',weekly:''})};
   yield{type:'finish',reason:{kind:'stop'}};
  };
  const r=await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources:[{sessionId:'s',seq:1,time:1,text:'决定'}],redact:x=>x});
  assert.deepEqual(caps,[4096,8192,16384]);
  assert.equal(r.batchCount,3);assert.equal(r.sourceCount,1);assert.equal(r.daily,'最终完整报告');
 }finally{h.close();}
});

test('currently configured 8192 is the initial allowance and only increases on truncation',async()=>{
 const h=setup(),caps=[];
 try{
  const cfg={...h.cfg,maxOutputTokens:8192};
  h.ctx.llm.stream=async function*(req){
   caps.push(req.maxTokens);
   if(req.maxTokens===8192){yield{type:'finish',reason:{kind:'max-tokens'}};return;}
   yield{type:'text-delta',index:0,text:JSON.stringify({facts:[],daily:'ok',dream:'',weekly:''})};
   yield{type:'finish',reason:{kind:'stop'}};
  };
  const r=await completeWorkspaceMemory({ctx:h.ctx,config:cfg,cwd:h.cwd,kind:'daily',sources:[{sessionId:'s',seq:3,time:3,text:'消息'}],redact:x=>x});
  assert.deepEqual(caps,[8192,16384]);assert.equal(r.sourceCount,1);
 }finally{h.close();}
});

test('complete JSON stops on the first request, without costly blind retries',async()=>{
 const h=setup();try{
  const r=await completeWorkspaceMemory({ctx:h.ctx,config:{...h.cfg,maxOutputTokens:8192},cwd:h.cwd,kind:'daily',sources:[{sessionId:'s',seq:1,time:1,text:'正常'}],redact:x=>x});
  assert.equal(r.batchCount,1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].maxTokens,8192);
 }finally{h.close();}
});

test('model declared output limit prevents retries past provider capability',async()=>{
 const h=setup(),caps=[];
 try{
  h.ctx.llm.resolveModelInfo=async()=>({context:{contextWindow:20000},defaultMaxTokens:6000});
  h.ctx.llm.stream=async function*(req){caps.push(req.maxTokens);yield{type:'finish',reason:{kind:'max-tokens'}};};
  await assert.rejects(completeWorkspaceMemory({ctx:h.ctx,config:{...h.cfg,maxOutputTokens:8192},cwd:h.cwd,kind:'daily',sources:[{sessionId:'s',seq:1,time:1,text:'来源'}],redact:x=>x}),/安全上限 6000/);
  assert.deepEqual(caps,[6000]);
 }finally{h.close();}
});

test('context window limits adaptive output for the exact input payload',async()=>{
 const h=setup(),caps=[];
 try{
  const contextWindow=9500;
  h.ctx.llm.resolveModelInfo=async()=>({context:{contextWindow}});
  h.ctx.llm.stream=async function*(req){
   caps.push(req.maxTokens);
   const consumed=h.ctx.tokenMeter.estimateMessage(req.messages[0])+h.ctx.tokenMeter.estimateMessage(req.messages[1]);
   assert(consumed+req.maxTokens+2048<=contextWindow,'each retry must fit context');
   if(caps.length===1){yield{type:'finish',reason:{kind:'max-tokens'}};return;}
   yield{type:'text-delta',index:0,text:JSON.stringify({facts:[],daily:'ok',dream:'',weekly:''})};
   yield{type:'finish',reason:{kind:'stop'}};
  };
  await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources:[{sessionId:'s',seq:1,time:1,text:'short'}],redact:x=>x});
  assert.equal(caps.length,2);
  assert(caps[1]>caps[0]&&caps[1]<8192);
 }finally{h.close();}
});

test('daily/dream/weekly infer only the requested report field and no other summaries',async()=>{
 const h=setup();
 try{
  for(const kind of ['daily','dream','weekly']){
   let prompt='';
   h.ctx.llm.stream=async function*(req){
    prompt=req.messages[0].content[0].text;
    yield{type:'text-delta',index:0,text:JSON.stringify({facts:[],daily:'',dream:'',weekly:''})};
    yield{type:'finish',reason:{kind:'stop'}};
   };
   await completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind,sources:[{sessionId:'s',seq:1,time:1,text:'ok'}],redact:x=>x});
   assert.match(prompt,new RegExp('仅填写 '+kind+' 字段'));
  }
 }finally{h.close();}
});

test('adaptive requests stop on abort rather than issuing the next larger call',async()=>{
 const h=setup(),controller=new AbortController(),caps=[];
 try{
  h.ctx.llm.stream=async function*(req){caps.push(req.maxTokens);controller.abort();yield{type:'finish',reason:{kind:'max-tokens'}};};
  await assert.rejects(completeWorkspaceMemory({ctx:h.ctx,config:h.cfg,cwd:h.cwd,kind:'daily',sources:[{sessionId:'s',seq:1,time:1,text:'ok'}],signal:controller.signal,redact:x=>x}));
  assert.deepEqual(caps,[4096]);
 }finally{h.close();}
});
