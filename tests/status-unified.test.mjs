import test from 'node:test';
import assert from 'node:assert/strict';
import MemoryDreaming from '../index.js';
test('memory_search returns separate newer timeline evidence even if relevance ranks stale facts first',async()=>{
 const fake={
  memory:{taskSearch:()=>[],search:async()=>({mode:'lexical',matches:[{text:'PageLingo 翻译路由仍在处理',score:.95,source:'old'}]}),vectorIndex:{}},
  history:{
    search:async()=>[{id:'history-old',text:'PageLingo 翻译路由仍在处理',score:.9,kind:'historical'}],
    timeline:()=>[{state:'completed',date:'2026-10-12',text:'PageLingo 翻译路由已完成',path:'memory/2026-10-12.md'},
                 {state:'incomplete',date:'2026-10-10',text:'PageLingo 翻译路由进行中',path:'memory/2026-10-10.md'}],
    status:()=>({indexed:true})
  },
  configFile:{value:{embeddingProvider:''}},
  context:{get:()=>null}
 };
 const result=await MemoryDreaming.prototype.searchUnified.call(fake,'E:/test','PageLingo 翻译路由做好了吗',2);
 assert.equal(result.matches.length,2);
 assert.deepEqual(result.statusEvidence.map(row=>row.state),['completed','incomplete']);
 assert.match(result.temporalCaution,/历史记录/);
});
test('non-status lookup has no temporal overhead and no invented current status',async()=>{
 let timelineCalls=0;
 const fake={
  memory:{taskSearch:()=>[],search:async()=>({mode:'lexical',matches:[]}),vectorIndex:{}},
  history:{search:async()=>[],timeline:()=>{timelineCalls++;return []},status:()=>({indexed:true})},
  configFile:{value:{}},context:{get:()=>null}
 };
 const result=await MemoryDreaming.prototype.searchUnified.call(fake,'E:/test','PageLingo 架构方案',5);
 assert.equal(timelineCalls,0);
 assert.equal(result.statusEvidence,undefined);
});
