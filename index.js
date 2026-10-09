import { Remote, RemoteError } from '@deepseek-ai/dsh-typert-protocol';
import { PluginConfig } from './plugin-settings/remote-config.js';
import { schema } from './config.js';
import { Memory } from './memory.js';
import { workspace,scopeId } from './workspace-io.js';
import { WorkflowLedger } from './workflows.js';
import { MemorySchedules } from './schedules.js';
import { startManualMemory } from './manual-run.js';
import { maintenanceToolDenial, restrictMaintenanceTools } from './session-setup.js';
import { attachAutoRecall,isUntrustedChannel } from './recall-context.js';
import { channelSessionIds,ownerChannelAuthorized } from './source-boundary.js';
import { installDshEmbeddingBridge } from './dsh-embedding.js';

export default class MemoryDreaming extends PluginConfig {
 static inject=['dshHomePath','workspaceController','sessionQuery','agentDefaultModel','llm','tokenMeter','settings','credentials'];
 constructor(ctx,legacy={}){
  super(ctx,{service:'memoryDreaming',packageName:'dsh-memory-dreaming',schema},legacy);this.context=ctx;this.abort=new AbortController();this.configAbort=new AbortController();this.queue=Promise.resolve();this.scheduleScope=null;this.scheduleError='';this.tasks=new Set();this.vectorRuns=new Map();
  this.memory=new Memory(ctx.dshHomePath('memory-dreaming','state.sqlite'),ctx,()=>this.configFile.value);
  this.embeddingBridge=installDshEmbeddingBridge(ctx,this.memory);
  this.embeddingCatalog=()=>{this.embeddingBridge.sync();return this.memory.vectorIndex.catalog(this.abort.signal);};
  ctx.effect(()=>()=>this.embeddingBridge.dispose());
  this.workflows=new WorkflowLedger(this.memory,ctx);this.schedules=new MemorySchedules(this.memory,ctx,undefined,this.workflows);this.workflowError='';this.workflowReady=this.workflows.recover(this.abort.signal).catch(error=>{if(!this.abort.signal.aborted)this.workflowError='原生任务记录暂不可核对。';});this.tasks.add(this.workflowReady);this.workflowReady.finally(()=>this.tasks.delete(this.workflowReady)).catch(()=>{});
  for(const initialize of initializers)initialize.call(this);
  this.configFile.subscribe(()=>{this.configAbort.abort();this.configAbort=new AbortController();for(const abort of this.memory.running.values())abort.abort();this.reconcileLater();});
  ctx.inject(['schedule','sessionController'],scope=>{this.scheduleScope=scope;this.scheduleService=scope.schedule;this.reconcileLater();scope.effect(()=>()=>{if(this.scheduleScope===scope)this.scheduleScope=null;});});
  ctx.on('session/event',(session,event)=>this.event(session,event),{global:true});
  // Native Schedule emits after durable deletion on archive/Session stop.
  // Reconcile also detects missing Sessions. A user-deleted task in an existing
  // Session remains needs-review; no automatic resurrection.
  ctx.on('schedule/changed',()=>{
   if(this.scheduleScope&&this.configFile.value.automatic)this.reconcileLater();
  },{global:true});
  // Agent-scoped trusted memory context; other users' channel Sessions are excluded.
  ctx.on('agent/created',({agent})=>{attachAutoRecall(agent,this,ctx);restrictMaintenanceTools(agent);},{global:true});
  ctx.on('agent/inbox/claimed',({agent,message,turn})=>{const preset=ctx.get('sessionProjections')?.stateOf(agent.session,'agentPreset')??agent.session.header.agentPreset;this.workflows.claim(this.workflows.identity(agent.session.header,preset),message,turn);},{global:true});
  ctx.on('user-questions/request',(request,next)=>this.waiting(request,next,'awaiting-user'),{global:true,prepend:true});
  ctx.on('approval/request',(request,next)=>this.waiting(request,next,'awaiting-approval'),{global:true,prepend:true});
  ctx.effect(()=>async()=>{this.abort.abort();this.workflows.close();for(const abort of this.memory.running.values())abort.abort();await Promise.allSettled([...this.tasks,this.queue]);const schedule=this.scheduleService;if(schedule&&!schedule.stopping)try{await this.schedules.stop(schedule);}catch(error){console.warn('[dsh-memory-dreaming] 自动任务收尾失败：',error.message);}await this.memory.close();});
  ctx.inject(['tools'],scope=>{
   // Scheduled maintenance Sessions may only invoke the typed memory_dream tool.
   // Denial is monotonic; it never auto-approves shell access or other permissions.
   scope.tools.guard(exec=>maintenanceToolDenial(exec,this.workflows,ctx));
   const tools=[['memory_dream','从当前会话整理 daily、dream 或 weekly 候选，普通会话不读取其他会话、不写入共享记忆文件；工作区归档通过记忆设置页或已启用的官方自动任务执行。',{kind:{type:'string',enum:['daily','dream','weekly']},day:{type:'string'}},async(args,exec,cwd)=>{
    const maintenance=exec.agent.session.id===this.sessionId(cwd),kind=args.kind??'dream';
    const scheduled=maintenance?this.workflows.current(exec.agent.session.id,kind).filter(row=>row.origin!=='manual'):[];
    if(maintenance&&!this.configFile.value.automatic&&scheduled.length){for(const row of scheduled)this.workflows.set(row.id,'cancelled','自动归档已关闭，本次记忆作业未执行。');if(!this.workflows.current(exec.agent.session.id,kind).some(row=>row.origin==='manual'))return{state:'cancelled',artifacts:[],message:'自动归档已关闭。'};}
    return maintenance?this.workflows.run(cwd,kind,exec,{signal:exec.signal,agent:exec.agent,day:args.day}):this.memory.run(cwd,kind,{signal:exec.signal,agent:exec.agent,day:args.day,sourceSessionId:exec.agent.session.id,draftOnly:true});
   }],['memory_search','检索当前工作区已确认的长期记忆；向量提供方失效时使用词语检索。',{query:{type:'string'},limit:{type:'integer',minimum:1,maximum:20}},(args,exec,cwd)=>this.memory.search(cwd,args.query,args.limit??8,exec.signal)],['memory_topics','只读查看已确认记忆的主题索引；再使用 memory_search 深入查找对应事实。',{},(_args,_exec,cwd)=>this.memory.topicIndex(cwd)]];
   for(const [name,description,properties,execute]of tools)scope.tools.register({name,description,parameters:{type:'object',properties,additionalProperties:false},output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(args,exec)=>{
    exec.signal.throwIfAborted();if(!this.configFile.value.enabled||!exec.agent)throw new Error('记忆插件已停用');const cwd=exec.agent.session.header.cwd,preset=ctx.get('sessionProjections')?.stateOf(exec.agent.session,'agentPreset');
    if(!cwd||typeof preset!=='string')throw new Error('当前会话缺少有效工作区或 Agent 预设');
    if((isUntrustedChannel(ctx,exec.agent.session)||channelSessionIds(ctx).has(exec.agent.session.id))&&!ownerChannelAuthorized(ctx,exec.agent.session.id,this.configFile.value))throw new Error('当前渠道会话未关联记忆主人身份，暂不能读取共享记忆');
    if(name!=='memory_dream'&&!this.configFile.value.recall)throw new Error('记忆检索已停用');
    const signal=AbortSignal.any([exec.signal,this.abort.signal,this.configAbort.signal]),task=execute(args,{...exec,signal},cwd);this.tasks.add(task);try{return await task;}finally{this.tasks.delete(task);}
   }});
  });
 }
 async operation(fn){if(this.abort.signal.aborted||!this.configFile.value.enabled)throw new RemoteError('memory/unavailable','记忆插件已停用',{});const revision=this.configFile.snapshot().revision,signal=AbortSignal.any([this.abort.signal,this.configAbort.signal]);
  const task=(async()=>{try{const cwd=await workspace(this.context,this.configFile.value,signal);if(revision!==this.configFile.snapshot().revision)throw new Error('设置已更新，请重新操作');signal.throwIfAborted();return JSON.parse(JSON.stringify(await fn(cwd,signal)));}catch(error){if(error instanceof RemoteError)throw error;throw new RemoteError('memory/operation-failed',error.message,{});}})();this.tasks.add(task);try{return await task;}finally{this.tasks.delete(task);}
 }
 status(){return this.operation(async cwd=>({...this.memory.status(cwd),vectorBusy:!!this.vectorRuns.get(this.memory.scope(cwd))?.busy,vectorResult:this.vectorRuns.get(this.memory.scope(cwd))?.result??null,manualResult:this.workflows.manualStatus(cwd),scheduleError:this.scheduleError,workflowError:this.workflowError,schedules:await this.scheduleRows(cwd),templates:this.schedules.rows(cwd),workflows:this.workflows.rows(cwd)}));}
 health({cwd,agentPreset,sessionId}={}){
  if(this.abort.signal.aborted)throw new Error('记忆插件已卸载');const config=this.configFile.value;
  // The Agent preset is an internal maintenance choice, not a source filter.
  const scope=cwd?this.memory.scope(cwd):null,where=scope?' WHERE scope=?':'',args=scope?[scope]:[];
  const states=Object.fromEntries(this.memory.db.prepare('SELECT state,COUNT(*) AS count FROM candidates'+where+' GROUP BY state').all(...args).map(row=>[row.state,row.count]));
  const workflows=this.workflows.counts(cwd,agentPreset??config.agentPreset);
  const last=this.memory.db.prepare('SELECT kind,state,started,ended FROM runs'+where+' ORDER BY started DESC LIMIT 1').get(...args);
  const recovery=Object.fromEntries(this.memory.db.prepare('SELECT state,COUNT(*) AS count FROM memory_commits'+where+' GROUP BY state').all(...args).map(row=>[row.state,row.count])),vectorCleanup=this.memory.db.prepare('SELECT COUNT(*) AS count FROM memory_vector_purge'+where).get(...args).count;
  return {enabled:config.enabled,automatic:config.automatic,busy:scope?this.memory.running.has(scope):this.memory.running.size>0,candidates:states,workflows,workflowError:!!this.workflowError,templates:this.schedules.counts(cwd,agentPreset??config.agentPreset),lastRun:last?{...last}:null,scheduleError:!!this.scheduleError,embeddingConfigured:!!config.embeddingProvider,vectorBusy:scope?!!this.vectorRuns.get(scope)?.busy:[...this.vectorRuns.values()].some(row=>row.busy),recovery,vectorCleanup};
 }
 runMemory(kind,day){return this.startMemory(kind,day);}
 startMemory(kind,day){return this.operation(async(cwd,signal)=>{
  // A manual request after archive uses the new bound Session as well.
  if(this.scheduleScope?.schedule&&this.configFile.value.automatic){this.reconcileLater();await this.queue;}
  const preset=this.configFile.value.agentPreset,existing=this.schedules.sessionId(cwd,preset);
  const registry=this.context.get('workspaceRegistry')??this.context.workspaceRegistry;
  if(this.scheduleScope?.schedule)await this.schedules.rotateArchived(this.scheduleScope.schedule,cwd,preset,signal);
  else if(registry?.archivedSessionIds?.includes(existing))throw new Error('原生 Schedule 未连接，无法安全接棒归档的维护会话');
  return startManualMemory(this.memory,this.workflows,this.context,this.scheduleScope?.sessionController,cwd,kind,{signal,day,sessionId:this.schedules.sessionId(cwd,this.configFile.value.agentPreset)});
 });}
 promote(id,confirmation){return this.operation((cwd,signal)=>this.memory.approve(cwd,id,confirmation,signal));}
 reaffirm(id,confirmation){return this.operation((cwd,signal)=>this.memory.reaffirm(cwd,id,confirmation,signal));}
 forget(id){return this.operation(cwd=>this.memory.forget(cwd,id));}
 inspectCommit(id){return this.operation(cwd=>this.memory.commits.inspect(cwd,id));}
 recheckCommits(){return this.operation(cwd=>{this.memory.retryVectorPurges(cwd);return{recovery:this.memory.commits.recover(cwd)};});}
 discardCommit(id,confirmation){return this.operation(cwd=>this.memory.commits.discard(cwd,id,confirmation));}
 retryVectorCleanup(){return this.operation(cwd=>this.memory.retryVectorPurges(cwd));}
 recheckWorkflows(){return this.operation(async(cwd,signal)=>{await this.workflows.recover(signal);this.workflowError='';this.reconcileLater();await this.queue;return{workflows:this.workflows.rows(cwd),templates:this.schedules.rows(cwd)};});}
 excludeSession(sessionId){return this.operation(cwd=>this.memory.forgetSession(cwd,sessionId));}
 search(query,limit){return this.operation((cwd,signal)=>this.memory.search(cwd,query,limit??8,signal));}
 cancel(){return this.operation(cwd=>{this.vectorRuns.get(this.memory.scope(cwd))?.abort?.abort();return this.memory.cancel(cwd);});}
 registerVectorProvider(name,provider){return this.memory.registerVectorProvider(name,provider);}
 registerEmbeddingProvider(name,provider){return this.memory.registerEmbeddingProvider(name,provider);}
 registerVectorStore(name,store){return this.memory.registerVectorStore(name,store);}
 rebuildVectors(){return this.operation((cwd,signal)=>this.memory.rebuildVectors(cwd,signal));}
 startRebuildVectors(){return this.operation((cwd,signal)=>{const id=this.memory.scope(cwd);if(this.vectorRuns.get(id)?.busy)throw new Error('向量索引正在更新');const abort=new AbortController(),entry={busy:true,abort,result:null};this.vectorRuns.set(id,entry);const task=this.memory.rebuildVectors(cwd,AbortSignal.any([signal,abort.signal]));this.tasks.add(task);task.then(result=>entry.result=result,error=>entry.result={error:error.message}).finally(()=>{entry.busy=false;entry.abort=null;this.tasks.delete(task);}).catch(()=>{});return {started:true};});}
 sessionId(cwd){return this.schedules.sessionId(cwd,this.configFile.value.agentPreset);}
 async scheduleRows(cwd){if(!this.scheduleScope)return [];return (await this.scheduleScope.schedule.catalog()).filter(task=>task.sessionId===this.sessionId(cwd));}
 ownsSchedule(task){return this.schedules.owns(task);}
 reconcileLater(){if(this.abort.signal.aborted)return;this.queue=this.queue.catch(()=>{}).then(()=>this.reconcile()).catch(error=>{this.scheduleError=error.message;});}
 async reconcile(){
  await this.workflowReady;
  const scope=this.scheduleScope;if(!scope)return;const config=this.configFile.value,revision=this.configFile.snapshot().revision;this.abort.signal.throwIfAborted();
  await this.schedules.reconcile(scope.schedule,scope.sessionController,config,this.abort.signal,()=>revision===this.configFile.snapshot().revision);this.scheduleError='';
 }
 async waiting(request,next,state){
  const session=request.agent?.session;if(!session?.id.startsWith('session-dsh-memory-')||this.abort.signal.aborted)return next();
  const rows=this.workflows.current(session.id);for(const row of rows)if(row.state==='running')this.workflows.set(row.id,state);
  try{return await next();}finally{if(!this.abort.signal.aborted)for(const row of rows)if(this.workflows.db.prepare('SELECT state FROM workflows WHERE id=?').get(row.id)?.state===state)this.workflows.set(row.id,'running');}
 }
 event(session,event){
  if(!session.id.startsWith('session-dsh-memory-')||this.abort.signal.aborted)return;
  const preset=this.context.get('sessionProjections')?.stateOf(session,'agentPreset')??session.header.agentPreset,identity=this.workflows.identity(session.header,preset);
  try{this.workflows.event(identity,event);}catch(error){this.workflowError='自动任务事件需要核对。';console.warn('[dsh-memory-dreaming] schedule ledger:',event.type,'seq',event.seq,error.message);const task=this.workflows.recover(this.abort.signal).catch(()=>{});this.tasks.add(task);task.finally(()=>this.tasks.delete(task)).catch(()=>{});}
 }
}
const initializers=[];for(const name of ['status','runMemory','startMemory','promote','reaffirm','forget','inspectCommit','recheckCommits','discardCommit','retryVectorCleanup','recheckWorkflows','excludeSession','search','cancel','rebuildVectors','startRebuildVectors'])Remote(MemoryDreaming.prototype[name],{kind:'method',name,static:false,private:false,addInitializer:fn=>initializers.push(fn)});
