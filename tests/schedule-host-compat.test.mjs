import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compatibleSchedule, timingOf } from '../schedule-host-compat.js';

const task = (id, sessionId = 's1') => ({ id, title: 'daily', prompt: 'summarize', kind: 'daily', time: '09:00:00.000', timeZone: 'Asia/Shanghai', scheduledAt: '2026-11-08T01:00:00.000Z', status: 'active', updatedAt: '2026-11-07T00:00:00.000Z', target: { kind: 'session', sessionId } });

test('v0.2.1 Schedule remains untouched', () => {
  const old = { update() {}, create() {}, catalog() {} };
  assert.equal(compatibleSchedule(old), old);
});

test('new Scheduler routes recurring maintenance to its existing Session, never a new one', async () => {
  const calls = [];
  const v2 = {
    catalog: async () => [task('old')],
    create: async (...args) => { calls.push(args); return task('new'); },
    edit: async () => task('old'),
    history: async () => ({ records: [] }),
  };
  const api = compatibleSchedule(v2);
  const rows = await api.catalog();
  assert.equal(rows[0].sessionId, 's1');
  assert.equal((await api.create('s1', { title: 'daily', prompt: 'p', daily: { time: '09:00:00.000', time_zone: 'Asia/Shanghai' } })).id, 'new');
  assert.deepEqual(calls[0][0].target, { kind: 'session', sessionId: 's1' });
  assert.equal(calls[0][0].timing.kind, 'daily');
  assert.equal(calls[0][1], undefined);
});

test('new edit uses optimistic concurrency, preserves legacy response and never edits another Session', async () => {
  const calls = [];
  const api = compatibleSchedule({ catalog: async () => [task('old')], create: async () => task('new'),
    edit: async (...args) => { calls.push(args); return { ...task('old'), prompt: 'edited' }; }, history: async () => ({records:[]}) });
  assert.equal((await api.update({ id: 'old', sessionId: 's2', title: 'x', prompt: 'y' })).code, 'schedule_not_found');
  assert.equal(calls.length, 0);
  const result = await api.update({id:'old', sessionId:'s1', title:'daily',prompt:'edited', expected: { updatedAt: '2026-11-07T00:00:00.000Z' }, change: {kind:'daily', daily:{time:'10:00:00.000',time_zone:'Asia/Shanghai'}}});
  assert.equal(result.record.prompt, 'edited');
  assert.equal(result.record.sessionId, 's1');
  assert.equal(calls[0][0].expectedUpdatedAt, '2026-11-07T00:00:00.000Z');
  assert.equal(calls[0][0].patch.timing.kind, 'daily');
  assert.equal((await api.update({ id: 'old', sessionId: 's1', expected: {updatedAt:'stale'}})).code, 'schedule_conflict');
  assert.equal(calls.length, 1);
});

test('new delete refuses unowned IDs and ambiguous outcomes rather than silently succeeding', async () => {
  let edits = 0;
  const api = compatibleSchedule({catalog:async () => [task('mine')],create:async()=>task('new'),history:async()=>({records:[]}),edit:async()=>{edits++;return {code:'schedule_conflict'};}});
  await assert.rejects(api.delete({id:'mine',sessionId:'alien'}), /ownership/);
  assert.equal(edits, 0);
  await assert.rejects(api.delete({id:'mine',sessionId:'s1'}), /unconfirmed/);
  assert.equal(edits, 1);
});

test('new history is bounded to the correct Session and timing selector validates input', async () => {
  const calls = [];
  const api = compatibleSchedule({catalog:async()=>[task('mine')],create:async()=>task('new'),edit:async()=>({deleted:true}),history:async req=>{calls.push(req);return {records:[]}}});
  assert.equal((await api.history({sessionId:'alien',id:'mine',limit:20})).code, 'schedule_not_found');
  await api.history({sessionId:'s1',id:'mine',limit:20});
  assert.deepEqual(calls,[{id:'mine',limit:20}]);
  assert.throws(()=>timingOf({title:'x'}),/unsupported schedule recurrence/);
});
