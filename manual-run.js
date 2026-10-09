import { randomUUID } from 'node:crypto';
import { ensureMaintenanceSession } from './session-setup.js';
import { maintenanceSession, manualPrompt, workflowKinds } from './workflows.js';

/** Manual and scheduled work enter the same native maintenance Session.
 * The prompt receipt is durable before admission; only the trusted native
 * requestId and exact prompt can claim the corresponding workflow.
 */
export async function startManualMemory(memory,ledger,ctx,controller,cwd,kind,{signal,day,sessionId=maintenanceSession(cwd,memory.getConfig().agentPreset)}={}){
 if(!workflowKinds.includes(kind))throw new Error('记忆任务类型无效');
 if(!controller?.create||!controller?.prompt)throw new Error('原生 Session 投递接口尚未就绪');
 signal?.throwIfAborted();
 const config=memory.getConfig(),scope=memory.scope(cwd);
 const date=day??new Intl.DateTimeFormat('en-CA',{timeZone:config.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new Error('手动整理日期无效');
 if(memory.running.has(scope)||ledger.hasActive(cwd))throw new Error('该工作区已有记忆整理任务，请等待完成后再试');
 await ensureMaintenanceSession(ctx,controller,{sessionId,cwd,preset:config.agentPreset,signal});
 signal?.throwIfAborted();
 const requestId=randomUUID(),prompt=manualPrompt(kind,requestId,date);
 const workflow=ledger.queueManual(cwd,config.agentPreset,kind,requestId,prompt,date,config.timeZone,sessionId);
 try{
  const accepted=await controller.prompt({sessionId,requestId,mode:'queue',content:[{type:'text',text:prompt}]},signal);
  if(accepted?.accepted!==true)throw new Error('原生 Session 未确认接收手动任务');
  ledger.admitManual(workflow.id);
 }catch(error){ledger.set(workflow.id,'failed','投递至原生 Session 失败：'+(error instanceof Error?error.message:String(error)));throw error;}
 return{started:true,kind,sessionId,workflow:workflow.id};
}
