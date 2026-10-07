import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { authHeaders, buildInput, endpoint, generate, listModels } from '../electron/providers';
import { addMessage, createConversation, initialState } from '../src/domain';
import type { Connection, Model } from '../src/types';
const connection: Connection = { id: 'g', name: 'Gemini', protocol: 'gemini', baseUrl: 'https://gemini.fixture.invalid/v1beta', apiKey: 'fixture-key', headers: {}, timeout: 10, proxy: '' };
const model: Model = { id: 'm', connectionId: 'g', name: 'fixture', model: 'models/gemini-fixture', contextWindow: 100000, maxOutput: 8192, vision: true, tools: true, nativeSearch: true, reasoning: 'effort', efforts: ['minimal', 'low', 'medium', 'high'], temperature: true };
const streamPath = '/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse';
const frames = (events: any[]) => events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
function fixture() {
  const state = initialState(); state.settings.connections = [connection]; state.settings.models = [model]; state.settings.defaultModel = model.id;
  const conversation = createConversation(state.settings), branch = conversation.branches[0]; addMessage(conversation, branch, 'user', '解释这张图片');
  return { state, conversation, branch };
}
const complete = (text: string) => ({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }] });

test('Gemini uses v1beta roots and header-based API keys without altering compatible prefixes', () => {
  assert.equal(endpoint({ ...connection, baseUrl: 'https://generativelanguage.googleapis.com/' }, 'models'), 'https://generativelanguage.googleapis.com/v1beta/models');
  assert.equal(endpoint({ ...connection, baseUrl: 'https://gateway.invalid/gemini/v1' }, 'models'), 'https://gateway.invalid/gemini/v1/models');
  const headers = authHeaders(connection); assert.equal(headers['x-goog-api-key'], 'fixture-key'); assert.equal(headers.Authorization, undefined);
});
test('Gemini sends images and system prompts, separates thoughts and counts cumulative usage once', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path: streamPath, method: 'POST', headers: { 'x-goog-api-key': 'fixture-key' } }).reply(200, options => {
      body = JSON.parse(String(options.body));
      return frames([
        { candidates: [{ content: { parts: [{ text: '观察图片。', thought: true }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 1, thoughtsTokenCount: 2 } },
        { candidates: [{ content: { parts: [{ text: '图片', thoughtSignature: 'signed-text' }] } }] },
        { candidates: [{ content: { parts: [{ text: '中有树。' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 } }
      ]);
    });
    const { state, conversation, branch } = fixture(); conversation.messages[0].attachments = [{ id: 'a', name: 'tree.png', mime: 'image/png', data: 'data:image/png;base64,aGVsbG8=', size: 5 }];
    const result = await generate(connection, model, { ...branch.config, search: 'off', webFetch: 'off', effort: 'low', temperature: 0.4, topP: 0.65, system: '你是图像助手。' }, conversation.messages, state.settings, new AbortController().signal);
    assert.equal(body.systemInstruction.parts[0].text, '你是图像助手。', '系统提示原样发送，不再追加工具或联网片段');
    assert.match(body.tools[0].functionDeclarations[0].description, /不要凭记忆回答/, '要求调用 datetime 避免凭记忆作答，改由工具描述承担');
    assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'LOW' });
    assert.equal(body.generationConfig.temperature, 0.4); assert.equal(body.generationConfig.topP, 0.65);
    assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } });
    assert.equal(result.text, '图片中有树。'); assert.equal(result.reasoning, '观察图片。'); assert.deepEqual(result.usage, { input: 10, output: 7 });
    const answer = addMessage(conversation, branch, 'assistant', result.text); answer.status = 'complete'; answer.raw = result.raw;
    assert.equal(buildInput('gemini', [answer])[0].parts[1].thoughtSignature, 'signed-text');
    answer.edited = true; assert.deepEqual(buildInput('gemini', [answer]), [{ role: 'model', parts: [{ text: result.text }] }]);
  } finally { await agent.close(); }
});
test('Gemini declares search and web_fetch as untrusted content', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); let body: any;
  agent.get('https://gemini.fixture.invalid').intercept({ path: streamPath, method: 'POST' }).reply(200, options => {
    body = JSON.parse(String(options.body)); return frames([complete('好。')]);
  });
  const { state, conversation, branch } = fixture(); state.settings.exaKey = 'exa-fixture';
  try {
    await generate(connection, model, { ...branch.config, search: 'exa', webFetch: 'exa', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal, undefined,
      async url => ({ url, title: 'Page', content: 'body', contentType: 'text/html', truncated: false }));
    // 与另外三种协议同一份提示：系统提示会被改写，工具描述不会。
    const declared = body.tools.flatMap((tool: any) => tool.functionDeclarations ?? []);
    const names = declared.map((tool: any) => tool.name);
    const guarded = declared.filter((tool: any) => tool.name === 'exa_search' || tool.name === 'web_fetch');
    assert.equal(guarded.length, 2, `搜索与抓取工具都应被声明：${names}`);
    for (const tool of guarded) assert.match(tool.description, /外部资料/, `Gemini 的 ${tool.name} 描述缺少外部资料提示`);
  } finally { await agent.close(); }
});
test('Gemini native search sends Google Search and displays only server-returned sources and tool events', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path: streamPath, method: 'POST' }).reply(200, options => {
      body = JSON.parse(String(options.body));
      const event = complete('基于搜索的回答。'); (event.candidates[0] as any).groundingMetadata = { webSearchQueries: ['Electron docs'], groundingChunks: [{ web: { uri: 'https://www.electronjs.org/docs', title: 'Electron' } }] };
      return frames([event]);
    });
    const { state, conversation, branch } = fixture(), tools: any[] = [];
    const result = await generate(connection, model, { ...branch.config, effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, sources() {}, tool: t => tools.push(t) });
    // The fixture model id is not a Gemini 3 model, so native search is sent without function tools.
    assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    assert.equal(result.sources[0].title, 'Electron'); assert.equal(tools[0].name, 'google_search'); assert.equal(tools[0].status, 'done');
  } finally { await agent.close(); }
});
for (const fail of [false, true]) test(`Gemini Exa ${fail ? 'failures are explicit' : 'results retain signed function calls'} in follow-up requests`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid'); let first: any, second: any;
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => {
      first = JSON.parse(String(options.body));
      return frames([{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call-g', name: 'exa_search', args: { query: 'Electron' } }, thoughtSignature: 'signed-call' }] }, finishReason: 'STOP' }] }]);
    });
    agent.get('https://api.exa.ai').intercept({ path: '/search', method: 'POST' }).reply(fail ? 429 : 200, fail ? { error: 'limited' } : { results: [{ title: 'Electron', url: 'https://www.electronjs.org/docs', text: 'Desktop docs' }] });
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete(fail ? '搜索失败。' : '搜索完成。')]); });
    const { state, conversation, branch } = fixture(); state.settings.exaKey = 'fixture';
    const result = await generate(connection, model, { ...branch.config, search: 'exa', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    assert.equal(first.tools[0].functionDeclarations[0].name, 'exa_search');
    assert.equal(second.contents.at(-2).parts[0].thoughtSignature, 'signed-call');
    const returned = second.contents.at(-1).parts[0].functionResponse;
    assert.equal(returned.id, 'call-g'); assert.equal(returned.name, 'exa_search');
    if (fail) { assert.match(returned.response.instruction, /搜索未成功/); assert.equal(result.sources.length, 0); }
    else { assert.equal(returned.response.results[0].text, 'Desktop docs'); assert.equal(result.sources.length, 1); }
  } finally { await agent.close(); }
});
for (const provider of ['ollama', 'tavily', 'firecrawl', 'anysearch'] as const) test(`Gemini can call ${provider} search and continue with its results`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid');
    const toolName = provider === 'ollama' ? 'ollama_web_search' : provider === 'tavily' ? 'tavily_search' : provider === 'firecrawl' ? 'firecrawl_search' : 'anysearch_search';
    let first: any, second: any;
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => {
      first = JSON.parse(String(options.body));
      return frames([{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: `call-${provider}`, name: toolName, args: { query: 'Gemini web search' } } }] }, finishReason: 'STOP' }] }]);
    });
    const host = provider === 'ollama' ? 'https://ollama.com' : provider === 'tavily' ? 'https://api.tavily.com' : provider === 'firecrawl' ? 'https://api.firecrawl.dev' : 'https://api.anysearch.com';
    const path = provider === 'ollama' ? '/api/web_search' : provider === 'firecrawl' ? '/v2/search' : provider === 'anysearch' ? '/v1/search' : '/search';
    agent.get(host).intercept({ path, method: 'POST' }).reply(200,
      provider === 'firecrawl' ? { success: true, data: { web: [{ title: 'Search result', url: 'https://example.com/gemini', markdown: 'Gemini search snippet' }] } }
      : provider === 'anysearch' ? { code: 0, data: { results: [{ title: 'Search result', url: 'https://example.com/gemini', content: 'Gemini search snippet' }] } }
      : { results: [{ title: 'Search result', url: 'https://example.com/gemini', content: 'Gemini search snippet' }] });
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete('搜索结果已处理。')]); });
    const { state, conversation, branch } = fixture();
    if (provider === 'ollama') state.settings.ollamaKey = 'ollama-fixture';
    else if (provider === 'tavily') state.settings.tavilyKey = 'tavily-fixture';
    else if (provider === 'firecrawl') state.settings.firecrawlKey = 'firecrawl-fixture';
    else state.settings.anysearchKey = 'anysearch-fixture';
    const result = await generate(connection, model, { ...branch.config, search: provider, effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    assert.equal(first.tools[0].functionDeclarations[0].name, toolName);
    const returned = second.contents.at(-1).parts[0].functionResponse;
    assert.equal(returned.name, toolName); assert.equal(returned.response.results[0].text, 'Gemini search snippet');
    assert.equal(result.sources[0].url, 'https://example.com/gemini');
  } finally { await agent.close(); }
});
test('Gemini exposes web_fetch beside native search and returns fetched Markdown', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid'), gemini3 = { ...model, model: 'models/gemini-3.8-flash' }, path = '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse'; let first: any, second: any;
    pool.intercept({ path, method: 'POST' }).reply(200, options => {
      first = JSON.parse(String(options.body));
      return frames([{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'fetch-g', name: 'web_fetch', args: { url: 'https://example.com/article' } } }] }, finishReason: 'STOP' }] }]);
    });
    pool.intercept({ path, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete('已阅读网页正文。')]); });
    const { state, conversation, branch } = fixture();
    const result = await generate(connection, gemini3, { ...branch.config, search: 'native', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal, undefined, async url => ({ url, title: 'Fetched article', content: '# Article\n\nGemini fetched this Markdown.', contentType: 'text/html', truncated: false }));
    assert.deepEqual(first.tools[0], { googleSearch: {} });
    assert.equal(first.tools[1].functionDeclarations[0].name, 'web_fetch');
    assert.deepEqual(first.toolConfig, { includeServerSideToolInvocations: true });
    const returned = second.contents.at(-1).parts[0].functionResponse;
    assert.equal(returned.name, 'web_fetch'); assert.match(returned.response.content, /Gemini fetched this Markdown/);
    assert.equal(result.sources[0].url, 'https://example.com/article');
  } finally { await agent.close(); }
});
test('Gemini thinking budgets remain numeric and incomplete streams preserve partial output as errors', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    let body: any; const output: string[] = [];
    agent.get('https://gemini.fixture.invalid').intercept({ path: streamPath, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return frames([{ candidates: [{ content: { parts: [{ text: '部分回答' }] } }] }]); });
    const { state, conversation, branch } = fixture();
    await assert.rejects(generate(connection, { ...model, reasoning: 'budget' }, { ...branch.config, search: 'off', budget: 2048 }, conversation.messages, state.settings, new AbortController().signal, { text: t => output.push(t), reasoning() {}, tool() {}, sources() {} }), /提前结束/);
    assert.equal(body.generationConfig.thinkingConfig.thinkingBudget, 2048); assert.equal(output.join(''), '部分回答');
  } finally { await agent.close(); }
});
test('Gemini declares datetime with its uppercase schema and returns the clock as a plain line', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid'); let first: any, second: any;
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => {
      first = JSON.parse(String(options.body));
      return frames([{ candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'clock-g', name: 'datetime', args: {} } }] }, finishReason: 'STOP' }] }]);
    });
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete('已获取本机时间。')]); });
    const { state, conversation, branch } = fixture();
    const result = await generate(connection, model, { ...branch.config, search: 'off', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    const declaration = first.tools[0].functionDeclarations[0];
    assert.equal(declaration.name, 'datetime'); assert.equal(declaration.parameters.type, 'OBJECT');
    assert.match(declaration.description, /不要凭记忆回答/, '要求调用 datetime 避免凭记忆作答，改由工具描述承担');
    assert.equal(first.systemInstruction.parts[0].text, branch.config.system, '系统提示原样发送');
    const returned = second.contents.at(-1).parts[0].functionResponse;
    assert.equal(returned.name, 'datetime');
    assert.match(returned.response.datetime, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 星期[日一二三四五六] \| .+ UTC[+-]\d{2}:\d{2} \| UTC \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(result.sources.length, 0);
  } finally { await agent.close(); }
});
test('Gemini background requests disable local tools', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path: streamPath, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return frames([complete('标题')]); });
    const { state, conversation, branch } = fixture();
    await generate(connection, model, { ...branch.config, search: 'off', webFetch: 'off', localTools: false, effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    assert.equal(body.tools, undefined);
    assert.equal(body.systemInstruction.parts[0].text, branch.config.system, '系统提示同样原样发送');
  } finally { await agent.close(); }
});
test('Gemini never replays a part without a content field', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid'); let second: any;
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, frames([
      // A signature that arrives before any content, and a bare thought marker, must not become
      // parts of their own: the provider rejects them ("required oneof field 'data' ...").
      { candidates: [{ content: { parts: [{ thoughtSignature: 'leading-signature' }] } }] },
      { candidates: [{ content: { parts: [{ text: '先想一下。', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ thought: true }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'clock-p', name: 'datetime', args: {} } }] }, finishReason: 'STOP' }] }
    ]));
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete('已获取时间。')]); });
    const { state, conversation, branch } = fixture();
    await generate(connection, model, { ...branch.config, search: 'off', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    const parts = second.contents[1].parts;
    assert.equal(parts.length, 2, `只有真实内容才应成为 part: ${JSON.stringify(parts)}`);
    for (const part of parts) {
      const contentFields = ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse'].filter(field => part[field] !== undefined);
      assert.equal(contentFields.length, 1, `每个 part 必须恰好设置一个内容字段: ${JSON.stringify(part)}`);
      if (part.text !== undefined) assert.ok(part.text.length > 0, `空字符串文本会被上游视为未初始化: ${JSON.stringify(part)}`);
    }
    assert.equal(parts[0].text, '先想一下。');
    assert.equal(parts[0].thoughtSignature, 'leading-signature', '签名分片应并入它后面第一个有内容的 part');
    assert.equal(parts[1].functionCall.id, 'clock-p');
  } finally { await agent.close(); }
});
test('Gemini opts into server-side tool invocations whenever functions accompany Google Search', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const gemini3 = { ...model, model: 'models/gemini-3.1-pro' }, path = '/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse';
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return frames([complete('现在是本机时间。')]); });
    const { state, conversation, branch } = fixture();
    // Native search with webpage reading switched off still sends datetime as a function declaration.
    await generate(connection, gemini3, { ...branch.config, search: 'native', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    assert.ok(body.tools.some((tool: any) => tool.googleSearch));
    assert.deepEqual(body.tools.find((tool: any) => tool.functionDeclarations).functionDeclarations.map((tool: any) => tool.name), ['datetime']);
    assert.deepEqual(body.toolConfig, { includeServerSideToolInvocations: true }, '内置工具与函数调用同时出现时必须 opt-in');
  } finally { await agent.close(); }
});
test('Gemini keeps native search alone on models that cannot mix in function calls', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const older = { ...model, model: 'models/gemini-2.5-pro' }, path = '/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse';
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return frames([complete('按记忆回答。')]); });
    const { state, conversation, branch } = fixture();
    await generate(connection, older, { ...branch.config, search: 'native', webFetch: 'auto', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    assert.deepEqual(body.tools, [{ googleSearch: {} }], '较早模型不应同时收到内置工具和函数声明');
    assert.equal(body.toolConfig, undefined);
    assert.equal(body.systemInstruction.parts[0].text, branch.config.system, '系统提示同样原样发送');
  } finally { await agent.close(); }
});
test('Gemini external search sends function declarations without a native tool config', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path: streamPath, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return frames([complete('按记忆回答。')]); });
    const { state, conversation, branch } = fixture(); state.settings.exaKey = 'fixture';
    await generate(connection, model, { ...branch.config, search: 'exa', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    assert.deepEqual(body.tools[0].functionDeclarations.map((tool: any) => tool.name), ['exa_search', 'datetime']);
    assert.equal(body.toolConfig, undefined, '没有内置工具时无需 opt-in');
  } finally { await agent.close(); }
});
test('Gemini opts in when only the history contains function calls', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const gemini3 = { ...model, model: 'models/gemini-3.1-pro', tools: false }, path = '/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse';
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return frames([complete('好的。')]); });
    const { state, conversation, branch } = fixture();
    // A model with tool calling switched off still replays an earlier tool round from history, and
    // Google requires the opt-in for that combination too.
    const answer = addMessage(conversation, branch, 'assistant', '时间已获取。'); answer.status = 'complete';
    answer.raw = { protocol: 'gemini', entries: [
      { role: 'model', parts: [{ functionCall: { id: 'clock-old', name: 'datetime', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'datetime', id: 'clock-old', response: { datetime: '2026-10-15 22:00:00 星期四' } } }] }
    ] };
    const question = addMessage(conversation, branch, 'user', '那现在呢');
    await generate(connection, gemini3, { ...branch.config, search: 'native', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    assert.deepEqual(body.tools, [{ googleSearch: {} }], '工具调用关闭时不应下发函数声明');
    assert.deepEqual(body.toolConfig, { includeServerSideToolInvocations: true }, '历史里有函数调用时同样必须 opt-in');
  } finally { await agent.close(); }
});
test('Gemini drops contentless parts coming from stored history', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    let body: any;
    agent.get('https://gemini.fixture.invalid').intercept({ path: streamPath, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return frames([complete('好的。')]); });
    const { state, conversation, branch } = fixture();
    // Both roles can carry the damage: a bare thought marker in the model turn and a stale empty
    // part in the tool-result turn must never reach the provider.
    const answer = addMessage(conversation, branch, 'assistant', '先想一下。'); answer.status = 'complete';
    answer.raw = { protocol: 'gemini', entries: [
      { role: 'model', parts: [{ text: '先想一下。', thought: true }, { thought: true }] },
      { role: 'user', parts: [{ functionResponse: { name: 'datetime', response: { datetime: '现在' } } }, { thoughtSignature: 'stale' }] }
    ] };
    const question = addMessage(conversation, branch, 'user', '继续');
    await generate(connection, model, { ...branch.config, search: 'off', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    for (const content of body.contents) {
      for (const part of content.parts) {
        const fields = ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse', 'executableCode', 'codeExecutionResult', 'toolCall', 'toolResponse'].filter(field => part[field] !== undefined);
        assert.equal(fields.length, 1, `每个 part 必须恰好一个内容字段: ${JSON.stringify(part)}`);
        if (part.text !== undefined) assert.ok(part.text.length > 0, `空字符串文本会被上游视为未初始化: ${JSON.stringify(part)}`);
      }
    }
  } finally { await agent.close(); }
});
test('Gemini retries with an external provider when a relay drops tool_config', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const gemini3 = { ...model, model: 'models/gemini-3.1-pro' }, path = '/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse';
    const pool = agent.get('https://gemini.fixture.invalid'); let first: any, second: any;
    pool.intercept({ path, method: 'POST' }).reply(400, options => {
      first = JSON.parse(String(options.body));
      // A relay that forwards tools but silently drops tool_config leaves Google rejecting the mix.
      return { error: { message: 'Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.' } };
    });
    pool.intercept({ path, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete('现在是本机时间。')]); });
    const { state, conversation, branch } = fixture(); const notices: string[] = [];
    const result = await generate(connection, gemini3, { ...branch.config, search: 'native', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool() {}, sources() {}, notice: message => notices.push(message) });
    assert.deepEqual(first.tools[0], { googleSearch: {} });
    assert.deepEqual(first.toolConfig, { includeServerSideToolInvocations: true });
    assert.equal(second.toolConfig, undefined, '放弃内置工具后不再需要 opt-in');
    assert.equal(second.tools.some((tool: any) => tool.googleSearch), false);
    // Keyless Tavily is the documented auto fallback when no search key is configured.
    assert.deepEqual(second.tools[0].functionDeclarations.map((tool: any) => tool.name), ['tavily_search', 'datetime']);
    assert.equal(result.text, '现在是本机时间。');
    assert.match(notices[0] || '', /未转发 tool_config/); assert.match(notices[0] || '', /Tavily/);
    assert.equal(result.sources.length, 0);
  } finally { await agent.close(); }
});
test('Gemini keeps the user configured external provider when falling back', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const gemini3 = { ...model, model: 'models/gemini-3.1-pro' }, path = '/v1beta/models/gemini-3.1-pro:streamGenerateContent?alt=sse';
    const pool = agent.get('https://gemini.fixture.invalid'); let second: any;
    pool.intercept({ path, method: 'POST' }).reply(400, { error: { message: 'Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling.' } });
    pool.intercept({ path, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete('现在是本机时间。')]); });
    const { state, conversation, branch } = fixture(); state.settings.exaKey = 'fixture'; const notices: string[] = [];
    await generate(connection, gemini3, { ...branch.config, search: 'native', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool() {}, sources() {}, notice: message => notices.push(message) });
    assert.deepEqual(second.tools[0].functionDeclarations.map((tool: any) => tool.name), ['exa_search', 'datetime']);
    assert.match(notices[0] || '', /Exa/);
  } finally { await agent.close(); }
});
test('Gemini never replays an empty text part', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid'); let second: any;
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, frames([
      { candidates: [{ content: { parts: [{ text: '先取时间。' }] } }] },
      { candidates: [{ content: { parts: [{ functionCall: { id: 'clock-e', name: 'datetime', args: {} }, thoughtSignature: 'call-signature' }] } }] },
      // The provider treats an empty string as "oneof not initialized", so this chunk must not
      // become a part of the replayed model turn (it caused a 400 on contents[1].parts[1]).
      { candidates: [{ content: { parts: [{ text: '' }] } }] },
      { candidates: [{ content: { parts: [{ text: '', thoughtSignature: 'late-signature' }] }, finishReason: 'STOP' }] }
    ]));
    pool.intercept({ path: streamPath, method: 'POST' }).reply(200, options => { second = JSON.parse(String(options.body)); return frames([complete('现在是本机时间。')]); });
    const { state, conversation, branch } = fixture();
    await generate(connection, model, { ...branch.config, search: 'off', webFetch: 'off', effort: 'auto' }, conversation.messages, state.settings, new AbortController().signal);
    const parts = second.contents[1].parts;
    assert.equal(parts.length, 2, `空文本分片不应成为 part: ${JSON.stringify(parts)}`);
    assert.equal(parts[0].text, '先取时间。');
    assert.equal(parts[1].functionCall.name, 'datetime');
    assert.equal(parts[1].thoughtSignature, 'late-signature', '空文本分片携带的签名应并入相邻 part');
    for (const part of parts) if (part.text !== undefined) assert.ok(part.text.length > 0);
  } finally { await agent.close(); }
});
test('Gemini model discovery paginates, filters unsupported models and strips models/ prefixes', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid');
    pool.intercept({ path: '/v1beta/models?pageSize=1000', method: 'GET' }).reply(200, { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next page' });
    pool.intercept({ path: '/v1beta/models?pageSize=1000&pageToken=next%20page', method: 'GET' }).reply(200, { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] });
    assert.deepEqual((await listModels(connection)).map(model => model.id), ['gemini-a', 'gemini-b']);
  } finally { await agent.close(); }
});
