import { Archive, MessageSquare, MoreHorizontal, PanelLeftClose, Plus, Search, Settings as SettingsIcon } from 'lucide-react';
import type { Conversation } from './types';

export type MenuAnchor = { top: number; bottom: number; right: number };

// The conversation list column: new chat, search, the list itself with its per item menu, the
// archive view entry, settings, and the resize handle that belongs to this edge of the window.
export default function Sidebar({ width, conversations, selectedId, query, showArchived, archiveCount, showSettings, runningIds, openMenuId, onQueryChange, onSelect, onNewChat, onArchiveView, onOpenSettings, onCollapse, onMenu, onResizeStart }: {
  width: number; conversations: Conversation[]; selectedId: string | null; query: string; showArchived: boolean; archiveCount: number; showSettings: boolean;
  runningIds: string[]; openMenuId: string | null;
  onQueryChange: (query: string) => void; onSelect: (id: string) => void; onNewChat: () => void; onArchiveView: () => void; onOpenSettings: () => void; onCollapse: () => void;
  onMenu: (id: string, anchor: MenuAnchor | null) => void; onResizeStart: (event: React.MouseEvent) => void;
}) {
  return <>
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-top"><div className="brand">DeepChan-chat</div><button className="icon-button" title="收起侧栏" onClick={onCollapse}><PanelLeftClose size={18}/></button></div>
      <button className="new-chat" onClick={onNewChat}><Plus size={18}/>新建对话<span>Ctrl N</span></button>
      <div className="search-input"><Search size={15}/><input aria-label="搜索对话" placeholder="搜索对话" value={query} onChange={e => onQueryChange(e.target.value)}/></div>
      <div className="sidebar-label">{showArchived ? '已归档' : '你的对话'} <span>{conversations.length}</span></div>
      <div className="conversation-list" onScroll={() => { if (openMenuId) onMenu(openMenuId, null); }}>
        {conversations.map(conversation => <div key={conversation.id} className={`conversation-item ${conversation.id === selectedId && !showSettings ? 'active' : ''}`}
          onContextMenu={event => { event.preventDefault(); onMenu(conversation.id, { top: event.clientY, bottom: event.clientY, right: event.clientX }); }}>
          <button className="conversation-select" onClick={() => onSelect(conversation.id)} title={conversation.title}>
            <MessageSquare size={15}/><span>{conversation.title}</span>{runningIds.includes(conversation.id) && <i className="status-dot"/>}
          </button>
          <button className="conversation-more icon-button" title="会话操作" aria-haspopup="menu" aria-expanded={openMenuId === conversation.id}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); onMenu(conversation.id, { top: rect.top, bottom: rect.bottom, right: rect.right }); }}>
            <MoreHorizontal size={16}/>
          </button>
        </div>)}
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
