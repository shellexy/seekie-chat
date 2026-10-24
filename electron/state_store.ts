import type { AppState, Branch, Conversation, Message } from '../src/types';

// The database is one row per entity instead of one document per application, so a save writes only
// what actually changed: during streaming that is a single message row rather than the whole state.
// The driver surface is kept structural so node:sqlite satisfies it and tests can wrap it.
export interface StateStatement { all(): unknown[]; get(...params: unknown[]): unknown; run(...params: unknown[]): unknown }
export interface StateDatabase { exec(sql: string): unknown; prepare(sql: string): StateStatement }

const SCHEMA = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, position INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, position INTEGER NOT NULL, payload TEXT NOT NULL);`;

/**
 * What was written last time, keyed by `meta:<key>` / `c:` / `b:` / `m:`. The value carries the row
 * position as well, because a conversation, branch or message can move without its payload changing.
 */
export type StateCache = Map<string, string>;
const signature = (payload: string, position?: number) => position === undefined ? payload : `${position}\u0000${payload}`;

export function initStateSchema(db: StateDatabase) { db.exec(SCHEMA); }

function rows(db: StateDatabase, sql: string): Record<string, unknown>[] { return db.prepare(sql).all() as Record<string, unknown>[]; }

/** Rebuilds the application state, or undefined when this database has never been written. */
export function loadState(db: StateDatabase): AppState | undefined {
  const meta = new Map(rows(db, 'SELECT key, value FROM meta').map(row => [String(row.key), JSON.parse(String(row.value)) as unknown]));
  if (!meta.has('settings')) return undefined;
  const conversations = rows(db, 'SELECT id, payload FROM conversations ORDER BY position').map(row => ({ ...JSON.parse(String(row.payload)) as Conversation, branches: [] as Branch[], messages: [] as Message[] }));
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  for (const row of rows(db, 'SELECT conversation_id, payload FROM branches ORDER BY position')) byId.get(String(row.conversation_id))?.branches.push(JSON.parse(String(row.payload)) as Branch);
  for (const row of rows(db, 'SELECT conversation_id, payload FROM messages ORDER BY position')) byId.get(String(row.conversation_id))?.messages.push(JSON.parse(String(row.payload)) as Message);
  const selectedId = meta.get('selectedId');
  return { settings: meta.get('settings') as AppState['settings'], conversations, selectedId: typeof selectedId === 'string' ? selectedId : null };
}

/** Writes the rows whose payload changed and deletes the rows that disappeared. */
export function saveState(db: StateDatabase, state: AppState, cache: StateCache) {
  const next: StateCache = new Map();
  let written = 0;
  const put = (key: string, position: number | undefined, run: (payload: string) => void, payload: string) => {
    const current = signature(payload, position);
    next.set(key, current);
    if (cache.get(key) === current) return;
    run(payload); written++;
  };
  put('meta:settings', undefined, payload => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('settings', payload), JSON.stringify(state.settings));
  put('meta:selectedId', undefined, payload => db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?,?)').run('selectedId', payload), JSON.stringify(state.selectedId ?? null));
  for (const [index, conversation] of state.conversations.entries()) {
    const { branches, messages, ...header } = conversation;
    put(`c:${conversation.id}`, index, payload => db.prepare('INSERT OR REPLACE INTO conversations (id, position, payload) VALUES (?,?,?)').run(conversation.id, index, payload), JSON.stringify(header));
    branches.forEach((branch, position) => put(`b:${branch.id}`, position, payload => db.prepare('INSERT OR REPLACE INTO branches (id, conversation_id, position, payload) VALUES (?,?,?,?)').run(branch.id, conversation.id, position, payload), JSON.stringify(branch)));
    messages.forEach((message, position) => put(`m:${message.id}`, position, payload => db.prepare('INSERT OR REPLACE INTO messages (id, conversation_id, position, payload) VALUES (?,?,?,?)').run(message.id, conversation.id, position, payload), JSON.stringify(message)));
  }
  // Anything cached but no longer produced was deleted, archived away or replaced by an edit.
  const deleteSql: Record<string, string> = { meta: 'DELETE FROM meta WHERE key = ?', c: 'DELETE FROM conversations WHERE id = ?', b: 'DELETE FROM branches WHERE id = ?', m: 'DELETE FROM messages WHERE id = ?' };
  for (const key of cache.keys()) {
    if (next.has(key)) continue;
    const [table, id] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    if (deleteSql[table]) { db.prepare(deleteSql[table]).run(id); written++; }
  }
  cache.clear(); for (const [key, payload] of next) cache.set(key, payload);
  return written;
}

/** Streaming fast path: one message row, no serialisation of anything else. */
export function saveMessage(db: StateDatabase, cache: StateCache, conversationId: string, position: number, message: Message) {
  const key = `m:${message.id}`, payload = JSON.stringify(message), current = signature(payload, position);
  if (cache.get(key) === current) return false;
  db.prepare('INSERT OR REPLACE INTO messages (id, conversation_id, position, payload) VALUES (?,?,?,?)').run(message.id, conversationId, position, payload);
  cache.set(key, current);
  return true;
}

/** 草稿快速路径：只写一个分支行，不序列化其他内容。 */
export function saveBranch(db: StateDatabase, cache: StateCache, conversationId: string, position: number, branch: Branch) {
  const key = `b:${branch.id}`, payload = JSON.stringify(branch), current = signature(payload, position);
  if (cache.get(key) === current) return false;
  db.prepare('INSERT OR REPLACE INTO branches (id, conversation_id, position, payload) VALUES (?,?,?,?)').run(branch.id, conversationId, position, payload);
  cache.set(key, current);
  return true;
}

/** Seeds the cache from the stored rows so the first save after a load writes only real changes. */
export function primeCache(db: StateDatabase, state: AppState, cache: StateCache) {
  cache.clear();
  cache.set('meta:settings', JSON.stringify(state.settings));
  cache.set('meta:selectedId', JSON.stringify(state.selectedId ?? null));
  state.conversations.forEach((conversation, index) => {
    const { branches, messages, ...header } = conversation;
    cache.set(`c:${conversation.id}`, signature(JSON.stringify(header), index));
    branches.forEach((branch, position) => cache.set(`b:${branch.id}`, signature(JSON.stringify(branch), position)));
    messages.forEach((message, position) => cache.set(`m:${message.id}`, signature(JSON.stringify(message), position)));
  });
}
