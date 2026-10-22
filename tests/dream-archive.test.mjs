import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archiveDreamBlocks, expiredDreamBlocks, mergeArchive, parseDreamBlocks, stripDreamBlocks } from '../dream-archive.js';

const block = (day, body = '内容') => [
  `<!-- dsh-memory:dream-${day} -->`,
  `## ${day} · 记忆巩固`,
  '',
  body,
  `<!-- /dsh-memory:dream-${day} -->`,
].join('\n');

const sample = ['# DREAMS', '', '人工写在文件开头的一段话。', '', block('2026-08-01'), '', block('2026-10-20'), ''].join('\n');

test('managed blocks are located without touching human text', () => {
  const blocks = parseDreamBlocks(sample);
  assert.deepEqual(blocks.map(item => item.day), ['2026-08-01', '2026-10-20']);
  assert.ok(sample.slice(blocks[0].start, blocks[0].end).startsWith('<!-- dsh-memory:dream-2026-08-01 -->'));
});

test('a block with a missing closing marker is left alone', () => {
  const broken = '<!-- dsh-memory:dream-2026-08-01 -->\n没有结束标记';
  assert.deepEqual(parseDreamBlocks(broken), []);
  assert.equal(stripDreamBlocks(broken, []), broken);
});

test('retention keeps the newest N days and nothing older', () => {
  const blocks = parseDreamBlocks(sample);
  assert.deepEqual(expiredDreamBlocks(blocks, '2026-10-22', 30).map(item => item.day), ['2026-08-01']);
  assert.deepEqual(expiredDreamBlocks(blocks, '2026-10-22', 90), []);
  assert.deepEqual(expiredDreamBlocks(blocks, '2026-10-22', 0), [], 'retention 0 keeps everything');
});

test('stripping removes only managed ranges and tidies blank lines', () => {
  const text = stripDreamBlocks(sample, expiredDreamBlocks(parseDreamBlocks(sample), '2026-10-22', 30));
  assert.ok(text.includes('人工写在文件开头的一段话。'));
  assert.ok(text.includes('dream-2026-10-20'));
  assert.ok(!text.includes('dream-2026-08-01'));
  assert.ok(!/\n{3,}/.test(text));
});

test('the archive merge is idempotent per day', () => {
  const blocks = parseDreamBlocks(sample);
  const once = mergeArchive('', sample, blocks);
  const twice = mergeArchive(once, sample, blocks);
  assert.equal(twice, null, 'the same days are never appended twice');
  assert.equal((once.match(/dsh-memory:dream-2026-08-01/g) ?? []).length, 2, 'open and close marker');
});

test('archiving moves old blocks into a monthly file and keeps recent ones in place', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dream-archive-'));
  try {
    fs.writeFileSync(path.join(cwd, 'DREAMS.md'), sample, 'utf8');
    const result = archiveDreamBlocks({ cwd, today: '2026-10-22', retentionDays: 30 });
    assert.deepEqual(result.archived, ['2026-08-01']);
    assert.deepEqual(result.files, ['memory/history/dreams/2026-08.md']);

    const dreams = fs.readFileSync(path.join(cwd, 'DREAMS.md'), 'utf8');
    assert.ok(!dreams.includes('2026-08-01'), 'the old block left DREAMS.md');
    assert.ok(dreams.includes('2026-10-20'), 'the recent block stayed');
    assert.ok(dreams.includes('人工写在文件开头的一段话。'), 'human text survived');

    const archive = fs.readFileSync(path.join(cwd, 'memory/history/dreams/2026-08.md'), 'utf8');
    assert.ok(archive.includes('2026-08-01'), 'the old block is preserved in the archive');

    const again = archiveDreamBlocks({ cwd, today: '2026-10-22', retentionDays: 30 });
    assert.deepEqual(again.archived, [], 'a second run has nothing left to move');
    assert.equal(fs.readFileSync(path.join(cwd, 'memory/history/dreams/2026-08.md'), 'utf8'), archive, 'the archive is unchanged');
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
