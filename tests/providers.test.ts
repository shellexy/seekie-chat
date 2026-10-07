import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { buildInput, endpoint, generate, sse } from '../electron/providers';
import { addMessage, createConversation, initialState } from '../src/domain';
import type { Connection, Model } from '../src/types';
import { UsageCounter } from '../electron/usage';
const connection = (protocol: Connection['protocol']): Connection => ({ id: 'c', name: 'Mock', protocol, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', headers: {}, timeout: 10, proxy: '' });
const model: Model = { id: 'm', connectionId: 'c', name: 'Mock', model: 'fixture', contextWindow: 100000, maxOutput: 4096, vision: true, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true };
test('usage aggregation counts cumulative frames once and keeps unknown cache distinct from zero across rounds', () => {
  const counter = new UsageCounter();
  counter.observe({ input: 100, output: 1, cachedInput: 20 });
  counter.observe({ input: 100, output: 9, cachedInput: 20 }); counter.finishRound();
  counter.observe({ input: 110, output: 6, cachedInput: 0 }); counter.finishRound();
  assert.deepEqual(counter.total, { input: 210, output: 15, cachedInput: 20 });
  counter.observe({ input: 120, output: 10 }); counter.finishRound();
  assert.deepEqual(counter.total, { input: 330, output: 25 });
  counter.observe({ input: 130, output: 4, cachedInput: 15 }); counter.finishRound();
  assert.equal(counter.total.cachedInput, undefined, 'partial cache totals must not be presented as complete');
});
for (const variant of ['chat', 'deepseek', 'responses', 'anthropic', 'gemini'] as const) test(`${variant} reads cache counts and avoids double counting cumulative usage`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const protocol = variant === 'deepseek' ? 'chat' : variant;
    const chatUsage = { prompt_tokens: 100, completion_tokens: 8, ...(variant === 'deepseek' ? { prompt_cache_hit_tokens: 40 } : { prompt_tokens_details: { cached_tokens: 40 } }) };
    const events = protocol === 'chat' ? [
      { choices: [{ delta: { content: '回答' } }], usage: { ...chatUsage, completion_tokens: 1 } },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: chatUsage }, { choices: [], usage: chatUsage }
    ] : protocol === 'responses' ? [
      { type: 'response.output_text.delta', delta: '回答' },
      { type: 'response.completed', response: { output: [], usage: { input_tokens: 100, output_tokens: 8, input_tokens_details: { cached_tokens: 40 } } } }
    ] : protocol === 'anthropic' ? [
      { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '回答' } },
      { type: 'message_delta', usage: { output_tokens: 3 } }, { type: 'message_delta', usage: { output_tokens: 8 } }, { type: 'message_stop' }
    ] : [
      { candidates: [{ content: { parts: [{ text: '回答' }] } }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 1 } },
      { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, cachedContentTokenCount: 40, candidatesTokenCount: 6, thoughtsTokenCount: 2 } }
    ];
    const path = protocol === 'chat' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : protocol === 'anthropic' ? '/v1/messages' : '/v1/models/fixture:streamGenerateContent?alt=sse';
    agent.get('https://fixture.invalid').intercept({ path, method: 'POST' }).reply(200, events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
    const state = initialState(), c = createConversation(state.settings), b = c.branches[0]; addMessage(c, b, 'user', '你好');
    const result = await generate(connection(protocol), model, { ...b.config, search: 'off' }, c.messages, state.settings, new AbortController().signal);
    assert.deepEqual(result.usage, { input: 100, output: 8, cachedInput: 40 });
  } finally { await agent.close(); }
});
test('URL construction respects v1 and custom prefixes', () => {
  assert.equal(endpoint({ ...connection('chat'), baseUrl: 'https://api.example.com' }, 'models'), 'https://api.example.com/v1/models');
  assert.equal(endpoint(connection('chat'), 'responses'), 'https://fixture.invalid/v1/responses');
  assert.equal(endpoint({ ...connection('chat'), baseUrl: 'https://fixture.invalid/custom/' }, 'messages'), 'https://fixture.invalid/custom/messages');
});
test('SSE handles fragmented utf8 and CRLF frames', async () => {
  const bytes = new TextEncoder().encode('data: {"text":"你好"}\r\n\r\ndata: [DONE]\r\n\r\n');
  async function* chunks() { for (let i = 0; i < bytes.length; i += 3) yield bytes.slice(i, i + 3); }
  const events = []; for await (const e of sse(chunks())) events.push(e);
  assert.deepEqual(events, [{ text: '你好' }]);
});
test('protocol-native signed blocks are preserved only in compatible unedited answers', () => {
  const state = initialState(), c = createConversation(state.settings); const a = addMessage(c, c.branches[0], 'assistant', '正文'); a.status = 'complete';
  a.raw = { protocol: 'anthropic', entries: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '摘要', signature: 'signed' }, { type: 'text', text: '正文' }] }] };
  assert.equal(buildInput('anthropic', [a])[0].content[0].signature, 'signed');
  assert.equal(buildInput('chat', [a])[0].content, '正文');
  a.edited = true; assert.equal(buildInput('anthropic', [a])[0].content[0].type, 'text');
});
for (const protocol of ['chat', 'responses', 'anthropic'] as const) test(`${protocol} streams text, reasoning, usage and correct native replay`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const events = protocol === 'chat' ? [ { choices: [{ delta: { reasoning_content: '摘要' } }] }, { choices: [{ delta: { content: '你好' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } } ]
    : protocol === 'responses' ? [ { type: 'response.reasoning_summary_text.delta', delta: '摘要' }, { type: 'response.output_text.delta', delta: '你好' }, { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } } } ]
    : [ { type: 'message_start', message: { usage: { input_tokens: 10 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '摘要' } }, { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } }, { type: 'content_block_stop', index: 0 }, { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '你好' } }, { type: 'message_delta', usage: { output_tokens: 2 } }, { type: 'message_stop' } ];
  const path = protocol === 'chat' ? 'chat/completions' : protocol === 'responses' ? 'responses' : 'messages';
  agent.get('https://fixture.invalid').intercept({ path: `/v1/${path}`, method: 'POST' }).reply(200, events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings), b = c.branches[0]; addMessage(c, b, 'user', '你好'); const output: string[] = [];
  const result = await generate(connection(protocol), model, b.config, c.messages, state.settings, new AbortController().signal, { text: s => output.push(s), reasoning() {}, tool() {}, sources() {} });
  assert.equal(result.text, '你好'); assert.equal(result.reasoning, '摘要'); assert.deepEqual(result.usage, { input: 10, output: 2 }); assert.equal(output.join(''), '你好'); assert.ok(result.raw.entries.length);
  await agent.close();
});
for (const protocol of ['chat', 'responses', 'anthropic'] as const) test(`${protocol} sends the branch temperature and top_p settings`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const events = protocol === 'chat' ? [ { choices: [{ delta: { content: 'ok' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] } ]
    : protocol === 'responses' ? [ { type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed', response: { output: [], usage: { input_tokens: 10, output_tokens: 1 } } } ]
    : [ { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }, { type: 'message_stop' } ];
  const path = protocol === 'chat' ? '/v1/chat/completions' : protocol === 'responses' ? '/v1/responses' : '/v1/messages'; let body: any;
  agent.get('https://fixture.invalid').intercept({ path, method: 'POST' }).reply(200, options => { body = JSON.parse(String(options.body)); return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''); }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', 'test');
  await generate(connection(protocol), { ...model, reasoning: 'none', temperature: true }, { ...c.branches[0].config, search: 'off', temperature: 0.4, topP: 0.65 }, c.messages, state.settings, new AbortController().signal);
  assert.equal(body.temperature, 0.4); assert.equal(body.top_p, 0.65);
  await agent.close();
});
for (const protocol of ['responses', 'anthropic'] as const) test(`${protocol} web_search records the actual search parameters`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const query = 'How do streamed native searches expose their query?';
  const events = protocol === 'responses' ? [
    { type: 'response.web_search_call.in_progress', item_id: 'ws-1' },
    { type: 'response.output_text.delta', delta: 'Answer' },
    { type: 'response.output_item.done', item: { type: 'web_search_call', id: 'ws-1', status: 'completed', action: { type: 'search', query } } },
    { type: 'response.completed', response: { output: [{ type: 'web_search_call', id: 'ws-1', status: 'completed', action: { type: 'search', query } }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer', annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2 } } }
  ] : [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ query }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: 'search-1', content: [] } },
    { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } },
    { type: 'message_stop' }
  ];
  const path = protocol === 'responses' ? '/v1/responses' : '/v1/messages';
  agent.get('https://fixture.invalid').intercept({ path, method: 'POST' }).reply(200, events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', 'Search'); const tools: Array<{ id: string; name: string; input: string; status: string }> = [];
  const result = await generate(connection(protocol), { ...model, nativeSearch: true }, { ...c.branches[0].config, search: 'native' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool: t => tools.push(t), sources() {} });
  const search = tools.filter(t => t.name === 'web_search').at(-1);
  assert.equal(JSON.parse(search?.input || '{}').query, query);
  assert.equal(search?.status, 'done'); assert.equal(result.text, 'Answer');
  await agent.close();
});
test('a stream ending without completion is an error, not a successful answer', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  agent.get('https://fixture.invalid').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, 'data: {"choices":[{"delta":{"content":"部分回答"}}]}\n\n');
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '你好');
  await assert.rejects(generate(connection('chat'), model, c.branches[0].config, c.messages, state.settings, new AbortController().signal), /提前结束/);
  await agent.close();
});
test('Exa tool results are returned to the model with matching call IDs and persisted sources', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'exa_search', arguments: '{"query":"Electron docs"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  agent.get('https://api.exa.ai').intercept({ path: '/search', method: 'POST' }).reply(200, { results: [{ title: 'Electron docs', url: 'https://www.electronjs.org/docs', text: 'Desktop framework documentation' }] });
  let secondBody: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '根据 Electron 文档回答。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  });
  const state = initialState(); state.settings.exaKey = 'fixture'; const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '搜索文档');
  const tools: string[] = [];
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'exa' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool: t => tools.push(t.status), sources() {} });
  assert.equal(secondBody.messages.at(-1).role, 'tool'); assert.equal(secondBody.messages.at(-1).tool_call_id, 'call-1');
  assert.deepEqual(tools, ['running','done']); assert.equal(result.sources[0].url, 'https://www.electronjs.org/docs');
  assert.equal(result.raw.entries.filter(e => e.role === 'tool').length, 1);
  await agent.close();
});
test('Exa failures return explicit tool errors without fabricated sources', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [ { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-2', function: { name: 'exa_search', arguments: '{"query":"search"}' } }] } }] }, { choices: [{ delta: {}, finish_reason: 'tool_calls' }] } ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''));
  agent.get('https://api.exa.ai').intercept({ path: '/search', method: 'POST' }).reply(429, { error: 'rate limited' });
  let secondBody: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => { secondBody = JSON.parse(String(options.body)); return [ { choices: [{ delta: { content: '搜索失败，请稍后重试。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] } ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''); });
  const state = initialState(); state.settings.exaKey = 'fixture'; const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '查询');
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'exa' }, c.messages, state.settings, new AbortController().signal);
  assert.match(secondBody.messages.at(-1).content, /搜索未成功/); assert.equal(result.sources.length, 0);
  await agent.close();
});
for (const provider of ['ollama', 'tavily'] as const) test(`${provider} web search sends authenticated queries and returns source snippets to the model`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'), toolName = provider === 'ollama' ? 'ollama_web_search' : 'tavily_search';
  let firstBody: any, secondBody: any, searchBody: any, searchHeaders: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    firstBody = JSON.parse(String(options.body));
    return [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${provider}`, function: { name: toolName, arguments: '{"query":"Ollama web search API"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const searchHost = provider === 'ollama' ? 'https://ollama.com' : 'https://api.tavily.com';
  const searchPath = provider === 'ollama' ? '/api/web_search' : '/search';
  agent.get(searchHost).intercept({ path: searchPath, method: 'POST' }).reply(200, options => {
    searchBody = JSON.parse(String(options.body)); searchHeaders = options.headers;
    return { results: [{ title: `${provider} result`, url: 'https://example.com/result', content: 'Verified search snippet' }] };
  });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '根据搜索结果回答。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaResults = 4;
  if (provider === 'ollama') state.settings.connections.push({ id: 'ollama-cloud', name: 'Ollama Cloud', protocol: 'chat', baseUrl: 'https://ollama.com/', apiKey: 'ollama-fixture', headers: {}, timeout: 30, proxy: '' });
  else state.settings.tavilyKey = 'tavily-fixture';
  const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '请搜索');
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: provider }, c.messages, state.settings, new AbortController().signal);
  assert.equal(firstBody.tools[0].function.name, toolName);
  assert.equal(searchBody.query, 'Ollama web search API'); assert.equal(searchBody.max_results, 4);
  if (provider === 'tavily') { assert.equal(searchBody.search_depth, 'basic'); assert.match(JSON.stringify(searchHeaders), /Bearer tavily-fixture/i); }
  else { assert.match(JSON.stringify(searchHeaders), /Bearer ollama-fixture/i); }
  assert.match(secondBody.messages.at(-1).content, /Verified search snippet/);
  assert.equal(result.sources[0].url, 'https://example.com/result'); assert.equal(result.sources[0].title, `${provider} result`);
  await agent.close();
});
