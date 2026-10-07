import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RequestRecord } from '../src/types';

// Persisted request log for the in-app debug view. Records live in their own files next to the
// database (the same pattern as attachments) so a growing log never enlarges the single SQLite
// file that every save rewrites, and so exports and backups stay free of request payloads.
export const MAX_REQUEST_BYTES = 32 * 1024 * 1024;
// The legacy table migration only needs these two calls, so it stays independent of the driver.
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);
const requestDirectory = (root: string) => join(root, 'requests');
const requestFile = (root: string, messageId: string) => join(requestDirectory(root), `${messageId}.json`);

export function initRequestDirectory(root: string) {
  mkdirSync(requestDirectory(root), { recursive: true, mode: 0o700 });
}
export function saveRequests(root: string, messageId: string, entries: RequestRecord[]) {
  if (!validId(messageId)) return;
  if (!entries.length) { deleteRequests(root, [messageId]); return; }
  initRequestDirectory(root);
  const file = requestFile(root, messageId);
  writeFileSync(`${file}.tmp`, JSON.stringify(entries), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  pruneRequests(root);
}
export function loadRequests(root: string, messageId: string): RequestRecord[] {
  if (!validId(messageId)) return [];
  try {
    const parsed = JSON.parse(readFileSync(requestFile(root, messageId), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}
export function deleteRequests(root: string, messageIds: string[]) {
  for (const messageId of messageIds) {
    if (!validId(messageId)) continue;
    try { unlinkSync(requestFile(root, messageId)); } catch { /* already gone */ }
  }
}
export function clearRequests(root: string) {
  for (const file of listRequests(root)) { try { unlinkSync(file.path); } catch { /* ignore */ } }
}
export function pruneRequests(root: string, maxBytes = MAX_REQUEST_BYTES) {
  const files = listRequests(root);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= maxBytes) return;
  // Oldest first, with the name breaking ties so the outcome never depends on directory order.
  for (const file of files.sort((a, b) => a.modified - b.modified || a.path.localeCompare(b.path))) {
    if (total <= maxBytes) return;
    try { unlinkSync(file.path); total -= file.size; } catch { /* ignore */ }
  }
}
function listRequests(root: string) {
  let names: string[] = [];
  try { names = readdirSync(requestDirectory(root)); } catch { return []; }
  return names.flatMap(name => {
    const path = join(requestDirectory(root), name);
    try { const stats = statSync(path); return [{ path, size: stats.size, modified: stats.mtimeMs }]; } catch { return []; }
  });
}
