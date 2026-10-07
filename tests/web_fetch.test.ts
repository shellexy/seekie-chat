import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWebPage } from '../electron/web_fetch';

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
