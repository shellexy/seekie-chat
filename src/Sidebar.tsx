import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Archive, MessageSquare, MoreHorizontal, PanelLeftClose, Plus, Search, Settings as SettingsIcon } from 'lucide-react';
import type { Conversation } from './types';
import { conversationGroups } from './domain';

export type MenuAnchor = { top: number; bottom: number; right: number };

type Props = {
  width: number; conversations: Conversation[]; selectedId: string | null; query: string; showArchived: boolean; archiveCount: number; showSettings: boolean;
  runningIds: string[]; openMenuId: string | null;
  onQueryChange: (query: string) => void; onSelect: (id: string) => void; onNewChat: () => void; onArchiveView: () => void; onOpenSettings: () => void; onCollapse: () => void;
  onMenu: (id: string, anchor: MenuAnchor | null) => void; onResizeStart: (event: React.MouseEvent) => void;
};

// 会话上千条时，一次性铺开就是上千个节点：每次筛选、每次父组件重渲染都在为看不见的行付钱。
// 这里只渲染可视区上下各留 OVERSCAN 行的窗口。行高不写死——样式改一次就悄悄错位——
// 而是在挂载后量一次真实占据的高度（含外边距），量到之后整个窗口按它计算。
const OVERSCAN = 8;

export type SidebarHandlers = Pick<Props, 'onSelect' | 'onNewChat' | 'onArchiveView' | 'onOpenSettings' | 'onCollapse' | 'onMenu' | 'onResizeStart'>;

type Row = { kind: 'group'; key: string; label: string } | { kind: 'item'; key: string; conversation: Conversation };

// The conversation list column: new chat, search, the list itself with its per item menu, the
// archive view entry, settings, and the resize handle that belongs to this edge of the window.
function Sidebar({ width, conversations, selectedId, query, showArchived, archiveCount, showSettings, runningIds, openMenuId, onQueryChange, onSelect, onNewChat, onArchiveView, onOpenSettings, onCollapse, onMenu, onResizeStart }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [rowHeight, setRowHeight] = useState({ item: 48, group: 28 });

  // 分组与拍平只在会话列表真的变化时重算：流式补丁之类的更新根本走不到这里。
  const rows = useMemo(() => {
    const flat: Row[] = [];
    for (const group of conversationGroups(conversations)) {
      flat.push({ kind: 'group', key: `g:${group.key}`, label: group.label });
      for (const conversation of group.conversations) flat.push({ kind: 'item', key: conversation.id, conversation });
    }
    return flat;
  }, [conversations]);

  useEffect(() => {
    const element = listRef.current;
    if (!element) return;
    const measure = () => setViewport(element.clientHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 行高实测。量「相邻两行的行距」而不是「盒子高度 + 外边距」：后者与真实行距差零点几像素，
  // 乘上几百行就是滚到底部时多出的一大块空白。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const nodes = [...list.querySelectorAll<HTMLElement>('.conversation-rows > div > *')];
    const tops = nodes.map(node => ({ group: node.classList.contains('conversation-group'), top: node.getBoundingClientRect().top }));
    let item = 0, group = 0;
    for (let index = 0; index + 1 < tops.length; index++) {
      // 同类相邻才有意义：分组行后面紧跟的一定是它自己的第一条会话。
      if (!item && !tops[index].group && !tops[index + 1].group) item = tops[index + 1].top - tops[index].top;
      if (!group && tops[index].group) group = tops[index + 1].top - tops[index].top;
    }
    // 四分之一像素容差，避免测量抖动把状态推来推去。
    if (item > 0 && Math.abs(item - rowHeight.item) > 0.25) setRowHeight(current => ({ ...current, item }));
    if (group > 0 && Math.abs(group - rowHeight.group) > 0.25) setRowHeight(current => ({ ...current, group }));
  }, [rows, rowHeight.item, rowHeight.group]);

  const layout = useMemo(() => {
    const step = (row: Row) => row.kind === 'group' ? rowHeight.group : rowHeight.item;
    const tops = new Array<number>(rows.length);
    let total = 0;
    for (let index = 0; index < rows.length; index++) { tops[index] = total; total += step(rows[index]); }
    // 首个「底部落在视口下沿之下」的行。
    let low = 0, high = rows.length;
    while (low < high) { const mid = (low + high) >> 1; if (tops[mid] + step(rows[mid]) <= scrollTop) low = mid + 1; else high = mid; }
    let last = low;
    while (last < rows.length && tops[last] < scrollTop + viewport) last++;
    const start = Math.max(0, low - OVERSCAN), end = Math.min(rows.length, last + OVERSCAN);
    // 吸顶标题：真实分组行滚出视野后窗口里就没有它了，所以单独画一条。
    const groups: { top: number; label: string }[] = [];
    for (let index = 0; index < rows.length; index++) if (rows[index].kind === 'group') groups.push({ top: tops[index], label: (rows[index] as { label: string }).label });
    // 只有当前分组的真实标题滚到视口上方之后才画覆盖层：此时真实标题已被裁掉，不会出现两条。
    let pinned = '';
    for (const group of groups) { if (group.top < scrollTop) pinned = group.label; else break; }
    return { start, end, offset: tops[start] ?? 0, total, pinned };
  }, [rows, rowHeight, scrollTop, viewport]);

  const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(event.currentTarget.scrollTop);
    if (openMenuId) onMenu(openMenuId, null);
  }, [openMenuId, onMenu]);

  return <>
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-top"><div className="brand">Seekie Chat</div><button className="icon-button" title="收起侧栏" onClick={onCollapse}><PanelLeftClose size={18}/></button></div>
      <button className="new-chat" onClick={onNewChat}><Plus size={18}/>新建对话<span>Ctrl N</span></button>
      <div className="search-input"><Search size={15}/><input aria-label="搜索对话" placeholder="搜索对话" value={query} onChange={e => onQueryChange(e.target.value)}/></div>
      <div className="sidebar-label">{showArchived ? '已归档' : '你的对话'} <span>{conversations.length}</span></div>
      <div className="conversation-list" ref={listRef} onScroll={handleScroll}>
        {layout.pinned && <div className="conversation-pinned"><div className="conversation-group pinned">{layout.pinned}</div></div>}
        <div className="conversation-rows" style={{ height: layout.total }}>
          <div style={{ transform: `translateY(${layout.offset}px)` }}>
            {rows.slice(layout.start, layout.end).map(row => row.kind === 'group'
              ? <div key={row.key} className="conversation-group">{row.label}</div>
              : <div key={row.key} data-id={row.conversation.id} className={`conversation-item ${row.conversation.id === selectedId && !showSettings ? 'active' : ''}`}
                  onContextMenu={event => { event.preventDefault(); onMenu(row.conversation.id, { top: event.clientY, bottom: event.clientY, right: event.clientX }); }}>
                  <button className="conversation-select" onClick={() => onSelect(row.conversation.id)} title={row.conversation.title}>
                    <MessageSquare size={15}/><span>{row.conversation.title}</span>{runningIds.includes(row.conversation.id) && <i className="status-dot"/>}
                  </button>
                  <button className="conversation-more icon-button" title="会话操作" aria-haspopup="menu" aria-expanded={openMenuId === row.conversation.id}
                    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onMenu(row.conversation.id, { top: rect.top, bottom: rect.bottom, right: rect.right }); }}>
                    <MoreHorizontal size={16}/>
                  </button>
                </div>)}
          </div>
        </div>
        {!conversations.length && <p className="sidebar-empty">{query ? '没有找到对话' : showArchived ? '暂无已归档对话' : '开始你的第一段对话'}</p>}
      </div>
      <div className="sidebar-bottom">
        <button className={`settings-entry archive-entry ${showArchived ? 'active' : ''}`} onClick={onArchiveView}><Archive size={17}/><span>{showArchived ? '返回对话' : '已归档'}</span><span className="local-badge">{archiveCount}</span></button>
        <button className={`settings-entry ${showSettings ? 'active' : ''}`} onClick={onOpenSettings}><SettingsIcon size={17}/><span>设置</span><span className="local-badge">本地</span></button>
      </div>
    </aside>
    <div className="resize-handle" onMouseDown={onResizeStart}/>
  </>;
}

// 侧栏收到的都是已经稳定下来的引用（列表、运行中 id、转发过的回调），浅比较就够：
// 流式回答每来一个补丁都不会让整列会话重渲染。
export default memo(Sidebar);
