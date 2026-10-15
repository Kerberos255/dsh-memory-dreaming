import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeWorkspaceMemory } from '../memory-batches.js';
import { schema } from '../config.js';
import { MEMORY_PROMPT_DEFAULTS } from '../memory-prompts.js';

function fixture(){
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'dsh-prompt-')),requests=[];
 const ctx={
  agentDefaultModel:{currentSelection:()=>({provider:'p',model:'m'})},
  tokenMeter:{estimateMessage:obj=>Math.ceil(JSON.stringify(obj).length/3)+10},
  llm:{resolveModelInfo:async()=>({context:{contextWindow:131072,maxOutputTokens:16384},defaultMaxTokens:16384}),
   stream:async function*(request){requests.push(request);
    yield {type:'text-delta',index:0,text:JSON.stringify({facts:[],daily:request.messages[1].content[0].text.includes('"kind":"daily"')?'日报':'',dream:'',weekly:'周记'})};
    yield {type:'finish',reason:{kind:'stop'}};
   }},
 };
 const source=[{sessionId:'session-owner',seq:2,time:Date.parse('2026-10-12T05:00:00Z'),text:'PageLingo 路由已完成。'}];
 return {cwd,requests,ctx,source,close(){fs.rmSync(cwd,{recursive:true,force:true})}};
}
for(const kind of ['daily','dream','weekly']){
 test(kind+' has distinct content focus and mandatory unmodified JSON/source rules',async()=>{
  const f=fixture();try{
   const config={...schema.defaults,modelProvider:'p',model:'m'};
   const result=await completeWorkspaceMemory({ctx:f.ctx,cwd:f.cwd,config,kind,sources:f.source,redact:t=>t,summaryOnly:kind==='weekly'});
   assert.equal(result.batchCount,1);
   const sys=f.requests[0].messages[0].content[0].text;
   assert(sys.includes(MEMORY_PROMPT_DEFAULTS[kind]));
   assert(sys.includes('禁止')&&sys.includes('JSON')&&sys.includes('来源'));
   if(kind==='weekly')assert(sys.includes('每周记忆归档编辑'));
   else assert(sys.includes('严格输出一个 JSON 对象'));
  }finally{f.close();}
 });
}
test('customization changes priorities but never removes the mandatory JSON protocol',async()=>{
 const f=fixture();try{
  const config=schema.validate({...schema.defaults,modelProvider:'p',model:'m',dailyPrompt:'只记录已验证的 PageLingo 状态'});
  await completeWorkspaceMemory({ctx:f.ctx,cwd:f.cwd,config,kind:'daily',sources:f.source,redact:t=>t});
  const system=f.requests[0].messages[0].content[0].text;
  assert(system.includes('只记录已验证的 PageLingo 状态'));
  assert(system.includes('严格输出一个 JSON 对象'));
  assert(!system.includes(MEMORY_PROMPT_DEFAULTS.daily));
  assert.equal(schema.validate({...schema.defaults}).dailyPrompt,MEMORY_PROMPT_DEFAULTS.daily);
  assert.throws(()=>schema.validate({...schema.defaults,dailyPrompt:'x'.repeat(3001)}),/取值无效/);
 }finally{f.close();}
});
