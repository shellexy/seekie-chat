import type { Database } from 'sql.js';
import type { RequestRecord } from '../src/types';

// Persisted request log for the in-app debug view. It lives in its own table so the exported and
// backed-up state JSON stays free of request payloads, and the total size is capped so a
// long-running install cannot grow without bound.
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

export function initRequestTable(db: Database) {
  db.run('CREATE TABLE IF NOT EXISTS requests (message_id TEXT PRIMARY KEY, created INTEGER NOT NULL, payload TEXT NOT NULL)');
}
export function saveRequests(db: Database, messageId: string, entries: RequestRecord[], created = Date.now()) {
  if (!entries.length) { deleteRequests(db, [messageId]); return; }
  db.run('INSERT OR REPLACE INTO requests (message_id,created,payload) VALUES (?,?,?)', [messageId, created, JSON.stringify(entries)]);
  pruneRequests(db);
}
export function loadRequests(db: Database, messageId: string): RequestRecord[] {
  const rows = db.exec('SELECT payload FROM requests WHERE message_id=?', [messageId]);
  const value = rows[0]?.values[0]?.[0];
  if (typeof value !== 'string') return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}
export function deleteRequests(db: Database, messageIds: string[]) {
  for (const messageId of messageIds) db.run('DELETE FROM requests WHERE message_id=?', [messageId]);
}
export function clearRequests(db: Database) { db.run('DELETE FROM requests'); }
export function pruneRequests(db: Database, maxBytes = MAX_REQUEST_BYTES) {
  const rows = db.exec('SELECT message_id, LENGTH(payload) FROM requests ORDER BY created DESC, rowid DESC')[0]?.values || [];
  let total = 0; const expired: string[] = [];
  for (const row of rows) {
    total += Number(row[1]) || 0;
    if (total > maxBytes) expired.push(String(row[0]));
  }
  if (expired.length) deleteRequests(db, expired);
}
