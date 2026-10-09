import fs from 'node:fs';

/** Attach the durable maintenance Session to the owning native Workspace.
 * Passing cwd alone creates a valid but "Ungrouped" Session in DSH.
 */
export function registeredWorkspace(ctx,cwd) {
 const registry=ctx.get?.('workspaceRegistry')??ctx.workspaceRegistry;
 const entries=registry?.list?.()??[];
 const target=fs.realpathSync(cwd);
 const match=entries.find(row=>{
  try {return row?.id&&row.path&&fs.realpathSync(row.path)===target;}
  catch{return false;}
 });
 if(!match)throw new Error('此工作区尚未登记到 DSH；请先在工作区列表创建或选择相应工作区，自动记忆不会创建未分组会话');
 return {id:match.id,path:target};
}

export const MAINTENANCE_TITLE='自动记忆 · 每日 / Dream / 每周复查';

export async function ensureMaintenanceSession(ctx,controller,{sessionId,cwd,preset,signal}) {
 const workspace=registeredWorkspace(ctx,cwd);
 // The controller attaches both newly created and adopted Sessions by workspaceId.
 await controller.create({sessionId,workspaceId:workspace.id,agentPreset:preset});
 // A managed Session that was archived cannot execute any Agent step.
 // Restore only the exact plugin-owned maintenance Session, never a user Session.
 const registry=ctx.get?.('workspaceRegistry')??ctx.workspaceRegistry;
 if(registry?.archivedSessionIds?.includes(sessionId)){
  if(typeof registry.unarchiveSession!=='function')throw new Error('记忆维护会话已归档，无法通过原生接口恢复');
  await registry.unarchiveSession(sessionId);
 }
 // Never overwrite a user-supplied title. Existing maintenance Sessions are stable
 // across schedule reloads, and title changes are durable native Session events.
 let observed;
 try{
  observed=await ctx.sessionQuery?.observeSession(sessionId,{signal});
  const events=observed?.events??[];
  const hasTitle=!!(observed?.header?.title||observed?.projections?.values?.title)
   ||events.some(e=>/title/i.test(e.type??''));
  if(!hasTitle&&typeof controller.rename==='function')try{
   await controller.rename({sessionId,title:MAINTENANCE_TITLE});
  }catch(error){console.warn('[dsh-memory-dreaming] 会话标题更新跳过：',error.code??error.message);}
 }finally{observed?.[Symbol.dispose]?.();}
 return {workspaceId:workspace.id,sessionId};
}

/** Monotonic tool denial for scheduled memory sessions; never grants approvals. */
export function maintenanceToolDenial(exec,workflows,ctx){
 const agent=exec.agent,session=agent?.session;
 if(!session?.id?.startsWith('session-dsh-memory-')||exec.name==='memory_dream')return;
 const preset=ctx.get?.('sessionProjections')?.stateOf(session,'agentPreset')??session.header?.agentPreset;
 // A damaged maintenance Session cannot use repair/privilege tools either.
 if(!workflows.identity(session.header,preset))return '记忆维护会话身份无法核验；禁止执行其他工具';
 return '自动记忆会话仅允许 memory_dream；禁止执行命令、技能修复或申请额外权限';
}

/** Hide unrelated tools from the maintenance Agent's model-facing tool catalog. */
export function restrictMaintenanceTools(agent){
 if(!agent?.session?.id?.startsWith('session-dsh-memory-'))return false;
 try{agent.ctx.inject(['tools'],scope=>scope.tools.restrict({allow:['memory_dream']}));}
 catch(error){console.warn('[dsh-memory-dreaming] 工具列表限制注册失败；执行守卫仍有效：',error.code??error.message);}
 return true;
}
