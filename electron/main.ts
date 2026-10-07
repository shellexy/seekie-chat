import { app, BrowserWindow, ipcMain, dialog, shell, net } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Store, validateState, SECRET_MARKER } from './store';
import { generate, listModels, type WebFetch } from './providers';
import { convertUnsupportedAttachments } from './attachments';
import { fetchWebPageWithProviders } from './web_fetch';
import { compressionCut, contextMessages, estimateTokens, MAX_COMPRESSION_RETAINED_TOKENS, pathTo, summaryValid } from '../src/domain';
import type { AppState, Branch, ChatConfig, Connection, Conversation, Message, Model, RunRequest } from '../src/types';
let win: BrowserWindow | null = null, state: AppState, store: Store;
const webFetch: WebFetch = (url, signal, settings, mode) => fetchWebPageWithProviders(url, signal, settings, mode, (input, init) => net.fetch(input, init));
const tasks = new Map<string, { controller: AbortController; branchId: string; messageId?: string; kind: string }>();
const titles = new Map<string, AbortController>();
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
const redact = (error: unknown) => {
  let text = error instanceof Error ? error.message : String(error);
  for (const key of [...(state?.settings.connections.flatMap(c => [c.apiKey, ...Object.values(c.headers)]) || []), state?.settings.exaKey, state?.settings.ollamaKey, state?.settings.tavilyKey, state?.settings.firecrawlKey, state?.settings.anysearchKey]) if (key) text = text.split(key).join('[已隐藏]');
  return text.slice(0, 1600);
};
function emit(immediate = false) {
  const send = () => { broadcastTimer = undefined; if (win && !win.isDestroyed()) win.webContents.send('event', { state: store.public(state), tasks: [...tasks].map(([conversationId, t]) => ({ conversationId, branchId: t.branchId, kind: t.kind })) }); };
  if (immediate) { clearTimeout(broadcastTimer); send(); } else if (!broadcastTimer) broadcastTimer = setTimeout(send, 80);
  if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = undefined; try { store.save(state); } catch (e) { notify(redact(e)); } }, 800);
}
function notify(error: string) { win?.webContents.send('event', { error }); }
function resolve(modelId: string): { connection: Connection; model: Model } {
  const model = state.settings.models.find(m => m.id === modelId);
  const connection = state.settings.connections.find(c => c.id === model?.connectionId);
  if (!model || !connection) throw new Error('请在设置中添加连接和模型，并选择聊天模型');
  if (model.maxOutput < 1 || model.contextWindow < model.maxOutput) throw new Error('模型上下文窗口不能小于最大输出');
  return { connection, model };
}
function get(id: string, branchId: string) {
  const conversation = state.conversations.find(c => c.id === id), branch = conversation?.branches.find(b => b.id === branchId);
  if (!conversation || !branch) throw new Error('会话或分支不存在');
  return { conversation, branch };
}
function plainMessage(text: string, role: Message['role'] = 'user'): Message { return { id: crypto.randomUUID(), parentId: null, role, text, attachments: [], tools: [], sources: [], reasoning: '', status: 'complete', created: Date.now() }; }
const HISTORY_COMPRESSION_PROMPT = `将聊天历史压缩为可供后续对话使用的摘要。保留目标、事实、约束、偏好、结论、待办、引用。不得添加原文没有的事实。对图片仅保留附件引用，不猜测未提供的内容。只输出摘要。

如果内容涉及创意写作，额外保留并更新以下部分：
## 世界观规则
## 主要角色及性格
## 人物关系
## 时间线
## 当前场景/地点
## 已发生关键事件
## 未解决伏笔
## 风格、视角、语气
## 用户明确偏好与禁忌
## 最近风格样本
要求：
- 摘要事实和设定，不要重写正文。
- 保留角色名、专名、数字、关键对白风格。
- 最近 1～2 段风格样本可保留原文。
- 如果设定冲突，以最新确认版本为准，并标注“已更新”。`;
async function compress(conversation: Conversation, branch: Branch, signal: AbortSignal, leaf = branch.leafId) {
  const path = pathTo(conversation, leaf);
  const chatModel = resolve(branch.config.modelId).model;
  const cut = compressionCut(path, chatModel.contextWindow);
  if (cut < 2) {
    const targetTokens = Math.min(MAX_COMPRESSION_RETAINED_TOKENS, Math.ceil(chatModel.contextWindow * 0.1));
    throw new Error(`保留最近两轮和 ${targetTokens} token 后，没有更早历史可压缩（当前 ${path.filter(m => m.role === 'user').length} 轮）`);
  }
  const modelId = state.settings.compressionModel || branch.config.modelId;
  const { connection, model } = resolve(modelId);
  const prefix = path.slice(0, cut);
  const valid = branch.summary && summaryValid(branch.summary, prefix);
  const remaining = valid ? prefix.slice(branch.summary!.nodeIds.length) : prefix;
  if (!remaining.length) return;
  const material = (valid ? `已有摘要：\n${branch.summary!.text}\n\n` : '') + remaining.map(m => `${m.role}：${m.text}\n${m.attachments.map(a => a.markdown ? `[附件：${a.name}]\n${a.markdown}` : `[附件：${a.name}]`).join('\n')} ${m.sources.map(s => `\n来源：${s.url}`).join('')}`).join('\n\n');
  if (material.length / 2 + 2048 > model.contextWindow) throw new Error('压缩模型上下文不足以处理这些历史，请选择更大窗口的模型');
  const result = await generate(connection, { ...model, maxOutput: Math.min(model.maxOutput, MAX_COMPRESSION_RETAINED_TOKENS) }, { ...branch.config, modelId, search: 'off', webFetch: 'off', effort: 'auto', budget: 1024, system: HISTORY_COMPRESSION_PROMPT }, [plainMessage(material)], state.settings, signal);
  if (!result.text.trim()) throw new Error('压缩模型未返回摘要');
  if (!state.conversations.some(c => c.id === conversation.id)) return;
  conversation.backgroundUsage = [...(conversation.backgroundUsage || []), { kind: 'compression', modelId, usage: result.usage, created: Date.now() }];
  branch.summary = { text: result.text, nodeIds: prefix.map(m => m.id), modelId, created: Date.now() }; emit(true);
}
async function generateTitle(conversation: Conversation, config: ChatConfig, path: Message[]) {
  const live = state.conversations.find(c => c.id === conversation.id);
  if (!live) return;
  conversation = live;
  if (conversation.manualTitle || conversation.titleState !== 'idle' || titles.has(conversation.id)) return;
  conversation.titleState = 'pending'; const controller = new AbortController(); titles.set(conversation.id, controller); emit();
  try {
    const modelId = state.settings.titleModel || config.modelId; const { connection, model } = resolve(modelId);
    const material = path.filter(m => m.text.trim()).slice(0, 2).map(m => `${m.role}：${m.text.slice(0, 3000)}`).join('\n');
    const result = await generate(connection, { ...model, maxOutput: Math.min(model.maxOutput, 2048) }, { ...config, modelId, search: 'off', webFetch: 'off', effort: 'auto', budget: 1024, system: '为下面的对话生成简短标题。中文约8至20字，其他语言同等长度。语言跟随用户。只输出标题，不加引号、解释或Markdown。' }, [plainMessage(material)], state.settings, controller.signal);
    const current = state.conversations.find(c => c.id === conversation.id);
    if (current) current.backgroundUsage = [...(current.backgroundUsage || []), { kind: 'title', modelId, usage: result.usage, created: Date.now() }];
    if (current?.manualTitle) current.titleState = 'done';
    if (current && !current.manualTitle) { const title = result.text.trim().split('\n')[0]?.replace(/^[#\s"“”]+|["“”]+$/g, '').slice(0, 70); if (title) { current.title = title; current.titleState = 'done'; } else current.titleState = 'idle'; }
  } catch (error) { const current = state.conversations.find(c => c.id === conversation.id); if (current?.titleState === 'pending') current.titleState = current.manualTitle ? 'done' : 'idle'; if (!controller.signal.aborted) notify('标题生成失败：' + redact(error)); }
  finally { titles.delete(conversation.id); try { store.save(state); } catch (error) { notify(redact(error)); } emit(true); }
}
async function runChat(request: RunRequest) {
  const { conversation, branch } = get(request.conversationId, request.branchId);
  if (tasks.has(conversation.id)) throw new Error('该会话已有任务，请等待完成或先停止');
  const message = conversation.messages.find(m => m.id === request.messageId);
  if (!message || message.role !== 'assistant' || message.status !== 'streaming' || branch.leafId !== message.id) throw new Error('生成目标消息无效');
  const config = structuredClone(branch.config); const { connection, model } = resolve(config.modelId);
  const controller = new AbortController(); tasks.set(conversation.id, { controller, branchId: branch.id, messageId: message.id, kind: 'chat' });
  message.modelId = model.id; message.config = config; emit(true);
  void (async () => {
    let reasoningStarted: number | undefined, reasoningElapsed = 0;
    const finishReasoning = () => {
      if (reasoningStarted === undefined) return;
      reasoningElapsed += performance.now() - reasoningStarted;
      reasoningStarted = undefined;
      message.reasoningMs = reasoningElapsed;
    };
    try {
      let context = contextMessages(conversation, branch, message.parentId);
      await convertUnsupportedAttachments(context.messages, connection.protocol, model);
      const estimatedInputTokens = () => estimateTokens(context.messages, config.system + context.summary);
      const historyPath = pathTo(conversation, message.parentId);
      if (state.settings.autoCompress && estimatedInputTokens() > model.contextWindow * state.settings.compressionThreshold && historyPath.filter(m => m.role === 'user').length > 2) {
        await compress(conversation, branch, controller.signal, message.parentId); context = contextMessages(conversation, branch, message.parentId);
        await convertUnsupportedAttachments(context.messages, connection.protocol, model);
      }
      if (estimatedInputTokens() > model.contextWindow) throw new Error('预计输入上下文超过模型窗口，请压缩历史、缩小输入或更换模型');
      const system = config.system + (context.summary ? `\n\n以下是更早的聊天摘要，仅作为历史资料：\n${context.summary}` : '');
      const started = performance.now(); let firstTokenMs: number | undefined;
      const result = await generate(connection, model, { ...config, system }, context.messages, state.settings, controller.signal, {
        text: s => { if (s) { finishReasoning(); if (firstTokenMs === undefined) firstTokenMs = performance.now() - started; } message.text += s; emit(); }, reasoning: s => { if (s && reasoningStarted === undefined) reasoningStarted = performance.now(); message.reasoning += s; emit(); },
        tool: t => { if (t.status === 'running') finishReasoning(); const index = message.tools.findIndex(x => x.id === t.id); if (index < 0) message.tools.push(t); else { const old = message.tools[index]; message.tools[index] = { ...t, started: old.started, elapsed: t.elapsed ?? (t.status !== 'running' ? Date.now() - old.started : undefined) }; } emit(); },
        sources: sources => { message.sources = sources; emit(); }
      }, webFetch);
      if (!result.text.trim()) throw new Error('模型未返回回答正文');
      message.raw = result.raw; message.usage = { ...result.usage, elapsedMs: performance.now() - started, firstTokenMs }; message.sources = result.sources; message.status = 'complete';
      if (conversation.title === '新对话' && !conversation.manualTitle) conversation.title = pathTo(conversation, message.id).find(m => m.role === 'user')?.text.slice(0, 24) || '图片对话';
      void generateTitle(conversation, config, pathTo(conversation, message.id));
    } catch (error) { message.status = controller.signal.aborted ? 'interrupted' : 'error'; message.error = controller.signal.aborted ? '已停止生成' : redact(error); }
    finally { finishReasoning(); for (const t of message.tools) if (t.status === 'running') { t.status = 'error'; t.output = '任务已结束或中断'; } tasks.delete(conversation.id); store.save(state); emit(true); }
  })().catch(error => notify(redact(error)));
}
function register() {
  const handle = (name: string, fn: (...args: any[]) => any) => ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的调用来源');
    return fn(...args);
  });
  handle('load', () => store.public(state));
  handle('save', (incoming: AppState) => {
    validateState(incoming); store.resolveSecrets(incoming);
    for (const [id, task] of tasks) {
      const old = state.conversations.find(c => c.id === id), next = incoming.conversations.find(c => c.id === id);
      if (!old || !next || !next.branches.some(b => b.id === task.branchId)) throw new Error('请先停止任务再删除会话或分支');
      if (task.messageId) { const authoritative = old.messages.find(m => m.id === task.messageId)!; const index = next.messages.findIndex(m => m.id === task.messageId); if (index < 0) throw new Error('不能删除生成中的消息'); next.messages[index] = authoritative; }
      const oldBranch = old.branches.find(b => b.id === task.branchId), nextBranch = next.branches.find(b => b.id === task.branchId);
      if (oldBranch && nextBranch) nextBranch.summary = oldBranch.summary;
    }
    for (const old of state.conversations) {
      const next = incoming.conversations.find(c => c.id === old.id);
      if (!next) { titles.get(old.id)?.abort(); continue; }
      next.backgroundUsage = old.backgroundUsage;
      next.messages = next.messages.map(m => { const existing = old.messages.find(x => x.id === m.id); return existing && (tasks.has(old.id) || existing.status !== 'streaming') ? existing : m; });
      if (next.manualTitle) next.titleState = 'done';
      else if (titles.has(old.id) || old.titleState !== 'idle') { next.title = old.title; next.titleState = titles.has(old.id) ? 'pending' : old.titleState; }
    }
    // Preserve object identity for tasks holding conversation/branch references.
    for (const next of incoming.conversations) {
      const old = state.conversations.find(c => c.id === next.id);
      if (old && (tasks.has(next.id) || titles.has(next.id))) {
        next.backgroundUsage = old.backgroundUsage;
      next.messages = next.messages.map(m => { const existing = old.messages.find(x => x.id === m.id); return m.id === tasks.get(next.id)?.messageId && existing ? existing : m; });
        next.branches = next.branches.map(b => { const existing = old.branches.find(x => x.id === b.id); if (existing) { Object.assign(existing, b); return existing; } return b; });
        Object.assign(old, next);
        incoming.conversations[incoming.conversations.indexOf(next)] = old;
      }
    }
    state = incoming; store.save(state); return store.public(state);
  });
  handle('run', runChat);
  handle('cancel', (id: string) => { tasks.get(id)?.controller.abort(); });
  handle('compress', async (id: string, branchId: string) => {
    const { conversation, branch } = get(id, branchId); if (tasks.has(id)) throw new Error('请先等待当前任务完成');
    const controller = new AbortController(); tasks.set(id, { controller, branchId, kind: 'compression' }); emit(true);
    try { await compress(conversation, branch, controller.signal); } finally { tasks.delete(id); store.save(state); emit(true); }
  });
  handle('title', async (id: string) => {
    const conversation = state.conversations.find(c => c.id === id); if (!conversation) throw new Error('会话不存在'); if (titles.has(id)) throw new Error('标题正在生成中');
    const branch = conversation.branches.find(b => b.id === conversation.activeBranchId)!; const path = pathTo(conversation, branch.leafId);
    if (!path.some(m => m.role === 'assistant' && m.status === 'complete' && m.text.trim())) throw new Error('请先完成一次模型回答');
    conversation.manualTitle = false; conversation.titleState = 'idle'; await generateTitle(conversation, branch.config, path);
  });
  handle('test', async (connection: Connection) => {
    if (connection.apiKey === SECRET_MARKER) connection.apiKey = state.settings.connections.find(c => c.id === connection.id)?.apiKey || '';
    for (const [name, value] of Object.entries(connection.headers)) if (value === SECRET_MARKER) connection.headers[name] = state.settings.connections.find(c => c.id === connection.id)?.headers[name] || '';
    try { return await listModels(connection); } catch (e) { let detail = redact(e); for (const secret of [connection.apiKey, ...Object.values(connection.headers)]) if (secret) detail = detail.split(secret).join('[已隐藏]'); throw new Error(detail); }
  });
  handle('external', (url: string) => { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('链接协议不受支持'); return shell.openExternal(parsed.href); });
  handle('window-minimize', () => win?.minimize());
  handle('window-toggle-maximize', () => { if (!win) return false; if (win.isMaximized()) win.unmaximize(); else win.maximize(); return win.isMaximized(); });
  handle('window-is-maximized', () => !!win?.isMaximized());
  handle('window-close', () => win?.close());
  handle('export', async (format: string, id?: string) => {
    const copy = structuredClone(state); copy.conversations = id ? copy.conversations.filter(c => c.id === id) : copy.conversations;
    for (const c of copy.settings.connections) { c.apiKey = ''; c.headers = {}; } copy.settings.exaKey = ''; copy.settings.ollamaKey = ''; copy.settings.tavilyKey = ''; copy.settings.firecrawlKey = ''; copy.settings.anysearchKey = '';
    copy.settings.secretPolicy = 'session'; copy.selectedId = copy.conversations[0]?.id || null;
    const content = format === 'json' ? JSON.stringify({ version: 1, state: copy }, null, 2) : copy.conversations.map(c => `# ${c.title}\n\n${c.branches.map(b => `## ${b.name}\n\n${pathTo(c, b.leafId).map(m => `### ${m.role === 'user' ? '用户' : '助手'}${m.edited ? '（手动编辑）' : ''}\n\n${m.text}${m.attachments.map(a => `\n\n![${a.name}](${a.data})`).join('')}`).join('\n\n')}`).join('\n\n')}`).join('\n\n');
    const file = await dialog.showSaveDialog(win!, { defaultPath: `DeepChan-chat-${Date.now()}.${format === 'json' ? 'json' : 'md'}` }); if (file.canceled || !file.filePath) return false;
    writeFileSync(file.filePath, content, { mode: 0o600 }); return true;
  });
  handle('import', async () => {
    if (tasks.size) throw new Error('请先等待所有生成和压缩任务完成');
    const file = await dialog.showOpenDialog(win!, { filters: [{ name: 'DeepChan-chat 备份', extensions: ['json'] }], properties: ['openFile'] }); if (file.canceled) return null;
    const backup = JSON.parse(readFileSync(file.filePaths[0], 'utf8')); if (backup.version !== 1) throw new Error('不支持的备份版本'); validateState(backup.state);
    const choice = await dialog.showMessageBox(win!, { type: 'warning', message: '用备份替换当前会话和配置？', detail: '建议先导出当前备份。导入的连接不包含密钥，需要重新填写。', buttons: ['取消', '替换'], defaultId: 0, cancelId: 0 }); if (choice.response !== 1) return null;
    for (const controller of titles.values()) controller.abort();
    state = backup.state; for (const c of state.settings.connections) { c.apiKey = ''; c.headers = {}; } state.settings.exaKey = ''; state.settings.ollamaKey = ''; state.settings.tavilyKey = ''; state.settings.firecrawlKey = ''; state.settings.anysearchKey = ''; state.settings.secretPolicy = 'file'; state.settings.credentialStorageVersion = 1; state.settings.secureStorage = store.secure;
    for (const c of state.conversations) { if (c.titleState === 'pending') c.titleState = 'idle'; for (const m of c.messages) if (m.status === 'streaming') m.status = 'interrupted'; }
    store.save(state); emit(true); return store.public(state);
  });
}
async function openWindow() {
  win = new BrowserWindow({ width: 1440, height: 720, minWidth: 800, minHeight: 560, title: 'DeepChan-chat', frame: false, hasShadow: true, transparent: false, backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const sendWindowState = () => { if (win && !win.isDestroyed()) win.webContents.send('window-state', { maximized: win.isMaximized() }); };
  win.on('maximize', sendWindowState); win.on('unmaximize', sendWindowState);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== win?.webContents.getURL()) event.preventDefault(); });
  const devUrl = process.env.DEEPCHAN_DEV_URL;
  if (devUrl) await win.loadURL(devUrl); else await win.loadFile(join(__dirname, '../dist/index.html'));
  win.on('close', event => {
    if (!tasks.size && !titles.size) return;
    const choice = dialog.showMessageBoxSync(win!, { type: 'question', message: '仍有生成或后台任务，停止并退出？', buttons: ['继续使用', '停止并退出'], defaultId: 0, cancelId: 0 });
    if (choice === 0) event.preventDefault(); else { for (const task of tasks.values()) task.controller.abort(); for (const task of titles.values()) task.abort(); for (const c of state.conversations) for (const m of c.messages) if (m.status === 'streaming') m.status = 'interrupted'; store.save(state); }
  });
}
app.setName('DeepChan-chat');
app.setPath('userData', process.env.DEEPCHAN_DATA_DIR ? join(process.env.DEEPCHAN_DATA_DIR, 'profile') : join(app.getPath('appData'), 'DeepChan-chat'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    const directory = process.env.DEEPCHAN_DATA_DIR || join(app.getPath('userData'), 'data');
    store = new Store(directory); await store.init(); state = store.load(); register(); await openWindow(); }).catch(error => { console.error('启动失败：', error.message); dialog.showErrorBox('DeepChan-chat 启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { clearTimeout(persistTimer); if (state && store) store.save(state); });
}
