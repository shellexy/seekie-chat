import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';

/** 把一段 HTML 抽成正文 Markdown。抽不到正文时 content 为空串，由调用方决定是否退回原文。 */
export async function htmlToMarkdown(source: string, url: string) {
  const { document } = parseHTML(source);
  const result = await Defuddle(document, url, { markdown: true, useAsync: false });
  return { title: String(result.title || document.title || '').trim(), content: String(result.content || '').trim() };
}

const QUOTED_PRINTABLE_ESCAPE = 0x3d; // =
const CR = 0x0d;
const LF = 0x0a;

/**
 * 解开 quoted-printable。按字节处理而不是按字符串：8bit 部分里的中文是原始字节，
 * 先当 latin1 读进来、再原样还原，才不会在解码前就被 UTF-8 解释坏。
 */
export function decodeQuotedPrintable(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length);
  let written = 0;
  for (let index = 0; index < input.length; index++) {
    const byte = input[index];
    if (byte === QUOTED_PRINTABLE_ESCAPE) {
      // 软换行：`=` 后面直接跟行尾，表示这一行还没结束。
      if (input[index + 1] === CR && input[index + 2] === LF) { index += 2; continue; }
      if (input[index + 1] === LF) { index += 1; continue; }
      const hex = String.fromCharCode(input[index + 1] ?? 0x30, input[index + 2] ?? 0x30);
      const value = Number.parseInt(hex, 16);
      if (!Number.isNaN(value)) { out[written++] = value; index += 2; continue; }
    }
    out[written++] = byte;
  }
  return out.subarray(0, written);
}

function decodeBytes(bytes: Buffer, headers: Record<string, string>): string {
  const encoding = (headers['content-transfer-encoding'] || '').trim().toLowerCase();
  let payload = bytes;
  if (encoding === 'base64') payload = Buffer.from(bytes.toString('latin1').replace(/\s+/g, ''), 'base64');
  else if (encoding === 'quoted-printable') payload = decodeQuotedPrintable(bytes);
  const charset = /charset="?([^";\r\n]+)"?/i.exec(headers['content-type'] || '')?.[1]?.trim();
  if (charset) {
    try { return new TextDecoder(charset, { fatal: false }).decode(payload); }
    catch { /* 不认识的编码就按 UTF-8 试，总比直接失败好 */ }
  }
  return payload.toString('utf8');
}

/** 把一段头文本解析成小写键的字典，顺带展开折行（续行以空白开头）。 */
function parseHeaders(source: string): Record<string, string> {
  const headers: Record<string, string> = {};
  let current = '';
  const merged = source.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of merged.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    current = line.slice(0, colon).trim().toLowerCase();
    headers[current] = line.slice(colon + 1).trim();
  }
  return headers;
}

/**
 * 从 MHTML（`multipart/related`，Chrome / Firefox / Edge 的“另存为单个文件”格式）里取出主体 HTML。
 *
 * 只做取正文需要的事：按 boundary 切分、解 transfer-encoding、按声明的 charset 解码。
 * `cid:` 引用的图片不解析——正文转 Markdown 时本来也不保留内嵌图片，省下这一步也不影响结果。
 */
export function mhtmlToHtml(buffer: Buffer): string {
  // 1 个字符 = 1 个字节：后面的 transfer-encoding 都是 ASCII，8bit 部分的原始字节也能原样还原。
  const raw = buffer.toString('latin1');
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const top = parseHeaders(headerEnd < 0 ? raw.slice(0, 4096) : raw.slice(0, headerEnd));
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(top['content-type'] || '')?.[1]?.trim();
  if (!boundary) throw new Error('不是 MHTML：找不到 multipart boundary');

  const snapshot = top['snapshot-content-location'] || top['x-webkit-location'] || '';
  const candidates: { html: string; location: string; length: number }[] = [];
  for (const chunk of raw.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith('--')) break; // 结束分隔符
    const partHeaderEnd = chunk.search(/\r?\n\r?\n/);
    if (partHeaderEnd < 0) continue;
    const headers = parseHeaders(chunk.slice(0, partHeaderEnd));
    const type = (headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (type !== 'text/html') continue;
    const body = chunk.slice(partHeaderEnd).replace(/^\r?\n\r?\n/, '');
    const bytes = Buffer.from(body, 'latin1');
    candidates.push({ html: decodeBytes(bytes, headers), location: headers['content-location'] || '', length: bytes.length });
  }
  if (!candidates.length) throw new Error('MHTML 里没有 text/html 部分');
  // 优先取与快照地址一致的那一帧；对不上就取最大的一份——主文档通常就是最大的那个。
  const main = (snapshot && candidates.find(candidate => candidate.location === snapshot)) || candidates.reduce((a, b) => (b.length > a.length ? b : a));
  return main.html;
}
