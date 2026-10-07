import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { clearRequests, deleteRequests, initRequestDirectory, loadRequests, migrateRequestTable, pruneRequests, saveRequests } from '../electron/request_store';
import { validateState } from '../src/validation';
import type { RequestRecord } from '../src/types';

const record = (index: number, body = '{}'): RequestRecord => ({ url: `https://fixture.invalid/v1/round-${index}`, method: 'POST', headers: { Authorization: '••••••••' }, body });
// Message ids are UUIDs in the app; these keep the same shape so the id guard is exercised.
const id = (name: string) => {
  let hash = 0; for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  const hex = hash.toString(16).padStart(8, '0');
  return `${hex}-${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(0, 4)}-${hex.repeat(2).slice(0, 12)}`;
};
const directory = () => mkdtempSync(join(tmpdir(), 'deepchan-requests-'));
function database() { return new DatabaseSync(':memory:'); }

test('request records survive in their own files', () => {
  const root = directory();
  try {
    const message = id('message1'), entries = [record(1), { ...record(2), error: '400 upstream rejected' }];
    saveRequests(root, message, entries);
    assert.deepEqual(loadRequests(root, message), entries);
    assert.deepEqual(loadRequests(root, id('missing1')), []);
    assert.equal(statSync(join(root, 'requests')).mode & 0o777, 0o700, '记录目录只允许当前用户访问');
    assert.equal(statSync(join(root, 'requests', `${message}.json`)).mode & 0o777, 0o600);
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

test('records stored by the previous release move out of the database table', () => {
  const root = directory();
  try {
    const db = database();
    db.exec('CREATE TABLE requests (message_id TEXT PRIMARY KEY, created INTEGER NOT NULL, payload TEXT NOT NULL)');
    const message = id('legacy');
    db.prepare('INSERT INTO requests (message_id,created,payload) VALUES (?,?,?)').run(message, Date.now(), JSON.stringify([record(7)]));
    mkdirSync(join(root, 'requests'), { recursive: true });
    migrateRequestTable(db, root);
    assert.equal(loadRequests(root, message).length, 1, '旧表里的记录必须迁移成文件');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='requests'").all().length, 0, '迁移后删除旧表');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a database written by the previous sql.js release still opens', () => {
  // tests/fixtures/legacy-chat.sqlite was produced by the sql.js code path (state + secrets +
  // legacy requests table), so this guards the upgrade path for existing installs. It is copied
  // first because migrating drops the legacy table, and the fixture must stay untouched.
  const root = directory();
  cpSync(join(process.cwd(), 'tests/fixtures/legacy-chat.sqlite'), join(root, 'chat.sqlite'));
  const db = new DatabaseSync(join(root, 'chat.sqlite'));
  const state = JSON.parse((db.prepare('SELECT payload FROM state WHERE id=1').get() as { payload: string }).payload);
  assert.doesNotThrow(() => validateState(state), '旧库的状态必须仍然合法');
  assert.equal(state.conversations[0].messages[1].text, '旧库里的回答');
  const secrets = db.prepare('SELECT id, payload FROM secrets').all() as { id: string; payload: string }[];
  assert.equal(Buffer.from(secrets[0].payload, 'base64').toString(), 'legacy-ciphertext', '密文必须原样保留');
  try {
    migrateRequestTable(db, root);
    assert.equal(loadRequests(root, state.conversations[0].messages[1].id).length, 1, '旧库里的请求记录也要迁移');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
