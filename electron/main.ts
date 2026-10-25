import { app, BrowserWindow, ipcMain, dialog, shell, net, screen } from 'electron';
import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { Store, SECRET_MARKER } from './store';
import { DEFAULT_WINDOW_SIZE, MINIMUM_WINDOW_SIZE, restoreWindow } from './window_state';
import { settingsProblems, validateState } from '../src/validation';
import { applyStateChanges, type StateChange } from '../src/domain';
import { generate, listModels, type WebFetch } from './providers';
import { convertUnsupportedAttachments, findAttachment } from './attachments';
import { fetchWebPageWithProviders } from './web_fetch';
import { appendAssistantSegment, appendReasoningDuration, compressionCut, contextMessages, effectiveProtocol, estimateTokens, MAX_COMPRESSION_RETAINED_TOKENS, pathTo, summaryValid } from '../src/domain';
import type { AppState, Branch, ChatConfig, Connection, Conversation, Message, Model, RequestRecord, RunRequest, WindowLayout } from '../src/types';
import { elapsedExcludingToolWait } from './usage';
import { RequestLog } from './request_log';
import { broadcastDelay } from './broadcast';
let win: BrowserWindow | null = null, state: AppState, store: Store;
// 上次关闭时的窗口布局：尺寸、是否最大化、大纲栏开没开。主进程是唯一写它的人，渲染层只读写
// 大纲栏那一项。
let windowLayout: WindowLayout = { ...DEFAULT_WINDOW_SIZE, maximized: false, outline: true };
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
// 删除的宽限期：渲染层删掉的会话先只解绑、不落刀，窗口内可以整批拿回来。行、附件文件和请求记录
// 都原样留着，所以撤销不需要恢复任何数据——它们根本没被删过。
let grace: { conversations: Map<string, Conversation>; selectedId: string | null } | null = null;
let graceTimer: ReturnType<typeof setTimeout> | undefined;
// 比渲染层那条带「撤销」按钮的提示（12s）多留 3s，免得按钮点到一个刚刚关掉的窗口上。
const DELETE_GRACE_MS = 15000;
const webFetch: WebFetch = (url, signal, settings, mode) => fetchWebPageWithProviders(url, signal, settings, mode, (input, init) => net.fetch(input, init));
const tasks = new Map<string, { controller: AbortController; branchId: string; messageId?: string; kind: string }>();
// Per-message request log for the in-app debug view. Memory only: never persisted, never exported,
// and the bodies arrive already redacted by the provider layer.
const requestLog = new RequestLog();
const titles = new Map<string, AbortController>();
let broadcastTimer: ReturnType<typeof setTimeout> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;
// The answer currently streaming: while it is set, the debounced persist writes only that row.
let streaming: { conversation: Conversation; message: Message } | null = null;
// The same answer is also the only thing the throttled broadcast has to send.
let pendingPatch: { conversationId: string; messageId: string } | null = null;
const redact = (error: unknown) => {
  let text = error instanceof Error ? error.message : String(error);
  for (const key of [...(state?.settings.connections.flatMap(c => [c.apiKey, ...Object.values(c.headers)]) || []), state?.settings.exaKey, state?.settings.ollamaKey, state?.settings.tavilyKey, state?.settings.firecrawlKey, state?.settings.anysearchKey, state?.settings.deepseekKey]) if (key) text = text.split(key).join('[已隐藏]');
  return text.slice(0, 1600);
};
function taskList() { return [...tasks].map(([conversationId, t]) => ({ conversationId, branchId: t.branchId, kind: t.kind })); }
function emit(immediate = false, streamingChars = 0) {
  const send = () => {
    broadcastTimer = undefined;
    if (!win || win.isDestroyed()) { pendingPatch = null; return; }
    // While an answer streams, only that message is sent: a full state would clone and transfer every
    // other message and every attachment on each refresh.
    const target = pendingPatch; pendingPatch = null;
    if (target && !immediate) {
      const conversation = state.conversations.find(c => c.id === target.conversationId);
      const message = conversation?.messages.find(m => m.id === target.messageId);
      if (conversation && message) { win.webContents.send('event', { patch: { conversationId: conversation.id, message: store.publicMessage(message) }, tasks: taskList() }); return; }
    }
    win.webContents.send('event', { state: store.public(state), tasks: taskList() });
  };
  // `streamingChars` is the length of the answer being streamed: long answers refresh less often.
  if (immediate) { clearTimeout(broadcastTimer); pendingPatch = null; send(); } else if (!broadcastTimer) broadcastTimer = setTimeout(send, broadcastDelay(streamingChars));
  if (!persistTimer) persistTimer = setTimeout(() => {
    persistTimer = undefined;
    try {
      // While an answer streams, only its own row changes; every other change waits for the full
      // save that each task runs when it ends.
      if (!streaming || !store.saveStreamingMessage(streaming.conversation, streaming.message)) store.save(state);
    } catch (e) { notify(redact(e)); }
  }, 800);
}
function notify(error: string) { win?.webContents.send('event', { error }); }
/**
 * 记下窗口现在的样子，好让下次打开时原样恢复。尺寸取 getNormalBounds 而不是 getBounds：最大化时
 * 后者是整块屏幕，照它存的话下次点「还原」会跳到一个谁也没设过的尺寸。
 */
function snapshotWindowLayout() {
  if (!win || win.isDestroyed()) return;
  windowLayout = { ...win.getNormalBounds(), maximized: win.isMaximized(), outline: windowLayout.outline };
  // 布局存档不值得拦住拖动或退出，下次改动还会再写一遍，所以这里连报错都不提示。
  try { store.saveWindowLayout(windowLayout); } catch { /* best effort */ }
}
function rememberWindowLayout() {
  if (layoutTimer || !win || win.isDestroyed()) return;
  // 拖动和缩放是连珠炮，攒 400ms 再写一次。闹钟只起一次、不因新事件续期：续期的话一直拖着就永远
  // 不落盘，不续期最坏也只丢 400ms 内的位移。
  layoutTimer = setTimeout(() => { layoutTimer = undefined; snapshotWindowLayout(); }, 400);
}
/** 关掉窗口前补写一次：防抖还没到点的话，最后那次拖动就只剩内存里知道了。 */
function flushWindowLayout() { clearTimeout(layoutTimer); layoutTimer = undefined; snapshotWindowLayout(); }
/**
 * 关掉撤销窗口，把留着的东西真删掉。persist=false 用在「正好有一次保存要跑」的场合：解绑之后那次
 * 保存就会把行和附件清掉，不必再存一遍；超时和退出前用 true，自己补一次保存。
 */
function closeGrace(persist: boolean) {
  clearTimeout(graceTimer); graceTimer = undefined;
  const lost = grace ? [...grace.conversations.values()] : [];
  grace = null;
  if (!lost.length) return;
  store.unhold(lost.map(conversation => conversation.id));
  // 请求记录不进数据库，只能自己删；附件文件交给下一次保存的 keep 集合。
  store.deleteRequests(lost.flatMap(conversation => conversation.messages.map(message => message.id)));
  if (persist) try { store.save(state); } catch (e) { notify(redact(e)); }
}
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
  const result = await generate(connection, { ...model, maxOutput: Math.min(model.maxOutput, MAX_COMPRESSION_RETAINED_TOKENS) }, { ...branch.config, modelId, search: 'off', webFetch: 'off', localTools: false, effort: 'auto', budget: 1024, system: HISTORY_COMPRESSION_PROMPT }, [plainMessage(material)], state.settings, signal);
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
    const result = await generate(connection, { ...model, maxOutput: Math.min(model.maxOutput, 2048) }, { ...config, modelId, search: 'off', webFetch: 'off', localTools: false, effort: 'auto', budget: 1024, system: '为下面的对话生成简短标题。中文约8至20字，其他语言同等长度。语言跟随用户。只输出标题，不加引号、解释或Markdown。' }, [plainMessage(material)], state.settings, controller.signal);
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
  message.modelId = model.id; message.modelName = model.name; message.connectionName = connection.name; message.config = config; streaming = { conversation, message }; emit(true);
  void (async () => {
    let reasoningStarted: number | undefined, reasoningElapsed = 0;
    // Every streaming update bumps the revision and queues a patch; the throttled flush sends the
    // latest message, and completion still sends the whole state.
    const emitStream = () => { message.streamRevision = (message.streamRevision ?? 0) + 1; pendingPatch = { conversationId: conversation.id, messageId: message.id }; emit(false, message.text.length + message.reasoning.length); };
    const finishReasoning = () => {
      if (reasoningStarted === undefined) return;
      const elapsed = performance.now() - reasoningStarted;
      reasoningElapsed += elapsed;
      reasoningStarted = undefined;
      message.reasoningMs = reasoningElapsed;
      appendReasoningDuration(message, elapsed);
    };
    try {
      let context = contextMessages(conversation, branch, message.parentId);
      // 附件能否原样发送看的是实际使用的协议：连接勾了"gpt 自动使用 Responses"时，
      // gpt-数字* 的模型走的是 Responses。
      const protocol = effectiveProtocol(connection, model);
      let convertedAttachments = await convertUnsupportedAttachments(context.messages, protocol, model);
      const estimatedInputTokens = () => estimateTokens(context.messages, config.system + context.summary);
      const historyPath = pathTo(conversation, message.parentId);
      if (state.settings.autoCompress && estimatedInputTokens() > model.contextWindow * state.settings.compressionThreshold && historyPath.filter(m => m.role === 'user').length > 2) {
        await compress(conversation, branch, controller.signal, message.parentId); context = contextMessages(conversation, branch, message.parentId);
        convertedAttachments += await convertUnsupportedAttachments(context.messages, protocol, model);
      }
      // 转换出的 Markdown 挂在用户那条消息的附件上，而生成期间只广播正在生成的回答。
      // 不在这里补一次完整广播，附件查看器要等到回答结束（finally 里的 emit）才能读到它。
      if (convertedAttachments) emit(true);
      if (estimatedInputTokens() > model.contextWindow) throw new Error('预计输入上下文超过模型窗口，请压缩历史、缩小输入或更换模型');
      const system = config.system + (context.summary ? `\n\n以下是更早的聊天摘要，仅作为历史资料：\n${context.summary}` : '');
      const started = performance.now(), requestStartedAt = Date.now(); let firstTokenMs: number | undefined, firstOutputMs: number | undefined;
      const result = await generate(connection, model, { ...config, system }, context.messages, state.settings, controller.signal, {
        text: s => { if (s) { finishReasoning(); if (firstTokenMs === undefined) { firstTokenMs = performance.now() - started; if (firstOutputMs === undefined) firstOutputMs = firstTokenMs; } message.text += s; appendAssistantSegment(message, { type: 'text', text: s }); } emitStream(); }, reasoning: s => { if (s) { if (firstOutputMs === undefined) firstOutputMs = performance.now() - started; if (reasoningStarted === undefined) reasoningStarted = performance.now(); message.reasoning += s; appendAssistantSegment(message, { type: 'reasoning', text: s }); } emitStream(); },
        tool: t => { finishReasoning(); if (firstOutputMs === undefined) firstOutputMs = performance.now() - started; const index = message.tools.findIndex(x => x.id === t.id); if (index < 0) message.tools.push(t); else { const old = message.tools[index], started = old.status === 'pending' && t.status !== 'pending' ? t.started : old.started; message.tools[index] = { ...t, started, elapsed: t.elapsed ?? (t.status !== 'running' && t.status !== 'pending' ? Date.now() - started : undefined) }; } appendAssistantSegment(message, { type: 'tool', toolId: t.id }); emitStream(); },
        sources: sources => { message.sources = sources; emitStream(); },
        notice: message => notify(message),
        record: entry => { requestLog.add(message.id, entry); store.saveRequests(message.id, requestLog.get(message.id)); }
      }, webFetch);
      if (!result.text.trim()) throw new Error('模型未返回回答正文');
      const elapsedMs = performance.now() - started;
      message.raw = result.raw; message.usage = { ...result.usage, elapsedMs, generationMs: elapsedExcludingToolWait(elapsedMs, requestStartedAt, message.tools), firstTokenMs, firstOutputMs }; message.sources = result.sources; message.status = 'complete';
      if (conversation.title === '新对话' && !conversation.manualTitle) conversation.title = pathTo(conversation, message.id).find(m => m.role === 'user')?.text.slice(0, 24) || '图片对话';
      void generateTitle(conversation, config, pathTo(conversation, message.id));
    } catch (error) { message.status = controller.signal.aborted ? 'interrupted' : 'error'; message.error = controller.signal.aborted ? '已停止生成' : redact(error); }
    finally { streaming = null; finishReasoning(); for (const t of message.tools) if (t.status === 'running' || t.status === 'pending') { if (t.status === 'running') t.elapsed = Date.now() - t.started; t.status = 'error'; t.output = '任务已结束或中断'; } tasks.delete(conversation.id); store.save(state);
      // 请求记录在发出时就落盘了，但上游返回的原文与失败原因都是之后才填上的同一个对象，
      // 这里再存一次，调试视图在重启后也能看到它们。
      store.saveRequests(message.id, requestLog.get(message.id));
      emit(true); }
  })().catch(error => notify(redact(error)));
}
function register() {
  const handle = (name: string, fn: (...args: any[]) => any) => ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('无效的调用来源');
    return fn(...args);
  });
  handle('load', () => store.public(state));
  handle('save', (incoming: AppState, undoIds?: string[]) => {
    validateState(incoming); store.resolveSecrets(incoming);
    // 撤销窗口一次只留一个：上一个窗口里的会话先解绑，它们不在 incoming 里，下面那次保存就真删了。
    closeGrace(false);
    for (const [id, task] of tasks) {
      const old = state.conversations.find(c => c.id === id), next = incoming.conversations.find(c => c.id === id);
      if (!old || !next || !next.branches.some(b => b.id === task.branchId)) throw new Error('请先停止任务再删除会话或分支');
      if (task.messageId) { const authoritative = old.messages.find(m => m.id === task.messageId)!; const index = next.messages.findIndex(m => m.id === task.messageId); if (index < 0) throw new Error('不能删除生成中的消息'); next.messages[index] = authoritative; }
      const oldBranch = old.branches.find(b => b.id === task.branchId), nextBranch = next.branches.find(b => b.id === task.branchId);
      if (oldBranch && nextBranch) nextBranch.summary = oldBranch.summary;
    }
    for (const old of state.conversations) {
      const next = incoming.conversations.find(c => c.id === old.id);
      if (!next) {
        titles.get(old.id)?.abort();
        // 这次删除是「可撤销」的：只解绑，不动行、附件和请求记录，等窗口关掉那次保存再清。
        if (undoIds?.includes(old.id)) {
          grace ??= { conversations: new Map(), selectedId: null };
          grace.conversations.set(old.id, old);
          if (state.selectedId === old.id) grace.selectedId = old.id;
          store.hold([old]);
          clearTimeout(graceTimer); graceTimer = setTimeout(() => closeGrace(true), DELETE_GRACE_MS);
          continue;
        }
        store.deleteRequests(old.messages.map(m => m.id)); continue;
      }
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
  // 草稿是唯一的高频写入，而且它只落在某一个分支上。走整份 state 的话，每停 450 ms 都要
  // 序列化一遍全部会话；这里只把文本写到主进程那份状态上再落盘（saveState 按行差量写）。
  handle('draft', (branchId: string, draft: string) => {
    if (typeof branchId !== 'string' || typeof draft !== 'string') throw new Error('草稿参数无效');
    if (draft.length > 200_000) throw new Error('草稿过长');
    for (const conversation of state.conversations) {
      const position = conversation.branches.findIndex(b => b.id === branchId);
      if (position < 0) continue;
      const branch = conversation.branches[position];
      branch.draft = draft;
      store.saveDraft(conversation.id, position, branch);
      return true;
    }
    // 分支可能刚被删掉：草稿丢了不算错误，不要因此打断用户输入。
    return false;
  });
  // 设置同理：只有 settings 这一段会变，没必要为它往返整份状态。返回值带上主进程才知道的
  // 字段（secureStorage、credentialStorageVersion），渲染层照单收下。
  handle('settings', (incoming: AppState['settings']) => {
    const problem = settingsProblems(incoming)[0];
    if (problem) throw new Error(problem);
    store.resolveSecrets({ settings: incoming });
    state.settings = incoming; store.save(state);
    return store.public(state).settings;
  });
  // 选择、切换分支、改名、归档：只写被改到的行（一个 meta、一个会话头、或一个分支），
  // 会话再多也不用把整份状态序列化一遍。字段白名单在 applyStateChanges 里，两端共用一份。
  handle('fields', (changes: StateChange[]) => {
    if (!Array.isArray(changes) || changes.length > 16) throw new Error('状态更新参数无效');
    const next = applyStateChanges(state, changes);
    for (const change of changes) {
      if (change.kind === 'selected') { store.saveSelection(next.selectedId); continue; }
      const conversationId = change.kind === 'conversation' ? change.id : change.conversationId;
      const position = next.conversations.findIndex(c => c.id === conversationId);
      if (position < 0) continue;
      const conversation = next.conversations[position];
      store.saveConversation(conversation, position);
      if (change.kind !== 'branch') continue;
      const branchPosition = conversation.branches.findIndex(b => b.id === change.id);
      if (branchPosition >= 0) store.saveBranchOf(conversation.id, branchPosition, conversation.branches[branchPosition]);
    }
    state = next;
    return true;
  });
  handle('run', runChat);
  handle('cancel', (id: string) => { tasks.get(id)?.controller.abort(); });
  handle('compress', async (id: string, branchId: string) => {
    const { conversation, branch } = get(id, branchId); if (tasks.has(id)) throw new Error('请先等待当前任务完成');
    const controller = new AbortController(); tasks.set(id, { controller, branchId, kind: 'compression' }); emit(true);
    try { await compress(conversation, branch, controller.signal); } finally { tasks.delete(id); store.save(state); emit(true); }
  });
  // Attachment payloads are fetched one at a time: a broadcast carries no bytes, only references.
  handle('attachment', (id: string) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) ? findAttachment(state, id)?.data || '' : '');
  handle('debug', (messageId: string) => requestLog.get(messageId).length ? requestLog.get(messageId) : store.loadRequests(messageId));
  handle('versions', () => ({ app: app.getVersion(), chromium: process.versions.chrome || '', electron: process.versions.electron || '', node: process.versions.node || '' }));
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
  // 撤销删除：把这些会话放回状态再广播一次就完了——数据库里的行、附件和请求记录一直没动过。
  handle('undo-delete', () => {
    if (!grace || !grace.conversations.size) return false;
    const back = [...grace.conversations.values()], selection = grace.selectedId;
    clearTimeout(graceTimer); graceTimer = undefined; grace = null;
    store.unhold(back.map(conversation => conversation.id));
    state.conversations = [...back, ...state.conversations];
    // 删掉的正是当下看着的那条时，撤销要连位置一起还回来。
    if (selection && !state.conversations.some(c => c.id === state.selectedId)) state.selectedId = selection;
    emit(true);
    return back.map(conversation => conversation.id);
  });
  // 渲染层只关心大纲栏：窗口尺寸、是否最大化由主进程自己看着办，不必绕一圈回来。
  handle('window-layout', () => ({ outline: windowLayout.outline }));
  handle('window-outline', (open: boolean) => { windowLayout = { ...windowLayout, outline: !!open }; return store.saveWindowLayout(windowLayout); });
  handle('export', async (format: string, id?: string) => {
    const copy = structuredClone(state); copy.conversations = id ? copy.conversations.filter(c => c.id === id) : copy.conversations;
    for (const c of copy.settings.connections) { c.apiKey = ''; c.headers = {}; } copy.settings.exaKey = ''; copy.settings.ollamaKey = ''; copy.settings.tavilyKey = ''; copy.settings.firecrawlKey = ''; copy.settings.anysearchKey = ''; copy.settings.deepseekKey = '';
    copy.settings.secretPolicy = 'session'; copy.selectedId = copy.conversations[0]?.id || null;
    const content = format === 'json' ? JSON.stringify({ version: 1, state: copy }, null, 2) : copy.conversations.map(c => `# ${c.title}\n\n${c.branches.map(b => `## ${b.name}\n\n${pathTo(c, b.leafId).map(m => `### ${m.role === 'user' ? '用户' : '助手'}${m.edited ? '（手动编辑）' : ''}\n\n${m.text}${m.attachments.map(a => `\n\n![${a.name}](${a.data})`).join('')}`).join('\n\n')}`).join('\n\n')}`).join('\n\n');
    const file = await dialog.showSaveDialog(win!, { defaultPath: `Seekie-Chat-${Date.now()}.${format === 'json' ? 'json' : 'md'}` }); if (file.canceled || !file.filePath) return false;
    writeFileSync(file.filePath, content, { mode: 0o600 }); return true;
  });
  handle('import', async () => {
    if (tasks.size) throw new Error('请先等待所有生成和压缩任务完成');
    const file = await dialog.showOpenDialog(win!, { filters: [{ name: 'Seekie Chat 备份', extensions: ['json'] }], properties: ['openFile'] }); if (file.canceled) return null;
    const backup = JSON.parse(readFileSync(file.filePaths[0], 'utf8')); if (backup.version !== 1) throw new Error('不支持的备份版本'); validateState(backup.state);
    const choice = await dialog.showMessageBox(win!, { type: 'warning', message: '用备份替换当前会话和配置？', detail: '建议先导出当前备份。导入的连接不包含密钥，需要重新填写。', buttons: ['取消', '替换'], defaultId: 0, cancelId: 0 }); if (choice.response !== 1) return null;
    for (const controller of titles.values()) controller.abort();
    // 导入会换掉整个状态，撤销窗口带着它走会让已删的会话在下次保存时复活，先关掉。
    closeGrace(false);
    state = backup.state; requestLog.clear(); store.clearRequests(); for (const c of state.settings.connections) { c.apiKey = ''; c.headers = {}; } state.settings.exaKey = ''; state.settings.ollamaKey = ''; state.settings.tavilyKey = ''; state.settings.firecrawlKey = ''; state.settings.anysearchKey = ''; state.settings.deepseekKey = ''; state.settings.secretPolicy = 'file'; state.settings.credentialStorageVersion = 1; state.settings.secureStorage = store.secure;
    for (const c of state.conversations) { if (c.titleState === 'pending') c.titleState = 'idle'; for (const m of c.messages) if (m.status === 'streaming') m.status = 'interrupted'; }
    store.save(state); emit(true); return store.public(state);
  });
}
async function openWindow() {
  // 上次的布局要先换算成建窗口参数才能建窗口：存档里的尺寸可能来自已经拔掉的显示器，也可能大过
  // 现在的屏幕，restoreWindow 负责把它拉回够得着的地方。
  const saved = store.loadWindowLayout();
  const restored = restoreWindow(saved, screen.getAllDisplays());
  windowLayout = { ...restored, outline: saved?.outline ?? true };
  win = new BrowserWindow({ ...(restored.x === undefined || restored.y === undefined ? {} : { x: restored.x, y: restored.y }), width: restored.width, height: restored.height, minWidth: MINIMUM_WINDOW_SIZE.width, minHeight: MINIMUM_WINDOW_SIZE.height, title: 'Seekie Chat', frame: false, hasShadow: true, transparent: false, backgroundColor: '#ffffff', autoHideMenuBar: true,
    // 先把窗口摆成上次的尺寸、该最大化就先最大化，再让它上屏：否则用户会看到窗口先以默认尺寸
    // 出现、下一帧才跳到恢复后的样子。
    show: false,
    // Electron 不会替我们从 package.json 取图标；构建时把 build/icon.png 复制到主进程旁边，
    // 这样无论从哪个工作目录启动都能按 __dirname 找到。
    icon: join(__dirname, 'icon.png'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  if (restored.maximized) win.maximize();
  const sendWindowState = () => { if (win && !win.isDestroyed()) win.webContents.send('window-state', { maximized: win.isMaximized() }); };
  win.on('maximize', () => { sendWindowState(); rememberWindowLayout(); }); win.on('unmaximize', () => { sendWindowState(); rememberWindowLayout(); });
  win.on('resize', rememberWindowLayout); win.on('move', rememberWindowLayout);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== win?.webContents.getURL()) event.preventDefault(); });
  win.once('ready-to-show', () => { if (win && !win.isDestroyed()) win.show(); });
  const devUrl = process.env.SEEKIE_DEV_URL;
  if (devUrl) await win.loadURL(devUrl); else await win.loadFile(join(__dirname, '../dist/index.html'));
  // 兜底：上屏这件事交给了 ready-to-show，万一它不来（某些显卡驱动或合成器下会），用户看到的
  // 就是「程序在跑但窗口看不见」。走到这里页面已经加载完，多 show 一次最多是一帧空白。
  if (!win.isDestroyed() && !win.isVisible()) win.show();
  // 关掉窗口前先认下最后的尺寸和大纲栏状态：放在问不问那句之前，因为「继续使用」会把这次关闭取消掉。
  win.on('close', event => {
    flushWindowLayout();
    if (!tasks.size && !titles.size) return;
    const choice = dialog.showMessageBoxSync(win!, { type: 'question', message: '仍有生成或后台任务，停止并退出？', buttons: ['继续使用', '停止并退出'], defaultId: 0, cancelId: 0 });
    if (choice === 0) event.preventDefault(); else { for (const task of tasks.values()) task.controller.abort(); for (const task of titles.values()) task.abort(); for (const c of state.conversations) for (const m of c.messages) if (m.status === 'streaming') m.status = 'interrupted'; store.save(state); }
  });
}
// 程序内部的标识一律用小写连字符：安装目录 /opt/seekie-chat 与配置目录 ~/.config/seekie-chat
// 都要能在命令行里直接写出来，不该逼用户转义空格。给人看的名字（窗口标题、桌面项、
// 关于页、侧栏）另有明确来源，不依赖这个名字。
app.setName('seekie-chat');
app.setPath('userData', process.env.SEEKIE_DATA_DIR ? join(process.env.SEEKIE_DATA_DIR, 'profile') : join(app.getPath('appData'), 'seekie-chat'));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { win?.show(); win?.focus(); });
  app.whenReady().then(async () => {
    const directory = process.env.SEEKIE_DATA_DIR || join(app.getPath('userData'), 'data');
    store = new Store(directory); await store.init(); state = store.load(); register(); await openWindow(); }).catch(error => { console.error('启动失败：', error.message); dialog.showErrorBox('Seekie Chat 启动失败', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  // 布局要在 store.close() 之前落盘：防抖还没到点又赶上退出（例如快捷键 Ctrl+Q 先走 before-quit）
  // 时，数据库已经关了，那时再写就只剩报错。
  // 宽限期里没点撤销就算确定要删：先解绑，紧接着那次 store.save 才会真的把行和附件清掉。
  // （被强杀时留着的行还在，下次启动这些会话会回来——宁可多留一份，也不要误删。）
  app.on('before-quit', () => { clearTimeout(persistTimer); if (store) { flushWindowLayout(); closeGrace(false); } if (state && store) { store.save(state); store.close(); } });
}
