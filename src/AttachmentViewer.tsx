import { useEffect, useLayoutEffect, useRef, useState, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, FlipHorizontal, FlipVertical, Minus, Paperclip, Plus, RotateCcw, RotateCw, Save, X } from 'lucide-react';
import { useAttachmentPayload } from './attachment_cache';
import type { Attachment } from './types';
import Markdown from './Markdown';

type ImageView = { scale: number; x: number; y: number; rotation: number; flipX: boolean; flipY: boolean };
type MarkdownHeading = { id: string; title: string; level: number };
const initialImageView: ImageView = { scale: 1, x: 0, y: 0, rotation: 0, flipX: false, flipY: false };

export default function AttachmentViewer({ attachment, onClose, onNotice }: { attachment: Attachment | null; onClose: () => void; onNotice?: (message: string) => void }) {
  const [view, setView] = useState<ImageView>(initialImageView);
  const [imageViewportSize, setImageViewportSize] = useState({ width: 0, height: 0 });
  const [markdownHeadings, setMarkdownHeadings] = useState<MarkdownHeading[]>([]), [activeHeading, setActiveHeading] = useState('');
  const imageViewport = useRef<HTMLDivElement>(null), markdownContent = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const isImage = !!attachment?.mime.startsWith('image/');
  const isMarkdown = !!attachment?.markdown;

  useEffect(() => {
    if (!attachment) return;
    const keydown = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [attachment, onClose]);

  useEffect(() => {
    setView(initialImageView);
    drag.current = null;
  }, [attachment?.id]);

  useLayoutEffect(() => {
    if (!isImage || !imageViewport.current) return;
    const element = imageViewport.current;
    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setImageViewportSize({ width: rect.width, height: rect.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [attachment?.id, isImage]);

  useLayoutEffect(() => {
    const container = markdownContent.current;
    if (!isMarkdown || !container) { setMarkdownHeadings([]); setActiveHeading(''); return; }
    const elements = [...container.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')];
    const headings = elements.map((element, index) => {
      const id = `attachment-heading-${index}`;
      element.id = id;
      return { id, title: element.textContent?.trim() || `标题 ${index + 1}`, level: Number(element.tagName.slice(1)) };
    });
    setMarkdownHeadings(headings);
    setActiveHeading(headings[0]?.id || '');
  }, [attachment?.id, attachment?.markdown, isMarkdown]);

  // Hooks must run on every render, so the payload request happens before the early return.
  const payload = useAttachmentPayload(attachment);
  if (!attachment) return null;
  const currentAttachment = attachment;

  const rotation = ((view.rotation % 360) + 360) % 360;
  const swapsImageAxes = rotation === 90 || rotation === 270;
  const imageWidth = swapsImageAxes ? imageViewportSize.height : imageViewportSize.width;
  const imageHeight = swapsImageAxes ? imageViewportSize.width : imageViewportSize.height;
  const imageTransform = `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.flipX ? -1 : 1}, ${view.flipY ? -1 : 1}) rotate(${rotation}deg) scale(${view.scale})`;

  function zoom(factor: number) {
    setView(current => {
      const scale = Math.max(0.25, Math.min(8, current.scale * factor)), ratio = scale / current.scale;
      return { ...current, scale, x: scale <= 1 ? 0 : current.x * ratio, y: scale <= 1 ? 0 : current.y * ratio };
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
      if (scale <= 1) return { ...current, scale, x: 0, y: 0 };
      return { ...current, scale, x: centerX - (centerX - current.x) * ratio, y: centerY - (centerY - current.y) * ratio };
    });
  }

  function rotateImage(degrees: number) {
    setView(current => ({ ...current, rotation: (current.rotation + degrees + 360) % 360, x: 0, y: 0 }));
  }

  async function transformedImage() {
    const image = new Image();
    image.src = payload;
    await image.decode();
    const outputWidth = swapsImageAxes ? image.naturalHeight : image.naturalWidth;
    const outputHeight = swapsImageAxes ? image.naturalWidth : image.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = outputWidth; canvas.height = outputHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法准备图片');
    context.translate(outputWidth / 2, outputHeight / 2);
    context.scale(view.flipX ? -1 : 1, view.flipY ? -1 : 1);
    context.rotate(rotation * Math.PI / 180);
    context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
    // 复制与保存都用 WebP：附件本身多半已经是 WebP，再压回 PNG 会把体积优势全丢掉。
    const mime = 'image/webp';
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('无法导出图片')), mime, 0.92));
  }

  async function copyImage() {
    try {
      const blob = await transformedImage();
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('当前环境不支持复制图片');
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      onNotice?.('图片已复制');
    } catch (error) { onNotice?.(`复制图片失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  async function saveImage() {
    try {
      const blob = await transformedImage();
      const extension = blob.type === 'image/webp' ? 'webp' : 'jpg';
      const basename = currentAttachment.name.replace(/\.[^.]*$/, '') || currentAttachment.name;
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `${basename}.${extension}`; document.body.append(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1500);
    } catch (error) { onNotice?.(`保存图片失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  function updateActiveHeading(event: React.UIEvent<HTMLDivElement>) {
    if (!markdownHeadings.length) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const elements = markdownHeadings.map(heading => document.getElementById(heading.id)).filter((element): element is HTMLElement => !!element);
    const visible = elements.filter(element => element.getBoundingClientRect().top < bounds.top + 72);
    setActiveHeading(visible.at(-1)?.id || elements[0]?.id || '');
  }

  return createPortal(
    <div className="attachment-viewer-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="attachment-viewer-window" role="dialog" aria-modal="true" aria-label={`查看附件：${attachment.name}`}>
        <header className="attachment-viewer-header">
          <div className="attachment-viewer-title"><Paperclip size={16}/><span title={attachment.name}>{attachment.name}</span></div>
          {isImage && <div className="attachment-viewer-image-actions" aria-label="图片操作">
            <button type="button" title="向左旋转" aria-label="向左旋转" onClick={() => rotateImage(-90)}><RotateCcw size={16}/></button>
            <button type="button" title="向右旋转" aria-label="向右旋转" onClick={() => rotateImage(90)}><RotateCw size={16}/></button>
            <button type="button" title="水平翻转" aria-label="水平翻转" onClick={() => setView(current => ({ ...current, flipX: !current.flipX, x: 0, y: 0 }))}><FlipHorizontal size={16}/></button>
            <button type="button" title="垂直翻转" aria-label="垂直翻转" onClick={() => setView(current => ({ ...current, flipY: !current.flipY, x: 0, y: 0 }))}><FlipVertical size={16}/></button>
            <button type="button" title="复制图片" aria-label="复制图片" onClick={() => void copyImage()}><Copy size={16}/></button>
            <button type="button" title="保存图片" aria-label="保存图片" onClick={() => void saveImage()}><Save size={16}/></button>
          </div>}
          {isImage && <div className="attachment-viewer-zoom" aria-label="图片缩放">
            <button type="button" title="缩小" aria-label="缩小图片" onClick={() => zoom(1 / 1.2)}><Minus size={15}/></button>
            <span>{Math.round(view.scale * 100)}%</span>
            <button type="button" title="放大" aria-label="放大图片" onClick={() => zoom(1.2)}><Plus size={15}/></button>
            <button type="button" title="重置缩放" aria-label="重置图片缩放" onClick={() => setView(initialImageView)}><RotateCcw size={14}/></button>
          </div>}
          <button type="button" className="icon-button attachment-viewer-close" aria-label="关闭附件预览" title="关闭" onClick={onClose}><X size={19}/></button>
        </header>
        <div
          ref={imageViewport}
          className={`attachment-viewer-content ${isImage ? 'image-viewer-content' : ''} ${isImage && view.scale > 1 ? 'zoomed' : ''} ${attachment.mime.startsWith('video/') ? 'video-viewer-content' : ''}`}
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
          {isImage ? <img className="attachment-viewer-image" src={payload} alt={attachment.name} draggable={false} style={{ width: imageWidth ? `${imageWidth}px` : '100%', height: imageHeight ? `${imageHeight}px` : '100%', transform: imageTransform }}/>
            : attachment.markdown ? <div className={`attachment-viewer-markdown-layout${markdownHeadings.length ? ' has-outline' : ''}`}>
              {markdownHeadings.length > 0 && <aside className="attachment-viewer-outline" aria-label="Markdown 大纲"><h3>大纲</h3>{markdownHeadings.map(heading => <button key={heading.id} type="button" className={activeHeading === heading.id ? 'active' : ''} style={{ paddingInlineStart: `${8 + (heading.level - 1) * 10}px` }} title={heading.title} onClick={() => { document.getElementById(heading.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); setActiveHeading(heading.id); }}>{heading.title}</button>)}</aside>}
              <div className="attachment-viewer-markdown" ref={markdownContent} onScroll={updateActiveHeading}><Markdown text={attachment.markdown}/></div>
            </div>
            : attachment.mime === 'application/pdf' ? <iframe className="attachment-viewer-frame" src={payload} title={attachment.name}/>
            : attachment.mime.startsWith('video/') ? <video className="attachment-viewer-media" src={payload} controls preload="metadata"/>
            : attachment.mime.startsWith('audio/') ? <audio className="attachment-viewer-audio" src={payload} controls preload="metadata"/>
            : <div className="attachment-viewer-download"><p>此附件类型无法在窗口中直接预览。</p><a href={payload} download={attachment.name}>下载 {attachment.name}</a></div>}
        </div>
      </section>
    </div>, document.body
  );
}
