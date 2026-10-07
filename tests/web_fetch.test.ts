import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWebPage, fetchWebPageWithProviders } from '../electron/web_fetch';
import { initialState } from '../src/domain';

const publicHost = async () => ['93.184.216.34'];
const signal = () => new AbortController().signal;
const html = `<!doctype html><html><head><title>Example article</title></head><body><nav>Home | About | Contact</nav><main><article><h1>Example article heading</h1><p>This is the first paragraph of a readable article. It contains enough useful detail to make it clearly identifiable as the page's main content, rather than a navigation item or a footer.</p><p>This second paragraph adds further detail about the subject and gives Defuddle meaningful article text to extract and convert into Markdown for the assistant.</p></article></main><footer>Copyright and related links</footer></body></html>`;

test('web_fetch requests Markdown first and converts HTML into Markdown', async () => {
  let accept = '';
  const page = await fetchWebPage('https://article.example/story', signal(), async (_url, init) => {
    accept = new Headers(init?.headers).get('accept') || '';
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }, publicHost);
  assert.match(accept, /text\/markdown/);
  assert.equal(page.title, 'Example article');
  assert.match(page.content, /Example article heading/);
  assert.match(page.content, /readable article/);
  assert.equal(page.contentType, 'text/html');
  assert.equal(page.truncated, false);
});

test('web_fetch preserves Markdown responses and follows only safe HTTP redirects', async () => {
  const requested: Array<{ url: string; accept: string }> = [];
  const page = await fetchWebPage('https://article.example/old', signal(), async (url, init) => {
    requested.push({ url, accept: new Headers(init?.headers).get('accept') || '' });
    if (url.endsWith('/old')) return new Response('', { status: 302, headers: { location: '/new' } });
    return new Response('# Already Markdown\n\nThe source served Markdown directly.', { status: 200, headers: { 'content-type': 'text/markdown' } });
  }, publicHost);
  assert.deepEqual(requested.map(x => x.url), ['https://article.example/old', 'https://article.example/new']);
  assert.ok(requested.every(x => /text\/markdown/.test(x.accept)));
  assert.match(page.content, /Already Markdown/);
  assert.equal(page.url, 'https://article.example/new');
});

test('web_fetch rejects local and private destinations before making a request', async () => {
  let requests = 0;
  const fetcher = async () => { requests++; return new Response('nope'); };
  await assert.rejects(fetchWebPage('file:///etc/passwd', signal(), fetcher, publicHost), /HTTP 或 HTTPS/);
  await assert.rejects(fetchWebPage('http://127.0.0.1/admin', signal(), fetcher, publicHost), /公网网页/);
  await assert.rejects(fetchWebPage('https://private.example/', signal(), fetcher, async () => ['192.168.1.10']), /公网地址/);
  assert.equal(requests, 0);
});

test('automatic webpage reading prefers Exa and sends the authenticated Contents request', async () => {
  const settings = initialState().settings;
  settings.exaKey = 'exa-fixture'; settings.tavilyKey = 'tavily-fixture';
  settings.connections.push({ id: 'ollama-cloud', name: 'Ollama Cloud', protocol: 'chat', baseUrl: 'https://ollama.com/', apiKey: 'ollama-fixture', headers: {}, timeout: 30, proxy: '' });
  let request: { url: string; init?: RequestInit } | undefined, localRequests = 0;
  const page = await fetchWebPageWithProviders('https://article.example/story#section', signal(), settings, 'auto', async () => {
    localRequests++; return new Response('unexpected local fetch');
  }, async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ results: [{ url: 'https://article.example/story', title: 'Exa page', text: '# Exa page\n\nMarkdown from Exa.' }] }), { headers: { 'content-type': 'application/json' } });
  }, publicHost);
  assert.equal(request?.url, 'https://api.exa.ai/contents');
  assert.equal(new Headers(request?.init?.headers).get('x-api-key'), 'exa-fixture');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { urls: ['https://article.example/story'], text: { maxCharacters: 20_000 } });
  assert.equal(page.provider, 'exa'); assert.equal(page.contentType, 'text/markdown');
  assert.equal(page.title, 'Exa page'); assert.match(page.content, /Markdown from Exa/);
  assert.equal(localRequests, 0);
});

test('automatic webpage reading falls through failed providers in priority order', async () => {
  const settings = initialState().settings;
  settings.exaKey = 'exa-fixture'; settings.tavilyKey = 'tavily-fixture';
  settings.connections.push({ id: 'ollama-cloud', name: 'Ollama Cloud', protocol: 'chat', baseUrl: 'https://ollama.com/', apiKey: 'ollama-fixture', headers: {}, timeout: 30, proxy: '' });
  const calls: string[] = []; let localRequests = 0;
  const page = await fetchWebPageWithProviders('https://article.example/story', signal(), settings, 'auto', async () => {
    localRequests++; return new Response('unexpected local fetch');
  }, async (url, init) => {
    calls.push(url);
    if (url === 'https://api.exa.ai/contents') return new Response('unavailable', { status: 503 });
    if (url === 'https://ollama.com/api/web_fetch') {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ollama-fixture');
      assert.deepEqual(JSON.parse(String(init?.body)), { url: 'https://article.example/story' });
      return new Response(JSON.stringify({ title: 'Ollama page', content: '# Ollama page\n\nMarkdown from Ollama.', links: [] }), { headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected provider ${url}`);
  }, publicHost);
  assert.deepEqual(calls, ['https://api.exa.ai/contents', 'https://ollama.com/api/web_fetch']);
  assert.equal(page.provider, 'ollama'); assert.equal(page.title, 'Ollama page'); assert.match(page.content, /Markdown from Ollama/);
  assert.equal(localRequests, 0);
});

test('Tavily Extract returns Markdown and automatic mode uses local fetch when no API key is configured', async () => {
  const settings = initialState().settings; settings.tavilyKey = 'tavily-fixture';
  let request: { url: string; init?: RequestInit } | undefined;
  const hosted = await fetchWebPageWithProviders('https://article.example/story', signal(), settings, 'tavily', async () => new Response('unused'), async (url, init) => {
    request = { url, init };
    return new Response(JSON.stringify({ results: [{ url: 'https://article.example/story', raw_content: '# Tavily page\n\nMarkdown from Tavily.' }], failed_results: [] }), { headers: { 'content-type': 'application/json' } });
  }, publicHost);
  assert.equal(request?.url, 'https://api.tavily.com/extract');
  assert.equal(new Headers(request?.init?.headers).get('authorization'), 'Bearer tavily-fixture');
  assert.deepEqual(JSON.parse(String(request?.init?.body)), { urls: ['https://article.example/story'], format: 'markdown', extract_depth: 'basic' });
  assert.equal(hosted.provider, 'tavily'); assert.match(hosted.content, /Markdown from Tavily/);

  const empty = initialState().settings; let localRequests = 0;
  const local = await fetchWebPageWithProviders('https://article.example/story', signal(), empty, undefined, async (_url, init) => {
    localRequests++;
    assert.equal(new Headers(init?.headers).get('accept')?.includes('text/markdown'), true);
    return new Response('# Local page\n\nThis response came from the proxy-aware local fetcher.', { headers: { 'content-type': 'text/markdown' } });
  }, async () => { throw new Error('No provider should be called without an API key'); }, publicHost);
  assert.equal(local.provider, 'local'); assert.equal(localRequests, 1); assert.match(local.content, /proxy-aware local fetcher/);
});

test('automatic webpage reading falls back to local fetch when every configured service fails', async () => {
  const settings = initialState().settings; settings.exaKey = 'exa-fixture'; settings.tavilyKey = 'tavily-fixture';
  const calls: string[] = [];
  const page = await fetchWebPageWithProviders('https://article.example/story', signal(), settings, 'auto', async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('accept')?.includes('text/markdown'), true);
    return new Response('# Local fallback\n\nThe configured hosted fetch services were unavailable.', { headers: { 'content-type': 'text/markdown' } });
  }, async url => {
    calls.push(url); return new Response('service error', { status: 503 });
  }, publicHost);
  assert.deepEqual(calls, ['https://api.exa.ai/contents', 'https://api.tavily.com/extract']);
  assert.equal(page.provider, 'local'); assert.match(page.content, /hosted fetch services were unavailable/);
});
