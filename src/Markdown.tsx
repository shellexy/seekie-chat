import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { api } from './api';
function Markdown({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeHighlight, { detect: false }]]} components={{
    a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//.test(href)) void api.openExternal(href); }}>{children}</a>,
    img: ({ alt }) => <span className="muted">[图片：{alt || '远程图片'}]</span>,
    pre: ({ children }) => <div className="code-wrap"><button className="code-copy" onClick={e => { const text = e.currentTarget.parentElement?.querySelector('code')?.textContent || ''; void navigator.clipboard.writeText(text); e.currentTarget.textContent = '已复制'; }}>复制代码</button><pre>{children}</pre></div>
  }}>{text}</ReactMarkdown>;
}
// Only the text prop matters, so an unchanged message never re-runs the Markdown pipeline.
export default memo(Markdown);
