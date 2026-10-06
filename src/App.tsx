import { useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, BookOpen, BrainCircuit, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, Download, GitBranch, ImagePlus, List, MessageSquare, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCcw, Search, Settings as SettingsIcon, Sparkles, Square, Trash2, X } from 'lucide-react';
import { api } from './api';
import { addMessage, createConversation, editMessage, firstLine, fork, initialState, normalizePromptSettings, pathTo, removeBranch, resolveSearch, uid } from './domain';
import type { AppState, Attachment, Branch, Conversation, Message, Model, Settings as SettingsType } from './types';
import Markdown from './Markdown';
import Settings from './Settings';
type Task = { conversationId: string; branchId: string; kind: string };
export default function App() {
  const [state, setState] = useState<AppState>(initialState), stateRef = useRef(state);
  const [loaded, setLoaded] = useState(false), [showSettings, setShowSettings] = useState(false);
  const [left, setLeft] = useState(true), [right, setRight] = useState(true), [query, setQuery] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]), [notice, setNotice] = useState(''), noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [branchMenu, setBranchMenu] = useState(false), [options, setOptions] = useState(false), [conversationMenu, setConversationMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null), [editText, setEditText] = useState('');
  const [activeMessage, setActiveMessage] = useState(''), [atBottom, setAtBottom] = useState(true), [summaryOpen, setSummaryOpen] = useState(false);
  const [composerHeight, setComposerHeight] = useState(56);
  const composerDrag = useRef<{ y: number; height: number } | null>(null);
  const [leftWidth, setLeftWidth] = useState(258), [rightWidth, setRightWidth] = useState(230);
  const scrollRef = useRef<HTMLDivElement>(null), textareaRef = useRef<HTMLTextAreaElement>(null), fileRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false), draftCache = useRef(new Map<string, { draft: string; attachments: Attachment[] }>());
  const persistDraftTimer = useRef<ReturnType<typeof setTimeout>>(undefined), queue = useRef(Promise.resolve()), saveSequence = useRef(0), pendingWrites = useRef(0);
  function toast(s: string) { setNotice(s); clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 6500); }
  function apply(s: AppState) {
    normalizePromptSettings(s.settings);
    for (const c of s.conversations) for (const b of c.branches) { const local = draftCache.current.get(b.id); if (local) { b.draft = local.draft; b.draftAttachments = local.attachments; } }
    stateRef.current = s; setState(s);
  }
  function receive(server: AppState) {
    if (!pendingWrites.current) { apply(server); return; }
    // Preserve optimistic navigation/config while receiving authoritative generation updates.
    const local = structuredClone(stateRef.current);
    for (const c of local.conversations) {
      const remote = server.conversations.find(x => x.id === c.id); if (!remote) continue;
      c.messages = c.messages.map(m => remote.messages.find(x => x.id === m.id) || m);
      if (!c.manualTitle) { c.title = remote.title; c.titleState = remote.titleState; }
      c.backgroundUsage = remote.backgroundUsage;
      for (const b of c.branches) { const rb = remote.branches.find(x => x.id === b.id); if (rb?.summary) b.summary = rb.summary; }
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
    const off = api.onEvent(event => { if (event.state) receive(event.state); if (event.tasks) setTasks(event.tasks); if (event.error) toast(event.error); });
    const reload = () => { draftCache.current.clear(); void api.load().then(apply); }; window.addEventListener('deepchan-reload', reload);
    return () => { alive = false; off(); window.removeEventListener('deepchan-reload', reload); };
  }, []);
  useEffect(() => { document.documentElement.dataset.theme = state.settings.theme; document.documentElement.style.setProperty('--chat-font', `${state.settings.fontSize}px`); }, [state.settings.theme, state.settings.fontSize]);
  const conversation = state.conversations.find(c => c.id === state.selectedId);
  const branch = conversation?.branches.find(b => b.id === conversation.activeBranchId);
  const messages = conversation && branch ? pathTo(conversation, branch.leafId) : [];
  const model = state.settings.models.find(m => m.id === branch?.config.modelId);
  const effectiveSearch = branch ? resolveSearch(state.settings, branch.config.modelId, branch.config.search) : 'off';
  const searchUnavailable = branch?.config.search === 'auto' && effectiveSearch === 'off';
  const task = tasks.find(t => t.conversationId === conversation?.id), busy = !!task;
  const pending = messages.some(m => m.status === 'streaming');
  useEffect(() => {
    if (atBottom && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.map(m => m.text.length + m.reasoning.length + m.tools.length).join(','), atBottom]);
  useEffect(() => {
    setEditing(null); setBranchMenu(false); setOptions(false); setSummaryOpen(false);
    requestAnimationFrame(() => { if (scrollRef.current && branch) { scrollRef.current.scrollTop = branch.scrollTop || scrollRef.current.scrollHeight; setAtBottom(scrollRef.current.scrollHeight - scrollRef.current.scrollTop - scrollRef.current.clientHeight < 100); } });
  }, [conversation?.id, branch?.id]);
  useEffect(() => {
    const key = (e: globalThis.KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); void newChat(); } if (e.key === 'Escape') { setBranchMenu(false); setOptions(false); setEditing(null); setConversationMenu(null); } };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, []);
  async function newChat() { await commit(s => { const c = createConversation(s.settings); s.conversations.unshift(c); s.selectedId = c.id; }); setShowSettings(false); setAtBottom(true); textareaRef.current?.focus(); }
  function find(s: AppState): { c: Conversation; b: Branch } { const c = s.conversations.find(c => c.id === stateRef.current.selectedId)!; const b = c.branches.find(b => b.id === c.activeBranchId)!; return { c, b }; }
  async function switchChat(id: string) { if (scrollRef.current && branch) branch.scrollTop = scrollRef.current.scrollTop; await commit(s => { s.selectedId = id; }); setShowSettings(false); }
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
    try { await api.run({ conversationId: id, branchId, messageId }); }
    catch (e) { toast(String(e instanceof Error ? e.message : e)); await commit(s => { const m = s.conversations.find(c => c.id === id)?.messages.find(m => m.id === messageId); if (m) { m.status = 'error'; m.error = String(e); } }); }
  }
  async function send() {
    if (!conversation || !branch || busy || pending) return;
    if (!branch.draft.trim() && !branch.draftAttachments.length) return;
    if (!model) { toast('请先配置并选择聊天模型'); setShowSettings(true); return; }
    if (branch.draftAttachments.length && !model.vision) { toast('当前模型不支持图片，请切换模型或移除附件'); return; }
    let messageId = '', branchId = branch.id, id = conversation.id;
    clearTimeout(persistDraftTimer.current); draftCache.current.delete(branch.id);
    await commit(s => { const { c, b } = find(s); const m = addMessage(c, b, 'user', b.draft.trim()); m.attachments = b.draftAttachments; b.draft = ''; b.draftAttachments = []; const reply = addMessage(c, b, 'assistant', ''); messageId = reply.id; if (c.title === '新对话') c.title = m.text.slice(0, 24) || '图片对话'; });
    setAtBottom(true); await begin(id, branchId, messageId);
  }
  async function regenerate(source: Message) {
    if (!conversation || !branch || busy || pending) return;
    let branchId = '', messageId = ''; const id = conversation.id;
    await commit(s => { const { c, b } = find(s); const next: Branch = { ...structuredClone(b), id: uid(), name: `重新生成 ${c.branches.length}`, parentBranchId: b.id, originId: source.parentId, leafId: source.parentId, draft: '', draftAttachments: [], scrollTop: 0, updated: Date.now() }; c.branches.push(next); c.activeBranchId = next.id; branchId = next.id; const m = addMessage(c, next, 'assistant', '', source.parentId); messageId = m.id; });
    setAtBottom(true); await begin(id, branchId, messageId);
  }
  async function submitEdit(source: Message) {
    if (!conversation || busy || pending || !editText.trim()) return;
    let branchId = '', messageId = ''; const id = conversation.id;
    await commit(s => { const { c } = find(s); const result = editMessage(c, source.id, editText); branchId = result.branch.id; if (source.role === 'assistant') { result.message.tools = structuredClone(source.tools); result.message.sources = structuredClone(source.sources); } else messageId = addMessage(c, result.branch, 'assistant', '').id; });
    setEditing(null); if (messageId) await begin(id, branchId, messageId);
  }
  async function createBranch(source: Message) { if (!conversation) return; await commit(s => { const { c } = find(s); fork(c, source.id); }); textareaRef.current?.focus(); toast('已创建分支，可以继续新的讨论'); }
  async function version(source: Message, target: Message) {
    await commit(s => { const { c } = find(s); const existing = c.branches.find(b => pathTo(c, b.leafId).some(m => m.id === target.id)); if (existing) c.activeBranchId = existing.id; else if (target.status === 'complete') fork(c, target.id); });
  }
  async function attach(files: File[]) {
    if (!branch) { toast('请先新建对话'); return; }
    if (branch.draftAttachments.length + files.length > 6) { toast('每条消息最多添加 6 张图片'); return; }
    const items: Attachment[] = [];
    for (const f of files) {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { toast('支持 PNG、JPEG、WebP 静态图片'); continue; }
      if (f.size > 10 * 1024 * 1024) { toast(`${f.name} 超过 10 MB，请先缩小图片`); continue; }
      try {
        // Re-encode to strip metadata and cap oversized dimensions before upload.
        const bitmap = await createImageBitmap(f); const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height)); const canvas = document.createElement('canvas'); canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale); canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
        const mime = f.type === 'image/jpeg' ? 'image/jpeg' : 'image/png'; const data = canvas.toDataURL(mime, 0.9);
        if (data.length > 15_000_000) throw new Error('重新编码后的图片超过限制');
        items.push({ id: uid(), name: f.name, mime, data, size: Math.floor(data.length * 0.75) });
      } catch { toast(`无法读取图片：${f.name}`); }
    }
    const current = stateRef.current.conversations.find(c => c.id === conversation!.id)?.branches.find(b => b.id === branch.id);
    if (current) draft(current.draft, [...current.draftAttachments, ...items]);
  }
  function resize(side: 'left' | 'right', start: number, initial: number) {
    const move = (e: MouseEvent) => { const width = initial + (e.clientX - start) * (side === 'left' ? 1 : -1); (side === 'left' ? setLeftWidth : setRightWidth)(Math.max(190, Math.min(360, width))); };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.style.cursor = ''; };
    document.body.style.cursor = 'col-resize'; window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
  }
  function setInputHeight(height: number) {
    setComposerHeight(Math.max(47, Math.min(Math.max(47, Math.min(420, window.innerHeight * 0.45)), height)));
  }
  function onScroll() {
    const el = scrollRef.current; if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
    const els = [...el.querySelectorAll<HTMLElement>('.message')]; const top = el.getBoundingClientRect().top;
    const active = els.find(node => node.getBoundingClientRect().bottom > top + 80); if (active) setActiveMessage(active.dataset.id || '');
  }
  function updateConfig(values: Partial<Branch['config']>) { void commit(s => { const { b } = find(s); b.config = { ...b.config, ...values }; }).catch(() => {}); }
  const grouped = state.conversations.filter(c => c.title.toLowerCase().includes(query.toLowerCase())).sort((a,b) => b.updated - a.updated);
  if (!loaded) return <div className="loading"><Sparkles size={28}/><p>正在打开 DeepChan-chat…</p></div>;
  return <div className="app-shell">
    {left && <><aside className="sidebar" style={{ width: leftWidth }}><div className="sidebar-top"><div className="brand"><span className="brand-mark"><GitBranch size={19}/></span>DeepChan-chat</div><button className="icon-button" title="收起侧栏" onClick={() => setLeft(false)}><PanelLeftClose size={18}/></button></div><button className="new-chat" onClick={() => newChat()}><Plus size={18}/>新建对话<span>Ctrl N</span></button><div className="search-input"><Search size={15}/><input aria-label="搜索对话" placeholder="搜索对话" value={query} onChange={e => setQuery(e.target.value)}/></div><div className="sidebar-label">你的对话 <span>{state.conversations.length}</span></div><div className="conversation-list">{grouped.map(c => <div key={c.id} className={`conversation-item ${c.id === state.selectedId && !showSettings ? 'active' : ''}`}><button className="conversation-select" onClick={() => switchChat(c.id)} title={c.title}><MessageSquare size={15}/><span>{c.title}</span>{tasks.some(t => t.conversationId === c.id) && <i className="status-dot"/>}</button><button className="conversation-more icon-button" title="会话操作" onClick={() => setConversationMenu(conversationMenu === c.id ? null : c.id)}><MoreHorizontal size={16}/></button>{conversationMenu === c.id && <div className="popover conversation-popover"><button onClick={async () => { const title = prompt('重命名会话', c.title); if (title?.trim()) await commit(s => { const next = s.conversations.find(x => x.id === c.id)!; next.title = title.trim(); next.manualTitle = true; }); setConversationMenu(null); }}><Pencil size={14}/>重命名</button><button onClick={() => { setConversationMenu(null); if (c.manualTitle && !confirm("用 AI 重新生成标题，替换手动标题？")) return; void api.title(c.id).catch(e => toast(String(e))); }}><Sparkles size={14}/>AI 生成标题</button><button className="danger" onClick={async () => { if (tasks.some(t => t.conversationId === c.id)) { toast('请先停止该会话的任务'); return; } if (confirm(`删除“${c.title}”及其全部分支？`)) await commit(s => { s.conversations = s.conversations.filter(x => x.id !== c.id); if (s.selectedId === c.id) s.selectedId = s.conversations[0]?.id || null; }); setConversationMenu(null); }}><Trash2 size={14}/>删除会话</button></div>}</div>)}{!grouped.length && <p className="sidebar-empty">{query ? '没有找到对话' : '开始你的第一段对话'}</p>}</div><div className="sidebar-bottom"><button className={`settings-entry ${showSettings ? 'active' : ''}`} onClick={() => setShowSettings(true)}><SettingsIcon size={17}/><span>设置</span><span className="local-badge">本地</span></button><div className="local-note"><span className="status-dot"/>聊天记录保存在此设备</div></div></aside><div className="resize-handle" onMouseDown={e => resize('left', e.clientX, leftWidth)}/></>}
    {showSettings ? <Settings settings={state.settings} onClose={() => setShowSettings(false)} onSave={settings => commit(s => { s.settings = settings; })} toast={toast}/> : <main className="workspace"><header className="chat-header"><div className="header-start">{!left && <button className="icon-button" title="展开侧栏" onClick={() => setLeft(true)}><PanelLeftOpen size={20}/></button>}<div className="header-title"><span title={conversation?.title}>{conversation?.title || '新对话'}</span><small title={model?.name}>{model?.name || '选择模型'}</small></div></div><div className="header-actions">{branch && <div className="popover-anchor"><button className="branch-pill" onClick={() => setBranchMenu(!branchMenu)}><GitBranch size={15}/>{branch.name}<ChevronDown size={13}/></button>{branchMenu && <div className="popover branch-popover"><div className="popover-heading">对话分支 · {conversation!.branches.length}</div>{conversation!.branches.map(b => <div className="branch-option" key={b.id}><button onClick={() => switchBranch(b.id)}><GitBranch size={14}/><span><strong>{b.name}</strong><small>{b.originId ? firstLine(conversation!.messages.find(m => m.id === b.originId)?.text || '') || '编辑 / 重新生成' : '对话起点'}</small></span>{b.id === branch.id && <Check size={14}/>}</button><button className="icon-button" title="重命名分支" onClick={() => { const name = prompt('分支名称', b.name); if (name?.trim()) void commit(s => { find(s).c.branches.find(x => x.id === b.id)!.name = name.trim(); }); }}><Pencil size={13}/></button><button className="icon-button danger" title="删除分支及其后代" disabled={busy || conversation!.branches.length === 1} onClick={() => { if (confirm(`删除“${b.name}”及其后代分支？其他分支共享的历史会保留。`)) void commit(s => removeBranch(find(s).c, b.id)).catch(e => toast(String(e))); }}><Trash2 size={13}/></button></div>)}</div>}</div>}{conversation && <button className="icon-button" title="导出当前会话 Markdown" onClick={() => api.exportData('markdown', conversation.id).catch(e => toast(String(e)))}><Download size={18}/></button>}<button className={`icon-button ${right ? 'selected' : ''}`} title="切换对话大纲" onClick={() => setRight(!right)}><List size={20}/></button></div></header>
    <div className="workspace-body"><section className="chat-panel" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void attach([...e.dataTransfer.files]); }}>
    <div className="message-scroll" ref={scrollRef} onScroll={onScroll}>{!messages.length ? <div className="welcome"><div className="welcome-icon"><Sparkles size={27}/></div><span className="eyebrow">一个想法，多种可能</span><h1>今天，想聊些什么？</h1><p>连接你喜欢的模型，让思路在对话中展开。</p>{!state.settings.models.length ? <button className="primary" onClick={() => setShowSettings(true)}><Plus size={16}/>连接第一个模型</button> : !conversation ? <button className="primary" onClick={() => newChat()}><Plus size={16}/>开始新对话</button> : <div className="starter-grid">{['帮我梳理一个项目的实现思路', '解释一个我想深入了解的概念', '一起比较几个方案的优缺点'].map(t => <button key={t} onClick={() => { draft(t); textareaRef.current?.focus(); }}>{t}<ArrowUp size={15}/></button>)}</div>}<div className="welcome-foot"><GitBranch size={15}/>从任何回答创建分支，探索不同方向</div></div> : <div className="messages">{branch?.originId && <div className="branch-banner"><GitBranch size={14}/>正在浏览「{branch.name}」，共享历史保持完整</div>}{branch?.summary && <button className="summary-banner" onClick={() => setSummaryOpen(!summaryOpen)}><BookOpen size={14}/>较早的历史已压缩 · 原始消息仍可阅读<ChevronDown size={13}/></button>}{summaryOpen && <div className="summary-content"><Markdown text={branch?.summary?.text || ''}/></div>}{messages.map((m, i) => {
      const siblings = conversation!.messages.filter(x => x.role === m.role && x.parentId === m.parentId); const index = siblings.findIndex(x => x.id === m.id);
      const forks = conversation!.branches.filter(b => b.originId === m.id);
      return <article className={`message ${m.role}`} key={m.id} id={`message-${m.id}`} data-id={m.id}><div className="message-label">{m.role === 'assistant' ? <><span className="assistant-avatar"><GitBranch size={15}/></span>{state.settings.models.find(x => x.id === m.modelId)?.name || 'DeepChan-chat'}{m.edited && <span className="edited-label">手动编辑</span>}</> : <span>你</span>}</div>
        {editing === m.id ? <div className="edit-box"><textarea value={editText} onChange={e => setEditText(e.target.value)} rows={5}/><div className="button-row"><button onClick={() => setEditing(null)}>取消</button><button className="primary" onClick={() => submitEdit(m)}>{m.role === 'user' ? '保存并生成' : '保存新版本'}</button></div><small>原版本及后续消息会保留。</small></div> : <><div className="message-attachments">{m.attachments.map(a => <img key={a.id} src={a.data} alt={a.name} title={a.name}/>)}</div>{m.reasoning && <details className="thinking"><summary><Sparkles size={13}/>推理摘要{m.status === 'streaming' ? ' · 生成中' : ''}</summary><Markdown text={m.reasoning}/></details>}{m.tools.map(t => <details className="tool-card" key={t.id}><summary><Search size={13}/>{t.name}<span className={`tool-status ${t.status}`}>{t.status === 'running' ? '执行中' : t.status === 'done' ? '完成' : '失败'}</span>{t.elapsed !== undefined && <small>{(t.elapsed / 1000).toFixed(1)}s</small>}</summary><div><strong>输入</strong><pre>{t.input}</pre><strong>结果</strong><pre>{t.output || '等待结果…'}</pre></div></details>)}{m.text ? <div className="message-content"><Markdown text={m.text}/>{m.status === 'streaming' && <span className="stream-cursor"/>}</div> : m.status === 'streaming' ? <div className="generating"><i/><i/><i/><span>{task?.kind === 'compression' ? '正在压缩上下文' : '正在思考'}</span></div> : null}
        {!!m.sources.length && <div className="sources"><span>来源</span>{m.sources.map((s, index) => <button title={s.url} key={s.url} onClick={() => api.openExternal(s.url).catch(e => toast(String(e)))}>{index + 1} · {s.title}</button>)}</div>}{m.error && <div className="message-error">{m.error}</div>}
        <div className="message-toolbar"><button className="icon-button" title="复制消息" onClick={() => navigator.clipboard.writeText(m.text).then(() => toast('已复制')).catch(e => toast(String(e)))}><Copy size={14}/></button><button className="icon-button" title="编辑为新版本" disabled={busy || pending} onClick={() => { setEditing(m.id); setEditText(m.text); }}><Pencil size={14}/></button>{m.role === 'assistant' && <><button className="icon-button" title="重新生成并保留旧回答" disabled={busy || pending} onClick={() => regenerate(m)}><RotateCcw size={14}/></button><button className="toolbar-branch" title="从此回答创建分支" disabled={m.status !== 'complete'} onClick={() => createBranch(m)}><GitBranch size={14}/>分支{forks.length > 0 && <span>{forks.length}</span>}</button></>}{siblings.length > 1 && <div className="version-switch"><button className="icon-button" title="上一个版本" disabled={index === 0 || siblings[index - 1]?.status !== 'complete'} onClick={() => version(m, siblings[index - 1])}><ChevronLeft size={13}/></button><span>{index + 1} / {siblings.length}</span><button className="icon-button" title="下一个版本" disabled={index === siblings.length - 1 || siblings[index + 1]?.status !== 'complete'} onClick={() => version(m, siblings[index + 1])}><ChevronRight size={13}/></button></div>}{m.usage && <small className="usage">{m.usage.input.toLocaleString()} 输入 · {m.usage.output.toLocaleString()} 输出 token</small>}</div></>}
      </article>;
    })}</div>}</div>

    <div className="composer-area">{!atBottom && !!messages.length && <button className="scroll-bottom" title="回到底部" onClick={() => { setAtBottom(true); scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }); }}><ArrowDown size={18}/></button>}{branch ? <><div className="composer"><div className="composer-resize" role="separator" aria-label="调整输入框高度" aria-orientation="horizontal" aria-valuemin={47} aria-valuemax={Math.max(47, Math.min(420, window.innerHeight * 0.45))} aria-valuenow={composerHeight} tabIndex={0} title="上下拖动调整输入框高度，也可使用方向键" onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); composerDrag.current = { y: e.clientY, height: textareaRef.current?.getBoundingClientRect().height || composerHeight }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { const drag = composerDrag.current; if (drag) setInputHeight(drag.height + drag.y - e.clientY); }} onPointerUp={e => { composerDrag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { composerDrag.current = null; }} onLostPointerCapture={() => { composerDrag.current = null; }} onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); setInputHeight((textareaRef.current?.getBoundingClientRect().height || composerHeight) + (e.key === 'ArrowUp' ? 24 : -24)); } else if (e.key === 'Home') { e.preventDefault(); setInputHeight(47); } else if (e.key === 'End') { e.preventDefault(); setInputHeight(420); } }}><span/></div><div className="draft-attachments">{branch.draftAttachments.map(a => <div key={a.id}><img src={a.data} alt={a.name}/><button className="icon-button" title="移除图片" onClick={() => draft(branch.draft, branch.draftAttachments.filter(x => x.id !== a.id))}><X size={12}/></button></div>)}</div><textarea aria-label="消息输入" style={{ height: composerHeight }} ref={textareaRef} rows={2} placeholder={model ? '发送消息，或从回答中开启一个新分支…' : '先在设置中连接一个模型…'} value={branch.draft} onChange={e => draft(e.target.value)} onCompositionStart={() => composing.current = true} onCompositionEnd={() => composing.current = false} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current) { e.preventDefault(); void send().catch(err => toast(String(err))); } }} onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); void attach(files); } }}/><div className="composer-bottom"><button className="icon-button" title="添加图片（PNG、JPEG、WebP）" onClick={() => fileRef.current?.click()}><ImagePlus size={20}/></button><input hidden ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" multiple onChange={e => { void attach([...e.target.files || []]); e.target.value = ''; }}/><div className="composer-meta"><div className="model-selector"><Sparkles size={14}/><select aria-label="聊天模型" value={branch.config.modelId} disabled={busy} onChange={e => { const m = state.settings.models.find(x => x.id === e.target.value); updateConfig({ modelId: e.target.value, effort: m?.efforts.includes(branch.config.effort) ? branch.config.effort : m?.efforts[0] || 'auto', budget: Math.min(branch.config.budget, Math.max(1024, (m?.maxOutput || 8192) - 1)), search: branch.config.search === 'off' ? 'off' : 'auto' }); }}><option value="">选择模型</option>{state.settings.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></div><div className="reasoning-selector"><BrainCircuit size={14}/>{model?.reasoning === 'budget' ? <select aria-label="思考等级" title="思考预算（token）" value={branch.config.budget} disabled={busy} onChange={e => updateConfig({ budget: Number(e.target.value) })}>{!([1024,2048,4096,8192].includes(branch.config.budget)) && <option value={branch.config.budget}>思考：{branch.config.budget} token</option>}{[1024,2048,4096,8192].map((budget,i) => <option key={budget} value={budget} disabled={budget >= model.maxOutput}>思考：{['轻量','适中','标准','深入'][i]} · {budget}</option>)}</select> : <select aria-label="思考等级" title={model?.reasoning === 'effort' ? '选择当前模型的思考等级' : '当前模型未配置思考等级能力'} value={model?.reasoning === 'effort' ? branch.config.effort : 'auto'} disabled={busy || model?.reasoning !== 'effort'} onChange={e => updateConfig({ effort: e.target.value })}><option value="auto">思考：{model?.reasoning === 'effort' ? '自动' : '不支持'}</option>{model?.reasoning === 'effort' && model.efforts.filter(Boolean).map(level => <option key={level} value={level}>思考：{({ low: '轻量', medium: '标准', high: '深入', minimal: '极简', xhigh: '更深入', max: '最高', none: '关闭' } as Record<string,string>)[level] || level}</option>)}</select>}</div><div className="popover-anchor"><button className="composer-option" onClick={() => setOptions(!options)}><SettingsIcon size={14}/>会话选项{effectiveSearch !== 'off' && <span className="mini-dot"/>}</button>{options && <div className="popover config-popover"><div className="config-popover-heading"><h3>当前分支设置</h3><button className="icon-button" aria-label="关闭会话选项" title="关闭会话选项" onClick={() => setOptions(false)}><X size={16}/></button></div><label className="field">联网搜索<select value={branch.config.search} disabled={busy} onChange={e => updateConfig({ search: e.target.value as Branch['config']['search'] })}><option value="auto">自动联网（默认）</option><option value="off">关闭</option><option value="native" disabled={!model?.nativeSearch || state.settings.connections.find(c => c.id === model.connectionId)?.protocol === 'chat'}>模型原生搜索</option><option value="exa" disabled={!model?.tools || !state.settings.exaKey}>Exa 搜索</option></select></label><label className="field">系统提示词 / 角色预设<select aria-label="系统提示词预设" value={state.settings.promptPresets.find(p => p.content === branch.config.system)?.id || ''} disabled={busy} onChange={e => { const preset = state.settings.promptPresets.find(p => p.id === e.target.value); if (preset) updateConfig({ system: preset.content }); }}><option value="">自定义提示词</option>{state.settings.promptPresets.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label><label className="field">系统提示词<textarea aria-label="系统提示词" value={branch.config.system} disabled={busy} onChange={e => updateConfig({ system: e.target.value })} rows={4}/></label><button disabled={busy || messages.length < 6} onClick={() => { setOptions(false); void api.compress(conversation!.id, branch.id).catch(e => toast(String(e))); }}><BookOpen size={14}/>压缩较早历史</button><p className="muted">设置仅影响当前分支后续请求。推理展示取决于服务返回内容。</p>{!!conversation?.backgroundUsage?.length && <details className="background-usage"><summary>标题与压缩用量</summary>{conversation.backgroundUsage.map((u,i) => <p key={i}>{u.kind === "title" ? "标题" : "压缩"} · {state.settings.models.find(m => m.id === u.modelId)?.name || "历史模型"}<br/>{u.usage.input} 输入 / {u.usage.output} 输出 token</p>)}</details>}</div>}</div></div><button className={`search-toggle ${branch.config.search !== 'off' ? 'enabled' : ''} ${searchUnavailable ? 'unavailable' : ''}`} aria-label="联网搜索" aria-pressed={branch.config.search !== 'off'} disabled={busy} title={searchUnavailable ? '自动联网已开启，但当前模型不支持原生搜索，且没有可用的 Exa。可在设置中配置搜索能力。' : effectiveSearch === 'native' ? '原生搜索已启用，点击关闭' : effectiveSearch === 'exa' ? 'Exa 搜索已启用，点击关闭' : '点击启用自动联网'} onClick={() => updateConfig({ search: branch.config.search === 'off' ? 'auto' : 'off' })}><Search size={14}/>{searchUnavailable ? '联网待配置' : '联网'}</button>{busy ? <button className="send-button stop" title="停止生成" onClick={() => api.cancel(conversation!.id)}><Square size={15} fill="currentColor"/></button> : <button className="send-button" title="发送消息" disabled={pending || !model || (!branch.draft.trim() && !branch.draftAttachments.length)} onClick={() => send().catch(e => toast(String(e)))}><ArrowUp size={20}/></button>}</div></div></> : <div className="empty-composer"><span>准备好开始了？</span><button onClick={() => newChat()}><Plus size={16}/>新建对话</button></div>}</div>
    </section>{right && <><div className="resize-handle outline-resize" onMouseDown={e => resize('right', e.clientX, rightWidth)}/><aside className="outline" style={{ width: rightWidth }}><div className="outline-heading"><List size={16}/><span>对话大纲</span><small>{messages.filter(m => m.role === 'user').length} 轮</small></div><div className="outline-list">{messages.length ? messages.map((m,i) => <button className={`outline-item ${m.role} ${activeMessage === m.id ? 'active' : ''}`} key={m.id} title={firstLine(m.text)} onClick={() => { document.getElementById(`message-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActiveMessage(m.id); }}><span className="outline-marker">{m.role === 'user' ? `${Math.floor(i / 2) + 1}` : <span/>}</span><span>{firstLine(m.text) || (m.attachments.length ? '图片提问' : m.status === 'streaming' ? '生成中…' : '未完成回答')}</span></button>) : <div className="outline-empty"><BookOpen size={25}/><p>思路，清晰可见</p><small>对话开始后，问答大纲会显示在这里。</small></div>}</div><div className="outline-footer"><GitBranch size={14}/>{branch ? branch.name : '每个分支都有自己的大纲'}</div></aside></>}</div></main>}
    {notice && <div role="status" className="toast">{notice}<button className="icon-button" title="关闭提示" onClick={() => setNotice('')}><X size={14}/></button></div>}
  </div>;
}
