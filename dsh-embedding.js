import { createHash } from 'node:crypto';

// DSH owns provider settings and credentials; Dream owns only the vector adapter.
const EMBEDDING_MODEL=/(?:^|[/_.-])(?:bge(?:[-_.]|$)|embed(?:ding|dings)?(?:[-_.]|$)|bce-embedding|gte(?:[-_.]|$)|e5(?:[-_.]|$)|jina-embeddings?)/i;
const VALID_ENV=/^[A-Z_][A-Z0-9_]{1,127}$/;
const APIS=new Set(['openai-completions','openai-chat','openai-responses']);

const versionFor=profile=>createHash('sha256').update(JSON.stringify([profile.baseURL,profile.api,profile.apiKeyEnv])).digest('hex').slice(0,24);

export function dshEmbeddingProfiles(settings) {
 const descriptor=settings?.describe?.().find(row=>row.ns==='llm-pi-ai');
 const configured=descriptor?.value?.providers;
 const results=new Map();
 if(!configured||typeof configured!=='object'||Array.isArray(configured))return results;
 for(const [id,config] of Object.entries(configured)){
  if(!id||typeof config!=='object'||!config||Array.isArray(config))continue;
  if(!APIS.has(config.api??'openai-completions')||!VALID_ENV.test(config.apiKeyEnv??''))continue;
  let url;try{url=new URL(config.baseURL);}catch{continue;}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)continue;
  if(!Array.isArray(config.models))continue;
  const models=config.models.filter(row=>row&&typeof row.id==='string'&&EMBEDDING_MODEL.test(row.id)
    &&(!row.type||row.type==='embedding'))
    .map(row=>({id:row.id,name:typeof row.name==='string'&&row.name?row.name:row.id}));
  if(!models.length)continue;
  results.set(id,{id,name:config.displayName||id,api:config.api??'openai-completions',
   baseURL:url.href,apiKeyEnv:config.apiKeyEnv,models});
 }
 return results;
}

export function installDshEmbeddingBridge(ctx,memory,{fetchImpl=fetch}={}){
 const registered=new Map();
 const profiles=()=>dshEmbeddingProfiles(ctx.settings);
 async function embed(id,{texts,model,signal}){
  const profile=profiles().get(id);
  if(!profile||!profile.models.some(row=>row.id===model))throw new Error('该 DSH 向量模型已被移除或停用');
  if(!Array.isArray(texts)||texts.length<1||texts.length>32||texts.some(text=>typeof text!=='string'||!text.trim()))
   throw new Error('Embedding 输入必须是 1–32 段非空文本');
  signal?.throwIfAborted();
  // CredentialRef is a validated string in DSH. apiKeyEnv was checked above.
  const resolved=await ctx.credentials.resolve(profile.apiKeyEnv);
  if(typeof resolved?.value!=='string'||!resolved.value)throw new Error('DSH 中对应提供方的 API 凭证未配置');
  // The existing DSH provider URL is used, not a new plugin-owned credential/endpoint.
  const url=new URL('embeddings',profile.baseURL.endsWith('/')?profile.baseURL:profile.baseURL+'/');
  const response=await fetchImpl(url.href,{
   method:'POST',redirect:'error',signal,
   headers:{'content-type':'application/json',authorization:'Bearer '+resolved.value},
   body:JSON.stringify({model,input:texts,encoding_format:'float'})
  });
  if(!response.ok)throw new Error('Embedding 请求失败（HTTP '+response.status+'）');
  const payload=await response.json();
  if(!Array.isArray(payload?.data)||payload.data.length!==texts.length)throw new Error('Embedding 返回数量不匹配');
  const values=Array(texts.length);
  for(const row of payload.data){
   if(!Number.isSafeInteger(row?.index)||row.index<0||row.index>=values.length||values[row.index]!==undefined
     ||!Array.isArray(row.embedding)||!row.embedding.length||row.embedding.length>8192
     ||row.embedding.some(n=>typeof n!=='number'||!Number.isFinite(n)))
    throw new Error('Embedding 返回格式无效');
   values[row.index]=row.embedding;
  }
  if(values.some(value=>!value))throw new Error('Embedding 返回索引不完整');
  return values;
 }
 function sync(){
  for(const [id,profile] of profiles()){
   if(registered.has(id))continue;
   const adapter={name:'DSH · '+profile.name,
    get version(){const current=profiles().get(id);return current?versionFor(current):'removed';},
    listModels(){return profiles().get(id)?.models??[];},
    embed:request=>embed(id,request)};
   try{registered.set(id,memory.registerEmbeddingProvider(id,adapter));}
   catch(error){if(!/重复/.test(error.message))throw error;} // Preserve external provider registrations.
  }
 }
 sync();
 return{sync,dispose(){for(const dispose of registered.values())dispose();registered.clear();}};
}
