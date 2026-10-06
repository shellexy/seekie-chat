import type { AppState, Branch, ChatConfig, Conversation, Message, Settings } from './types';
export const uid = () => crypto.randomUUID();
export const defaultConfig = (settings: Settings): ChatConfig => ({ modelId: settings.defaultModel, system: '你是一位严谨、友善的助手。使用用户的语言回答。', search: 'off', effort: settings.models.find(m => m.id === settings.defaultModel)?.efforts.includes('medium') ? 'medium' : settings.models.find(m => m.id === settings.defaultModel)?.efforts[0] || 'auto', budget: 4096 });
export function initialState(): AppState {
  return { settings: { connections: [], models: [], defaultModel: '', titleModel: '', compressionModel: '', theme: 'light', fontSize: 15, exaKey: '', exaResults: 5, autoCompress: true, compressionThreshold: 0.75, secureStorage: false, secretPolicy: 'session' }, conversations: [], selectedId: null };
}
export function createConversation(settings: Settings): Conversation {
  const id = uid(), branchId = uid(), now = Date.now();
  return { id, title: '新对话', manualTitle: false, titleState: 'idle', created: now, updated: now, activeBranchId: branchId,
    messages: [], branches: [{ id: branchId, name: '主线', leafId: null, originId: null, parentBranchId: null, config: defaultConfig(settings), draft: '', draftAttachments: [], scrollTop: 0, updated: now }] };
}
export function pathTo(conversation: Conversation, leafId: string | null): Message[] {
  const index = new Map(conversation.messages.map(m => [m.id, m]));
  const seen = new Set<string>(), path: Message[] = [];
  while (leafId) { if (seen.has(leafId)) throw new Error('对话路径存在循环'); seen.add(leafId); const node = index.get(leafId); if (!node) throw new Error('对话节点不存在'); path.unshift(node); leafId = node.parentId; }
  return path;
}
export function fork(conversation: Conversation, sourceId: string, name?: string): Branch {
  const source = conversation.messages.find(m => m.id === sourceId);
  if (!source || source.role !== 'assistant' || source.status !== 'complete') throw new Error('只能从已完成的回答创建分支');
  const current = conversation.branches.find(b => b.id === conversation.activeBranchId)!;
  const branch: Branch = { id: uid(), name: name || `分支 ${conversation.branches.length}`, leafId: sourceId, originId: sourceId, parentBranchId: current.id,
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
export function editMessage(conversation: Conversation, sourceId: string, text: string): { branch: Branch; message: Message } {
  const source = conversation.messages.find(m => m.id === sourceId)!;
  const current = conversation.branches.find(b => b.id === conversation.activeBranchId)!;
  const branch: Branch = { ...structuredClone(current), id: uid(), name: `编辑 ${conversation.branches.length}`, originId: source.parentId, parentBranchId: current.id, leafId: source.parentId, draft: '', draftAttachments: [], summary: undefined, updated: Date.now() };
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
export function estimateTokens(messages: Message[], system = '') {
  const text = system + messages.map(m => m.text + m.tools.map(t => t.output).join('')).join('\n');
  const nonAscii = [...text].filter(ch => ch.charCodeAt(0) > 127).length;
  return Math.ceil(nonAscii + (text.length - nonAscii) / 3.5) + messages.reduce((n, m) => n + m.attachments.length * 1600 + 12, 0);
}
