import fs from 'node:fs';
import { readBounded, writeCAS, digest, safePath, ownedDirectory } from './workspace-io.js';

/** Managed Dream blocks as [start,end) ranges. A block whose closing marker is
 *  missing is skipped, so a hand-edited file is never cut by the archiver. */
export function parseDreamBlocks(text = '') {
  const blocks = [];
  const open = /<!-- dsh-memory:dream-(\d{4}-\d{2}-\d{2}) -->/g;
  let match;
  while ((match = open.exec(text))) {
    const day = match[1];
    const close = `<!-- /dsh-memory:dream-${day} -->`;
    const stop = text.indexOf(close, match.index + match[0].length);
    if (stop < 0) continue;
    blocks.push({ day, start: match.index, end: stop + close.length });
  }
  return blocks;
}

const cutoffDay = (today, days) => {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
};

/** Retention 0 keeps every block: DREAMS.md then grows until the 1 MB guard. */
export function expiredDreamBlocks(blocks, today, retentionDays) {
  if (!(retentionDays > 0)) return [];
  const limit = cutoffDay(today, retentionDays);
  return blocks.filter(block => block.day < limit);
}

/** Remove only managed ranges; human text outside them is preserved verbatim. */
export function stripDreamBlocks(text, blocks) {
  let output = text;
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    output = output.slice(0, block.start) + output.slice(block.end);
  }
  return output.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}

/** Append only days the archive does not have yet, so re-runs stay idempotent. */
export function mergeArchive(existing, text, blocks) {
  const have = new Set(parseDreamBlocks(existing).map(block => block.day));
  const add = blocks.filter(block => !have.has(block.day)).map(block => text.slice(block.start, block.end)).join('\n\n');
  if (!add) return null;
  const head = existing.trimEnd();
  return (head ? head + '\n\n' : '') + add + '\n';
}

/** Move Dream blocks older than the retention window into
 *  memory/history/dreams/<YYYY-MM>.md. The archive is written first, so a crash
 *  can duplicate a block but can never lose it. */
export function archiveDreamBlocks({ cwd, today, retentionDays = 30, maxBytes = 1048576 } = {}) {
  const source = safePath(cwd, 'DREAMS.md');
  const text = readBounded(source, maxBytes);
  if (text === null) return { archived: [], files: [] };
  const expired = expiredDreamBlocks(parseDreamBlocks(text), today, retentionDays);
  if (!expired.length) return { archived: [], files: [] };
  const byMonth = new Map();
  for (const block of expired) byMonth.set(block.day.slice(0, 7), [...(byMonth.get(block.day.slice(0, 7)) ?? []), block]);
  const files = [];
  for (const [month, blocks] of [...byMonth].sort(([a], [b]) => a.localeCompare(b))) {
    const relative = `memory/history/dreams/${month}.md`;
    ownedDirectory(cwd, 'memory/history/dreams');
    const target = safePath(cwd, relative);
    const existing = readBounded(target, maxBytes) ?? '';
    const merged = mergeArchive(existing, text, blocks);
    if (merged) writeCAS(target, merged, existing === '' ? null : digest(existing), maxBytes);
    files.push(relative);
  }
  writeCAS(source, stripDreamBlocks(text, expired), digest(text), maxBytes);
  return { archived: expired.map(block => block.day), files };
}
