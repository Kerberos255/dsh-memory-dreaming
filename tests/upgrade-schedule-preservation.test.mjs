import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Dream shutdown preserves native schedules across Host restart and plugin reload', () => {
  const plugin = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  const scheduler = readFileSync(new URL('../schedules.js', import.meta.url), 'utf8');
  assert.doesNotMatch(plugin, /await\s+this\.schedules\.stop\(/);
  // Explicitly disabling automatic maintenance is still handled by reconciliation,
  // rather than being coupled to the shutdown/destructor order.
  assert.match(scheduler, /if\s*\(config\.enabled&&config\.automatic\)/);
  assert.match(scheduler, /if\s*\(!scope\|\|row\.scope!==scope\)\s*await\s+this\.retire/);
});

test('Dream schedule adapter retains v1 native task identities and never recreates on catalog', async () => {
  const { compatibleSchedule } = await import('../schedule-host-compat.js');
  const original = { id: 'schedule-existing', status: 'active', kind: 'daily',
    title: 'daily', prompt: 'keep original', time: '09:00:00.000', timeZone: 'Asia/Shanghai',
    scheduledAt: '2026-11-08T01:00:00.000Z',
    target: { kind: 'session', sessionId: 'session-existing' },
    lastDelivery: { messageId: 'msg-existing', scheduledAt: '2026-11-07T01:00:00.000Z',
      deliveredAt: '2026-11-07T01:00:01.000Z', targetSessionId: 'session-existing' } };
  let writes = 0;
  const v2 = {
    catalog: async () => [original],
    create: async () => { writes++; throw new Error('unexpected create'); },
    edit: async () => { writes++; throw new Error('unexpected edit'); },
    history: async () => { writes++; throw new Error('unexpected history'); },
  };
  const adapted = compatibleSchedule(v2);
  const entries = await adapted.catalog();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'schedule-existing');
  assert.equal(entries[0].sessionId, 'session-existing');
  assert.deepEqual(entries[0].lastDelivery, original.lastDelivery);
  assert.equal(writes, 0);
});
