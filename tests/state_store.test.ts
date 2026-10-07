import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dropBlobState, hasBlobState, initStateSchema, loadState, normalizedIsEmpty, primeCache, readBlobState, saveMessage, saveState } from '../electron/state_store';
import { addMessage, createConversation, initialState, uid } from '../src/domain';
import { validateState } from '../src/validation';
import type { AppState, Message } from '../src/types';

function fixture() {
  const state = initialState();
  const conversation = createConversation(state.settings);
  addMessage(conversation, conversation.branches[0], 'user', '第一个问题');
  const answer = addMessage(conversation, conversation.branches[0], 'assistant', '第一个回答');
  answer.status = 'complete'; answer.reasoning = '推理内容'; answer.tools = [{ id: uid(), name: 'exa_search', input: '{}', output: '结果', status: 'done', started: 1, elapsed: 9 }];
  state.conversations = [conversation]; state.selectedId = conversation.id;
  return state;
}

// Counts the statements a save actually issues, which is what "only writes what changed" means.
function counting(db: DatabaseSync) {
  const statements: string[] = [];
  return {
    statements,
    database: {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => {
        const statement = db.prepare(sql);
        if (!sql.startsWith('SELECT')) statements.push(sql);
        return { all: () => statement.all(), get: (...params: unknown[]) => statement.get(...params as never[]), run: (...params: unknown[]) => statement.run(...params as never[]) };
      }
    } as unknown as DatabaseSync
  };
}

test('state survives a round trip through the normalised tables', () => {
  const db = new DatabaseSync(':memory:');
  initStateSchema(db);
  const state = fixture();
  const cache = new Map<string, string>();
  saveState(db, state, cache);
  assert.deepEqual(loadState(db), state, '写进表再读出来必须与原状态完全一致');
  assert.doesNotThrow(() => validateState(loadState(db)));
  // Branches and messages keep their order even with several conversations interleaved.
  const second = createConversation(state.settings);
  addMessage(second, second.branches[0], 'user', '第二个会话的问题');
  const merged: AppState = { ...state, conversations: [second, state.conversations[0]] };
  saveState(db, merged, cache);
  const reloaded = loadState(db)!;
  assert.deepEqual(reloaded.conversations.map(conversation => conversation.id), [second.id, state.conversations[0].id]);
  assert.deepEqual(reloaded.conversations[1].messages.map(message => message.text), ['第一个问题', '第一个回答']);
});

test('a save writes only the rows that changed and deletes the rows that disappeared', () => {
  const db = new DatabaseSync(':memory:');
  initStateSchema(db);
  const state = fixture();
  const cache = new Map<string, string>();

  const first = counting(db); saveState(first.database, state, cache);
  assert.ok(first.statements.length >= 5, '第一次写入要落库');
  const conversation = state.conversations[0], answer = conversation.messages[1];

  // Nothing changed at all: no writes.
  const idle = counting(db); assert.equal(saveState(idle.database, state, cache), 0);
  assert.deepEqual(idle.statements, []);

  // Only the streaming message changed: exactly one row is written.
  answer.text += '，继续输出';
  const streaming = counting(db); assert.equal(saveState(streaming.database, state, cache), 1);
  assert.equal(streaming.statements.length, 1);
  assert.match(streaming.statements[0], /INSERT OR REPLACE INTO messages/);
  assert.equal(loadState(db)!.conversations[0].messages[1].text, '第一个回答，继续输出');

  // A deleted version disappears from the table as well.
  const removed = conversation.messages.pop()!;
  const deletion = counting(db); saveState(deletion.database, state, cache);
  assert.equal(deletion.statements.length, 1);
  assert.match(deletion.statements[0], /^DELETE FROM messages/);
  assert.equal(loadState(db)!.conversations[0].messages.length, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM messages WHERE id=?').get(removed.id)!.n, 0);
});

test('the streaming fast path updates a single row', () => {
  const db = new DatabaseSync(':memory:');
  initStateSchema(db);
  const state = fixture();
  const cache = new Map<string, string>();
  saveState(db, state, cache);
  primeCache(db, state, cache);
  const conversation = state.conversations[0], message: Message = conversation.messages[1];
  assert.equal(saveMessage(db, cache, conversation.id, 1, message), false, '没有变化就不写');
  message.text += '流式追加';
  assert.equal(saveMessage(db, cache, conversation.id, 1, message), true);
  assert.equal(loadState(db)!.conversations[0].messages[1].text, '第一个回答流式追加');
  assert.equal(saveMessage(db, cache, conversation.id, 1, message), false, '写完立刻再存不应重复写');
});

test('a database written as one blob is recognised and can be migrated', () => {
  // The committed fixture is a real database from the sql.js release: state blob + secrets + the
  // legacy requests table. It is copied because migrating drops tables from the file.
  const root = mkdtempSync(join(tmpdir(), 'state-store-'));
  cpSync(join(process.cwd(), 'tests/fixtures/legacy-chat.sqlite'), join(root, 'chat.sqlite'));
  const db = new DatabaseSync(join(root, 'chat.sqlite'));
  try {
    initStateSchema(db);
    assert.equal(normalizedIsEmpty(db), true);
    assert.equal(hasBlobState(db), true);
    const blob = readBlobState(db)!;
    assert.equal(blob.conversations[0].messages[0].text, '旧库里的提问');
    const cache = new Map<string, string>();
    saveState(db, blob, cache);
    dropBlobState(db);
    assert.equal(hasBlobState(db), false);
    assert.deepEqual(loadState(db), blob, '迁移后读出来的状态必须与旧的整份状态一致');
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='state'").get()!.n, 0);
  } finally {
    db.close(); rmSync(root, { recursive: true, force: true });
  }
});
