import { memo, useLayoutEffect, useRef } from 'react';
import { ChevronLeft, ChevronRight, Copy, FileJson, GitBranch, Paperclip, Pencil, RotateCcw, Search, Sparkles } from 'lucide-react';
import Markdown from './Markdown';
import AnswerMetaDetails from './AnswerMetaDetails';
import { lastAssistantBody, messageDateTime, sameMessage } from './domain';
import type { Attachment, Message } from './types';

function ReasoningDetails({ message, text, active, duration }: { message: Message; text: string; active: boolean; duration?: number }) {
  const details = useRef<HTMLDetailsElement>(null);
  useLayoutEffect(() => { if (details.current) details.current.open = message.status === 'streaming'; }, [message.id, message.status]);
  return <details ref={details} className="thinking"><summary><Sparkles size={13}/>推理摘要{active ? <span className="thinking-status">思考中</span> : duration !== undefined ? <span className="cot-time">{(duration / 1000).toFixed(1)}s</span> : null}</summary><Markdown text={text}/></details>;
}
function ToolDetails({ tool }: { tool: Message['tools'][number] }) {
  return <details className="tool-card"><summary><Search size={13}/>{tool.name}<span className={`tool-status ${tool.status}`}>{tool.status === 'pending' ? '准备中' : tool.status === 'running' ? '执行中' : tool.status === 'done' ? '完成' : '失败'}</span>{tool.elapsed !== undefined && <small>{(tool.elapsed / 1000).toFixed(1)}s</small>}</summary><div><strong>输入</strong><pre>{tool.input}</pre><strong>结果</strong><pre>{tool.output || '等待结果…'}</pre></div></details>;
}
function GeneratingIndicator({ taskKind }: { taskKind?: string }) {
  return <div className="generating"><i/><i/><i/><span>{taskKind === 'compression' ? '正在压缩上下文' : '正在思考'}</span></div>;
}
function AssistantContent({ message, taskKind }: { message: Message; taskKind?: string }) {
  const segments = message.segments;
  if (!segments?.length) return <>
    {message.reasoning && <ReasoningDetails message={message} text={message.reasoning} active={message.status === 'streaming'} duration={message.reasoningMs}/>}
    {message.tools.map(tool => <ToolDetails key={tool.id} tool={tool}/>)}
    {message.text ? <div className="message-content"><Markdown text={message.text}/>{message.status === 'streaming' && <span className="stream-cursor"/>}</div> : message.status === 'streaming' ? <GeneratingIndicator taskKind={taskKind}/> : null}
  </>;
  // Older answers only have the message total, which is still correct for a single reasoning card.
  const reasoningCount = segments.filter(segment => segment.type === 'reasoning').length;
  const last = segments.length - 1;
  return <>
    {segments.map((segment, index) => {
      if (segment.type === 'text') return <div className="message-content" key={`text-${index}`}><Markdown text={segment.text}/>{message.status === 'streaming' && index === last && <span className="stream-cursor"/>}</div>;
      if (segment.type === 'reasoning') return <ReasoningDetails key={`reasoning-${index}`} message={message} text={segment.text} active={message.status === 'streaming' && index === last} duration={segment.ms ?? (reasoningCount === 1 ? message.reasoningMs : undefined)}/>;
      const tool = message.tools.find(item => item.id === segment.toolId);
      return tool ? <ToolDetails key={`tool-${segment.toolId}`} tool={tool}/> : null;
    })}
    {message.status === 'streaming' && segments[last]?.type !== 'text' && <GeneratingIndicator taskKind={taskKind}/>}
  </>;
}

function MessageRow({ message, taskKind, searchHighlighted, editing, editText, siblings, versionIndex, forkCount, modelName, connectionName, busy, pending,
  onStartEdit, onCancelEdit, onEditTextChange, onSubmitEdit, onCopy, onRegenerate, onBranch, onVersion, onDebug, onOpenAttachment, onContextMenu, onOpenExternal, onNotice
}: {
  message: Message; taskKind?: string; searchHighlighted: boolean; editing: boolean; editText: string; siblings: Message[]; versionIndex: number; forkCount: number;
  modelName: string; connectionName: string; busy: boolean; pending: boolean;
  onStartEdit: (message: Message) => void; onCancelEdit: () => void; onEditTextChange: (text: string) => void; onSubmitEdit: (message: Message) => void;
  onCopy: (message: Message) => void; onRegenerate: (message: Message) => void; onBranch: (message: Message) => void; onVersion: (message: Message) => void;
  onDebug: (message: Message) => void; onOpenAttachment: (attachment: Attachment) => void; onContextMenu: (message: Message, point: { x: number; y: number }) => void;
  onOpenExternal: (url: string) => void; onNotice: (text: string) => void;
}) {
  const role = message.role, body = lastAssistantBody(message);
  const attachable = (attachment: Attachment) => attachment.mime.startsWith('image/') && !!attachment.data;
  return <article className={`message ${role} ${searchHighlighted ? 'search-highlight-active' : ''}`} id={`message-${message.id}`} data-id={message.id}
    onContextMenu={event => { event.preventDefault(); onContextMenu(message, { x: event.clientX, y: event.clientY }); }}>
    {editing ? <div className="edit-box"><textarea value={editText} onChange={e => onEditTextChange(e.target.value)} rows={5}/><div className="button-row"><button onClick={onCancelEdit}>取消</button><button className="primary" onClick={() => onSubmitEdit(message)}>{role === 'user' ? '保存并生成' : '保存新版本'}</button></div><small>原版本及后续消息会保留。</small></div> : <>
      <div className="message-attachments">{message.attachments.map(attachment => attachable(attachment)
        ? <button type="button" key={attachment.id} className="image-attachment-trigger" aria-label={`查看图片：${attachment.name}`} title={attachment.name} onClick={() => onOpenAttachment(attachment)}><img src={attachment.data} alt={attachment.name}/></button>
        : <button type="button" key={attachment.id} className="file-attachment" aria-label={`查看附件：${attachment.name}`} onClick={() => onOpenAttachment(attachment)} title={`查看附件：${attachment.name}`}><Paperclip size={14}/><span>{attachment.name}</span>{attachment.markdown && <small>Markdown</small>}</button>)}</div>
      {role === 'assistant' ? <AssistantContent message={message} taskKind={taskKind}/> : message.text ? <div className="message-content"><Markdown text={message.text}/></div> : null}
      {!!message.sources.length && <div className="sources"><span>来源</span>{message.sources.map((source, index) => <button title={source.url} key={source.url} onClick={() => onOpenExternal(source.url)}>{index + 1} · {source.title}</button>)}</div>}
      {message.error && <div className="message-error">{message.error}</div>}
      <div className="message-toolbar">
        {role === 'user' && <span className="message-time">{messageDateTime(message.created)}</span>}
        <button className="icon-button" title={role === 'assistant' ? '复制最终正文' : '复制消息'} onClick={() => onCopy(message)}><Copy size={14}/></button>
        <button className="icon-button" title="编辑为新版本" disabled={busy || pending} onClick={() => onStartEdit(message)}><Pencil size={14}/></button>
        {role === 'assistant' && <>
          <button className="icon-button" title="重新生成并保留旧回答" disabled={busy || pending} onClick={() => onRegenerate(message)}><RotateCcw size={14}/></button>
          <button className="icon-button" aria-label="查看请求详情" title="查看本次回答发送的请求头与请求体" disabled={message.status === 'streaming'} onClick={() => onDebug(message)}><FileJson size={14}/></button>
          <button className="toolbar-branch" aria-label="从此回答创建分支" title="从此回答创建分支" disabled={message.status !== 'complete'} onClick={() => onBranch(message)}><GitBranch size={14}/>{forkCount > 0 && <span>{forkCount}</span>}</button>
        </>}
        {siblings.length > 1 && <div className="version-switch">
          <button className="icon-button" title="上一个版本" disabled={versionIndex === 0 || siblings[versionIndex - 1]?.status === 'streaming'} onClick={() => onVersion(siblings[versionIndex - 1])}><ChevronLeft size={13}/></button>
          <span>{versionIndex + 1} / {siblings.length}</span>
          <button className="icon-button" title="下一个版本" disabled={versionIndex === siblings.length - 1 || siblings[versionIndex + 1]?.status === 'streaming'} onClick={() => onVersion(siblings[versionIndex + 1])}><ChevronRight size={13}/></button>
        </div>}
        {role === 'assistant' && <AnswerMetaDetails modelName={modelName} connectionName={connectionName} timestamp={message.created} usage={message.usage}/>}
      </div>
    </>}
  </article>;
}

// Everything the row renders, compared by value: message content, and the few interaction flags.
function propsEqual(previous: Parameters<typeof MessageRow>[0], next: Parameters<typeof MessageRow>[0]) {
  const sameNeighbour = (offset: number) => (previous.siblings[previous.versionIndex + offset]?.status ?? '') === (next.siblings[next.versionIndex + offset]?.status ?? '');
  return previous.editing === next.editing && previous.editText === next.editText && previous.searchHighlighted === next.searchHighlighted
    && previous.busy === next.busy && previous.pending === next.pending && previous.taskKind === next.taskKind
    && previous.modelName === next.modelName && previous.connectionName === next.connectionName
    && previous.versionIndex === next.versionIndex && previous.forkCount === next.forkCount && previous.siblings.length === next.siblings.length
    && sameNeighbour(-1) && sameNeighbour(1) && sameMessage(previous.message, next.message);
}
export default memo(MessageRow, propsEqual);
