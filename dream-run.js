import {collectDreamDiaries,dreamBatchCache} from './dream-delta.js';
import {completeWorkspaceMemory} from './memory-batches.js';
import {readBounded,safePath,digest} from './workspace-io.js';

const priorBlock=(cwd,day)=>{
 const body=readBounded(safePath(cwd,'DREAMS.md'),1048576)??'';
 const start='<!-- dsh-memory:dream-'+day+' -->',end='<!-- /dsh-memory:dream-'+day+' -->';
 const a=body.indexOf(start);if(a<0)return '';
 const b=body.indexOf(end,a+start.length);
 if(b<0)throw new Error('既有 Dream 当日受管区块缺少结束标记，禁止覆盖');
 return body.slice(a+start.length,b).trim().slice(0,4000);
};

/** Incrementally consolidate already-produced daily memories. */
export async function runDreamDelta(memory,cwd,{day,signal,agent,id,scope,redact}){
 const pending=collectDreamDiaries(memory.db,cwd,scope,day,{signal,limit:30});
 const entries=pending.slice(0,7);
 const remaining=pending.length-entries.length;
 if(!entries.length)return{entries:[],result:{id,state:'completed',empty:true,artifacts:[],batchCount:0,sourceCount:0,message:'没有新增或变化的每日记忆；Dream 未调用模型'}};
 const sources=entries.map(entry=>({sessionId:'diary:'+entry.day,seq:0,time:Date.parse(entry.day+'T12:00:00.000Z'),text:entry.text}));
 const prior=priorBlock(cwd,day);
 const limit=new AbortController();
 const timer=setTimeout(()=>limit.abort(new Error('Dream 本轮巩固超过 8 分钟上限')),480000);
 timer.unref?.();
 let generated;
 try{
  generated=await completeWorkspaceMemory({ctx:memory.ctx,config:memory.getConfig(),cwd,kind:'dream',
   sources,signal:signal?AbortSignal.any([signal,limit.signal]):limit.signal,agent,redact,consolidationOnly:true,priorDream:prior,
   batchCache:dreamBatchCache(memory.db,scope)});
 }finally{clearTimeout(timer);}
 limit.signal.throwIfAborted();
 signal?.throwIfAborted();
 if(!generated.dream?.trim())throw new Error('Dream 巩固模型返回空报告；已完成的日记不会标记处理');
 if(generated.facts?.length||generated.taskEvents?.length)throw new Error('Dream 巩固阶段返回未经原始出处核验的事实或任务事件');
 const artifact=memory.artifact(cwd,'DREAMS.md','dream-'+day,'## '+day+' · 记忆巩固\n\n'+redact(generated.dream),1048576,id);
 if(!artifact)throw new Error('Dream 巩固报告保存失败；未推进处理进度');
 return{entries,result:{id,state:'completed',inputKey:digest(JSON.stringify([scope,'dream-daily-v1',entries.map(e=>[e.day,e.hash])])),staged:0,rejected:0,promoted:0,artifacts:[artifact],batchCount:generated.batchCount,sourceCount:entries.length,sessionCount:0,sourceKind:'daily-memory',remainingDays:remaining,message:'已增量巩固 '+entries.length+' 篇新增或修改的每日记忆'+(remaining?'；仍有 '+remaining+' 篇待下次处理':'')}};
}
