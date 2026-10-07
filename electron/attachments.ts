import { formatFromExtension, toMarkdownBytes } from '@firecrawl/anydoc';
import { extname } from 'node:path';
import type { Attachment, Message, Model, Protocol } from '../src/types';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'pdf' | 'document';

export function attachmentKind(attachment: Pick<Attachment, 'mime' | 'name'>): AttachmentKind {
  const mime = attachment.mime.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf' || attachment.name.toLowerCase().endsWith('.pdf')) return 'pdf';
  return 'document';
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
      const format = extension ? formatFromExtension(extension) : null;
      const plainText = !format && (attachment.mime.startsWith('text/') || ['.json', '.yaml', '.yml', '.log', '.rst', '.xml'].includes(extension));
      if (!format && !plainText) throw new Error(extension ? `@firecrawl/anydoc 不支持 ${extension} 格式` : '文件名缺少扩展名，无法识别格式');
      const markdown = (plainText ? buffer.toString('utf8') : await toMarkdownBytes(buffer, format)).trim();
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
