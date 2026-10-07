import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import initSqlJs, { type Database } from 'sql.js';
import { clearRequests, deleteRequests, initRequestTable, loadRequests, pruneRequests, saveRequests } from '../electron/request_store';
import type { RequestRecord } from '../src/types';

const record = (index: number, body = '{}'): RequestRecord => ({ url: `https://fixture.invalid/v1/round-${index}`, method: 'POST', headers: { Authorization: '••••••••' }, body });

async function database(): Promise<Database> {
  const SQL = await initSqlJs({ locateFile: () => join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm') });
  const db = new SQL.Database();
  initRequestTable(db);
  return db;
}

test('request records survive a reload of the database', async () => {
  const db = await database();
  const entries = [record(1), { ...record(2), error: '400 upstream rejected' }];
  saveRequests(db, 'message-1', entries);
  assert.deepEqual(loadRequests(db, 'message-1'), entries);
  assert.deepEqual(loadRequests(db, 'never-recorded'), []);
  const file = db.export();
  const SQL = await initSqlJs({ locateFile: () => join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm') });
  const reopened = new SQL.Database(file); initRequestTable(reopened as Database);
  assert.deepEqual(loadRequests(reopened as Database, 'message-1'), entries, '记录必须随数据库文件持久保存');
});

test('request records are dropped for deleted conversations and cleared on import', async () => {
  const db = await database();
  saveRequests(db, 'kept', [record(1)]); saveRequests(db, 'removed', [record(1)]);
  deleteRequests(db, ['removed']);
  assert.deepEqual(loadRequests(db, 'removed'), []); assert.equal(loadRequests(db, 'kept').length, 1);
  saveRequests(db, 'kept', []);
  assert.deepEqual(loadRequests(db, 'kept'), [], '没有记录的消息不应留下空行');
  saveRequests(db, 'other', [record(2)]);
  clearRequests(db);
  assert.deepEqual(loadRequests(db, 'other'), []);
});

test('request records are capped by total size, oldest message first', async () => {
  const db = await database();
  const body = 'x'.repeat(2000);
  saveRequests(db, 'oldest', [record(1, body)], 1000);
  saveRequests(db, 'middle', [record(2, body)], 2000);
  saveRequests(db, 'newest', [record(3, body)], 3000);
  pruneRequests(db, 5000);
  assert.deepEqual(loadRequests(db, 'oldest'), [], '超出上限时先丢弃最旧的记录');
  assert.equal(loadRequests(db, 'middle').length, 1);
  assert.equal(loadRequests(db, 'newest').length, 1);
  pruneRequests(db, 1);
  assert.deepEqual(loadRequests(db, 'middle'), []); assert.deepEqual(loadRequests(db, 'newest'), []);
});

test('request records keep the newest message when timestamps collide', async () => {
  const db = await database();
  const body = 'x'.repeat(2000);
  for (const id of ['first', 'second']) saveRequests(db, id, [record(1, body)], 1000);
  saveRequests(db, 'third', [record(2, body)], 1000);
  pruneRequests(db, 5000);
  assert.deepEqual(loadRequests(db, 'third').length, 1, '同一毫秒内写入时也要按写入顺序保留最新');
  assert.deepEqual(loadRequests(db, 'first'), []);
});

test('request records tolerate a corrupt payload', async () => {
  const db = await database();
  db.run('INSERT INTO requests (message_id,created,payload) VALUES (?,?,?)', ['broken', Date.now(), '{not json']);
  assert.deepEqual(loadRequests(db, 'broken'), []);
});
