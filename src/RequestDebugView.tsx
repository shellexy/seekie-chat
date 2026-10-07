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

// One request's big payloads each get their own collapsible block. A request body or a streamed
// response runs to hundreds of lines, and laying them all out pushes everything else off screen;
// the ::details-content rule keeps the first few lines visible so the shape of the payload is
// still readable without scrolling.
function RecordBlock({ label, content, language }: { label: string; content: string; language: string }) {
  return <details className="debug-block">
    <summary>{label}</summary>
    <Markdown text={fence(content, language)}/>
  </details>;
}

function recordView(record: RequestRecord, index: number) {
  return <section className="debug-record" key={index}>
    <Markdown text={`## 第 ${index + 1} 次请求${record.error ? '（失败）' : ''}\n\n\`${record.method}\` \`${record.url}\`\n\n### 请求头\n\n${fence(JSON.stringify(record.headers, null, 2), 'json')}`}/>
    <RecordBlock label="请求体" content={record.body} language="json"/>
    {record.response && <RecordBlock label="响应内容" content={record.response} language="text"/>}
    {record.error && <RecordBlock label="上游返回" content={record.error} language="text"/>}
  </section>;
}

const EMPTY_HINT = '这条回答没有可用的请求记录。\n\n请求详情随对话保存在本地，但只保留最近一段时间的记录，且不进入导出和备份。';

export default function RequestDebugView({ messageLabel, records, onClose }: { messageLabel: string; records: RequestRecord[]; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="attachment-viewer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="attachment-viewer-window" role="dialog" aria-modal="true" aria-label="查看请求详情">
        <header className="attachment-viewer-header">
          <div className="attachment-viewer-title"><FileJson size={16}/><span title={messageLabel}>请求详情 · {records.length} 次 · {messageLabel}</span></div>
          <button className="icon-button" aria-label="关闭请求详情" title="关闭" onClick={onClose}><X size={16}/></button>
        </header>
        <div className="attachment-viewer-markdown-layout">
          <div className="attachment-viewer-markdown debug-view">
            {records.length ? records.map(recordView) : <Markdown text={EMPTY_HINT}/>}
          </div>
        </div>
      </section>
    </div>, document.body
  );
}
