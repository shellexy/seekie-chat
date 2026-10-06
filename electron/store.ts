import initSqlJs, { type Database } from 'sql.js';
import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { initialState } from '../src/domain';
import type { AppState, Attachment } from '../src/types';
export const SECRET_MARKER = '••••••••';
export class Store {
  private db!: Database;
  private secrets = new Map<string, string>();
  secure = false;
  constructor(public directory: string) {}
  async init() {
    mkdirSync(join(this.directory, 'attachments'), { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm') });
    const file = join(this.directory, 'chat.sqlite');
    this.db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
    this.db.run('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    this.secure = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    if (this.secure) for (const row of this.db.exec('SELECT id,payload FROM secrets')[0]?.values || []) { try { this.secrets.set(String(row[0]), safeStorage.decryptString(Buffer.from(String(row[1]), 'base64'))); } catch { /* A missing keyring leaves keys unset; never expose ciphertext. */ } }
  }
  load(): AppState {
    const rows = this.db.exec('SELECT payload FROM state WHERE id=1');
    const state: AppState = rows.length ? JSON.parse(String(rows[0].values[0][0])) : initialState();
    state.settings.secureStorage = this.secure;
    if (!this.secure) state.settings.secretPolicy = 'session';
    for (const c of state.settings.connections) { c.apiKey = this.secrets.get(c.id) || ''; c.headers = JSON.parse(this.secrets.get('headers:' + c.id) || '{}'); }
    state.settings.exaKey = this.secrets.get('exa') || '';
    for (const a of attachments(state)) if (validId(a.id)) { const file = join(this.directory, 'attachments', `${a.id}.txt`); if (existsSync(file)) a.data = readFileSync(file, 'utf8'); }
    for (const c of state.conversations) { if (c.titleState === 'pending') c.titleState = 'idle'; for (const m of c.messages) if (m.status === 'streaming') { m.status = 'interrupted'; m.error = '上次运行中断，已保留收到的内容'; } }
    return state;
  }
  resolveSecrets(state: AppState) {
    for (const c of state.settings.connections) {
      if (c.apiKey === SECRET_MARKER) c.apiKey = this.secrets.get(c.id) || '';
      const previous = JSON.parse(this.secrets.get('headers:' + c.id) || '{}');
      for (const [name, value] of Object.entries(c.headers)) if (value === SECRET_MARKER) c.headers[name] = previous[name] || '';
    }
    if (state.settings.exaKey === SECRET_MARKER) state.settings.exaKey = this.secrets.get('exa') || '';
    state.settings.secureStorage = this.secure;
    if (!this.secure) state.settings.secretPolicy = 'session';
  }
  public(state: AppState): AppState {
    const copy = structuredClone(state);
    for (const c of copy.settings.connections) { if (c.apiKey) c.apiKey = SECRET_MARKER; for (const name of Object.keys(c.headers)) c.headers[name] = SECRET_MARKER; }
    if (copy.settings.exaKey) copy.settings.exaKey = SECRET_MARKER;
    return copy;
  }
  save(state: AppState) {
    this.resolveSecrets(state);
    const copy = structuredClone(state);
    this.secrets.clear(); this.db.run('DELETE FROM secrets');
    for (const c of copy.settings.connections) { this.saveSecret(c.id, c.apiKey, copy.settings.secretPolicy); this.saveSecret('headers:' + c.id, JSON.stringify(c.headers), copy.settings.secretPolicy); c.apiKey = ''; c.headers = {}; }
    this.saveSecret('exa', copy.settings.exaKey, copy.settings.secretPolicy); copy.settings.exaKey = '';
    const keep = new Set<string>();
    for (const a of attachments(copy)) {
      if (!validId(a.id) || !/^data:image\/(png|jpeg|webp);base64,/.test(a.data) || a.data.length > 15_000_000) throw new Error('图片附件无效或超过 10 MB');
      const name = `${a.id}.txt`; keep.add(name); const file = join(this.directory, 'attachments', name);
      if (!existsSync(file)) writeFileSync(file, a.data, { mode: 0o600 }); a.data = '';
    }
    this.db.run('INSERT OR REPLACE INTO state (id,payload) VALUES (1,?)', [JSON.stringify(copy)]);
    const file = join(this.directory, 'chat.sqlite'); writeFileSync(file + '.tmp', this.db.export(), { mode: 0o600 }); renameSync(file + '.tmp', file);
    for (const file of readdirSync(join(this.directory, 'attachments'))) if (!keep.has(file)) unlinkSync(join(this.directory, 'attachments', file));
  }
  private saveSecret(id: string, value: string, policy: string) {
    if (!value) return; this.secrets.set(id, value);
    if (this.secure && policy === 'encrypted') this.db.run('INSERT INTO secrets (id,payload) VALUES (?,?)', [id, safeStorage.encryptString(value).toString('base64')]);
  }
}
function validId(id: string) { return /^[a-f0-9-]{36}$/.test(id); }
function attachments(state: AppState): Attachment[] { return state.conversations.flatMap(c => [...c.messages.flatMap(m => m.attachments), ...c.branches.flatMap(b => b.draftAttachments)]); }
export function validateState(value: unknown): asserts value is AppState {
  const s = value as AppState;
  if (!s || !s.settings || !Array.isArray(s.settings.connections) || !Array.isArray(s.settings.models) || !Array.isArray(s.conversations)) throw new Error('备份或设置格式无效');
  if (s.conversations.length > 10000) throw new Error('会话数量超过限制');
  for (const c of s.settings.connections) { if (!validId(c.id) || !['chat', 'responses', 'anthropic'].includes(c.protocol) || typeof c.apiKey !== 'string' || !Number.isFinite(c.timeout) || c.timeout < 10 || c.timeout > 600) throw new Error('连接配置无效'); const u = new URL(c.baseUrl); if (!['https:', 'http:'].includes(u.protocol)) throw new Error('连接地址无效'); if (c.proxy && !/^https?:\/\//.test(c.proxy)) throw new Error('当前版本的代理需使用 HTTP/HTTPS 地址'); }
  for (const c of s.conversations) {
    if (!validId(c.id) || !Array.isArray(c.messages) || !Array.isArray(c.branches) || !c.branches.length) throw new Error('会话结构无效');
    const ids = new Set<string>();
    for (const m of c.messages) { if (!validId(m.id) || ids.has(m.id) || !['user','assistant'].includes(m.role) || typeof m.text !== 'string' || !Array.isArray(m.attachments) || !Array.isArray(m.tools) || !Array.isArray(m.sources)) throw new Error('消息结构无效'); ids.add(m.id); }
    const byId = new Map(c.messages.map(m => [m.id, m]));
    for (const m of c.messages) { const seen = new Set<string>(); let current: typeof m | undefined = m; while (current) { if (seen.has(current.id)) throw new Error('消息结构存在循环'); seen.add(current.id); if (!current.parentId) break; current = byId.get(current.parentId); if (!current) throw new Error('缺少父消息'); } }
    const branchIds = new Set(c.branches.map(b => b.id));
    if (!branchIds.has(c.activeBranchId)) throw new Error('当前分支无效');
    for (const b of c.branches) if (!validId(b.id) || (b.leafId && !ids.has(b.leafId)) || !b.config || !Array.isArray(b.draftAttachments) || (b.parentBranchId && !branchIds.has(b.parentBranchId))) throw new Error('分支结构无效');
  }
}
