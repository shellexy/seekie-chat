import initSqlJs, { type Database } from 'sql.js';
import { safeStorage } from 'electron';
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, normalizeSettings } from '../src/domain';
import type { AppState, Attachment } from '../src/types';
export const SECRET_MARKER = '••••••••';
export class Store {
  private db!: Database;
  private secrets = new Map<string, string>();
  secure = false;
  constructor(public directory: string) {}
  async init() {
    mkdirSync(join(this.directory, 'attachments'), { recursive: true, mode: 0o700 });
    const SQL = await initSqlJs({ locateFile: () => join(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm') });
    const file = join(this.directory, 'chat.sqlite');
    this.db = existsSync(file) ? new SQL.Database(readFileSync(file)) : new SQL.Database();
    this.db.run('CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    this.secure = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    if (this.secure) for (const row of this.db.exec('SELECT id,payload FROM secrets')[0]?.values || []) { try { this.secrets.set(String(row[0]), safeStorage.decryptString(Buffer.from(String(row[1]), 'base64'))); } catch { /* A missing keyring leaves keys unset; never expose ciphertext. */ } }
    const credentials = join(this.directory, 'credentials.json');
    if (existsSync(credentials)) {
      let file: { version: number; secrets: Record<string, string> };
      try { file = JSON.parse(readFileSync(credentials, 'utf8')); } catch { throw new Error('credentials.json 无法读取或格式错误，已停止启动以避免覆盖'); }
      if (file.version !== 1 || !file.secrets || typeof file.secrets !== 'object' || Array.isArray(file.secrets) || Object.values(file.secrets).some(v => typeof v !== 'string')) throw new Error('credentials.json 格式无效，已停止读取以避免覆盖');
      chmodSync(credentials, 0o600);
      for (const [id, value] of Object.entries(file.secrets)) this.secrets.set(id, value as string);
    }
  }
  load(): AppState {
    const rows = this.db.exec('SELECT payload FROM state WHERE id=1');
    const state: AppState = rows.length ? JSON.parse(String(rows[0].values[0][0])) : initialState();
    normalizeSettings(state.settings);
    state.settings.secureStorage = this.secure;
    if (!state.settings.credentialStorageVersion) { if (state.settings.secretPolicy !== 'encrypted' || !this.secure) state.settings.secretPolicy = 'file'; state.settings.credentialStorageVersion = 1; }
    for (const c of state.settings.connections) { c.apiKey = this.secrets.get(c.id) || ''; c.headers = JSON.parse(this.secrets.get('headers:' + c.id) || '{}'); }
    state.settings.exaKey = this.secrets.get('exa') || '';
    state.settings.ollamaKey = this.secrets.get('ollama') || '';
    state.settings.tavilyKey = this.secrets.get('tavily') || '';
    state.settings.firecrawlKey = this.secrets.get('firecrawl') || '';
    state.settings.anysearchKey = this.secrets.get('anysearch') || '';
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
    if (state.settings.ollamaKey === SECRET_MARKER) state.settings.ollamaKey = this.secrets.get('ollama') || '';
    if (state.settings.tavilyKey === SECRET_MARKER) state.settings.tavilyKey = this.secrets.get('tavily') || '';
    if (state.settings.firecrawlKey === SECRET_MARKER) state.settings.firecrawlKey = this.secrets.get('firecrawl') || '';
    if (state.settings.anysearchKey === SECRET_MARKER) state.settings.anysearchKey = this.secrets.get('anysearch') || '';
    state.settings.secureStorage = this.secure;
    if (state.settings.secretPolicy === 'encrypted' && !this.secure) throw new Error('系统安全存储不可用，请选择保存到数据目录');
  }
  public(state: AppState): AppState {
    const copy = structuredClone(state);
    for (const c of copy.settings.connections) { if (c.apiKey) c.apiKey = SECRET_MARKER; for (const name of Object.keys(c.headers)) c.headers[name] = SECRET_MARKER; }
    if (copy.settings.exaKey) copy.settings.exaKey = SECRET_MARKER;
    if (copy.settings.ollamaKey) copy.settings.ollamaKey = SECRET_MARKER;
    if (copy.settings.tavilyKey) copy.settings.tavilyKey = SECRET_MARKER;
    if (copy.settings.firecrawlKey) copy.settings.firecrawlKey = SECRET_MARKER;
    if (copy.settings.anysearchKey) copy.settings.anysearchKey = SECRET_MARKER;
    return copy;
  }
  save(state: AppState) {
    this.resolveSecrets(state);
    state.settings.credentialStorageVersion = 1;
    // Attachment bytes live in their own files. Restore any that the in-memory copy lost so a
    // stale renderer payload can never empty a stored attachment (the request builder then has
    // no blob to send and providers answer with an opaque 400).
    for (const a of attachments(state)) if (validId(a.id) && !a.data) { const file = join(this.directory, 'attachments', `${a.id}.txt`); if (existsSync(file)) a.data = readFileSync(file, 'utf8'); }
    const copy = structuredClone(state);
    this.secrets.clear(); this.db.run('DELETE FROM secrets');
    for (const c of copy.settings.connections) { this.saveSecret(c.id, c.apiKey, copy.settings.secretPolicy); this.saveSecret('headers:' + c.id, JSON.stringify(c.headers), copy.settings.secretPolicy); c.apiKey = ''; c.headers = {}; }
    this.saveSecret('exa', copy.settings.exaKey, copy.settings.secretPolicy); copy.settings.exaKey = '';
    this.saveSecret('ollama', copy.settings.ollamaKey, copy.settings.secretPolicy); copy.settings.ollamaKey = '';
    this.saveSecret('tavily', copy.settings.tavilyKey, copy.settings.secretPolicy); copy.settings.tavilyKey = '';
    this.saveSecret('firecrawl', copy.settings.firecrawlKey, copy.settings.secretPolicy); copy.settings.firecrawlKey = '';
    this.saveSecret('anysearch', copy.settings.anysearchKey, copy.settings.secretPolicy); copy.settings.anysearchKey = '';
    const keep = new Set<string>();
    for (const a of attachments(copy)) {
      if (!validId(a.id) || (a.markdown !== undefined && (typeof a.markdown !== 'string' || a.markdown.length > 1_000_000))) throw new Error('附件内容无效');
      // Every referenced attachment keeps its file, including one that is down to its converted
      // Markdown: deleting that file would destroy the only remaining copy of the content.
      const name = `${a.id}.txt`; keep.add(name);
      if (!a.data && a.markdown !== undefined) continue;
      if (!a.data) throw new Error(`附件“${a.name}”的内容已缺失，请重新添加该附件`);
      if (!/^data:[^;,]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new Error('附件格式无效');
      if (a.data.length > 15_000_000) throw new Error('附件超过 10 MB');
      const file = join(this.directory, 'attachments', name);
      if (!existsSync(file)) writeFileSync(file, a.data, { mode: 0o600 }); a.data = '';
    }
    this.db.run('INSERT OR REPLACE INTO state (id,payload) VALUES (1,?)', [JSON.stringify(copy)]);
    const file = join(this.directory, 'chat.sqlite'); writeFileSync(file + '.tmp', this.db.export(), { mode: 0o600 }); renameSync(file + '.tmp', file);
    const credentials = join(this.directory, 'credentials.json');
    if (copy.settings.secretPolicy === 'file') {
      writeFileSync(credentials + '.tmp', JSON.stringify({ version: 1, secrets: Object.fromEntries(this.secrets) }, null, 2), { mode: 0o600 });
      chmodSync(credentials + '.tmp', 0o600); renameSync(credentials + '.tmp', credentials);
    } else if (existsSync(credentials)) unlinkSync(credentials);
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
  normalizeSettings(s.settings);
  const presetIds = new Set<string>();
  for (const preset of s.settings.promptPresets) {
    if (!preset || typeof preset.id !== 'string' || !preset.id || presetIds.has(preset.id) || typeof preset.name !== 'string' || !preset.name.trim() || typeof preset.content !== 'string' || !preset.content.trim()) throw new Error('系统提示词预设无效');
    presetIds.add(preset.id);
  }
  if (s.settings.defaultPromptPresetId && !presetIds.has(s.settings.defaultPromptPresetId)) throw new Error('默认系统提示词预设不存在');
  if (s.conversations.length > 10000) throw new Error('会话数量超过限制');
  for (const c of s.settings.connections) { if (!validId(c.id) || !['chat', 'responses', 'anthropic', 'gemini'].includes(c.protocol) || typeof c.apiKey !== 'string' || !Number.isFinite(c.timeout) || c.timeout < 10 || c.timeout > 600) throw new Error('连接配置无效'); const u = new URL(c.baseUrl); if (!['https:', 'http:'].includes(u.protocol)) throw new Error('连接地址无效'); if (c.proxy && !/^https?:\/\//.test(c.proxy)) throw new Error('当前版本的代理需使用 HTTP/HTTPS 地址'); }
  for (const c of s.conversations) {
    if (!validId(c.id) || !Array.isArray(c.messages) || !Array.isArray(c.branches) || !c.branches.length) throw new Error('会话结构无效');
    if (c.archived !== undefined && typeof c.archived !== 'boolean') throw new Error('会话归档状态无效');
    const ids = new Set<string>();
    for (const m of c.messages) { if (!validId(m.id) || ids.has(m.id) || !['user','assistant'].includes(m.role) || typeof m.text !== 'string' || !Array.isArray(m.attachments) || !Array.isArray(m.tools) || !Array.isArray(m.sources)) throw new Error('消息结构无效'); ids.add(m.id); }
    const byId = new Map(c.messages.map(m => [m.id, m]));
    for (const m of c.messages) { const seen = new Set<string>(); let current: typeof m | undefined = m; while (current) { if (seen.has(current.id)) throw new Error('消息结构存在循环'); seen.add(current.id); if (!current.parentId) break; current = byId.get(current.parentId); if (!current) throw new Error('缺少父消息'); } }
    const branchIds = new Set(c.branches.map(b => b.id));
    if (!branchIds.has(c.activeBranchId)) throw new Error('当前分支无效');
    for (const b of c.branches) if (!validId(b.id) || (b.leafId && !ids.has(b.leafId)) || !b.config || !Array.isArray(b.draftAttachments) || (b.parentBranchId && !branchIds.has(b.parentBranchId)) || (b.config.temperature !== undefined && (!Number.isFinite(b.config.temperature) || b.config.temperature < 0 || b.config.temperature > 2)) || (b.config.topP !== undefined && (!Number.isFinite(b.config.topP) || b.config.topP < 0 || b.config.topP > 1))) throw new Error('分支结构无效');
  }
}
