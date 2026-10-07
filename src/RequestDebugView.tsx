import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FileJson, X } from 'lucide-react';
import Markdown from './Markdown';
import type { RequestRecord } from './types';

// A fence must be longer than any backtick run inside the payload, or the payload would end its own
// code block and the rest of the document would render as text.
function fence(content: string, language = '') {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map(match => match[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return `${ticks}${language}\n${content}\n${ticks}`;
}

function recordMarkdown(record: RequestRecord, index: number) {
  const sections = [
    `## 第 ${index + 1} 次请求${record.error ? '（失败）' : ''}`,
    `\`${record.method}\` \`${record.url}\``,
    '### 请求头',
    fence(JSON.stringify(record.headers, null, 2), 'json'),
    '### 请求体',
    fence(record.body, 'json')
  ];
  if (record.error) sections.push('### 上游返回', fence(record.error, 'text'));
  return sections.join('\n\n');
}

const EMPTY_HINT = '这条回答没有可用的请求记录。\n\n请求详情只保存在内存中：重启应用、重新生成或重新发送之后，旧记录会清空。';

export default function RequestDebugView({ messageLabel, records, onClose }: { messageLabel: string; records: RequestRecord[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  const text = records.length ? records.map(recordMarkdown).join('\n\n') : EMPTY_HINT;
  return createPortal(
    <div className="attachment-viewer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="attachment-viewer-window" role="dialog" aria-modal="true" aria-label="查看请求详情">
        <header className="attachment-viewer-header">
          <div className="attachment-viewer-title"><FileJson size={16}/><span title={messageLabel}>请求详情 · {records.length} 次 · {messageLabel}</span></div>
          <button className="icon-button" aria-label="关闭请求详情" title="关闭" onClick={onClose}><X size={16}/></button>
        </header>
        <div className="attachment-viewer-markdown-layout"><div className="attachment-viewer-markdown"><Markdown text={text}/></div></div>
      </section>
    </div>, document.body
  );
}
