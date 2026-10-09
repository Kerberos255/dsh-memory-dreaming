import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import { dshEmbeddingProfiles,installDshEmbeddingBridge } from '../dsh-embedding.js';
import {VectorIndex} from '../vector.js';

const sample={
 providers:{
  siliconflow:{displayName:'SiliconFlow',api:'openai-completions',
   baseURL:'https://api.siliconflow.cn/v1/',apiKeyEnv:'SILICONFLOW_API_KEY',
   models:[{id:'BAAI/bge-m3',name:'BAAI/bge-m3'},{id:'deepseek-v4-flash',name:'not an embedding'}]},
  unsupported:{api:'openai-completions',baseURL:'http://internal.test/v1/',apiKeyEnv:'KEY',models:[{id:'BAAI/bge-m3'}]},
  opencode:{api:'openai-completions',baseURL:'https://example.org/v1/',apiKeyEnv:'OTHER_API_KEY',models:[{id:'chat-model'}]}
 }};
const clone=()=>structuredClone(sample);
function harness(overrides={}){
 const config=clone(),db=new DatabaseSync(':memory:'),index=new VectorIndex(db);
 let resolution=0,requestCount=0;
 const calls=[];
 const ctx={
  settings:{describe(){return [{ns:'llm-pi-ai',value:config},{ns:'llm-deepseek',value:{}}]}},
  credentials:{async resolve(ref){resolution++;return {value:'test-placeholder-key'}}}
 };
 const fetchImpl=async(url,request)=>{
  requestCount++;calls.push({url,method:request.method,redirect:request.redirect,
    request:JSON.parse(request.body),auth:request.headers.authorization,signal:request.signal});
  if(overrides.badData)return{ok:true,async json(){return{data:[{index:0,embedding:[1,2]}]};}};
  const {input}=JSON.parse(request.body);
  return{ok:true,async json(){return{data:input.map((_,i)=>({index:input.length-i-1,embedding:[i+1,0.1]}))};}};
 };
 const bridge=installDshEmbeddingBridge(ctx,{registerEmbeddingProvider:(id,p)=>index.registerEmbeddingProvider(id,p)},{fetchImpl});
 return {config,ctx,index,bridge,db,calls,get resolution(){return resolution;},get requestCount(){return requestCount;},
  close(){bridge.dispose();db.close();}};
}
test('reads configured embedding model from DSH provider settings without copying the key',()=>{
 const found=dshEmbeddingProfiles({describe(){return[{ns:'llm-pi-ai',value:clone()}];}});
 assert.equal(found.size,1);
 assert.deepEqual(found.get('siliconflow').models,[{id:'BAAI/bge-m3',name:'BAAI/bge-m3'}]);
});
test('selected DSH model routes to SiliconFlow embeddings endpoint using existing credential',async()=>{
 const h=harness();
 try{
  const catalog=await h.index.catalog();
  assert.equal(catalog.groups.length,1);
  assert.equal(catalog.groups[0].id,'siliconflow');
  assert.equal(catalog.groups[0].models[0].id,'BAAI/bge-m3');
  const result=await h.index.providers.get('siliconflow').embed({model:'BAAI/bge-m3',texts:['alpha','beta'],signal:new AbortController().signal});
  assert.equal(result.length,2);
  assert.deepEqual(result[0],[2,0.1]); // API returns indexes in reverse order
  assert.deepEqual(result[1],[1,0.1]);
  assert.equal(h.calls[0].url,'https://api.siliconflow.cn/v1/embeddings');
  assert.equal(h.calls[0].method,'POST');
  assert.equal(h.calls[0].redirect,'error');
  assert.equal(h.calls[0].request.model,'BAAI/bge-m3');
  assert.equal(h.calls[0].auth,['Bearer','test-placeholder-key'].join(' '));
  assert.equal(h.resolution,1);
 }finally{h.close();}
});
test('moving provider configuration refreshes model dropdown and fingerprint safely',async()=>{
 const h=harness();
 try{
  const provider=h.index.providers.get('siliconflow'),initial=provider.version;
  h.config.providers.siliconflow.baseURL='https://api.siliconflow.cn/secondary/';
  h.config.providers.siliconflow.models.push({id:'Qwen/Qwen3-Embedding-0.6B'});
  h.bridge.sync();
  const c=await h.index.catalog();
  assert.equal(c.groups.length,1);
  assert.equal(c.groups[0].models.length,2);
  assert.notEqual(provider.version,initial);
  await assert.rejects(provider.embed({model:'chat-model',texts:['alpha']}),/移除或停用/);
  assert.equal(h.requestCount,0);
 }finally{h.close();}
});
test('missing DSH credential blocks API calls and no secret is included in error',async()=>{
 const h=harness();
 try{
  h.ctx.credentials.resolve=async()=>({value:''});
  await assert.rejects(h.index.providers.get('siliconflow').embed({model:'BAAI/bge-m3',texts:['x']}),/凭证未配置/);
  assert.equal(h.requestCount,0);
 }finally{h.close();}
});
test('other plugins can register their own provider alongside the DSH adapter',async()=>{
 const h=harness();
 try{
  h.index.registerEmbeddingProvider('third-party',{embed:async()=>[[1,2]],models:[{id:'vector',name:'vector'}]});
  h.bridge.sync();
  assert.equal((await h.index.catalog()).groups.length,2);
  h.bridge.dispose();
  assert.equal((await h.index.catalog()).groups.length,1);
 }finally{h.db.close();}
});
test('bad vector output is rejected before storing and the lexical fallback remains available',async()=>{
 const h=harness({badData:true});
 try{
  const p=h.index.providers.get('siliconflow');
  await assert.rejects(p.embed({model:'BAAI/bge-m3',texts:['first','second']}),/数量不匹配/);
  assert.throws(()=>h.index.selection({embeddingProvider:'missing',embeddingModel:'x',vectorStore:'sqlite'}),/不可用/);
 }finally{h.close();}
});
