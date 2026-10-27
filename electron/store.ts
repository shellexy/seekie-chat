import { DatabaseSync } from 'node:sqlite';
import { safeStorage } from 'electron';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialState, needsRawReplay, normalizeSettings, rawHasToolCalls } from '../src/domain';
import type { AppState, Attachment, Branch, Conversation, Message, RequestRecord, WindowLayout } from '../src/types';
import { sweepAttachmentFiles } from './attachment_files';
import { clearRequests, deleteRequests, initRequestDirectory, loadRequests, saveRequests } from './request_store';
import { initStateSchema, loadState, loadWindowRow, primeCache, saveBranch, saveConversationRow, saveMessage, saveSelectedId, saveSettingsRow, saveState, saveWindowRow, type StateCache, type WindowLayoutCache } from './state_store';
export const SECRET_MARKER = '••••••••';
export class Store {
  private db!: DatabaseSync;
  private secrets = new Map<string, string>();
  // Row payloads as last written, so a save only touches what changed.
  private cache: StateCache = new Map();
  // 窗口布局单独一份缓存：它写得比会话勤（拖动窗口就是一次），不该惊动会话状态的增量判断。
  private windowCache: WindowLayoutCache = {};
  // 删除宽限期：渲染层已经不要这几条会话了，但它们的行、附件文件和请求记录得留着，撤销窗口关掉
  // 的那一次保存才真删。写盘时把它们当作仍然存在的会话带上——「留着」和「删掉」在这一层只由
  // 「状态里还有没有它们」决定，所以不需要另一套删除路径。
  private held = new Map<string, Conversation>();
  secure = false;
  constructor(public directory: string) {}
  init() {
    mkdirSync(join(this.directory, 'attachments'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.directory, 'chat.sqlite'));
    // WAL keeps each save to the pages that changed instead of rewriting the whole file, and FULL
    // sync trades a little speed for durability of settings, credentials and chat history.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, payload TEXT NOT NULL)');
    this.secureFiles();
    initStateSchema(this.db);
    initRequestDirectory(this.directory);
    this.secure = safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text');
    if (this.secure) for (const row of this.db.prepare('SELECT id,payload FROM secrets').all() as { id: string; payload: string }[]) { try { this.secrets.set(row.id, safeStorage.decryptString(Buffer.from(row.payload, 'base64'))); } catch { /* A missing keyring leaves keys unset; never expose ciphertext. */ } }
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
    const stored = loadState(this.db);
    const state: AppState = stored || initialState();
    // Prime from exactly what the database holds: the repairs below are then persisted once, and a
    // save that changes nothing writes nothing.
    if (stored) primeCache(this.db, stored, this.cache);
    normalizeSettings(state.settings);
    state.settings.secureStorage = this.secure;
    if (!state.settings.credentialStorageVersion) { if (state.settings.secretPolicy !== 'encrypted' || !this.secure) state.settings.secretPolicy = 'file'; state.settings.credentialStorageVersion = 1; }
    for (const c of state.settings.connections) { c.apiKey = this.secrets.get(c.id) || ''; c.headers = JSON.parse(this.secrets.get('headers:' + c.id) || '{}'); }
    state.settings.exaKey = this.secrets.get('exa') || '';
    state.settings.ollamaKey = this.secrets.get('ollama') || '';
    state.settings.tavilyKey = this.secrets.get('tavily') || '';
    state.settings.firecrawlKey = this.secrets.get('firecrawl') || '';
    state.settings.anysearchKey = this.secrets.get('anysearch') || '';
    state.settings.deepseekKey = this.secrets.get('deepseek') || '';
    for (const a of attachments(state)) if (validId(a.id)) { const file = join(this.directory, 'attachments', `${a.id}.txt`); if (existsSync(file)) a.data = readFileSync(file, 'utf8'); }
    // 纯文本回答的 raw 是正文的重复副本（旧版本每条都存），读上来时顺手丢掉——它没有工具
    // 调用可回放，buildInput 用 text 重建出来的结构完全一样。带工具的回答一律保留。
    for (const c of state.conversations) { if (c.titleState === 'pending') c.titleState = 'idle'; for (const m of c.messages) { if (m.status === 'streaming') { m.status = 'interrupted'; m.error = '上次运行中断，已保留收到的内容'; } if (!needsRawReplay(m) && !rawHasToolCalls(m.raw)) delete m.raw; } }
    // 只在确实读到存档时清扫：初始化失败时 state 是个空壳，按空集合清扫会把用户的附件全删了。
    // 启动这一刻还没有窗口在写文件，是唯一安全的全量清理时机；保存路径上的那次只管本次改动。
    if (stored) sweepAttachmentFiles(this.directory, attachments(state).map(a => a.id));
    return state;
  }
  /**
   * 上次关闭时的窗口布局。建窗口之前读一次，所以它不经过 AppState：既不会被广播给渲染层，
   * 也不会被导入备份顺手改掉。没有存档（第一次运行）时返回 undefined，由调用方决定默认值。
   */
  loadWindowLayout() { return loadWindowRow(this.db, this.windowCache); }
  saveWindowLayout(layout: WindowLayout) { return saveWindowRow(this.db, this.windowCache, layout); }
  // 只碰 settings：设置页和草稿这类窄面写入就不必构造一份完整的 AppState。
  resolveSecrets(state: { settings: AppState['settings'] }) {
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
    if (state.settings.deepseekKey === SECRET_MARKER) state.settings.deepseekKey = this.secrets.get('deepseek') || '';
    state.settings.secureStorage = this.secure;
    if (state.settings.secretPolicy === 'encrypted' && !this.secure) throw new Error('系统安全存储不可用，请选择保存到数据目录');
  }
  /** One message in the shape the renderer may see: attachment payloads stay in the main process. */
  publicMessage(message: Message): Message {
    const copy = structuredClone(message);
    for (const attachment of copy.attachments) attachment.data = '';
    return copy;
  }
  public(state: AppState): AppState {
    const copy = structuredClone(state);
    // Attachment bytes stay in the main process: the renderer asks for one by id when it needs to
    // show it. Otherwise every broadcast would copy and transfer every image in the conversation.
    for (const a of attachments(copy)) a.data = '';
    // message.raw 存的是协议原生的 assistant 条目，只有主进程用得到（compatibleRaw 在多轮
    // 工具调用时重放历史）；渲染层从没读过它。每次广播都带着它等于白做一次深拷贝和 IPC
    // 序列化，所以出口处统一剔掉。保存时渲染层送回的是去掉 raw 的状态，主进程在 save
    // 处理器里会用自己那份消息对象覆盖回去，所以 raw 不会因此丢失。
    for (const c of copy.conversations) for (const m of c.messages) delete m.raw;
    for (const c of copy.settings.connections) { if (c.apiKey) c.apiKey = SECRET_MARKER; for (const name of Object.keys(c.headers)) c.headers[name] = SECRET_MARKER; }
    if (copy.settings.exaKey) copy.settings.exaKey = SECRET_MARKER;
    if (copy.settings.ollamaKey) copy.settings.ollamaKey = SECRET_MARKER;
    if (copy.settings.tavilyKey) copy.settings.tavilyKey = SECRET_MARKER;
    if (copy.settings.firecrawlKey) copy.settings.firecrawlKey = SECRET_MARKER;
    if (copy.settings.anysearchKey) copy.settings.anysearchKey = SECRET_MARKER;
    if (copy.settings.deepseekKey) copy.settings.deepseekKey = SECRET_MARKER;
    return copy;
  }
  /**
   * 草稿只改一个分支行。它每次停顿都要写一次，走 save() 的话得把全部会话重新序列化一遍
   * （一兆的状态就是几十毫秒），而这里只动那一行。
   */
  saveDraft(conversationId: string, position: number, branch: Branch) {
    return saveBranch(this.db, this.cache, conversationId, position, branch);
  }

  // 选择、改名、归档、切换分支都只动单个实体的几个标量字段，同样只写那一行。
  saveSelection(selectedId: string | null) { return saveSelectedId(this.db, this.cache, selectedId); }
  saveConversation(conversation: Conversation, position: number) { return saveConversationRow(this.db, this.cache, conversation, position); }
  saveBranchOf(conversationId: string, position: number, branch: Branch) { return saveBranch(this.db, this.cache, conversationId, position, branch); }
  // 只写 settings 那一行。连接或密钥变了别走这里——那种情况得重写凭据存储，用 save()。
  // 写盘前必须像 save() 一样把密钥抹掉：真实值在 secrets 表里，落进 settings 行就等于明文入库。
  saveSettingsOnly(settings: AppState['settings']) {
    const copy = structuredClone(settings);
    for (const c of copy.connections) { c.apiKey = ''; c.headers = {}; }
    copy.exaKey = ''; copy.ollamaKey = ''; copy.tavilyKey = ''; copy.firecrawlKey = ''; copy.anysearchKey = ''; copy.deepseekKey = '';
    return saveSettingsRow(this.db, this.cache, copy);
  }
  hold(conversations: Conversation[]) { for (const conversation of conversations) this.held.set(conversation.id, conversation); }
  unhold(ids: string[]) { for (const id of ids) this.held.delete(id); }
  save(state: AppState) {
    this.resolveSecrets(state);
    state.settings.credentialStorageVersion = 1;
    // Attachment bytes live in their own files. Restore any that the in-memory copy lost so a
    // stale renderer payload can never empty a stored attachment (the request builder then has
    // no blob to send and providers answer with an opaque 400).
    for (const a of attachments(state)) if (validId(a.id) && !a.data) { const file = join(this.directory, 'attachments', `${a.id}.txt`); if (existsSync(file)) a.data = readFileSync(file, 'utf8'); }
    const copy = structuredClone(state);
    // 带着宽限期里的会话一起写：saveState 的删行循环和下面的附件清理都只看这份拷贝里有什么。
    // 必须再克隆一份：下面的附件循环会把写盘副本里的 data 就地清空，而宽限期那边还要指着同一个
    // 对象把附件内容端给界面（撤销回来后到下一次保存之前，主进程内存里那份就是唯一的一份）。
    for (const [id, conversation] of this.held) if (!copy.conversations.some(c => c.id === id)) copy.conversations.push(structuredClone(conversation));
    this.secrets.clear(); this.db.exec('DELETE FROM secrets');
    for (const c of copy.settings.connections) { this.saveSecret(c.id, c.apiKey, copy.settings.secretPolicy); this.saveSecret('headers:' + c.id, JSON.stringify(c.headers), copy.settings.secretPolicy); c.apiKey = ''; c.headers = {}; }
    this.saveSecret('exa', copy.settings.exaKey, copy.settings.secretPolicy); copy.settings.exaKey = '';
    this.saveSecret('ollama', copy.settings.ollamaKey, copy.settings.secretPolicy); copy.settings.ollamaKey = '';
    this.saveSecret('tavily', copy.settings.tavilyKey, copy.settings.secretPolicy); copy.settings.tavilyKey = '';
    this.saveSecret('firecrawl', copy.settings.firecrawlKey, copy.settings.secretPolicy); copy.settings.firecrawlKey = '';
    this.saveSecret('anysearch', copy.settings.anysearchKey, copy.settings.secretPolicy); copy.settings.anysearchKey = '';
    this.saveSecret('deepseek', copy.settings.deepseekKey, copy.settings.secretPolicy); copy.settings.deepseekKey = '';
    const keep = new Set<string>();
    for (const a of attachments(copy)) {
      if (!validId(a.id) || (a.markdown !== undefined && (typeof a.markdown !== 'string' || a.markdown.length > 1_000_000))) throw new Error('附件内容无效');
      // Every referenced attachment keeps its file, including one that is down to its converted
      // Markdown: deleting that file would destroy the only remaining copy of the content.
      const name = `${a.id}.txt`; keep.add(a.id);
      const file = join(this.directory, 'attachments', name);
      if (!a.data && a.markdown !== undefined) continue;
      // The renderer never receives attachment bytes, so its copy of the state has none: an empty
      // payload is expected as long as the file itself is still on disk.
      if (!a.data) { if (existsSync(file)) continue; throw new Error(`附件“${a.name}”的内容已缺失，请重新添加该附件`); }
      if (!/^data:[^;,]+;base64,[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new Error('附件格式无效');
      if (a.data.length > 15_000_000) throw new Error('附件超过 10 MB');
      if (!existsSync(file)) writeFileSync(file, a.data, { mode: 0o600 }); a.data = '';
    }
    // Only the rows whose payload changed are written; SQLite then writes just those pages.
    saveState(this.db, copy, this.cache);
    this.secureFiles();
    const credentials = join(this.directory, 'credentials.json');
    if (copy.settings.secretPolicy === 'file') {
      writeFileSync(credentials + '.tmp', JSON.stringify({ version: 1, secrets: Object.fromEntries(this.secrets) }, null, 2), { mode: 0o600 });
      chmodSync(credentials + '.tmp', 0o600); renameSync(credentials + '.tmp', credentials);
    } else if (existsSync(credentials)) unlinkSync(credentials);
    sweepAttachmentFiles(this.directory, keep);
  }
  // Request records live in their own files: they persist for the in-app debug view but never enter
  // the state JSON, and they never enlarge the database that every save rewrites.
  saveRequests(messageId: string, entries: RequestRecord[]) { saveRequests(this.directory, messageId, entries); }
  loadRequests(messageId: string) { return loadRequests(this.directory, messageId); }
  deleteRequests(messageIds: string[]) { deleteRequests(this.directory, messageIds); }
  clearRequests() { clearRequests(this.directory); }
  /** Streaming writes one message row; everything else is reconciled by the next full save. */
  saveStreamingMessage(conversation: Conversation, message: Message) {
    const position = conversation.messages.indexOf(message);
    if (position < 0) return false;
    const copy = structuredClone(message);
    for (const a of copy.attachments) { const file = join(this.directory, 'attachments', `${a.id}.txt`); if (existsSync(file)) a.data = ''; }
    saveMessage(this.db, this.cache, conversation.id, position, copy);
    return true;
  }
  private saveSecret(id: string, value: string, policy: string) {
    if (!value) return; this.secrets.set(id, value);
    if (this.secure && policy === 'encrypted') this.db.prepare('INSERT OR REPLACE INTO secrets (id,payload) VALUES (?,?)').run(id, safeStorage.encryptString(value).toString('base64'));
  }
  // WAL and shared-memory files are created next to the database; keep them as private as the
  // database itself, and fold the log back into it when the app closes.
  private secureFiles() {
    for (const name of ['chat.sqlite', 'chat.sqlite-wal', 'chat.sqlite-shm']) {
      const file = join(this.directory, name);
      if (existsSync(file)) try { chmodSync(file, 0o600); } catch { /* permissions are best effort */ }
    }
  }
  close() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* already closed or read-only */ }
    try { this.db.close(); } catch { /* ignore */ }
    this.secureFiles();
  }
}
function validId(id: string) { return /^[a-f0-9-]{36}$/.test(id); }
function attachments(state: AppState): Attachment[] { return state.conversations.flatMap(c => [...c.messages.flatMap(m => m.attachments), ...c.branches.flatMap(b => b.draftAttachments)]); }
