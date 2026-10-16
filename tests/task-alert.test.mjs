import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowLedger } from '../workflows.js';

test('only first scheduled failure emits optional task alert after state persistence', async () => {
  let state='running',origin='scheduled',emitted=[],writes=0;
  const ledger=Object.create(WorkflowLedger.prototype);
  ledger.db={prepare(sql){
    if(sql.startsWith('SELECT state FROM workflows'))return {get:()=>({state})};
    if(sql.startsWith('UPDATE workflows SET state='))return {run(next){state=next;writes++;}};
    if(sql.startsWith('SELECT origin,kind FROM workflows'))return {get:()=>({origin,kind:'daily'})};
    throw Error('Unexpected SQL');
  }};
  ledger.ctx={get:()=>null,emit:(name,payload)=>{emitted.push({name,payload,persisted:state==='failed'})}};
  ledger.set('run-id','failed','model error');
  await new Promise(setImmediate);
  assert.equal(writes,1);
  assert.deepEqual(emitted,[{name:'dsh/task-alert',payload:{source:'dsh-memory-dreaming',id:'run-id',kind:'daily',origin:'scheduled',state:'failed'},persisted:true}]);
  ledger.set('run-id','failed','same error');
  await new Promise(setImmediate);
  assert.equal(emitted.length,1);
  state='running';origin='manual';
  ledger.set('manual-id','failed','error');
  await new Promise(setImmediate);
  assert.equal(emitted.length,1);
});
