import { formatFromExtension, toMarkdownBytes } from '@firecrawl/anydoc';
import { extname } from 'node:path';
import { htmlToMarkdown, mhtmlToHtml } from './html';
import type { AppState, Attachment, Message, Model, Protocol } from '../src/types';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'document';

export function attachmentKind(attachment: Pick<Attachment, 'mime' | 'name'>): AttachmentKind {
  const mime = attachment.mime.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf')) return 'pdf';
  return 'document';
}

/** Locates one attachment by id, whether it belongs to a message or to a branch draft. */
export function findAttachment(state: AppState, id: string): Attachment | undefined {
  for (const conversation of state.conversations) {
    for (const message of conversation.messages) for (const attachment of message.attachments) if (attachment.id === id) return attachment;
    for (const branch of conversation.branches) for (const attachment of branch.draftAttachments) if (attachment.id === id) return attachment;
  }
  return undefined;
}
export function attachmentBase64(attachment: Pick<Attachment, 'data'>) {
  return /^data:[^;,]+;base64,(.*)$/s.exec(attachment.data || '')?.[1] || '';
}

export function canSendNative(protocol: Protocol | string, model: Model | undefined, attachment: Pick<Attachment, 'mime' | 'name'>) {
  if (!model) return attachmentKind(attachment) === 'image';
  const kind = attachmentKind(attachment);
  if (kind === 'image') return model.vision;
  if (kind === 'pdf') return !!model.pdfInput;
  if (kind === 'video') return !!model.videoInput && (protocol === 'gemini' || protocol === 'chat');
  if (kind === 'audio') {
    const format = extname(attachment.name).slice(1).toLowerCase();
    return !!model.audioInput && (protocol === 'gemini' || protocol === 'chat' || protocol === 'responses') && (protocol === 'gemini' || ['mp3', 'wav'].includes(format));
  }
  return false;
}

export async function convertUnsupportedAttachments(messages: Message[], protocol: Protocol, model: Model) {
  for (const message of messages) for (const attachment of message.attachments) {
    if (canSendNative(protocol, model, attachment) || attachment.markdown) continue;
    const data = attachmentBase64(attachment);
    if (!data) throw new Error(`无法转换附件“${attachment.name}”：文件内容不可用。`);
    const buffer = Buffer.from(data, 'base64');
    const extension = extname(attachment.name).toLowerCase() || (attachment.mime === 'text/csv' ? '.csv' : attachment.mime === 'application/json' ? '.json' : '');
    try {
      // MHTML 先还原成 HTML，再和普通 HTML 走同一条路：两者都不能当纯文本直传，
      // 否则整份标签、样式和脚本都会进请求体。
      const mhtml = ['.mhtml', '.mht'].includes(extension) || /^(multipart\/related|application\/x-mimearchive)/i.test(attachment.mime);
      const html = !mhtml && (attachment.mime === 'text/html' || attachment.mime === 'application/xhtml+xml' || ['.html', '.htm', '.xhtml'].includes(extension));
      const format = !mhtml && !html && extension ? formatFromExtension(extension) : null;
      const plainText = !format && !mhtml && !html && (attachment.mime.startsWith('text/') || ['.json', '.yaml', '.yml', '.log', '.rst', '.xml'].includes(extension));
      let markdown: string;
      if (mhtml || html) {
        let source = buffer.toString('utf8');
        if (mhtml) {
          try { source = mhtmlToHtml(buffer); }
          catch (error) {
            // 扩展名写错的文件（把普通 HTML 存成 .mhtml）不该直接卡住发送：看着像 HTML 就按 HTML 处理。
            if (!/^\s*</.test(source)) throw error;
          }
        }
        // Defuddle 优先：它按网页正文抽取，会丢掉导航、页脚和脚本。抽不到正文时退回原文——
        // 多花 token 也好过把内容整段丢掉（单页应用导出的 HTML，正文就在 script 里）。
        // Defuddle 要一个合法地址来解析相对链接；附件没有 URL，给个永不解析的占位源。
        // 传裸文件名会直接抛 ERR_INVALID_URL，那样每次都会静默退化成原文。
        const base = `https://attachment.invalid/${encodeURIComponent(attachment.name)}`;
        let extracted = '';
        try { extracted = (await htmlToMarkdown(source, base)).content; } catch { /* 抽取失败就退回原文 */ }
        markdown = (extracted.trim() || source).trim();
      } else {
        if (!format && !plainText) throw new Error(extension ? `@firecrawl/anydoc 不支持 ${extension} 格式` : '文件名缺少扩展名，无法识别格式');
        markdown = (plainText ? buffer.toString('utf8') : await toMarkdownBytes(buffer, format)).trim();
      }
      if (!markdown) throw new Error('转换器没有提取到可读内容');
      if (markdown.length > 1_000_000) throw new Error('转换结果超过 1 MB 文本限制');
      attachment.markdown = markdown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`附件“${attachment.name}”不能由当前模型原生读取，也无法转换为 Markdown：${reason.slice(0, 500)}`);
    }
  }
}

export function markdownForUnsupported(attachment: Attachment, protocol: Protocol | string, model?: Model) {
  return canSendNative(protocol, model, attachment) ? '' : attachment.markdown || '';
}
