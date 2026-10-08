import { createHash } from 'node:crypto';

export async function bounded(operation,signal,timeoutMs=3000){
 signal?.throwIfAborted();const abort=new AbortController(),combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
 let listener;const timeout=setTimeout(()=>abort.abort(new Error('向量提供方响应超时')),timeoutMs);
 const cancelled=new Promise((_,reject)=>{listener=()=>reject(combined.reason);combined.addEventListener('abort',listener,{once:true});});
 try{return await Promise.race([Promise.resolve().then(()=>operation(combined)),cancelled]);}
 finally{clearTimeout(timeout);combined.removeEventListener('abort',listener);}
}
const hash=value=>createHash('sha256').update(value).digest('hex');
function vector(value){
 if(!Array.isArray(value)&&!ArrayBuffer.isView(value))throw new Error('EmbeddingProvider 未返回向量');
 if(value.length<1||value.length>8192)throw new Error('向量维度无效');const result=Float32Array.from(value);let norm=0;
 for(const item of result){if(!Number.isFinite(item))throw new Error('向量包含非有限值');norm+=item*item;}
 if(norm<=0)throw new Error('向量为空');norm=Math.sqrt(norm);for(let i=0;i<result.length;i++)result[i]/=norm;return result;
}

/** Derived vectors only; the sourced fact and native transcript remain elsewhere. */
export class SQLiteVectorStore {
 constructor(db){this.db=db;db.exec('CREATE TABLE IF NOT EXISTS memory_vectors(scope TEXT NOT NULL,id TEXT NOT NULL,fingerprint TEXT NOT NULL,hash TEXT NOT NULL,vector BLOB NOT NULL,PRIMARY KEY(scope,id,fingerprint));');}
 get(scope,id,fingerprint){const row=this.db.prepare('SELECT * FROM memory_vectors WHERE scope=? AND id=? AND fingerprint=?').get(scope,id,fingerprint);return row?{...row,vector:new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength))}:null;}
 upsert(scope,id,fingerprint,textHash,values){this.db.prepare('INSERT OR REPLACE INTO memory_vectors VALUES(?,?,?,?,?)').run(scope,id,fingerprint,textHash,Buffer.from(values.buffer,values.byteOffset,values.byteLength));}
 list(scope,fingerprint){return this.db.prepare('SELECT id,hash,vector FROM memory_vectors WHERE scope=? AND fingerprint=?').all(scope,fingerprint).map(row=>({...row,vector:new Float32Array(row.vector.buffer.slice(row.vector.byteOffset,row.vector.byteOffset+row.vector.byteLength))}));}
 remove(scope,id){this.db.prepare('DELETE FROM memory_vectors WHERE scope=? AND id=?').run(scope,id);}
 prune(scope,ids,fingerprint){if(!ids.length)this.db.prepare('DELETE FROM memory_vectors WHERE scope=?').run(scope);else this.db.prepare('DELETE FROM memory_vectors WHERE scope=? AND (fingerprint<>? OR id NOT IN ('+ids.map(()=>'?').join(',')+'))').run(scope,fingerprint,...ids);}
}

/** Replaceable EmbeddingProvider and VectorStore contracts, with a local default. */
export class VectorIndex {
 constructor(db,guard={}){this.providers=new Map();this.stores=new Map([['sqlite',new SQLiteVectorStore(db)]]);this.pending=new Map();this.guard=guard;}
 registerEmbeddingProvider(name,provider){if(typeof name!=='string'||!name||this.providers.has(name)||typeof provider.embed!=='function')throw new Error('EmbeddingProvider 无效或重复');this.providers.set(name,provider);return()=>this.providers.delete(name);}
 async catalog(signal){
  const groups=[],failures=[];
  for(const [id,provider]of this.providers){
   try{const models=typeof provider.listModels==='function'?await bounded(current=>provider.listModels(current),signal):provider.models??[];
    if(!Array.isArray(models))throw new Error('向量模型目录无效');
    const valid=models.filter(row=>row&&typeof row.id==='string'&&row.id&&typeof (row.name??row.id)==='string').map(row=>({id:row.id,name:row.name??row.id}));
    if(valid.length)groups.push({id,name:provider.name??id,models:valid});
   }catch(error){failures.push({id,message:error.message});}
  }return {groups,failures};
 }
 registerVectorStore(name,store){if(typeof name!=='string'||!name||this.stores.has(name)||!['get','upsert','list','remove','prune'].every(method=>typeof store[method]==='function'))throw new Error('VectorStore 无效或重复');this.stores.set(name,store);return()=>this.stores.delete(name);}
 selection(config){const provider=this.providers.get(config.embeddingProvider),store=this.stores.get(config.vectorStore);if(!provider||!store)throw new Error('向量提供方或存储不可用');return {provider,store,fingerprint:hash(JSON.stringify([config.embeddingProvider,provider.version??'1',config.embeddingModel]))};}
 async rebuild(scope,facts,config,signal){
  const {provider,store,fingerprint}=this.selection(config),key=scope+':'+fingerprint;
  if(this.pending.has(key))throw new Error('此范围的向量索引正在更新');const task=(async()=>{
   signal?.throwIfAborted();await bounded(current=>store.prune(scope,facts.map(fact=>fact.id),fingerprint,current),signal);let updated=0;
   for(let offset=0;offset<facts.length;offset+=16){
    const batch=[];for(const fact of facts.slice(offset,offset+16)){const digest=hash(fact.text),existing=await bounded(current=>store.get(scope,fact.id,fingerprint,current),signal);if(existing?.hash!==digest)batch.push({...fact,digest});}
    if(!batch.length)continue;const values=await bounded(current=>provider.embed({texts:batch.map(fact=>fact.text),model:config.embeddingModel,signal:current}),signal,10000);
    signal?.throwIfAborted();if(!Array.isArray(values)||values.length!==batch.length)throw new Error('EmbeddingProvider 返回数量不匹配');
    const normalized=values.map(vector);if(normalized.some(item=>item.length!==normalized[0].length))throw new Error('EmbeddingProvider 维度不一致');
    for(let i=0;i<batch.length;i++){
     if(this.guard.current&&!this.guard.current(scope,batch[i]))continue;
     await bounded(current=>store.upsert(scope,batch[i].id,fingerprint,batch[i].digest,normalized[i],current),signal);updated++;
     if(this.guard.current&&!this.guard.current(scope,batch[i]))this.guard.stale?.(scope,batch[i].id,config.vectorStore);
    }
   }return {indexed:facts.length,updated};
  })();this.pending.set(key,task);try{return await task;}finally{this.pending.delete(key);}
 }
 async search(scope,query,facts,config,limit,signal){
  const {provider,store,fingerprint}=this.selection(config),allowed=new Map(facts.map(fact=>[fact.id,fact]));
  // A cold small fact pool is populated lazily; larger pools use explicit rebuild.
  if(facts.length<=64&&!this.pending.has(scope+':'+fingerprint))await this.rebuild(scope,facts,config,signal);
  const [queryVector]=await bounded(current=>provider.embed({texts:[query],model:config.embeddingModel,signal:current}),signal);const needle=vector(queryVector),ranked=[];
  for(const row of await bounded(current=>store.list(scope,fingerprint,current),signal)){const fact=allowed.get(row.id);if(!fact||row.hash!==hash(fact.text)||row.vector.length!==needle.length)continue;let score=0;for(let i=0;i<needle.length;i++)score+=needle[i]*row.vector[i];if(score>0)ranked.push({id:row.id,score});}
  return ranked.sort((a,b)=>b.score-a.score).slice(0,limit);
 }
 remove(scope,id){for(const store of this.stores.values())void Promise.resolve(store.remove(scope,id)).catch(()=>{});}
}
