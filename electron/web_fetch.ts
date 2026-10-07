import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import { ollamaWebSearchKey } from '../src/domain';
import type { Settings, WebFetchMode } from '../src/types';

export interface FetchedPage { url: string; title: string; content: string; contentType: string; truncated: boolean; provider?: 'exa' | 'ollama' | 'tavily' | 'firecrawl' | 'anysearch' | 'local' }
export type PageFetcher = (url: string, init?: RequestInit) => Promise<Response>;
export type HostResolver = (hostname: string) => Promise<string[]>;
export type WebFetchProvider = Exclude<WebFetchMode, 'auto' | 'off' | 'local'>;

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
export async function validateWebFetchUrl(input: string, resolver: HostResolver = resolveAddresses): Promise<string> {
  return (await safeUrl(input, resolver)).href;
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
async function htmlToMarkdown(source: string, url: string) {
  const { document } = parseHTML(source);
  const result = await Defuddle(document, url, { markdown: true, useAsync: false });
  return { title: String(result.title || document.title || '').trim(), content: String(result.content || '').trim() };
}
function looksLikeHtml(source: string) { return /^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(source); }

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
    const result = await htmlToMarkdown(source, url.href);
    title = result.title || title; content = result.content;
    if (!content) throw new Error('Defuddle 未能从网页提取正文');
  } else if (contentType === 'application/json' || contentType.endsWith('+json')) {
    let formatted = source;
    try { formatted = JSON.stringify(JSON.parse(source), null, 2); } catch { /* keep the server's text response */ }
    content = `\`\`\`json\n${formatted}\n\`\`\``;
  } else if (contentType.startsWith('text/') || !contentType) content = source;
  else throw new Error(`web_fetch 不支持此内容类型：${contentType}`);
  const trimmed = trimContent(content);
  return { url: url.href, title: title || url.hostname, content: trimmed.content, contentType: contentType || 'text/plain', truncated: trimmed.truncated, provider: 'local' };
}

function apiKeyFor(provider: WebFetchProvider, settings: Settings) {
  if (provider === 'exa') return settings.exaKey;
  if (provider === 'ollama') return ollamaWebSearchKey(settings);
  if (provider === 'tavily') return settings.tavilyKey;
  if (provider === 'firecrawl') return settings.firecrawlKey;
  return settings.anysearchKey;
}
function providerUrl(provider: WebFetchProvider) {
  return provider === 'exa' ? 'https://api.exa.ai/contents'
    : provider === 'ollama' ? 'https://ollama.com/api/web_fetch'
      : provider === 'tavily' ? 'https://api.tavily.com/extract'
        : provider === 'firecrawl' ? 'https://api.firecrawl.dev/v2/scrape' : 'https://api.anysearch.com/v1/extract';
}
function providerName(provider: WebFetchProvider) {
  return provider === 'exa' ? 'Exa' : provider === 'ollama' ? 'Ollama Cloud' : provider === 'tavily' ? 'Tavily' : provider === 'firecrawl' ? 'Firecrawl' : 'AnySearch';
}
function providerHeaders(provider: WebFetchProvider, key: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider === 'exa') headers['x-api-key'] = key;
  else if (provider === 'tavily' && !key) headers['X-Tavily-Access-Mode'] = 'keyless';
  else if (key) headers.Authorization = `Bearer ${key}`;
  return headers;
}
async function fetchFromProvider(provider: WebFetchProvider, url: string, key: string, signal: AbortSignal, fetcher: PageFetcher): Promise<FetchedPage> {
  const body = provider === 'exa' ? { urls: [url], text: { maxCharacters: MAX_CONTENT_CHARS } }
    : provider === 'ollama' ? { url }
      : provider === 'tavily' ? { urls: [url], format: 'markdown', extract_depth: 'basic' }
        : provider === 'firecrawl' ? { url, formats: ['markdown'], onlyMainContent: true } : { url };
  const response = await fetcher(providerUrl(provider), {
    method: 'POST', headers: providerHeaders(provider, key), body: JSON.stringify(body), redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)])
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`${providerName(provider)} 读取网页失败 (${response.status})`); }
  let data: any;
  try { data = JSON.parse(await readBody(response)); } catch { throw new Error(`${providerName(provider)} 返回了无效的网页内容`); }
  let title = '', content = '';
  if (provider === 'ollama') {
    title = String(data?.title || ''); content = String(data?.content || '');
  } else if (provider === 'firecrawl') {
    if (data?.success === false) throw new Error('Firecrawl 未能读取网页');
    const pageStatus = Number(data?.data?.metadata?.statusCode);
    if (Number.isFinite(pageStatus) && pageStatus > 0 && !(pageStatus >= 200 && pageStatus < 300) && pageStatus !== 304) throw new Error(`Firecrawl 页面请求失败 (${pageStatus})`);
    title = String(data?.data?.metadata?.title || ''); content = String(data?.data?.markdown || data?.data?.html || '');
  } else if (provider === 'anysearch') {
    if (data?.code !== 0) throw new Error('AnySearch 未能读取网页');
    title = String(data?.data?.title || ''); content = String(data?.data?.content || '');
  } else {
    const result = Array.isArray(data?.results) ? data.results.find((item: any) => !item.url || item.url === url) || data.results[0] : undefined;
    title = String(result?.title || '');
    content = String(provider === 'exa' ? result?.text || '' : result?.raw_content || '');
    if (!content.trim()) {
      const failed = Array.isArray(data?.statuses) ? data.statuses.find((item: any) => item.url === url) : Array.isArray(data?.failed_results) ? data.failed_results.find((item: any) => item.url === url) : undefined;
      throw new Error(String(failed?.error || `${providerName(provider)} 未能提取网页正文`));
    }
  }
  if (!content.trim()) throw new Error(`${providerName(provider)} 未返回网页正文`);
  if ((provider === 'firecrawl' && !data?.data?.markdown) || provider === 'anysearch' && looksLikeHtml(content)) {
    const extracted = await htmlToMarkdown(content, url);
    title = title || extracted.title; content = extracted.content;
  }
  const trimmed = trimContent(content);
  return { url, title: title.trim() || new URL(url).hostname, content: trimmed.content, contentType: 'text/markdown', truncated: trimmed.truncated, provider };
}

/** Uses configured hosted extractors in priority order, then the Electron-backed local fetcher. */
export async function fetchWebPageWithProviders(
  input: string,
  signal: AbortSignal,
  settings: Settings,
  mode: WebFetchMode | undefined,
  localFetcher: PageFetcher,
  apiFetcher: PageFetcher = localFetcher,
  resolver: HostResolver = resolveAddresses
): Promise<FetchedPage> {
  const selected = mode || 'auto';
  if (selected === 'off') throw new Error('读取网页已关闭');
  const url = await validateWebFetchUrl(input, resolver);
  if (selected === 'local') return fetchWebPage(url, signal, localFetcher, resolver);
  const configured: WebFetchProvider[] = selected === 'auto'
    ? [
      ...(['exa', 'ollama', 'tavily', 'firecrawl', 'anysearch'] as const).filter(provider => !!apiKeyFor(provider, settings)),
      ...(['firecrawl', 'anysearch', 'tavily'] as const).filter(provider => !apiKeyFor(provider, settings))
    ]
    : [selected];
  const failures: string[] = [];
  for (const provider of configured) {
    if (signal.aborted) throw signal.reason || new Error('读取网页已取消');
    const key = apiKeyFor(provider, settings);
    if (!key && (provider === 'exa' || provider === 'ollama')) throw new Error(`请在设置中配置${providerName(provider)} API Key`);
    try { return await fetchFromProvider(provider, url, key, signal, apiFetcher); }
    catch (error) {
      if (signal.aborted) throw error;
      failures.push(`${providerName(provider)}：${error instanceof Error ? error.message : String(error)}`);
      if (selected !== 'auto') throw error;
    }
  }
  try { return await fetchWebPage(url, signal, localFetcher, resolver); }
  catch (error) {
    if (!failures.length) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${failures.join('；')}；本地读取网页失败：${detail}`);
  }
}
