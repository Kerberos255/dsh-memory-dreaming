import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Memory} from '../memory.js';
import {schema} from '../config.js';
function open(spec){
 const config={...schema.defaults,...spec.config};
 const ctx={
  emit(){},dshHomePath:(...parts)=>path.join(path.dirname(spec.db),'dsh-home',...parts),
  sessionQuery:{listSessions:async()=>[],observeSession:async()=>{throw Error('not expected')}},
  agentDefaultModel:{currentSelection:()=>({provider:'test',model:'summary'})},
  tokenMeter:{estimateMessage:value=>Math.max(1,Math.ceil(JSON.stringify(value).length/2))},
  llm:{resolveModelInfo:async()=>({context:{contextWindow:32768}}),async *stream(){throw Error('test response not configured');}}
 };
 return {memory:new Memory(spec.db,ctx,()=>config),ctx,config};
}

const DATE='2026-10-18';
function setup({maxSessions=8}={}){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-dream-delta-'));
 const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
 const spec={cwd,db:path.join(root,'state.sqlite'),config:{modelProvider:'test',model:'summary',maxSessions,autoPromote:false}};
 let fixture=open(spec);
 let calls=[],responder=null;
 const configure=()=>{
  fixture.ctx.sessionQuery.listSessions=async()=>{throw new Error('Dream must not scan native transcripts')};
  fixture.ctx.llm.stream=async function*(req){
   const sources=JSON.parse(req.messages[1].content[0].text).sources;
   calls.push(sources.map(x=>x.sessionId));
   if(responder){yield* responder(sources);return;}
   yield {type:'text-delta',index:0,text:JSON.stringify({facts:[],taskEvents:[],dream:'巩固来自 '+sources.map(x=>x.sessionId).join('、'),daily:'',weekly:''})};
   yield {type:'finish',reason:{kind:'stop'}};
  };
 };
 configure();
 return {
  cwd,spec,get memory(){return fixture.memory},get calls(){return calls},
  setResponder(fn){responder=fn},
  diary(day,body='这天用户明确确定了一个项目后续事项。'){
   fixture.memory.artifact(cwd,'memory/'+day+'.md','daily-'+day,'## '+day+'\n\n'+body);
  },
  async restart(){
   await fixture.memory.close();
   fixture=open(spec);configure();
  },
  async close(){await fixture.memory.close();fs.rmSync(root,{recursive:true,force:true});}
 };
}
const n=db=>db.prepare('SELECT count(*) AS n FROM memory_dream_diaries').get().n;

test('Dream uses recent managed daily reports once, not 90 days of native conversations',async()=>{
 const f=setup();
 try{
  f.diary('2026-10-16','已完成一次翻译路由测试');
  f.diary('2026-10-17','后续需要复查性能日志');
  const first=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(first.state,'completed');assert.equal(first.sourceKind,'daily-memory');
  assert.equal(first.sourceCount,2);assert.equal(n(f.memory.db),2);
  assert.equal(f.calls.length,1);
  const again=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(again.empty,true);assert.equal(f.calls.length,1);
  assert(fs.readFileSync(path.join(f.cwd,'DREAMS.md'),'utf8').includes('巩固来自'));
 }finally{await f.close();}
});

test('modified day is re-consolidated; unchanged days are excluded, without losing prior daily input',async()=>{
 const f=setup();try{
  f.diary('2026-10-16','第一次日记');
  await f.memory.run(f.cwd,'dream',{day:DATE});
  f.diary('2026-10-17','第二天日记');
  const r=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(r.sourceCount,1);assert.deepEqual(f.calls.at(-1),['diary:2026-10-17']);
  f.diary('2026-10-16','更正后的第一天日记');
  const update=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(update.sourceCount,1);assert.deepEqual(f.calls.at(-1),['diary:2026-10-16']);
  assert.equal(n(f.memory.db),2);
 }finally{await f.close();}
});

test('Dream reads weekly-archived daily file safely and fails closed on tampering',async()=>{
 const f=setup();try{
  f.diary('2026-10-15','归档日记');
  const src=path.join(f.cwd,'memory','2026-10-15.md'),folder=path.join(f.cwd,'memory','.archive','daily');
  fs.mkdirSync(folder,{recursive:true});fs.renameSync(src,path.join(folder,'2026-10-15.md'));
  const r=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(r.sourceCount,1);
  fs.appendFileSync(path.join(folder,'2026-10-15.md'),'\n未受管内容');
  await assert.rejects(f.memory.run(f.cwd,'dream',{day:DATE}),/非受管内容/);
 }finally{await f.close();}
});

test('transient model connection loss retries once, but permanent failure leaves cursor unadvanced',async()=>{
 const f=setup();try{
  f.diary('2026-10-17');
  let failed=0;
  f.setResponder(async function*(sources){
   failed++;
   if(failed<=2){yield {type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT'}}};return;}
   yield {type:'text-delta',index:0,text:JSON.stringify({facts:[],dream:'重试成功',daily:'',weekly:''})};
   yield {type:'finish',reason:{kind:'stop'}};
  });
  await assert.rejects(f.memory.run(f.cwd,'dream',{day:DATE}),/模型网络连接失败/);
  assert.equal(failed,2);assert.equal(n(f.memory.db),0);
  const r=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(r.state,'completed');assert.equal(n(f.memory.db),1);
 }finally{await f.close();}
});

test('validated complete batch cached across restart; failed trailing batch redoes only unfinished work',async()=>{
 const f=setup({maxSessions:1});try{
  f.diary('2026-10-16','唯一有效信息甲');
  f.diary('2026-10-17','唯一有效信息乙');
  const bySource={};
  f.setResponder(async function*(sources){
   const id=sources[0].sessionId;bySource[id]=(bySource[id]??0)+1;
   if(id==='diary:2026-10-17'){
    yield {type:'finish',reason:{kind:'error',failure:{code:'TRANSPORT'}}};return;
   }
   yield {type:'text-delta',index:0,text:JSON.stringify({facts:[],dream:'完整叶结果',daily:'',weekly:''})};
   yield {type:'finish',reason:{kind:'stop'}};
  });
  await assert.rejects(f.memory.run(f.cwd,'dream',{day:DATE}),/模型网络连接失败/);
  assert.equal(n(f.memory.db),0);
  assert.equal(f.memory.db.prepare('SELECT COUNT(*) AS n FROM memory_dream_batch_cache').get().n,1);
  assert.equal(bySource['diary:2026-10-16'],1);
  await f.restart();
  f.setResponder(async function*(sources){
   const id=sources[0].sessionId;bySource[id]=(bySource[id]??0)+1;
   yield {type:'text-delta',index:0,text:JSON.stringify({facts:[],dream:'完整续跑结果',daily:'',weekly:''})};
   yield {type:'finish',reason:{kind:'stop'}};
  });
  const r=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(r.state,'completed');assert.equal(n(f.memory.db),2);
  assert.equal(bySource['diary:2026-10-16'],1,'already completed first batch must not be re-requested');
  assert.equal(bySource['diary:2026-10-17'],3,'second batch retried, then re-executed successfully');
 }finally{await f.close();}
});

test('consolidation refuses forged model facts and does not mark any diary processed',async()=>{
 const f=setup();try{
  f.diary('2026-10-17');
  f.setResponder(async function*(){
   yield {type:'text-delta',index:0,text:JSON.stringify({facts:[{text:'伪造'}],dream:'报告',daily:'',weekly:''})};
   yield {type:'finish',reason:{kind:'stop'}};
  });
  await assert.rejects(f.memory.run(f.cwd,'dream',{day:DATE}),/无伪造事实/);
  assert.equal(n(f.memory.db),0);
  assert(!fs.existsSync(path.join(f.cwd,'DREAMS.md')));
 }finally{await f.close();}
});

test('backlog is bounded to seven diary inputs per run, and the remainder is retained',async()=>{
 const f=setup();try{
  for(let date=9;date<=16;date++)f.diary('2026-10-'+String(date).padStart(2,'0'),'项目阶段记录 '+date);
  const first=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(first.sourceCount,7);
  assert.equal(first.remainingDays,1);
  assert.equal(n(f.memory.db),7);
  const next=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(next.sourceCount,1);
  assert.equal(next.remainingDays,0);
  assert.equal(n(f.memory.db),8);
  const idle=await f.memory.run(f.cwd,'dream',{day:DATE});
  assert.equal(idle.empty,true);
 }finally{await f.close();}
});
