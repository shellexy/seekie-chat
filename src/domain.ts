import type { AppState, AssistantSegment, Branch, ChatConfig, Connection, Conversation, Message, Model, PromptPreset, Protocol, Settings, Usage } from './types';
export const DEFAULT_SYSTEM_PROMPT = '你是一位严谨、友善的助手。使用用户的语言回答。';
export function defaultPromptPresets(): PromptPreset[] {
  return [
    { id: 'general', name: '通用助手', content: DEFAULT_SYSTEM_PROMPT },
    { id: 'coding', name: '编程助手', content: '你是一位严谨的编程助手。先理解目标和现有代码，给出可运行、易维护的方案。说明关键取舍和验证方法；缺少信息时明确指出，不编造执行结果。使用用户的语言回答。' },
    { id: 'writing', name: '写作助手', content: '你是一位写作和编辑助手。根据读者、目的和语气组织内容，使用清晰自然的语言。保留用户原意，避免空泛表达；不编造事实和引用。使用用户的语言回答。' },
    { id: 'translator', name: '翻译助手', content: '你是一位专业翻译助手。准确保留原文含义、语气和格式，术语保持一致。按照用户指定的目标语言翻译；未指定时先确认。需要解释时将说明与译文分开。' }
  ];
}
export function normalizePromptSettings(settings: Settings) {
  // Only missing libraries get defaults; an intentionally empty library stays empty.
  if (!Array.isArray(settings.promptPresets)) settings.promptPresets = defaultPromptPresets();
  if (typeof settings.defaultPromptPresetId !== 'string') settings.defaultPromptPresetId = 'general';
}
export function normalizeSettings(settings: Settings) {
  normalizePromptSettings(settings);
  if (typeof settings.firecrawlKey !== 'string') settings.firecrawlKey = '';
  if (typeof settings.anysearchKey !== 'string') settings.anysearchKey = '';
}
export const uid = () => crypto.randomUUID();
export function defaultModelEfforts(protocol: Protocol, model: string): string[] {
  if (protocol === 'gemini') return ['minimal', 'low', 'medium', 'high'];
  if (/^(gpt(?:[-/]|$)|deepseek(?:[-/]|$))/i.test(model.trim())) return ['low', 'medium', 'high', 'xhigh', 'max'];
  return ['minimal', 'low', 'medium', 'high'];
}
export function shouldDefaultVisionAndTools(...names: string[]): boolean {
  return names.some(name => {
    const normalized = name.trim().toLowerCase().replace(/(^|\/)models\//g, '$1');
    // Gemini models are also served through Chat Completions / Responses connections, where the
    // protocol alone cannot tell that the model accepts images and tools.
    return /(?:^|\/)(?:gpt|gemini)(?:[-_.:/]|$)/.test(normalized) || /(?:^|\/)deepseek[- ]flash(?:[-_.:/]|$)/.test(normalized);
  });
}
// Preference order for a model's initial effort: what the service recommends, then the usual middle
// level if the model supports it, then whatever comes first.
export function defaultModelEffort(model?: Model): string {
  if (!model) return 'auto';
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort)) return model.defaultEffort;
  if (model.efforts.includes('medium')) return 'medium';
  return model.efforts[0] || 'auto';
}
export const defaultConfig = (settings: Settings): ChatConfig => ({ modelId: settings.defaultModel, system: settings.promptPresets?.find(p => p.id === settings.defaultPromptPresetId)?.content ?? DEFAULT_SYSTEM_PROMPT, search: 'auto', webFetch: 'auto', effort: defaultModelEffort(settings.models.find(m => m.id === settings.defaultModel)), budget: Math.min(4096, Math.max(1024, (settings.models.find(m => m.id === settings.defaultModel)?.maxOutput || 8192) - 1)), temperature: 1, topP: 1 });
export function ollamaWebSearchKey(settings: Settings): string {
  if (settings.ollamaKey) return settings.ollamaKey;
  return settings.connections.find(connection => {
    try { return new URL(connection.baseUrl).hostname === 'ollama.com' && !!connection.apiKey; }
    catch { return false; }
  })?.apiKey || '';
}
export function resolveSearch(settings: Settings, modelId: string, mode: ChatConfig['search']): Exclude<ChatConfig['search'], 'auto'> {
  if (mode !== 'auto') return mode;
  const model = settings.models.find(m => m.id === modelId);
  const connection = settings.connections.find(c => c.id === model?.connectionId);
  if (model?.nativeSearch && connection && connection.protocol !== 'chat') return 'native';
  if (model?.tools && settings.exaKey) return 'exa';
  if (model?.tools && ollamaWebSearchKey(settings)) return 'ollama';
  if (model?.tools && settings.firecrawlKey) return 'firecrawl';
  if (model?.tools && settings.anysearchKey) return 'anysearch';
  if (model?.tools && settings.tavilyKey) return 'tavily';
  if (model?.tools) return 'firecrawl';
  return 'off';
}
export function initialState(): AppState {
  return { settings: { promptPresets: defaultPromptPresets(), defaultPromptPresetId: 'general', connections: [], models: [], defaultModel: '', titleModel: '', compressionModel: '', theme: 'light', fontSize: 15, exaKey: '', ollamaKey: '', tavilyKey: '', firecrawlKey: '', anysearchKey: '', exaResults: 5, autoCompress: true, compressionThreshold: 0.75, secureStorage: false, secretPolicy: 'file', credentialStorageVersion: 1 }, conversations: [], selectedId: null };
}
export function createConversation(settings: Settings): Conversation {
  const id = uid(), branchId = uid(), now = Date.now();
  return { id, title: '新对话', manualTitle: false, titleState: 'idle', archived: false, created: now, updated: now, activeBranchId: branchId,
    messages: [], branches: [{ id: branchId, name: '主线', leafId: null, originId: null, parentBranchId: null, config: defaultConfig(settings), draft: '', draftAttachments: [], scrollTop: 0, updated: now }] };
}
export function pathTo(conversation: Conversation, leafId: string | null): Message[] {
  const index = new Map(conversation.messages.map(m => [m.id, m]));
  const seen = new Set<string>(), path: Message[] = [];
  while (leafId) { if (seen.has(leafId)) throw new Error('对话路径存在循环'); seen.add(leafId); const node = index.get(leafId); if (!node) throw new Error('对话节点不存在'); path.unshift(node); leafId = node.parentId; }
  return path;
}
// Branch names are user visible and used to tell branches apart, so a counter alone is not enough:
// deleting or renaming a branch used to make the next one collide with an existing name.
export function uniqueBranchName(branches: Branch[], base: string): string {
  const taken = new Set(branches.map(b => b.name));
  if (!taken.has(base)) return base;
  for (let index = 2; ; index++) { const candidate = `${base} ${index}`; if (!taken.has(candidate)) return candidate; }
}
// A deleted model must not turn every historical answer into "未知模型": the message keeps the
// names it was answered with, so history still explains itself.
export function modelLabel(model: Model | undefined, connections: Connection[]): string {
  return model ? `${model.name} | ${connections.find(connection => connection.id === model.connectionId)?.name || '未知连接'}` : 'DeepChan-chat';
}
export function messageModelLabel(message: Message, models: Model[]): string {
  const live = models.find(m => m.id === message.modelId);
  return live?.name || message.modelName || (message.modelId ? '未知模型' : '未知模型');
}
export function fork(conversation: Conversation, sourceId: string, name?: string): Branch {
  const source = conversation.messages.find(m => m.id === sourceId);
  if (!source || source.role !== 'assistant' || source.status !== 'complete') throw new Error('只能从已完成的回答创建分支');
  const current = conversation.branches.find(b => b.id === conversation.activeBranchId)!;
  const branch: Branch = { id: uid(), name: name || uniqueBranchName(conversation.branches, '分支'), leafId: sourceId, originId: sourceId, parentBranchId: current.id,
    config: structuredClone(current.config), draft: '', draftAttachments: [], scrollTop: 0, updated: Date.now() };
  if (current.summary && summaryValid(current.summary, pathTo(conversation, sourceId))) branch.summary = structuredClone(current.summary);
  conversation.branches.push(branch); conversation.activeBranchId = branch.id;
  return branch;
}
export function summaryValid(summary: NonNullable<Branch['summary']>, path: Message[]): boolean {
  return summary.nodeIds.length > 0 && summary.nodeIds.every((id, i) => path[i]?.id === id);
}
export function contextMessages(conversation: Conversation, branch: Branch, leafId = branch.leafId) {
  const path = pathTo(conversation, leafId);
  return branch.summary && summaryValid(branch.summary, path)
    ? { summary: branch.summary.text, messages: path.slice(branch.summary.nodeIds.length) }
    : { summary: '', messages: path };
}
export function addMessage(conversation: Conversation, branch: Branch, role: Message['role'], text: string, parentId = branch.leafId): Message {
  const message: Message = { id: uid(), parentId, role, text, reasoning: '', attachments: [], tools: [], sources: [], status: role === 'assistant' ? 'streaming' : 'complete', created: Date.now() };
  conversation.messages.push(message); branch.leafId = message.id; branch.updated = conversation.updated = Date.now();
  return message;
}
// State broadcasts deep-clone the whole tree, so every message object gets a new identity on every
// update. A message row can therefore only skip re-rendering when its rendered content is compared
// by value; this is that comparison, kept pure so it can be tested for staleness directly.
export function sameMessage(a: Message, b: Message): boolean {
  if (a === b) return true;
  return a.id === b.id && a.parentId === b.parentId && a.role === b.role && a.text === b.text && a.reasoning === b.reasoning
    && a.status === b.status && a.edited === b.edited && a.error === b.error && a.created === b.created
    && a.modelId === b.modelId && a.modelName === b.modelName && a.connectionName === b.connectionName && a.reasoningMs === b.reasoningMs
    && a.segments?.length === b.segments?.length
    && (a.segments || []).every((segment, index) => { const other = b.segments![index]; return segment.type === other.type && (segment.type === 'tool' ? segment.toolId === (other as typeof segment).toolId : segment.text === (other as typeof segment).text && (segment.type === 'reasoning' ? segment.ms === (other as typeof segment).ms : true)); })
    && a.tools.length === b.tools.length
    && a.tools.every((tool, index) => { const other = b.tools[index]; return !!other && tool.id === other.id && tool.name === other.name && tool.status === other.status && tool.input === other.input && tool.output === other.output && tool.elapsed === other.elapsed; })
    && a.sources.length === b.sources.length && a.sources.every((source, index) => source.url === b.sources[index]?.url && source.title === b.sources[index]?.title)
    && a.attachments.length === b.attachments.length && a.attachments.every((attachment, index) => { const other = b.attachments[index]; return !!other && attachment.id === other.id && attachment.name === other.name && attachment.markdown === other.markdown && attachment.data === other.data; })
    && sameUsage(a.usage, b.usage);
}
function sameUsage(a?: Usage, b?: Usage) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.input === b.input && a.output === b.output && a.cachedInput === b.cachedInput && a.elapsedMs === b.elapsedMs && a.generationMs === b.generationMs && a.firstTokenMs === b.firstTokenMs;
}
// "最终正文" is the last text segment: the toolbar copy button, the answer editor and the copy
// menu all act on it, so the definition lives in one place.
/**
 * The whole visible answer: an answer may be interrupted by reasoning or tool calls and then continue
 * writing, so every text block counts as body text. Blocks are separated by a blank line, which is
 * what makes both the rendering and a copied answer read as paragraphs.
 */
export function assistantBody(message: Message) {
  const texts = message.segments?.filter((segment): segment is Extract<AssistantSegment, { type: 'text' }> => segment.type === 'text') || [];
  return texts.length ? texts.map(segment => segment.text).join('\n\n') : message.text;
}
/** What the editor shows: one box per text block for an answer, the single text for a question. */
export function editableBodies(message: Message): string[] {
  if (message.role !== 'assistant') return [message.text];
  const texts = message.segments?.filter((segment): segment is Extract<AssistantSegment, { type: 'text' }> => segment.type === 'text') || [];
  return texts.length ? texts.map(segment => segment.text) : [message.text];
}
/**
 * Writes edited bodies back into a message. An emptied box removes its block, and the summary fields
 * (`text`, `reasoning`) are recomputed so search, outline and copying stay consistent with the blocks.
 */
export function applyBodies(message: Message, texts: string[]) {
  if (message.role !== 'assistant') { message.text = texts[0] ?? ''; return; }
  const segments: AssistantSegment[] = message.segments?.length ? structuredClone(message.segments) : [
    ...(message.reasoning ? [{ type: 'reasoning' as const, text: message.reasoning }] : []),
    ...message.tools.map(tool => ({ type: 'tool' as const, toolId: tool.id })),
    ...(message.text ? [{ type: 'text' as const, text: message.text }] : [])
  ];
  const edited = texts.map(text => text.trim()).filter(text => text.length > 0);
  let index = 0;
  const next: AssistantSegment[] = [];
  for (const segment of segments) {
    if (segment.type !== 'text') { next.push(segment); continue; }
    const text = index < edited.length ? edited[index++] : '';
    if (text) next.push({ type: 'text', text });
  }
  // A box that was added beyond the existing blocks still becomes a block of its own.
  while (index < edited.length) next.push({ type: 'text', text: edited[index++] });
  message.segments = next;
  message.text = next.filter((segment): segment is Extract<AssistantSegment, { type: 'text' }> => segment.type === 'text').map(segment => segment.text).join('\n\n');
  message.reasoning = next.filter((segment): segment is Extract<AssistantSegment, { type: 'reasoning' }> => segment.type === 'reasoning').map(segment => segment.text).join('');
}
export function appendReasoningDuration(message: Message, elapsedMs: number) {
  const segment = message.segments?.at(-1);
  if (segment?.type === 'reasoning') segment.ms = (segment.ms ?? 0) + elapsedMs;
}
export function messageDateTime(timestamp: number) {
  const date = new Date(timestamp), pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function appendAssistantSegment(message: Message, segment: AssistantSegment) {
  const segments = message.segments ??= [];
  if (segment.type === 'tool') {
    if (!segments.some(existing => existing.type === 'tool' && existing.toolId === segment.toolId)) segments.push(segment);
    return;
  }
  const previous = segments.at(-1);
  if (previous && previous.type === segment.type) previous.text += segment.text;
  else segments.push(segment);
}
export function editMessage(conversation: Conversation, sourceId: string, text: string): { branch: Branch; message: Message } {
  const source = conversation.messages.find(m => m.id === sourceId)!;
  const current = conversation.branches.find(b => b.id === conversation.activeBranchId)!;
  const branch: Branch = { ...structuredClone(current), id: uid(), name: uniqueBranchName(conversation.branches, '编辑'), originId: source.parentId, parentBranchId: current.id, leafId: source.parentId, draft: '', draftAttachments: [], summary: undefined, updated: Date.now() };
  conversation.branches.push(branch); conversation.activeBranchId = branch.id;
  const message = addMessage(conversation, branch, source.role, text, source.parentId);
  message.attachments = structuredClone(source.attachments); message.edited = true; message.status = 'complete'; message.modelId = source.modelId;
  // A manual answer is plain assistant text; do not replay stale signed reasoning or tools.
  return { branch, message };
}
export function removeBranch(conversation: Conversation, branchId: string) {
  if (conversation.branches.length === 1) throw new Error('不能删除最后一个分支');
  const removed = new Set([branchId]);
  for (let changed = true; changed;) { changed = false; for (const b of conversation.branches) if (b.parentBranchId && removed.has(b.parentBranchId) && !removed.has(b.id)) { removed.add(b.id); changed = true; } }
  const keep = conversation.branches.filter(b => !removed.has(b.id));
  if (!keep.length) throw new Error('不能删除全部分支，请删除整个会话');
  conversation.branches = keep;
  if (removed.has(conversation.activeBranchId)) conversation.activeBranchId = keep[0].id;
  // Preserve alternative answer versions and audit evidence. Garbage collection belongs to conversation deletion.
}
export function firstLine(text: string) {
  const first = text.split('\n').map(l => l.trim()).find(Boolean) || '';
  if (first.startsWith('```')) return '代码片段';
  if (first.startsWith('|')) return '表格：' + first.replace(/\|/g, ' ').trim().slice(0, 65);
  return first.replace(/^[#>*\-\s]+/, '').replace(/[`*_]/g, '').slice(0, 80) || '';
}
function tokenCounter(system = '') {
  let ascii = 0, nonAscii = 0, fixed = 0, messageCount = 0;
  const addText = (text: string) => {
    for (const ch of text) {
      if (ch.codePointAt(0)! > 127) nonAscii++;
      else ascii++;
    }
  };
  addText(system);
  return {
    addMessage(message: Message) {
      if (messageCount) ascii++;
      const hasReportedOutput = message.role === 'assistant' && message.status === 'complete' && !message.edited
        && message.usage?.estimated !== true && Number.isFinite(message.usage?.output) && message.usage!.output > 0;
      if (hasReportedOutput) fixed += message.usage!.output;
      else addText(message.text + (message.role === 'assistant' ? message.reasoning : '') + message.tools.map(t => t.input).join(''));
      // Tool results become input to later turns, so estimate them separately from assistant output usage.
      addText(message.tools.map(t => t.output).join(''));
      for (const attachment of message.attachments) {
        if (attachment.markdown) addText(attachment.markdown);
        else if (attachment.mime.startsWith('image/')) fixed += 184;
        else fixed += 1600; // Conservative fallback for native PDF, audio, and video inputs.
      }
      fixed += 12; // Message framing overhead.
      messageCount++;
    },
    value() { return Math.ceil(nonAscii * 0.6 + ascii * 0.3 + fixed); }
  };
}
export function estimateTokens(messages: Message[], system = '') {
  const counter = tokenCounter(system);
  messages.forEach(message => counter.addMessage(message));
  return counter.value();
}
export const MAX_COMPRESSION_RETAINED_TOKENS = 50_000;
export function compressionCut(path: Message[], contextWindow: number, maxRetainedTokens = MAX_COMPRESSION_RETAINED_TOKENS) {
  const turns: number[] = [];
  path.forEach((message, index) => { if (message.role === 'user') turns.push(index); });
  if (turns.length <= 2) return 0;

  const targetTokens = Math.max(1, Math.min(maxRetainedTokens, Math.ceil(contextWindow * 0.1)));
  let turnIndex = turns.length - 2, cut = turns[turnIndex];
  const counter = tokenCounter();
  for (let index = path.length - 1; index >= cut; index--) counter.addMessage(path[index]);
  while (turnIndex > 0 && counter.value() < targetTokens) {
    const previousCut = turns[turnIndex - 1];
    for (let index = cut - 1; index >= previousCut; index--) counter.addMessage(path[index]);
    cut = previousCut; turnIndex--;
  }
  return cut;
}
