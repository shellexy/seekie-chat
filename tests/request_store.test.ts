import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearRequests, deleteRequests, initRequestDirectory, loadRequests, pruneRequests, saveRequests } from '../electron/request_store';
import type { RequestRecord } from '../src/types';

const record = (index: number, body = '{}'): RequestRecord => ({ url: `https://fixture.invalid/v1/round-${index}`, method: 'POST', headers: { Authorization: '••••••••' }, body });
// Message ids are UUIDs in the app; these keep the same shape so the id guard is exercised.
const id = (name: string) => {
  let hash = 0; for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(0, 4)}-${hex.repeat(2).slice(0, 12)}`;
};
const directory = () => mkdtempSync(join(tmpdir(), 'seekie-requests-'));

test('request records survive in their own files', () => {
  const root = directory();
  try {
    const message = id('message1'), entries = [record(1), { ...record(2), error: '400 upstream rejected' }];
    saveRequests(root, message, entries);
    assert.deepEqual(loadRequests(root, message), entries);
    assert.deepEqual(loadRequests(root, id('missing1')), []);
    // Windows 的 stat.mode 是合成值（目录报 0o666），不反映 mkdir/writeFile 传入的 mode，权限位只在 POSIX 上有意义。
    if (process.platform !== 'win32') {
      assert.equal(statSync(join(root, 'requests')).mode & 0o777, 0o700, '记录目录只允许当前用户访问');
      assert.equal(statSync(join(root, 'requests', `${message}.json`)).mode & 0o777, 0o600);
    }
    saveRequests(root, message, []);
    assert.deepEqual(loadRequests(root, message), []);
    assert.deepEqual(readdirSync(join(root, 'requests')), [], '没有记录的消息不应留下空文件');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('request records ignore identifiers that could escape the directory', () => {
  const root = directory();
  try {
    saveRequests(root, '../../escaped', [record(1)]);
    assert.deepEqual(readdirSync(root), [], '非法 id 不得写出目录');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('request records are deleted with their conversation and cleared on import', () => {
  const root = directory();
  try {
    saveRequests(root, id('kept'), [record(1)]); saveRequests(root, id('removed'), [record(1)]);
    deleteRequests(root, [id('removed')]);
    assert.deepEqual(loadRequests(root, id('removed')), []); assert.equal(loadRequests(root, id('kept')).length, 1);
    saveRequests(root, id('other'), [record(2)]);
    clearRequests(root);
    assert.deepEqual(readdirSync(join(root, 'requests')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('request records are capped by total size, oldest message first', () => {
  const root = directory();
  try {
    initRequestDirectory(root);
    const body = 'x'.repeat(2000);
    const files: Array<[string, number]> = [[id('oldest'), 1_000_000], [id('middle'), 2_000_000], [id('newest'), 3_000_000]];
    for (const [message, seconds] of files) { saveRequests(root, message, [record(1, body)]); utimesSync(join(root, 'requests', `${message}.json`), seconds, seconds); }
    pruneRequests(root, 5000);
    assert.deepEqual(loadRequests(root, id('oldest')), [], '超出上限时先丢弃最旧的记录');
    assert.equal(loadRequests(root, id('middle')).length, 1);
    assert.equal(loadRequests(root, id('newest')).length, 1);
    pruneRequests(root, 1);
    assert.deepEqual(readdirSync(join(root, 'requests')), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a corrupt record file is ignored instead of breaking the debug view', () => {
  const root = directory();
  try {
    initRequestDirectory(root);
    const message = id('broken');
    writeFileSync(join(root, 'requests', `${message}.json`), '{not json', { mode: 0o600 });
    assert.deepEqual(loadRequests(root, message), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
