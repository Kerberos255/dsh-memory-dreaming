import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryReadAction} from '../memory-read-action.js';
test('memory search stays backward compatible while topics share the tool',async()=>{
 const seen=[];
 const api={topics:()=>({themes:['technical']}),search:(q,limit)=>{seen.push([q,limit]);return {matches:[]}}};
 assert.deepEqual(memoryReadAction({action:'topics'},api),{themes:['technical']});
 assert.deepEqual(memoryReadAction({query:'索引'},api),{matches:[]});
 assert.deepEqual(memoryReadAction({action:'search',query:'SQL',limit:3},api),{matches:[]});
 assert.deepEqual(seen,[['索引',5],['SQL',3]]);
 for(const args of [{action:'topics',query:'secret'},{action:'topics',limit:3},{action:'search'},
 {action:'unknown',query:'foo'},{query:'   '}])assert.throws(()=>memoryReadAction(args,api));
});
