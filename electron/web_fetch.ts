import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';

export interface FetchedPage { url: string; title: string; content: string; contentType: string; truncated: boolean }
export type PageFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<string[]>;

const ACCEPT = 'text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.8, text/plain;q=0.7, application/json;q=0.6, */*;q=0.3';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CONTENT_CHARS = 20_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function ipv4Number(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  const parts = address.split('.').map(Number);
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}
function ipv4IsPublic(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) return false;
  const ranges: Array<[number, number]> = [
    [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
    [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
    [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
    [0xcb007100, 24], [0xe0000000, 4]
  ];
  return !ranges.some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)));
}
function ipv6IsPublic(address: string): boolean {
  const value = address.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (value.startsWith('::ffff:')) {
    const mapped = value.slice(7);
    if (mapped.includes('.')) return ipv4IsPublic(mapped);
    const groups = mapped.split(':');
    if (groups.length === 2) {
      const a = Number.parseInt(groups[0], 16), b = Number.parseInt(groups[1], 16);
      if (Number.isFinite(a) && Number.isFinite(b)) return ipv4IsPublic(`${a >>> 8}.${a & 255}.${b >>> 8}.${b & 255}`);
    }
    return false;
  }
  const first = Number.parseInt(value.split(':')[0] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && !value.startsWith('2001:db8:') && !value.startsWith('2001:0:') && !value.startsWith('2002:');
}
async function resolveAddresses(hostname: string) {
  return (await lookup(hostname, { all: true, verbatim: true })).map(record => record.address);
}
async function safeUrl(input: string, resolver: HostResolver): Promise<URL> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error('web_fetch URL 格式无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('web_fetch 只支持 HTTP 或 HTTPS 网页');
  if (url.username || url.password) throw new Error('web_fetch 不支持包含账号或密码的 URL');
  url.hash = '';
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal') || hostname.endsWith('.home.arpa')) throw new Error('web_fetch 只允许访问公网网页');
  const version = isIP(hostname);
  if (version === 4 && !ipv4IsPublic(hostname) || version === 6 && !ipv6IsPublic(hostname)) throw new Error('web_fetch 只允许访问公网网页');
  if (!version) {
    let addresses: string[];
    try { addresses = await resolver(hostname); } catch { throw new Error('无法解析网页域名'); }
    if (!addresses.length || addresses.some(address => isIP(address) === 4 ? !ipv4IsPublic(address) : !ipv6IsPublic(address))) throw new Error('web_fetch 只允许访问解析到公网地址的网页');
  }
  return url;
}
function decoderFor(response: Response) {
  const charset = response.headers.get('content-type')?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  try { return new TextDecoder(charset || 'utf-8'); } catch { return new TextDecoder('utf-8'); }
}
async function readBody(response: Response): Promise<string> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error('网页内容超过 2 MB 限制');
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = decoderFor(response);
  let total = 0, text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('网页内容超过 2 MB 限制'); }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { reader.releaseLock(); }
}
function trimContent(content: string) {
  const clean = content.trim();
  return { content: clean.length > MAX_CONTENT_CHARS ? `${clean.slice(0, MAX_CONTENT_CHARS)}\n\n[内容已截断]` : clean, truncated: clean.length > MAX_CONTENT_CHARS };
}

export async function fetchWebPage(input: string, signal: AbortSignal, fetcher: PageFetcher, resolver: HostResolver = resolveAddresses): Promise<FetchedPage> {
  const timeout = AbortSignal.timeout(30_000), requestSignal = AbortSignal.any([signal, timeout]);
  let url = await safeUrl(input, resolver), response: Response | undefined;
  for (let redirects = 0; redirects <= 5; redirects++) {
    response = await fetcher(url.href, { method: 'GET', headers: { Accept: ACCEPT }, redirect: 'manual', signal: requestSignal });
    if (!REDIRECTS.has(response.status)) break;
    const location = response.headers.get('location');
    if (!location || redirects === 5) throw new Error('web_fetch 重定向次数超过限制');
    const next = await safeUrl(new URL(location, url).href, resolver);
    if (url.protocol === 'https:' && next.protocol === 'http:') throw new Error('web_fetch 拒绝从 HTTPS 降级到 HTTP');
    await response.body?.cancel();
    url = next;
  }
  if (!response) throw new Error('web_fetch 没有收到网页响应');
  if (!response.ok) throw new Error(`网页请求失败 (${response.status})`);
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const source = await readBody(response);
  if (!source.trim()) throw new Error('网页没有返回可读取内容');
  let title = url.hostname, content: string;
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml' || (!contentType && /^\s*<!doctype html|^\s*<html[\s>]/i.test(source))) {
    const { document } = parseHTML(source);
    const result = await Defuddle(document, url.href, { markdown: true, useAsync: false });
    title = String(result.title || document.title || title).trim();
    content = String(result.content || '').trim();
    if (!content) throw new Error('Defuddle 未能从网页提取正文');
  } else if (contentType === 'application/json' || contentType.endsWith('+json')) {
    let formatted = source;
    try { formatted = JSON.stringify(JSON.parse(source), null, 2); } catch { /* keep the server's text response */ }
    content = `\`\`\`json\n${formatted}\n\`\`\``;
  } else if (contentType.startsWith('text/') || !contentType) content = source;
  else throw new Error(`web_fetch 不支持此内容类型：${contentType}`);
  const trimmed = trimContent(content);
  return { url: url.href, title: title || url.hostname, content: trimmed.content, contentType: contentType || 'text/plain', truncated: trimmed.truncated };
}
