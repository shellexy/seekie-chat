import { useEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { Minus, Paperclip, Plus, RotateCcw, X } from 'lucide-react';
import type { Attachment } from './types';
import Markdown from './Markdown';

export default function AttachmentViewer({ attachment, onClose }: { attachment: Attachment | null; onClose: () => void }) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 });
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const isImage = !!attachment?.mime.startsWith('image/');

  useEffect(() => {
    if (!attachment) return;
    const keydown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [attachment, onClose]);
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
    drag.current = null;
  }, [attachment?.id]);

  if (!attachment) return null;

  function zoom(factor: number) {
    setView(current => {
      const scale = Math.max(0.25, Math.min(8, current.scale * factor)), ratio = scale / current.scale;
      return { scale, x: scale <= 1 ? 0 : current.x * ratio, y: scale <= 1 ? 0 : current.y * ratio };
    });
  }

  function onWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!isImage) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const centerX = event.clientX - rect.left - rect.width / 2;
    const centerY = event.clientY - rect.top - rect.height / 2;
    const factor = Math.exp(-event.deltaY * 0.0015);
    setView(current => {
      const scale = Math.max(0.25, Math.min(8, current.scale * factor)), ratio = scale / current.scale;
      if (scale <= 1) return { scale, x: 0, y: 0 };
      return { scale, x: centerX - (centerX - current.x) * ratio, y: centerY - (centerY - current.y) * ratio };
    });
  }

  return createPortal(
    <div className="attachment-viewer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="attachment-viewer-window" role="dialog" aria-modal="true" aria-label={`查看附件：${attachment.name}`}>
        <header className="attachment-viewer-header">
          <div className="attachment-viewer-title"><Paperclip size={16}/><span title={attachment.name}>{attachment.name}</span></div>
          {isImage && <div className="attachment-viewer-zoom" aria-label="图片缩放">
            <button type="button" title="缩小" aria-label="缩小图片" onClick={() => zoom(1 / 1.2)}><Minus size={15}/></button>
            <span>{Math.round(view.scale * 100)}%</span>
            <button type="button" title="放大" aria-label="放大图片" onClick={() => zoom(1.2)}><Plus size={15}/></button>
            <button type="button" title="重置缩放" aria-label="重置图片缩放" onClick={() => setView({ scale: 1, x: 0, y: 0 })}><RotateCcw size={14}/></button>
          </div>}
          <button type="button" className="icon-button attachment-viewer-close" aria-label="关闭附件预览" title="关闭" onClick={onClose}><X size={19}/></button>
        </header>
        <div
          className={`attachment-viewer-content ${isImage ? 'image-viewer-content' : ''} ${isImage && view.scale > 1 ? 'zoomed' : ''}`}
          onWheel={onWheel}
          onPointerDown={event => {
            if (!isImage || view.scale <= 1 || event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = { pointerId: event.pointerId, x: event.clientX - view.x, y: event.clientY - view.y };
          }}
          onPointerMove={event => {
            const current = drag.current;
            if (current?.pointerId === event.pointerId) setView(value => ({ ...value, x: event.clientX - current.x, y: event.clientY - current.y }));
          }}
          onPointerUp={event => {
            drag.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          }}
          onPointerCancel={() => { drag.current = null; }}
        >
          {isImage ? <img className="attachment-viewer-image" src={attachment.data} alt={attachment.name} draggable={false} style={{ transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}/>
            : attachment.markdown ? <div className="attachment-viewer-markdown"><Markdown text={attachment.markdown}/></div>
            : attachment.mime === 'application/pdf' ? <iframe className="attachment-viewer-frame" src={attachment.data} title={attachment.name}/>
            : attachment.mime.startsWith('video/') ? <video className="attachment-viewer-media" src={attachment.data} controls/>
            : attachment.mime.startsWith('audio/') ? <audio className="attachment-viewer-audio" src={attachment.data} controls/>
            : <div className="attachment-viewer-download"><p>此附件类型无法在窗口中直接预览。</p><a href={attachment.data} download={attachment.name}>下载 {attachment.name}</a></div>}
        </div>
      </section>
    </div>, document.body
  );
}
