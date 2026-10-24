import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentBase64, attachmentKind, canSendNative, convertUnsupportedAttachments, findAttachment, markdownForUnsupported } from '../electron/attachments';
import { decodeQuotedPrintable, mhtmlToHtml } from '../electron/html';
import type { Attachment, Message, Model, Protocol } from '../src/types';
import { addMessage, createConversation, initialState } from '../src/domain';

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
  // 返回值是「实际转换了几个」，调用方靠它决定要不要补一次状态广播。
  assert.equal(await convertUnsupportedAttachments(messages, 'chat', model('chat')), 1, '纯文本也算一次转换');
  assert.equal(messages[0].attachments[0].markdown, '纯文本内容');
  assert.equal(await convertUnsupportedAttachments(messages, 'chat', model('chat')), 0, '已转换过的不会再转，也就不会重复广播');
  assert.equal(messages[0].attachments[0].markdown, '纯文本内容');
  const missing = attachment('broken.docx', 'application/msword', '');
  await assert.rejects(convertUnsupportedAttachments([message([missing])], 'chat', model('chat')), /文件内容不可用/);
  assert.equal(attachmentBase64(attachment('a.png', 'image/png')), 'AA==');
  assert.equal(attachmentBase64(attachment('a.png', 'image/png', 'not-a-data-url')), '');
});

test('an attachment can be located by id for the renderer to fetch', () => {
  const image = attachment('a.png', 'image/png');
  const state = initialState();
  const conversation = createConversation(state.settings);
  addMessage(conversation, conversation.branches[0], 'user', '看图').attachments = [image];
  conversation.branches[0].draftAttachments = [{ ...attachment('draft.pdf', 'application/pdf'), id: 'd1d1d1d1-d1d1-d1d1-d1d1-d1d1d1d1d1d1' }];
  state.conversations = [conversation];
  assert.equal(findAttachment(state, image.id)?.name, 'a.png', '消息附件要能找到');
  const draft = conversation.branches[0].draftAttachments[0];
  assert.equal(findAttachment(state, draft.id)?.name, 'draft.pdf', '草稿附件也要能找到');
  assert.equal(findAttachment(state, 'ffffffff-ffff-ffff-ffff-ffffffffffff'), undefined);
});

// ---- MHTML / HTML 附件 ----
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');
const qp = (text: string) => Buffer.from(text, 'utf8').toString('latin1').replace(/[^\x20-\x7e\r\n]/g, c => '=' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));

function mhtml(parts: { headers: string; body: string }[]) {
  const boundary = '----MultipartBoundary--fixture';
  const head = ['MIME-Version: 1.0', `Content-Type: multipart/related; type="text/html"; boundary="${boundary}"`, 'Snapshot-Content-Location: https://example.com/page', '', ''].join('\r\n');
  return head + parts.map(part => `--${boundary}\r\n${part.headers}\r\n\r\n${part.body}\r\n`).join('') + `--${boundary}--\r\n`;
}

test('MHTML decoding picks the snapshot frame and honours quoted-printable and charsets', () => {
  const source = mhtml([
    { headers: 'Content-Type: text/html\r\nContent-Location: https://example.com/frame\r\nContent-Transfer-Encoding: quoted-printable', body: qp('<html><body>子帧</body></html>') },
    { headers: 'Content-Type: text/html; charset=utf-8\r\nContent-Location: https://example.com/page\r\nContent-Transfer-Encoding: base64', body: b64('<html><body>主文档</body></html>') }
  ]);
  assert.match(mhtmlToHtml(Buffer.from(source, 'latin1')), /主文档/, '应挑与快照地址一致的那一帧');
  // 没有快照头时退回“最大的那份”。
  const noSnapshot = source.replace('Snapshot-Content-Location: https://example.com/page\r\n', '');
  assert.match(mhtmlToHtml(Buffer.from(noSnapshot, 'latin1')), /主文档/);
  // 软换行与 =XX 转义都要解开。
  assert.equal(decodeQuotedPrintable(Buffer.from('a=\r\nb=E4=B8=AD', 'latin1')).toString('utf8'), 'ab中');
  assert.throws(() => mhtmlToHtml(Buffer.from('not mhtml at all', 'latin1')), /boundary/);
});

test('HTML and MHTML attachments are simplified to Markdown, falling back to the source', async () => {
  const html = '<html><head><title>标题</title><style>.a{color:red}</style></head><body><nav>导航</nav><article><h1>正文标题</h1><p>这是正文段落，足够长以便抽取，再补一些字。</p></article><footer>页脚</footer></body></html>';
  const htmlAttachment = attachment('说明.html', 'text/html', `data:text/html;base64,${b64(html)}`);
  const messages = [message([htmlAttachment])];
  await convertUnsupportedAttachments(messages, 'chat', model('chat'));
  const converted = messages[0].attachments[0].markdown || '';
  assert.match(converted, /正文标题/, '应保留正文');
  assert.match(converted, /正文段落/);
  assert.doesNotMatch(converted, /<style>|<nav>|页脚/, '应剥掉样式、导航与页脚');

  // 正文只在 script 里时 Defuddle 抽不到东西，必须退回原文而不是给出空白。
  const spa = '<html><head><title>SPA</title></head><body><div id="root"></div><script>window.__DATA__="正文在这里";</script></body></html>';
  const spaMessages = [message([attachment('spa.html', 'text/html', `data:text/html;base64,${b64(spa)}`)])];
  await convertUnsupportedAttachments(spaMessages, 'chat', model('chat'));
  assert.match(spaMessages[0].attachments[0].markdown || '', /window\.__DATA__/, '抽不到正文时退回原文');

  // MHTML 走同一条路：先还原成 HTML，再精简。
  const source = mhtml([{ headers: 'Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64', body: b64(html) }]);
  const mhtmlMessages = [message([attachment('存档.mhtml', 'multipart/related', `data:multipart/related;base64,${Buffer.from(source, 'latin1').toString('base64')}`)])];
  await convertUnsupportedAttachments(mhtmlMessages, 'chat', model('chat'));
  assert.match(mhtmlMessages[0].attachments[0].markdown || '', /正文标题/);
});

test('a plain HTML file misnamed as .mhtml still converts instead of failing', async () => {
  const html = '<html><body><article><h1>正文标题</h1><p>这是被误存成 mhtml 的普通网页，段落要够长才能抽出。</p></article></body></html>';
  const messages = [message([attachment('错名.mhtml', 'multipart/related', `data:multipart/related;base64,${b64(html)}`)])];
  await convertUnsupportedAttachments(messages, 'chat', model('chat'));
  const markdown = messages[0].attachments[0].markdown || '';
  assert.match(markdown, /被误存成 mhtml 的普通网页/, '扩展名写错时应按 HTML 处理');
  assert.doesNotMatch(markdown, /<article>|<p>/, '应按 HTML 精简而不是原样搬运标签');
});
