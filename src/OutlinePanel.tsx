import { BookOpen, GitBranch, List } from 'lucide-react';
import { firstLine } from './domain';
import type { Message } from './types';

// The right hand outline: one entry per message in the current branch, with the real turn number
// for questions, plus the resize handle that sits next to it.
export default function OutlinePanel({ width, messages, turnNumbers, activeMessage, branchName, onResizeStart, onJump }: {
  width: number; messages: Message[]; turnNumbers: Map<string, number>; activeMessage: string; branchName?: string;
  onResizeStart: (event: React.MouseEvent) => void; onJump: (id: string) => void;
}) {
  return <>
    <div className="resize-handle outline-resize" onMouseDown={onResizeStart}/>
    <aside className="outline" style={{ width }}>
      <div className="outline-heading"><List size={16}/><span>对话大纲</span><small>{messages.filter(message => message.role === 'user').length} 轮</small></div>
      <div className="outline-list">
        {messages.length ? messages.map(message => <button className={`outline-item ${message.role} ${activeMessage === message.id ? 'active' : ''}`} key={message.id} title={firstLine(message.text)} onClick={() => onJump(message.id)}>
          <span className="outline-marker">{message.role === 'user' ? `${turnNumbers.get(message.id) ?? ''}` : <span/>}</span>
          <span>{firstLine(message.text) || (message.attachments.length ? '图片提问' : message.status === 'streaming' ? '思考中…' : '未完成回答')}</span>
        </button>) : <div className="outline-empty"><BookOpen size={25}/><p>思路，清晰可见</p><small>对话开始后，问答大纲会显示在这里。</small></div>}
      </div>
      <div className="outline-footer"><GitBranch size={14}/>{branchName || '每个分支都有自己的大纲'}</div>
    </aside>
  </>;
}
