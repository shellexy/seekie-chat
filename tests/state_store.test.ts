import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStateSchema, loadState, loadWindowRow, primeCache, saveMessage, saveState, saveWindowRow, type WindowLayoutCache } from '../electron/state_store';
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

test('窗口布局单独一行，全量保存不会把它带走', () => {
  const db = new DatabaseSync(':memory:');
  initStateSchema(db);
  const cache = new Map<string, string>();
  const layoutCache: WindowLayoutCache = {};
  const layout = { x: 40, y: 20, width: 1200, height: 800, maximized: false, outline: false };
  assert.equal(loadWindowRow(db, layoutCache), undefined, '第一次运行没有存档');
  assert.equal(saveWindowRow(db, layoutCache, layout), true);
  assert.deepEqual(loadWindowRow(db, layoutCache), layout);
  assert.equal(saveWindowRow(db, layoutCache, layout), false, '没改动就不该再写盘');
  // 全量保存会把状态里没有的行删掉，布局不在状态里，所以它必须活下来。
  saveState(db, fixture(), cache);
  assert.deepEqual(loadWindowRow(db, layoutCache), layout, '窗口布局不该被会话状态的清理逻辑删掉');
  // 写坏的行只让布局退回默认值，不能把整个应用挡在门外。
  db.prepare("INSERT OR REPLACE INTO window_layout (key, value) VALUES ('layout', ?)").run('{oops');
  assert.equal(loadWindowRow(db, layoutCache), undefined);
  assert.doesNotThrow(() => loadState(db), 'meta 表与布局无关，坏掉的布局不能拖垮状态读取');
});
