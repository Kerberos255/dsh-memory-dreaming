import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registeredWorkspace,ensureMaintenanceSession,MAINTENANCE_TITLE,maintenanceToolDenial,restrictMaintenanceTools } from '../session-setup.js';
import { MemorySchedules } from '../schedules.js';

function mock(){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-memory-workspace-'));
 const registry={list(){return [{id:'work-known',path:cwd,title:'小虎鲸'}];}};
 let title='',creation=[];
 const query={async observeSession(){return {header:{id:'session-dsh-memory-dummy',cwd,title},projections:{values:{}},events:title?[{type:'session/title'}]:[],[Symbol.dispose]() {}};}};
 const controller={
  async create(request){creation.push(request);return{sessionId:request.sessionId};},
  async rename(request){title=request.title;return{title}}
 };
 const ctx={get(name){return name==='workspaceRegistry'?registry:null;},sessionQuery:query};
 return{cwd,ctx,registry,controller,creation, get title(){return title;},close(){fs.rmSync(cwd,{recursive:true,force:true});}};
}
test('maintenance session uses native workspace id rather than ungrouped cwd',async()=>{
 const h=mock();
 try{
  const s=registeredWorkspace(h.ctx,h.cwd);
  assert.equal(s.id,'work-known');
  const res=await ensureMaintenanceSession(h.ctx,h.controller,{sessionId:'session-dsh-memory-dummy',cwd:h.cwd,preset:'agent'});
  assert.equal(res.workspaceId,'work-known');
  assert.deepEqual(h.creation[0],{sessionId:'session-dsh-memory-dummy',workspaceId:'work-known',agentPreset:'agent'});
  assert.equal(h.title,MAINTENANCE_TITLE);
  await ensureMaintenanceSession(h.ctx,h.controller,{sessionId:'session-dsh-memory-dummy',cwd:h.cwd,preset:'agent'});
  assert.equal(h.creation.length,2,'reconciliation can safely attach an existing session');
 }finally{h.close();}
});
test('missing registered workspace blocks creating any ungrouped Session',async()=>{
 const h=mock();
 try{
  h.registry.list=()=>[];
  await assert.rejects(ensureMaintenanceSession(h.ctx,h.controller,{sessionId:'session-123',cwd:h.cwd,preset:'agent'}),/尚未登记/);
  assert.equal(h.creation.length,0);
 }finally{h.close();}
});
test('existing user title is never overwritten by reconciliation',async()=>{
 const h=mock();
 try{
  await h.controller.rename({title:'用户命名',sessionId:'session-dsh-memory-dummy'});
  await ensureMaintenanceSession(h.ctx,h.controller,{sessionId:'session-dsh-memory-dummy',cwd:h.cwd,preset:'agent'});
  assert.equal(h.title,'用户命名');
 }finally{h.close();}
});
test('scheduled prompt prohibits skills, shell and privilege repair',()=>{
 const prompt=MemorySchedules.prototype.prompt.call({},'daily','token');
 assert.match(prompt,/只调用一次 memory_dream/);
 assert.match(prompt,/严禁执行命令/);
 assert.match(prompt,/申请提升权限/);
});

test('scheduled memory Agent is denied shell and skills without automatically granting permissions',()=>{
 const h=mock();
 try{
  const session={id:'session-dsh-memory-example',header:{cwd:h.cwd,agentPreset:'agent'}};
  const workflows={identity(){return {session:session.id};}};
  const ctx={get(){return null;}};
  assert.match(maintenanceToolDenial({agent:{session},name:'exec'},workflows,ctx),/禁止执行命令/);
  assert.match(maintenanceToolDenial({agent:{session},name:'skill'},workflows,ctx),/memory_dream/);
  assert.equal(maintenanceToolDenial({agent:{session},name:'memory_dream'},workflows,ctx),undefined);
  assert.equal(maintenanceToolDenial({agent:{session:{id:'ordinary',header:session.header}},name:'exec'},workflows,ctx),undefined);
  assert.match(maintenanceToolDenial({agent:{session},name:'exec'},{identity(){return null;}},ctx),/身份无法核验/);
 }finally{h.close();}
});

test('maintenance agent sees only memory_dream, ordinary agents are unaffected',()=>{
 let selected;
 const agent={session:{id:'session-dsh-memory-1234'},ctx:{inject(names,apply){assert.deepEqual(names,['tools']);apply({tools:{restrict(filter){selected=filter;}}});}}};
 assert.equal(restrictMaintenanceTools(agent),true);
 assert.deepEqual(selected,{allow:['memory_dream']});
 selected=null;agent.session.id='session-user';
 assert.equal(restrictMaintenanceTools(agent),false);
 assert.equal(selected,null);
});

test('a missing optional title service cannot block scheduled memory execution',async()=>{
 const h=mock();
 try{
  h.controller.rename=async()=>{throw Error('title backend missing');};
  const res=await ensureMaintenanceSession(h.ctx,h.controller,{sessionId:'session-dsh-memory-dummy',cwd:h.cwd,preset:'agent'});
  assert.equal(res.workspaceId,'work-known');
  assert.equal(h.creation.length,1);
 }finally{h.close();}
});
