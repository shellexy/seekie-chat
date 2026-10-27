import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepAttachmentFiles } from '../electron/attachment_files';

test('sweepAttachmentFiles removes files that no message or draft references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seekie-attach-'));
  try {
    mkdirSync(join(dir, 'attachments'));
    for (const name of ['a.txt', 'b.txt', 'c.txt', 'stray.tmp']) writeFileSync(join(dir, 'attachments', name), 'x');
    // 引用集合里是附件 id，不是文件名；目录里任何不认识的东西都算孤儿（含写盘残留）。
    const removed = sweepAttachmentFiles(dir, ['a', 'b']);
    assert.deepEqual(removed.sort(), ['c.txt', 'stray.tmp']);
    assert.deepEqual(readdirSync(join(dir, 'attachments')).sort(), ['a.txt', 'b.txt']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sweepAttachmentFiles tolerates a missing attachments directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'seekie-attach-'));
  // 还没写过任何附件时目录可能不存在，这时不该抛错、也不该顺手建目录。
  try {
    assert.deepEqual(sweepAttachmentFiles(dir, ['a']), []);
    assert.deepEqual(readdirSync(dir), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
