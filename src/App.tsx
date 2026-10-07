import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ChangeEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Archive, ArchiveRestore, ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, FileJson, GitBranch, Globe2, ImagePlus, List, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Search, Settings as SettingsIcon, Sparkles, Paperclip, Square, Trash2, X } from 'lucide-react';
import { api } from './api';
import { applyMessagePatch, keepNewerStreaming, type MessagePatch } from './merge';
import { addMessage, applyBodies, assistantBody, createConversation, deepseekWebSearchKey, editMessage, editableBodies, effectiveProtocol, firstLine, fork, initialState, messageDateTime, messageModelLabel, modelLabel, normalizeSettings, ollamaWebSearchKey, pathTo, rememberRecentModel, removeBranch, resolveSearch, uid, uniqueBranchName } from './domain';
import type { AppState, AssistantSegment, Attachment, Branch, Conversation, Message, Model, RequestRecord, Settings as SettingsType } from './types';
import Markdown from './Markdown';
import Settings from './Settings';
import { copyFlavors, elementHtml, hasSelectionInside, messageBodies, readableText, selectedHtml, selectedPlainText } from './clipboard';
import Composer from './Composer';
import OutlinePanel from './OutlinePanel';
import Sidebar from './Sidebar';
import WindowControls from './WindowControls';
import AttachmentViewer from './AttachmentViewer';
import RequestDebugView from './RequestDebugView';
import MessageRow from './MessageRow';
import { welcomeMask } from './brand';
import { prepareImage } from './imageEncode';
type Task = { conversationId: string; branchId: string; kind: string };
function searchableParts(message: Message) {
  if (message.role === 'user') return [{ kind: '提问', text: message.text }];
  const parts: { kind: string; text: string }[] = [];
  if (message.segments?.length) for (const segment of message.segments) {
    if (segment.type === 'text') parts.push({ kind: '正文', text: segment.text });
    else if (segment.type === 'reasoning') parts.push({ kind: '思考', text: segment.text });
    else { const tool = message.tools.find(item => item.id === segment.toolId); if (tool) parts.push({ kind: `${tool.name} 输入`, text: tool.input }, { kind: `${tool.name} 结果`, text: tool.output }); }
  } else {
    if (message.reasoning) parts.push({ kind: '思考', text: message.reasoning });
    for (const tool of message.tools) parts.push({ kind: `${tool.name} 输入`, text: tool.input }, { kind: `${tool.name} 结果`, text: tool.output });
    if (message.text) parts.push({ kind: '正文', text: message.text });
  }
  if (message.error) parts.push({ kind: '错误', text: message.error });
  return parts;
}
type ChatSearchMatch = { messageId: string; role: Message['role']; kind: string; snippet: string };
function searchMessages(messages: Message[], query: string): ChatSearchMatch[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const matches: ChatSearchMatch[] = [];
  for (const message of messages) for (const part of searchableParts(message)) for (const line of part.text.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
    const at = line.toLocaleLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 48), end = Math.min(line.length, at + needle.length + 72);
    matches.push({ messageId: message.id, role: message.role, kind: part.kind, snippet: `${start ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}` });
    if (matches.length >= 500) return matches;
  }
  return matches;
}
export default function App() {
  const [state, setState] = useState<AppState>(initialState), stateRef = useRef(state);
  const [loaded, setLoaded] = useState(false), [showSettings, setShowSettings] = useState(false);
  const [left, setLeft] = useState(true), [right, setRight] = useState(true), [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]), [notice, setNotice] = useState(''), noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [branchMenu, setBranchMenu] = useState(false), [conversationMenu, setConversationMenu] = useState<string | null>(null);
  const [chatSearchOpen, setChatSearchOpen] = useState(false), [chatSearchQuery, setChatSearchQuery] = useState(''), [chatSearchIndex, setChatSearchIndex] = useState(0), [searchHighlightMessage, setSearchHighlightMessage] = useState('');
  const [conversationMenuAnchor, setConversationMenuAnchor] = useState<{ top: number; bottom: number; right: number } | null>(null);
  const [conversationMenuPosition, setConversationMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [messageMenu, setMessageMenu] = useState<{ id: string; x: number; y: number; selection: boolean } | null>(null);
  const [renamingConversation, setRenamingConversation] = useState<string | null>(null), [renameValue, setRenameValue] = useState('');
  const [renamingBranch, setRenamingBranch] = useState<{ conversationId: string; branchId: string } | null>(null), [renameBranchValue, setRenameBranchValue] = useState('');
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);
  const [debugView, setDebugView] = useState<{ label: string; records: RequestRecord[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [editTexts, setEditTexts] = useState<string[]>([]);
  const [activeMessage, setActiveMessage] = useState(''), [atBottom, setAtBottom] = useState(true), [summaryOpen, setSummaryOpen] = useState(false);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [composerHeight, setComposerHeight] = useState(56);
  const [leftWidth, setLeftWidth] = useState(258), [rightWidth, setRightWidth] = useState(230);
  const scrollRef = useRef<HTMLDivElement>(null), textareaRef = useRef<HTMLTextAreaElement>(null), conversationMenuRef = useRef<HTMLDivElement>(null), chatSearchAnchorRef = useRef<HTMLDivElement>(null), chatSearchInputRef = useRef<HTMLInputElement>(null);
  // The answer currently streaming per conversation; its model moves to the front of the recent list
  // only after the run ends with a complete answer, so a stop or an error does not count as usage.
  const running = useRef(new Map<string, string>());
  const draftCache = useRef(new Map<string, { draft: string; attachments: Attachment[] }>());
  const persistDraftTimer = useRef<ReturnType<typeof setTimeout>>(undefined), queue = useRef(Promise.resolve()), saveSequence = useRef(0), pendingWrites = useRef(0);
  function toast(s: string) { setNotice(s); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 6500); }
  function openAttachmentPreview(attachment: Attachment) { setPreviewAttachment(attachment); }
  function closeAttachmentPreview() { setPreviewAttachment(null); }
  function apply(incoming: AppState) {
    // A full state may have been produced before the newest streaming patch arrived; the newer text
    // wins so the answer never visibly moves backwards.
    const s = keepNewerStreaming(stateRef.current, incoming);
    normalizeSettings(s.settings);
    for (const c of s.conversations) for (const b of c.branches) { const local = draftCache.current.get(b.id); if (local) { b.draft = local.draft; b.draftAttachments = local.attachments; } }
    stateRef.current = s; setState(s);
  }
  // Streaming answers arrive as patches: replacing one message keeps every other object identity, so
  // only the row that changed re-renders.
  function applyPatch(patch: MessagePatch) {
    const next = applyMessagePatch(stateRef.current, patch);
    if (next) { stateRef.current = next; setState(next); }
  }
  function receive(server: AppState) {
    if (!pendingWrites.current) { apply(server); return; }
    // Preserve optimistic navigation/config while receiving authoritative generation updates.
    const local = structuredClone(stateRef.current);
    // Settings carry authoritative values (secureStorage, credential policy) that the renderer
    // cannot derive, so they are merged instead of being left behind at a stale local copy.
    local.settings = { ...server.settings, ...local.settings, secureStorage: server.settings.secureStorage, credentialStorageVersion: server.settings.credentialStorageVersion };
    // Index the incoming state once: scanning every message for every message is quadratic, and this
    // merge runs while a save is in flight, which is exactly when generation updates arrive.
    const remoteConversations = new Map(server.conversations.map(c => [c.id, c]));
    for (const c of local.conversations) {
      const remote = remoteConversations.get(c.id); if (!remote) continue;
      const remoteMessages = new Map(remote.messages.map(m => [m.id, m]));
      c.messages = c.messages.map(m => remoteMessages.get(m.id) || m);
      if (!c.manualTitle) { c.title = remote.title; c.titleState = remote.titleState; }
      c.backgroundUsage = remote.backgroundUsage;
      const remoteBranches = new Map(remote.branches.map(b => [b.id, b]));
      for (const b of c.branches) { const rb = remoteBranches.get(b.id); if (rb?.summary) b.summary = rb.summary; }
    }
    apply(local);
  }
  async function commit(mutate: (s: AppState) => void): Promise<void> {
    const next = structuredClone(stateRef.current); mutate(next); apply(next); const sequence = ++saveSequence.current; pendingWrites.current++;
    const operation = queue.current.then(async () => { try { const saved = await api.save(next); if (sequence === saveSequence.current) apply(saved); else receive(saved); } finally { pendingWrites.current--; } });
    queue.current = operation.catch(e => toast(String(e instanceof Error ? e.message : e)));
    return operation;
  }
  useEffect(() => {
    let alive = true;
    void api.load().then(s => { if (alive) { apply(s); setLoaded(true); } }).catch(e => toast(String(e)));
    const off = api.onEvent(event => { if (event.patch) applyPatch(event.patch); else if (event.state) receive(event.state); if (event.tasks) setTasks(event.tasks); if (event.error) toast(event.error); });
    const reload = () => { draftCache.current.clear(); void api.load().then(apply); }; window.addEventListener('deepchan-reload', reload);
    return () => { alive = false; off(); window.removeEventListener('deepchan-reload', reload); };
  }, []);
  useEffect(() => {
    let alive = true;
    void api.isWindowMaximized().then(value => { if (alive) setWindowMaximized(value); }).catch(() => {});
    const off = api.onWindowState(setWindowMaximized);
    return () => { alive = false; off(); };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = state.settings.theme; document.documentElement.style.setProperty('--chat-font', `${state.settings.fontSize}px`); }, [state.settings.theme, state.settings.fontSize]);
  const conversation = state.conversations.find(c => c.id === state.selectedId);
  const branch = conversation?.branches.find(b => b.id === conversation.activeBranchId);
  const messages = conversation && branch ? pathTo(conversation, branch.leafId) : [];
  // Turn numbers follow the actual questions, so forked or multi-version branches stay correct.
  const turnNumbers = new Map<string, number>(); let turnCount = 0;
  for (const message of messages) if (message.role === 'user') turnNumbers.set(message.id, ++turnCount);
  const chatSearchResults = searchMessages(messages, chatSearchQuery);
  const activeSearchIndex = chatSearchResults.length ? ((chatSearchIndex % chatSearchResults.length) + chatSearchResults.length) % chatSearchResults.length : 0;
  const model = state.settings.models.find(m => m.id === branch?.config.modelId);
  const modelConnection = state.settings.connections.find(c => c.id === model?.connectionId);
  const modelProtocol = modelConnection ? effectiveProtocol(modelConnection, model) : 'chat';
  const samplingSupported = !!model?.temperature && !(['responses', 'anthropic'].includes(modelProtocol || '') && model?.reasoning !== 'none');
  const samplingHelp = !model?.temperature ? '当前模型未配置温度和 top_p 能力' : samplingSupported ? '控制当前回答的采样参数' : '当前协议的思考模式不接受温度和 top_p 参数';
  const effectiveSearch = branch ? resolveSearch(state.settings, branch.config.modelId, branch.config.search) : 'off';
  const ollamaSearchConfigured = !!ollamaWebSearchKey(state.settings);
  const webFetchMode = branch?.config.webFetch ?? (branch?.config.search === 'off' ? 'off' : 'auto');
  const webFetchAvailable = !!model?.tools && webFetchMode !== 'off';
  const networkingEnabled = !!branch && (branch.config.search !== 'off' || webFetchMode !== 'off');
  const searchUnavailable = branch?.config.search === 'auto' && effectiveSearch === 'off';
  const networkUnavailable = searchUnavailable && !webFetchAvailable;
  const task = tasks.find(t => t.conversationId === conversation?.id), busy = !!task;
  const pending = messages.some(m => m.status === 'streaming');
  // Task changes are what this effect reacts to; the joined string keeps it from running on every
  // streaming broadcast, which carries a fresh tasks array each time.
  const taskKey = tasks.map(item => `${item.conversationId}:${item.kind}`).join(',');
  useEffect(() => {
    const live = new Set(tasks.map(item => item.conversationId));
    const finished = [...running.current].filter(([conversationId]) => !live.has(conversationId));
    if (!finished.length) return;
    for (const [conversationId] of finished) running.current.delete(conversationId);
    const promoted = finished.map(([conversationId, messageId]) => stateRef.current.conversations.find(c => c.id === conversationId)?.messages.find(m => m.id === messageId))
      .filter(answer => answer?.status === 'complete' && answer.modelId).map(answer => answer!.modelId!);
    // One save for the whole batch: two commits in the same tick would both start from the state
    // this component last applied, and the second would drop the first one's entry.
    if (promoted.length) void commit(s => { for (const modelId of promoted) rememberRecentModel(s.settings, modelId, true); }).catch(() => {});
  }, [taskKey]);
  useEffect(() => {
    if (atBottom && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.map(m => m.text.length + m.reasoning.length + m.tools.length).join(','), atBottom]);
  useEffect(() => {
    setEditing(null); setBranchMenu(false); setChatSearchOpen(false); setSummaryOpen(false);
    requestAnimationFrame(() => { if (scrollRef.current && branch) { scrollRef.current.scrollTop = branch.scrollTop || scrollRef.current.scrollHeight; setAtBottom(scrollRef.current.scrollHeight - scrollRef.current.scrollTop - scrollRef.current.clientHeight < 100); } });
  }, [conversation?.id, branch?.id]);
  useEffect(() => {
    if (!chatSearchOpen) return;
    const frame = requestAnimationFrame(() => chatSearchInputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [chatSearchOpen]);
  useEffect(() => { if (chatSearchOpen && chatSearchQuery.trim() && chatSearchResults.length) activateSearchResult(0); }, [chatSearchQuery, chatSearchOpen]);
  useEffect(() => {
    if (!chatSearchOpen) return;
    const closeOutside = (event: PointerEvent) => { if (!(event.target instanceof Node) || !chatSearchAnchorRef.current?.contains(event.target)) setChatSearchOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [chatSearchOpen]);
  useEffect(() => {
    if (!conversationMenu) return;
    const close = () => { setConversationMenu(null); setConversationMenuAnchor(null); setConversationMenuPosition(null); };
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || (!target.closest('.conversation-popover') && !target.closest('.conversation-more'))) close();
    };
    window.addEventListener('pointerdown', closeOutside); window.addEventListener('resize', close);
    return () => { window.removeEventListener('pointerdown', closeOutside); window.removeEventListener('resize', close); };
  }, [conversationMenu]);
  useEffect(() => {
    if (!messageMenu) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.message-context-menu')) return;
      setMessageMenu(null);
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') setMessageMenu(null); };
    // Scrolling dismisses the menu, but not the scroll that brought the message into view, nor the
    // momentum still running right after the right click. Dismissing in the same instant the menu
    // opened makes it unusable whenever the list has just been scrolled to the message.
    const openedAt = performance.now();
    const scroll = () => { if (performance.now() - openedAt < 250) return; setMessageMenu(null); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', escape);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [messageMenu]);
  useLayoutEffect(() => {
    const menu = conversationMenuRef.current, anchor = conversationMenuAnchor;
    if (!conversationMenu || !menu || !anchor) return;
    const { width, height } = menu.getBoundingClientRect(), margin = 8;
    const roomBelow = window.innerHeight - anchor.bottom - margin, roomAbove = anchor.top - margin;
    const openAbove = height > roomBelow && roomAbove > roomBelow;
    const top = Math.max(margin, Math.min(openAbove ? anchor.top - height : anchor.bottom, window.innerHeight - height - margin));
    const left = Math.max(margin, Math.min(anchor.right - width, window.innerWidth - width - margin));
    setConversationMenuPosition(current => current?.top === top && current.left === left ? current : { top, left });
  }, [conversationMenu, conversationMenuAnchor]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current, editBox = editing ? document.getElementById(`message-${editing}`)?.querySelector<HTMLElement>('.edit-box') : null;
    if (!editing || !scroller || !editBox) return;
    const scrollRect = scroller.getBoundingClientRect(), editRect = editBox.getBoundingClientRect();
    scroller.scrollTop = Math.max(0, scroller.scrollTop + editRect.top - scrollRect.top - 12);
    editBox.querySelector('textarea')?.focus({ preventScroll: true });
  }, [editing]);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => {
      const command = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
      if (command && key === 'n') { e.preventDefault(); void newChat(); }
      if (command && key === 'f' && !showSettings && !previewAttachment && !renamingConversation && !renamingBranch) { e.preventDefault(); setChatSearchOpen(true); }
      if (command && key === 'i' && !showSettings && !previewAttachment && !renamingConversation && !renamingBranch && textareaRef.current) { e.preventDefault(); setChatSearchOpen(false); textareaRef.current.focus(); }
      if (e.key === 'Escape') { setChatSearchOpen(false); setSearchHighlightMessage(''); setBranchMenu(false); setEditing(null); setConversationMenu(null); setMessageMenu(null); setRenamingConversation(null); setRenamingBranch(null); }
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [showSettings, previewAttachment, renamingConversation, renamingBranch]);
  async function newChat() { await commit(s => { const c = createConversation(s.settings); s.conversations.unshift(c); s.selectedId = c.id; }); setShowArchived(false); setShowSettings(false); setAtBottom(true); textareaRef.current?.focus(); }
  // Reads the state it is given, so a mutation that also changes selectedId sees its own change.
  function find(s: AppState): { c: Conversation; b: Branch } { const id = s.selectedId || stateRef.current.selectedId; const c = s.conversations.find(c => c.id === id) || s.conversations[0]; const b = c.branches.find(b => b.id === c.activeBranchId)!; return { c, b }; }
  async function switchChat(id: string) { if (scrollRef.current && branch) branch.scrollTop = scrollRef.current.scrollTop; await commit(s => { s.selectedId = id; }); setShowSettings(false); }
  async function toggleArchive(source: Conversation) {
    const archive = !source.archived;
    setConversationMenu(null);
    await commit(s => {
      const target = s.conversations.find(c => c.id === source.id);
      if (!target) return;
      target.archived = archive;
      if (archive && s.selectedId === source.id) s.selectedId = s.conversations.find(c => c.id !== source.id && !c.archived)?.id || null;
    });
    if (!archive) setShowArchived(false);
  }
  async function saveConversationRename() {
    const id = renamingConversation, title = renameValue.trim();
    if (!id || !title) { if (id) toast('对话标题不能为空'); return; }
    try {
      await commit(s => { const target = s.conversations.find(c => c.id === id); if (target) { target.title = title; target.manualTitle = true; target.titleState = 'done'; } });
      setRenamingConversation(null);
    } catch { /* commit already reports save errors */ }
  }
  async function saveBranchRename() {
    const target = renamingBranch, name = renameBranchValue.trim();
    if (!target || !name) { if (target) toast('分支名称不能为空'); return; }
    try {
      await commit(s => {
        const branch = s.conversations.find(c => c.id === target.conversationId)?.branches.find(b => b.id === target.branchId);
        if (branch) branch.name = name;
      });
      setRenamingBranch(null);
    } catch { /* commit already reports save errors */ }
  }
  async function switchBranch(id: string) { await commit(s => { const { c, b } = find(s); if (scrollRef.current) b.scrollTop = scrollRef.current.scrollTop; c.activeBranchId = id; }); }
  function draft(value: string, attachments?: Attachment[]) {
    if (!branch) return;
    const local = { draft: value, attachments: attachments ?? branch.draftAttachments };
    draftCache.current.set(branch.id, local);
    const next = structuredClone(stateRef.current); const b = next.conversations.find(c => c.id === conversation!.id)!.branches.find(b => b.id === branch.id)!;
    b.draft = local.draft; b.draftAttachments = local.attachments; apply(next);
    clearTimeout(persistDraftTimer.current); persistDraftTimer.current = setTimeout(() => { void commit(() => {}).catch(() => {}); }, 450);
  }
  async function begin(id: string, branchId: string, messageId: string) {
    // Remember which answer is streaming, so its model can be promoted once the run really finishes.
    running.current.set(id, messageId);
    try { await api.run({ conversationId: id, branchId, messageId }); }
    catch (e) { toast(String(e instanceof Error ? e.message : e)); await commit(s => { const m = s.conversations.find(c => c.id === id)?.messages.find(m => m.id === messageId); if (m) { m.status = 'error'; m.error = String(e); } }); }
  }
  async function send() {
    if (!conversation || !branch || busy || pending) return;
    if (!branch.draft.trim() && !branch.draftAttachments.length) return;
    if (!model) { toast('请先配置并选择聊天模型'); setShowSettings(true); return; }

    let messageId = '', branchId = branch.id, id = conversation.id;
    clearTimeout(persistDraftTimer.current); draftCache.current.delete(branch.id);
    await commit(s => { const { c, b } = find(s); const m = addMessage(c, b, 'user', b.draft.trim()); m.attachments = b.draftAttachments; b.draft = ''; b.draftAttachments = []; const reply = addMessage(c, b, 'assistant', ''); messageId = reply.id; if (c.title === '新对话') c.title = m.text.slice(0, 24) || (m.attachments.length ? '附件对话' : '新对话'); });
    setAtBottom(true); await begin(id, branchId, messageId);
  }
  async function regenerate(source: Message) {
    if (!conversation || !branch || busy || pending) return;
    let branchId = '', messageId = ''; const id = conversation.id;
await commit(s => { const { c, b } = find(s); const next: Branch = { ...structuredClone(b), id: uid(), name: uniqueBranchName(c.branches, '重新生成'), parentBranchId: b.id, originId: source.parentId, leafId: source.parentId, draft: '', draftAttachments: [], scrollTop: 0, updated: Date.now() }; c.branches.push(next); c.activeBranchId = next.id; branchId = next.id; const m = addMessage(c, next, 'assistant', '', source.parentId); messageId = m.id; });
    setAtBottom(true); await begin(id, branchId, messageId);
  }
  async function submitEdit(source: Message) {
    if (!conversation || busy || pending || !editTexts.some(text => text.trim())) return;
    let branchId = '', messageId = ''; const id = conversation.id; const texts = editTexts;
    await commit(s => { const { c } = find(s); const result = editMessage(c, source.id, source.role === 'assistant' ? texts.map(text => text.trim()).filter(Boolean).join('\n\n') : texts[0]); branchId = result.branch.id; if (source.role === 'assistant') {
      result.message.tools = structuredClone(source.tools); result.message.sources = structuredClone(source.sources);
      result.message.segments = structuredClone(source.segments);
      // One box per text block: each block is written back, and a box left empty removes its block.
      applyBodies(result.message, texts);
    } else messageId = addMessage(c, result.branch, 'assistant', '').id; });
    setEditing(null); if (messageId) await begin(id, branchId, messageId);
  }
  async function createBranch(source: Message) { if (!conversation) return; await commit(s => { const { c } = find(s); fork(c, source.id); }); textareaRef.current?.focus(); toast('已创建分支，可以继续新的讨论'); }
  async function version(target: Message) {
    await commit(s => {
      const { c, b } = find(s);
      const existing = c.branches.find(candidate => pathTo(c, candidate.leafId).some(m => m.id === target.id));
      if (existing) { c.activeBranchId = existing.id; return; }
      if (target.status === 'complete') { fork(c, target.id); return; }
      if (target.status === 'streaming') return;
      const next: Branch = { ...structuredClone(b), id: uid(), name: uniqueBranchName(c.branches, '版本'), parentBranchId: b.id, originId: target.id, leafId: target.id, summary: undefined, draft: '', draftAttachments: [], scrollTop: 0, updated: Date.now() };
      c.branches.push(next); c.activeBranchId = next.id;
    });
  }
  async function attach(files: File[]) {
    if (!branch) { toast('请先新建对话'); return; }
    if (branch.draftAttachments.length + files.length > 6) { toast('每条消息最多添加 6 个附件'); return; }
    const items: Attachment[] = [];
    const mimeByExtension: Record<string, string> = {
      pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
      mp4: 'video/mp4', mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo', webm: 'video/webm',
      mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', flac: 'audio/flac'
    };
    for (const f of files) {
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name} 超过 10 MB`); continue; }
      const extension = f.name.split('.').at(-1)?.toLowerCase() || '';
      const mime = (!f.type || f.type === 'application/octet-stream') ? (mimeByExtension[extension] || f.type || 'application/octet-stream') : f.type;
      try {
        let data: string, storedMime = mime, storedSize = f.size;
        if (mime.startsWith('image/')) {
          // 图片先缩小再压成 WebP：长边超过 1280 的按比例缩小，体积够大的重新编码；
          // 小图与动图原样保留。附件的 mime 与体积按处理后的实际值记。
          const prepared = await prepareImage(f, mime);
          data = prepared.data; storedMime = prepared.mime; storedSize = prepared.size;
        } else {
          data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取文件'));
            reader.onerror = () => reject(reader.error || new Error('无法读取文件')); reader.readAsDataURL(f);
          });
        }
        if (data.length > 15_000_000) throw new Error('重新编码后的附件超过限制');
        items.push({ id: uid(), name: f.name, mime: storedMime, data, size: storedSize });
      } catch (error) { toast(`无法读取附件“${f.name}”：${error instanceof Error ? error.message : String(error)}`); }
    }
    const current = stateRef.current.conversations.find(c => c.id === conversation!.id)?.branches.find(b => b.id === branch.id);
    if (current) draft(current.draft, [...current.draftAttachments, ...items]);
  }
  function resize(event: React.MouseEvent, side: 'left' | 'right', initial: number) {
    // Pressing on a non-text element still anchors a selection, so dragging a handle used to select
    // whatever it passed over. Suppressing selection for the drag only keeps normal selection intact.
    event.preventDefault();
    const start = event.clientX, previousSelect = document.body.style.userSelect;
    const move = (e: MouseEvent) => { const width = initial + (e.clientX - start) * (side === 'left' ? 1 : -1); (side === 'left' ? setLeftWidth : setRightWidth)(Math.max(190, Math.min(360, width))); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; document.body.style.userSelect = previousSelect; };
    document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  function setInputHeight(height: number) {
    setComposerHeight(Math.max(47, Math.min(Math.max(47, Math.min(420, window.innerHeight * 0.45)), height)));
  }
  function activateSearchResult(index: number) {
    if (!chatSearchResults.length) return;
    const normalized = ((index % chatSearchResults.length) + chatSearchResults.length) % chatSearchResults.length;
    const match = chatSearchResults[normalized]; setChatSearchIndex(normalized); setSearchHighlightMessage(match.messageId); setActiveMessage(match.messageId);
    requestAnimationFrame(() => document.getElementById(`message-${match.messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }
  function onScroll() {
    const el = scrollRef.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
    const els = [...el.querySelectorAll<HTMLElement>('.message')]; const top = el.getBoundingClientRect().top;
    const active = els.find(node => node.getBoundingClientRect().bottom > top + 80); if (active) setActiveMessage(active.dataset.id || '');
  }
  function updateConfig(values: Partial<Branch['config']>) {
    void commit(s => {
      const { b } = find(s);
      b.config = { ...b.config, ...values };
      // Switching the model records it straight away, so the list is useful before any answer runs.
      if (values.modelId) rememberRecentModel(s.settings, values.modelId);
      // Likewise for the webpage reader: a new chat configured to follow the last choice has to see
      // the choice that was actually made, not the one that seeded the branch it was changed on.
      // A branch only ever stores a concrete mode, never 'last'.
      if (values.webFetch) s.settings.lastWebFetch = values.webFetch;
    }).catch(() => {});
  }
  function toggleFavorite(modelId: string) {
    void commit(s => { s.settings.favoriteModels = s.settings.favoriteModels.includes(modelId) ? s.settings.favoriteModels.filter(id => id !== modelId) : [...s.settings.favoriteModels, modelId]; }).catch(() => {});
  }
  const menuConversation = state.conversations.find(c => c.id === conversationMenu);
  const archiveCount = state.conversations.filter(c => c.archived).length;
  const conversationsForView = state.conversations.filter(c => !!c.archived === showArchived);
  const grouped = conversationsForView.filter(c => c.title.toLowerCase().includes(query.toLowerCase())).sort((a,b) => b.updated - a.updated);
  // Same actions as the message toolbar, reachable by right clicking the question or the answer.
  // Callbacks handed to MessageRow. They are defined once per render so the row is a pure function
  // of its props, which is what lets the list memoise rows later.
  const connectionLabel = (message: Message) => {
    const live = state.settings.models.find(entry => entry.id === message.modelId);
    const connection = live ? state.settings.connections.find(entry => entry.id === live.connectionId) : undefined;
    return connection?.name || message.connectionName || (live ? '未配置连接' : '已删除的连接');
  };
  const copyToolbarBody = (message: Message) => { const text = message.role === 'assistant' ? assistantBody(message) : message.text; void navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(e => toast(String(e))); };
  const startEdit = (message: Message) => { setEditing(message.id); setEditTexts(editableBodies(message)); };
  const openDebug = (message: Message) => { void api.debug(message.id).then(records => setDebugView({ label: messageModelLabel(message, state.settings.models), records })).catch(e => toast(String(e))); };
  const openMessageMenu = (message: Message, point: { x: number; y: number }) => setMessageMenu({ id: message.id, ...point, selection: hasSelectionInside(message.id) });
  const openExternal = (url: string) => { void api.openExternal(url).catch(e => toast(String(e))); };
  const copyMessageBody = (message: Message, flavor: 'markdown' | 'plain' | 'rich') => {
    const node = messageBodies(message.id);
    if (flavor === 'markdown' || !node) return navigator.clipboard.writeText(assistantBody(message)).then(() => toast('已复制 Markdown')).catch(e => toast(String(e)));
    const plain = readableText(node);
    if (flavor === 'plain') return copyFlavors(plain).then(() => toast('已复制纯文本')).catch(e => toast(String(e)));
    return copyFlavors(plain, elementHtml(node)).then(() => toast('已复制富文本')).catch(e => toast(String(e)));
  };
  const copySelection = (rich: boolean) => {
    const plain = selectedPlainText();
    return (rich ? copyFlavors(plain, selectedHtml()) : copyFlavors(plain)).then(() => toast(rich ? '已复制选中（富文本）' : '已复制选中（纯文本）')).catch(e => toast(String(e)));
  };
  const messageContextMenu = (target: Message) => createPortal(<div className="popover conversation-popover message-context-menu" role="menu"
    style={{ position: 'fixed', top: Math.min(messageMenu?.y ?? 0, Math.max(8, window.innerHeight - 340)), left: Math.min(messageMenu?.x ?? 0, Math.max(8, window.innerWidth - 230)) }}>
    {messageMenu?.selection && <>
      <button role="menuitem" onClick={() => { setMessageMenu(null); void copySelection(false); }}><Copy size={14}/>复制选中（纯文本）</button>
      <button role="menuitem" onClick={() => { setMessageMenu(null); void copySelection(true); }}><Copy size={14}/>复制选中（富文本）</button>
      <div className="menu-separator"/>
    </>}
    {target.role === 'assistant' ? <>
      <button role="menuitem" onClick={() => { setMessageMenu(null); void copyMessageBody(target, 'markdown'); }}><Copy size={14}/>复制正文（Markdown）</button>
      <button role="menuitem" onClick={() => { setMessageMenu(null); void copyMessageBody(target, 'plain'); }}><Copy size={14}/>复制正文（纯文本）</button>
      <button role="menuitem" onClick={() => { setMessageMenu(null); void copyMessageBody(target, 'rich'); }}><Copy size={14}/>复制正文（富文本）</button>
      <div className="menu-separator"/>
    </> : <button role="menuitem" onClick={() => { setMessageMenu(null); navigator.clipboard.writeText(target.text).then(() => toast('已复制')).catch(e => toast(String(e))); }}><Copy size={14}/>复制消息</button>}
    <button role="menuitem" disabled={busy || pending} onClick={() => { setMessageMenu(null); startEdit(target); }}><Pencil size={14}/>编辑为新版本</button>
    {target.role === 'assistant' && <>
      <button role="menuitem" disabled={busy || pending} onClick={() => { setMessageMenu(null); regenerate(target); }}><RotateCcw size={14}/>重新生成并保留旧回答</button>
      <button role="menuitem" disabled={target.status === 'streaming'} onClick={() => { setMessageMenu(null); void api.debug(target.id).then(records => setDebugView({ label: (state.settings.models.find(x => x.id === target.modelId)?.name || '未知模型'), records })).catch(e => toast(String(e))); }}><FileJson size={14}/>查看请求详情</button>
      <button role="menuitem" disabled={target.status !== 'complete'} onClick={() => { setMessageMenu(null); createBranch(target); }}><GitBranch size={14}/>从此回答创建分支</button>
    </>}
  </div>, document.body);
  if (!loaded) return <div className="loading"><Sparkles size={28}/><p>正在打开 DeepChan-chat…</p></div>;
  return <div className="app-shell">
    {left && <Sidebar width={leftWidth} conversations={grouped} selectedId={state.selectedId} query={query} showArchived={showArchived}
      archiveCount={archiveCount} showSettings={showSettings} runningIds={tasks.map(task => task.conversationId)} openMenuId={conversationMenu}
      onQueryChange={setQuery} onSelect={id => void switchChat(id)} onNewChat={() => void newChat()} onArchiveView={() => { setShowArchived(!showArchived); setConversationMenu(null); }}
      onOpenSettings={() => setShowSettings(true)} onCollapse={() => setLeft(false)}
      onMenu={(id, anchor) => {
        if (!anchor || conversationMenu === id) { setConversationMenu(null); setConversationMenuAnchor(null); setConversationMenuPosition(null); return; }
        setConversationMenuAnchor(anchor); setConversationMenuPosition(null); setConversationMenu(id);
      }}
      onResizeStart={event => resize(event, 'left', leftWidth)}/>}
    {showSettings ? <Settings settings={state.settings} onClose={() => setShowSettings(false)} onSave={settings => commit(s => { s.settings = settings; })} toast={toast} windowMaximized={windowMaximized} onWindowMaximized={setWindowMaximized}/> : <main className="workspace"><header className="chat-header">
        <div className="header-start">
              {!left && <button className="icon-button" title="展开侧栏" onClick={() => setLeft(true)}>
                <PanelLeftOpen size={20}/>
                </button>}
                    <div className="header-title">
                      <span title={conversation?.title}>
                          {conversation?.title || '新对话'}
                          </span>
                            <small title={model ? modelLabel(model, state.settings.connections) : '选择模型'}>
                                {model ? modelLabel(model, state.settings.connections) : '选择模型'}
                                </small>
                                </div>
</div>
      <div className="header-actions">
              {branch && <div className="popover-anchor">
                  <button className="branch-pill" onClick={() => setBranchMenu(!branchMenu)}>
                  <GitBranch size={15}/>
                      {branch.name}
                        <ChevronDown size={13}/>
                      </button>
                            {branchMenu && <div className="popover branch-popover">
                                  <div className="popover-heading">对话分支 · {conversation!.branches.length}
                                </div>
                                      {conversation!.branches.map(b => <div className="branch-option" key={b.id}>
                                          <button onClick={() => switchBranch(b.id)}>
                                            <GitBranch size={14}/>
                                                <span>
                                                  <strong>
                                                      {b.name}
                                                      </strong>
                                                        <small>
                                                            {b.originId ? firstLine(conversation!.messages.find(m => m.id === b.originId)?.text || '') || '编辑 / 重新生成' : '对话起点'}
                                                            </small>
                                                          </span>
                                                              {b.id === branch.id && <Check size={14}/>}
                                                              </button>
                                                                  <button className="icon-button" title="重命名分支" aria-label={'重命名分支 ' + b.name} onClick={() => { setRenameBranchValue(b.name); setRenamingBranch({ conversationId: conversation!.id, branchId: b.id }); setBranchMenu(false); }}>
                                                                    <Pencil size={13}/>
                                                                    </button>
                                                                        <button className="icon-button danger" title="删除分支及其后代" disabled={busy || conversation!.branches.length === 1} onClick={() => { if (confirm('删除“' + b.name + '”及其后代分支？其他分支共享的历史会保留。')) void commit(s => removeBranch(find(s).c, b.id)).catch(e => toast(String(e))); }}>
                                                                          <Trash2 size={13}/>
                                                                          </button>
                                                                          </div>)}
                                                                          </div>}
</div>}
        {conversation && <div className="chat-search-anchor" ref={chatSearchAnchorRef}>
          <button className={'icon-button ' + (chatSearchOpen ? 'selected' : '')} aria-label="搜索对话" title="搜索对话（Ctrl+F）" aria-expanded={chatSearchOpen} onClick={() => setChatSearchOpen(value => !value)}><Search size={18}/></button>
          {chatSearchOpen && <div className="chat-search-popover" role="dialog" aria-label="搜索对话">
            <div className="chat-search-heading"><strong>搜索当前分支</strong><span>Ctrl+F</span><button className="icon-button" aria-label="关闭搜索" title="关闭搜索" onClick={() => { setChatSearchOpen(false); setSearchHighlightMessage(''); }}><X size={15}/></button></div>
            <input ref={chatSearchInputRef} type="search" aria-label="搜索当前分支" placeholder="搜索对话文字" value={chatSearchQuery} onChange={event => { setChatSearchQuery(event.target.value); setChatSearchIndex(0); setSearchHighlightMessage(''); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); activateSearchResult(activeSearchIndex + (event.shiftKey ? -1 : 1)); } }}/>
              <div className="chat-search-results">
                    {chatSearchResults.length ? chatSearchResults.map((result, index) => <button className={'chat-search-result ' + (index === activeSearchIndex ? 'active' : '')} aria-current={index === activeSearchIndex} key={index} onClick={() => activateSearchResult(index)}>
                      <small>
                          {result.role === 'user' ? '用户' : 'AI'} · {result.kind}
                          </small>
                            <span>
                                {result.snippet}
                                </span>
                                </button>) : <p>
                                    {chatSearchQuery.trim() ? '没有匹配的内容' : '输入关键词搜索当前分支'}
                                    </p>}
</div>
                <div className="chat-search-footer">
                  <span>
                      {chatSearchResults.length ? (activeSearchIndex + 1) + ' / ' + chatSearchResults.length : '0 条结果'}
                      </span>
                          <div>
                              <button className="icon-button" aria-label="上一个搜索结果" title="上一个（Shift+Enter）" disabled={!chatSearchResults.length} onClick={() => activateSearchResult(activeSearchIndex - 1)}>
                                <ChevronLeft size={15}/>
                                </button>
                                    <button className="icon-button" aria-label="下一个搜索结果" title="下一个（Enter）" disabled={!chatSearchResults.length} onClick={() => activateSearchResult(activeSearchIndex + 1)}>
                                      <ChevronRight size={15}/>
                                      </button>
                                      </div>
</div>
          </div>}
        </div>}
        {conversation && <button className="icon-button" title="导出当前会话 Markdown" onClick={() => api.exportData('markdown', conversation.id).catch(e => toast(String(e)))}><Download size={18}/></button>}
        <button className={'icon-button ' + (right ? 'selected' : '')} title="切换对话大纲" onClick={() => setRight(!right)}><List size={20}/></button><WindowControls maximized={windowMaximized} onMaximizedChange={setWindowMaximized} onError={toast}/>
      </div>
    </header>
    <div className="workspace-body"><section className="chat-panel" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void attach([...e.dataTransfer.files]); }}>
      <div className={`message-scroll ${editing ? "is-editing" : ""}`} ref={scrollRef} onScroll={onScroll}>
            {!messages.length ? <div className="welcome">
                <div className="welcome-icon" style={{ '--welcome-mask': welcomeMask } as CSSProperties} role="img" aria-label="DeepChan-chat"/>
                    <span className="eyebrow">一个想法，多种可能</span>
                      <h1>今天，想聊些什么？</h1>
                      <p>连接你喜欢的模型，让思路在对话中展开。</p>
                            {!state.settings.models.length ? <button className="primary" onClick={() => setShowSettings(true)}>
                              <Plus size={16}/>连接第一个模型</button> : !conversation ? <button className="primary" onClick={() => newChat()}>
                              <Plus size={16}/>开始新对话</button> : <div className="starter-grid">
                                  {['帮我梳理一个项目的实现思路', '解释一个我想深入了解的概念', '一起比较几个方案的优缺点'].map(t => <button key={t} onClick={() => { draft(t); textareaRef.current?.focus(); }}>
                                      {t}
                                        <ArrowUp size={15}/>
                                        </button>)}
                                        </div>}
                                            <div className="welcome-foot">
                                            <GitBranch size={15}/>从任何回答创建分支，探索不同方向</div>
                                            </div> : <div className="messages">
                                                  {branch?.originId && <div className="branch-banner">
                                                <GitBranch size={14}/>正在浏览「{branch.name}」，共享历史保持完整</div>}
                                                      {branch?.summary && <button className="summary-banner" onClick={() => setSummaryOpen(!summaryOpen)}>
                                                        <BookOpen size={14}/>较早的历史已压缩 · 原始消息仍可阅读<ChevronDown size={13}/>
                                                      </button>}
                                                            {summaryOpen && <div className="summary-content">
                                                              <Markdown text={branch?.summary?.text || ''}/>
                                                            </div>}
{messages.map((m, i) => {
      const siblings = conversation!.messages.filter(x => x.role === m.role && x.parentId === m.parentId), versionIndex = siblings.findIndex(x => x.id === m.id);
      return <MessageRow key={m.id} message={m} taskKind={task?.kind} searchHighlighted={searchHighlightMessage === m.id}
        editing={editing === m.id} editTexts={editTexts} siblings={siblings} versionIndex={versionIndex}
        forkCount={conversation!.branches.filter(b => b.originId === m.id).length}
        modelName={messageModelLabel(m, state.settings.models)} connectionName={connectionLabel(m)} busy={busy} pending={pending}
        onStartEdit={startEdit} onCancelEdit={() => setEditing(null)} onEditTextChange={(index, text) => setEditTexts(current => current.map((value, position) => position === index ? text : value))} onSubmitEdit={submitEdit}
        onCopy={copyToolbarBody} onRegenerate={regenerate} onBranch={createBranch} onVersion={version} onDebug={openDebug}
        onOpenAttachment={setPreviewAttachment} onContextMenu={openMessageMenu} onOpenExternal={openExternal} onNotice={toast}/>;
    })}</div>}</div>

    <Composer branch={branch || null} model={model} models={state.settings.models} connections={state.settings.connections} busy={busy} pending={pending}
      atBottom={atBottom} messageCount={messages.length} height={composerHeight} textareaRef={textareaRef}
      networkingEnabled={networkingEnabled} networkUnavailable={networkUnavailable} effectiveSearch={effectiveSearch} webFetchMode={webFetchMode}
      samplingSupported={samplingSupported} samplingHelp={samplingHelp} ollamaSearchConfigured={ollamaSearchConfigured}
      hasExaKey={!!state.settings.exaKey} deepseekSearchConfigured={!!deepseekWebSearchKey(state.settings)} promptPresets={state.settings.promptPresets} backgroundUsage={conversation?.backgroundUsage}
      userTurnCount={messages.filter(m => m.role === 'user').length}
      favoriteModels={state.settings.favoriteModels} recentModels={state.settings.recentModels} defaultSearch={state.settings.defaultSearch} onToggleFavorite={toggleFavorite}
      onHeightChange={setInputHeight} onDraftChange={text => draft(text)} onRemoveAttachment={attachment => { if (branch) draft(branch.draft, branch.draftAttachments.filter(item => item.id !== attachment.id)); }}
      onAttach={files => void attach(files)} onSend={() => void send().catch(error => toast(String(error)))} onStop={() => void api.cancel(conversation!.id)}
      onCompress={() => { if (conversation && branch) void api.compress(conversation.id, branch.id).catch(error => toast(String(error))); }}
      onUpdateConfig={updateConfig} onNewChat={() => void newChat()} onNotice={toast}
      onScrollToBottom={() => { setAtBottom(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}/>
    </section>{right && <OutlinePanel width={rightWidth} messages={messages} turnNumbers={turnNumbers} activeMessage={activeMessage} branchName={branch?.name}
      onResizeStart={event => resize(event, 'right', rightWidth)} onJump={id => { document.getElementById(`message-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActiveMessage(id); }}/>}</div></main>}
    {messageMenu && messageContextMenu(conversation!.messages.find(m => m.id === messageMenu.id)!)}
          {conversationMenu && menuConversation && conversationMenuAnchor && createPortal(<div ref={conversationMenuRef} className="popover conversation-popover" role="menu" style={{ position: 'fixed', top: conversationMenuPosition?.top ?? conversationMenuAnchor.bottom, left: conversationMenuPosition?.left ?? Math.max(8, conversationMenuAnchor.right - 140), right: 'auto' }}>
              <button role="menuitem" onClick={() => { setRenameValue(menuConversation.title); setRenamingConversation(menuConversation.id); setConversationMenu(null); }}>
              <Pencil size={14}/>重命名</button>
                  <button role="menuitem" onClick={() => { setConversationMenu(null); if (menuConversation.manualTitle && !confirm("用 AI 重新生成标题，替换手动标题？")) return; void api.title(menuConversation.id).catch(e => toast(String(e))); }}>
                  <Sparkles size={14}/>AI 生成标题</button>
                    <button role="menuitem" onClick={() => void toggleArchive(menuConversation).catch(e => toast(String(e)))}>
                        {menuConversation.archived ? <ArchiveRestore size={14}/> : <Archive size={14}/>} {menuConversation.archived ? '取消归档' : '归档'}
                        </button>
                            <button role="menuitem" className="danger" onClick={async () => { setConversationMenu(null); if (tasks.some(t => t.conversationId === menuConversation.id)) { toast('请先停止该会话的任务'); return; } if (confirm(`删除“${menuConversation.title}”及其全部分支？`)) await commit(s => { s.conversations = s.conversations.filter(x => x.id !== menuConversation.id); if (s.selectedId === menuConversation.id) s.selectedId = s.conversations[0]?.id || null; }); setConversationMenu(null); }}>
                            <Trash2 size={14}/>删除会话</button>
</div>, document.body)}
          {renamingConversation && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setRenamingConversation(null); }}>
              <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-dialog-title" onMouseDown={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void saveConversationRename(); }}>
                <h2 id="rename-dialog-title">重命名对话</h2>
                    <label className="field">对话标题<input autoFocus value={renameValue} onChange={e => setRenameValue(e.target.value)} maxLength={120}/>
                    </label>
                        <div className="button-row">
                          <button type="button" onClick={() => setRenamingConversation(null)}>取消</button>
                            <button className="primary" type="submit" disabled={!renameValue.trim()}>保存</button>
                            </div>
                            </form>
</div>}
          {renamingBranch && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setRenamingBranch(null); }}>
              <form className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-branch-dialog-title" onMouseDown={e => e.stopPropagation()} onSubmit={e => { e.preventDefault(); void saveBranchRename(); }}>
                <h2 id="rename-branch-dialog-title">重命名分支</h2>
                    <label className="field">分支名称<input autoFocus value={renameBranchValue} onChange={e => setRenameBranchValue(e.target.value)} maxLength={120}/>
                    </label>
                        <div className="button-row">
                          <button type="button" onClick={() => setRenamingBranch(null)}>取消</button>
                            <button className="primary" type="submit" disabled={!renameBranchValue.trim()}>保存</button>
                            </div>
                            </form>
</div>}
    <AttachmentViewer attachment={previewAttachment} onClose={closeAttachmentPreview} onNotice={toast}/>
    {debugView && <RequestDebugView messageLabel={debugView.label} records={debugView.records} onClose={() => setDebugView(null)}/>}
    {notice && <div role="status" className="toast">{notice}<button className="icon-button" title="关闭提示" onClick={() => setNotice('')}><X size={14}/></button></div>}
  </div>;
}
