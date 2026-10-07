import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentBase64, attachmentKind, canSendNative, convertUnsupportedAttachments, markdownForUnsupported } from '../electron/attachments';
import type { Attachment, Message, Model, Protocol } from '../src/types';

const attachment = (name: string, mime: string, data = `data:${mime};base64,AA==`): Attachment => ({ id: 'a1', name, mime, size: 4, data });
const model = (protocol: Protocol | string, overrides: Partial<Model> = {}): Model => ({
  id: 'm', connectionId: 'c', name: 'fixture', model: 'fixture', contextWindow: 1000, maxOutput: 100,
  vision: false, tools: false, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true, ...overrides
});
const message = (attachments: Attachment[]): Message => ({ id: 'm1', parentId: null, role: 'user', text: '', reasoning: '', attachments, tools: [], sources: [], status: 'complete', created: 0 });

test('attachment kinds and native capabilities follow the protocol and model flags', () => {
  assert.equal(attachmentKind({ mime: 'image/png', name: 'a.png' }), 'image');
  assert.equal(attachmentKind({ mime: 'application/octet-stream', name: '报告.PDF' }), 'pdf');
  assert.equal(attachmentKind({ mime: 'video/mp4', name: 'v.mp4' }), 'video');
  assert.equal(attachmentKind({ mime: 'audio/mpeg', name: 'a.mp3' }), 'audio');
  assert.equal(attachmentKind({ mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'd.docx' }), 'document');
  // Images need the vision flag, PDFs the pdfInput flag, and video/audio only work on protocols that accept them.
  assert.equal(canSendNative('chat', model('chat'), attachment('a.png', 'image/png')), false);
  assert.equal(canSendNative('chat', model('chat', { vision: true }), attachment('a.png', 'image/png')), true);
  assert.equal(canSendNative('chat', model('chat', { pdfInput: true }), attachment('a.pdf', 'application/pdf')), true);
  assert.equal(canSendNative('chat', model('chat', { videoInput: true }), attachment('v.mp4', 'video/mp4')), true);
  assert.equal(canSendNative('anthropic', model('anthropic', { videoInput: true }), attachment('v.mp4', 'video/mp4')), false, 'Anthropic 不支持视频输入');
  assert.equal(canSendNative('gemini', model('gemini', { videoInput: true }), attachment('v.mp4', 'video/mp4')), true);
  assert.equal(canSendNative('responses', model('responses', { audioInput: true }), attachment('a.mp3', 'audio/mpeg')), true);
  assert.equal(canSendNative('responses', model('responses', { audioInput: true }), attachment('a.wav', 'audio/wav')), true);
  assert.equal(canSendNative('chat', model('chat', { audioInput: true }), attachment('a.flac', 'audio/flac')), false, 'chat/responses 只接受 mp3 与 wav');
  assert.equal(canSendNative('gemini', model('gemini', { audioInput: true }), attachment('a.flac', 'audio/flac')), true, 'Gemini 接受任意音频格式');
  assert.equal(canSendNative('chat', model('chat'), attachment('d.docx', 'application/msword')), false);
  assert.equal(canSendNative('chat', undefined, attachment('a.png', 'image/png')), true, '没有模型信息时按图片处理');
});

test('only the converted Markdown is sent for attachments the model cannot read natively', async () => {
  const converted = { ...attachment('d.docx', 'application/msword'), markdown: '# 转换后的正文' };
  assert.equal(markdownForUnsupported(converted, 'chat', model('chat')), '# 转换后的正文');
  assert.equal(markdownForUnsupported(converted, 'chat', model('chat', { vision: true })), '# 转换后的正文', '文档始终走 Markdown');
  const image = { ...attachment('a.png', 'image/png'), markdown: '# 不该用' };
  assert.equal(markdownForUnsupported(image, 'chat', model('chat', { vision: true })), '', '可原生发送的图片不使用 Markdown');
  // A plain text file needs no converter, and conversion must not run twice.
  const plain = attachment('notes.txt', 'text/plain', `data:text/plain;base64,${Buffer.from('纯文本内容').toString('base64')}`);
  const messages = [message([plain])];
  await convertUnsupportedAttachments(messages, 'chat', model('chat'));
  assert.equal(messages[0].attachments[0].markdown, '纯文本内容');
  await convertUnsupportedAttachments(messages, 'chat', model('chat'));
  assert.equal(messages[0].attachments[0].markdown, '纯文本内容');
  const missing = attachment('broken.docx', 'application/msword', '');
  await assert.rejects(convertUnsupportedAttachments([message([missing])], 'chat', model('chat')), /文件内容不可用/);
  assert.equal(attachmentBase64(attachment('a.png', 'image/png')), 'AA==');
  assert.equal(attachmentBase64(attachment('a.png', 'image/png', 'not-a-data-url')), '');
});
