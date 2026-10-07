import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, MockAgent, setGlobalDispatcher } from 'undici';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { authHeaders, buildInput, debugHeaders, endpoint, generate, listModels, parseServerModel, request, sse } from '../electron/providers';
import { addMessage, appendAssistantSegment, createConversation, initialState } from '../src/domain';
import type { Connection, Model, RequestRecord } from '../src/types';
import { elapsedExcludingToolWait, UsageCounter } from '../electron/usage';
const connection = (protocol: Connection['protocol']): Connection => ({ id: 'c', name: 'Mock', protocol, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', headers: {}, timeout: 10, proxy: '' });
const model: Model = { id: 'm', connectionId: 'c', name: 'Mock', model: 'fixture', contextWindow: 100000, maxOutput: 4096, vision: true, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true };
test('model family User-Agent defaults identify Codex or Claude Code and respect custom headers', () => {
  const codexHeaders = authHeaders(connection('responses'), 'gpt-4o');
  assert.match(codexHeaders['User-Agent'], /^codex_cli_rs\/0\.162\.1 \(/);
  assert.equal(codexHeaders.originator, 'codex_cli_rs');
  assert.equal(codexHeaders['OpenAI-Beta'], 'responses=experimental');
  const claudeHeaders = authHeaders(connection('anthropic'), 'anthropic/claude-sonnet-4');
  assert.match(claudeHeaders['User-Agent'], /^claude-cli\/2\.1\.296 \(external, cli\)$/);
  assert.equal(claudeHeaders.originator, undefined);
  assert.match(authHeaders(connection('responses'), { model: 'compatible-id', name: 'GPT 4o' })['User-Agent'], /^codex_cli_rs\//);
  assert.match(authHeaders(connection('anthropic'), { model: 'compatible-id', name: 'Claude Sonnet 4' })['User-Agent'], /^claude-cli\//);
  assert.equal(authHeaders(connection('chat'), 'deepseek-flash')['User-Agent'], undefined);
  const custom = authHeaders({ ...connection('responses'), headers: { 'user-agent': 'custom-agent/1.0', Originator: 'custom-origin', 'openai-beta': 'custom-beta' } }, 'gpt-4o');
  assert.equal(custom['user-agent'], 'custom-agent/1.0'); assert.equal(custom.Originator, 'custom-origin'); assert.equal(custom['openai-beta'], 'custom-beta');
});
for (const [modelName, protocol, prefix, originator] of [['gpt-4o', 'responses', 'codex_cli_rs/', 'codex_cli_rs'], ['claude-3-7-sonnet', 'anthropic', 'claude-cli/', '']] as const) test(`HTTP requests for ${modelName} send the matching client headers`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); let userAgent = '', requestOriginator = '';
  agent.get('https://fixture.invalid').intercept({ path: '/v1/models', method: 'GET' }).reply(options => {
    const headers = new Headers(options.headers as HeadersInit);
    userAgent = headers.get('user-agent') || ''; requestOriginator = headers.get('originator') || '';
    return { statusCode: 200, data: { data: [] } };
  });
  const { response, close } = await request(connection(protocol), 'models', undefined, new AbortController().signal, modelName);
  await response.json(); close();
  assert.ok(userAgent.startsWith(prefix), userAgent); assert.equal(requestOriginator, originator);
  await agent.close();
});
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
test('generation time subtracts the union of overlapping tool waits once', () => {
  const tools = [
    { id: 'a', name: 'exa_search', input: '', output: '', status: 'done' as const, started: 1200, elapsed: 500 },
    { id: 'b', name: 'web_fetch', input: '', output: '', status: 'done' as const, started: 1400, elapsed: 300 },
    { id: 'c', name: 'tavily_search', input: '', output: '', status: 'done' as const, started: 1800, elapsed: 500 },
    { id: 'native', name: 'google_search', input: '', output: '', status: 'done' as const, started: 1000, elapsed: 1000 }
  ];
  assert.equal(elapsedExcludingToolWait(1000, 1000, tools, 2000), 300);
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
test('Anthropic model discovery retries the parent /models endpoint when the base URL route fails', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://api.deepseek.com');
    pool.intercept({ path: '/anthropic/models', method: 'GET' }).reply(404, { error: 'not found' });
    pool.intercept({ path: '/models', method: 'GET' }).reply(options => {
      assert.equal(new Headers(options.headers as HeadersInit).get('authorization'), 'Bearer fixture-only');
      return { statusCode: 200, data: { data: [{ id: 'deepseek-flash' }] } };
    });
    const deepseekAnthropic = { ...connection('anthropic'), baseUrl: 'https://api.deepseek.com/anthropic' };
    assert.deepEqual((await listModels(deepseekAnthropic)).map(model => model.id), ['deepseek-flash']);
  } finally { await agent.close(); }
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
test('stream events preserve alternating answer, reasoning and tool order in one assistant message', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const events = [
      { choices: [{ delta: { content: '第一段正文' } }] },
      { choices: [{ delta: { reasoning_content: '第一次思考' } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'sequence-call', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }] } }] },
      { choices: [{ delta: { content: '第二段正文' } }] },
      { choices: [{ delta: { reasoning_content: '第二次思考' } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ];
    const pool = agent.get('https://fixture.invalid');
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
      { choices: [{ delta: { content: '最终回答' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const state = initialState(), conversation = createConversation(state.settings), branch = conversation.branches[0], user = addMessage(conversation, branch, 'user', '测试多段回答'), answer = addMessage(conversation, branch, 'assistant', '');
    const result = await generate(connection('chat'), model, { ...branch.config, search: 'off', webFetch: 'off' }, [user], state.settings, new AbortController().signal, {
      text(text) { answer.text += text; appendAssistantSegment(answer, { type: 'text', text }); },
      reasoning(text) { answer.reasoning += text; appendAssistantSegment(answer, { type: 'reasoning', text }); },
      tool(event) { const old = answer.tools.findIndex(tool => tool.id === event.id); if (old < 0) answer.tools.push(event); else answer.tools[old] = event; appendAssistantSegment(answer, { type: 'tool', toolId: event.id }); }, sources() {}
    });
    assert.equal(result.text, '第一段正文第二段正文最终回答');
    assert.deepEqual(answer.segments, [
      { type: 'text', text: '第一段正文' }, { type: 'reasoning', text: '第一次思考' }, { type: 'tool', toolId: 'sequence-call' },
      { type: 'text', text: '第二段正文' }, { type: 'reasoning', text: '第二次思考' }, { type: 'text', text: '最终回答' }
    ]);
    assert.equal(answer.tools[0].status, 'error');
  } finally { await agent.close(); }
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
  assert.deepEqual(tools, ['pending','running','done']); assert.equal(result.sources[0].url, 'https://www.electronjs.org/docs');
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
for (const provider of ['ollama', 'tavily', 'firecrawl', 'anysearch'] as const) test(`${provider} web search sends authenticated queries and returns source snippets to the model`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  const toolName = provider === 'ollama' ? 'ollama_web_search' : provider === 'tavily' ? 'tavily_search' : provider === 'firecrawl' ? 'firecrawl_search' : 'anysearch_search';
  let firstBody: any, secondBody: any, searchBody: any, searchHeaders: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    firstBody = JSON.parse(String(options.body));
    return [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: `call-${provider}`, function: { name: toolName, arguments: '{"query":"provider search API"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const searchHost = provider === 'ollama' ? 'https://ollama.com' : provider === 'tavily' ? 'https://api.tavily.com' : provider === 'firecrawl' ? 'https://api.firecrawl.dev' : 'https://api.anysearch.com';
  const searchPath = provider === 'ollama' ? '/api/web_search' : provider === 'firecrawl' ? '/v2/search' : provider === 'anysearch' ? '/v1/search' : '/search';
  agent.get(searchHost).intercept({ path: searchPath, method: 'POST' }).reply(200, options => {
    searchBody = JSON.parse(String(options.body)); searchHeaders = options.headers;
    if (provider === 'firecrawl') return { success: true, data: { web: [{ title: `${provider} result`, url: 'https://example.com/result', markdown: 'Verified search snippet' }] } };
    if (provider === 'anysearch') return { code: 0, data: { results: [{ title: `${provider} result`, url: 'https://example.com/result', content: 'Verified search snippet' }] } };
    return { results: [{ title: `${provider} result`, url: 'https://example.com/result', content: 'Verified search snippet' }] };
  });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '根据搜索结果回答。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaResults = 4;
  if (provider === 'ollama') state.settings.connections.push({ id: 'ollama-cloud', name: 'Ollama Cloud', protocol: 'chat', baseUrl: 'https://ollama.com/', apiKey: 'ollama-fixture', headers: {}, timeout: 30, proxy: '' });
  else if (provider === 'tavily') state.settings.tavilyKey = 'tavily-fixture';
  else if (provider === 'firecrawl') state.settings.firecrawlKey = 'firecrawl-fixture';
  else state.settings.anysearchKey = 'anysearch-fixture';
  const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '请搜索');
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: provider }, c.messages, state.settings, new AbortController().signal);
  assert.equal(firstBody.tools[0].function.name, toolName);
  assert.equal(searchBody.query, 'provider search API'); assert.equal(searchBody.max_results ?? searchBody.limit, 4);
  if (provider === 'tavily') assert.equal(searchBody.search_depth, 'basic');
  if (provider === 'firecrawl') { assert.deepEqual(searchBody.sources, [{ type: 'web' }]); assert.deepEqual(searchBody.scrapeOptions.formats, ['markdown']); }
  if (provider === 'anysearch') assert.equal(searchBody.format, 'markdown');
  const expectedKey = provider === 'ollama' ? 'ollama-fixture' : `${provider}-fixture`;
  assert.match(JSON.stringify(searchHeaders), new RegExp(`Bearer ${expectedKey}`, 'i'));
  assert.match(secondBody.messages.at(-1).content, /Verified search snippet/);
  assert.equal(result.sources[0].url, 'https://example.com/result'); assert.equal(result.sources[0].title, `${provider} result`);
  await agent.close();
});
for (const provider of ['tavily', 'firecrawl', 'anysearch'] as const) test(`${provider} web search uses official keyless access when its API key is empty`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  const toolName = provider === 'tavily' ? 'tavily_search' : provider === 'firecrawl' ? 'firecrawl_search' : 'anysearch_search';
  let searchHeaders: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `keyless-${provider}`, function: { name: toolName, arguments: '{"query":"anonymous search"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const host = provider === 'tavily' ? 'https://api.tavily.com' : provider === 'firecrawl' ? 'https://api.firecrawl.dev' : 'https://api.anysearch.com';
  const path = provider === 'firecrawl' ? '/v2/search' : provider === 'anysearch' ? '/v1/search' : '/search';
  agent.get(host).intercept({ path, method: 'POST' }).reply(200, options => {
    searchHeaders = options.headers;
    if (provider === 'firecrawl') return { success: true, data: { web: [{ title: 'Keyless result', url: 'https://example.com/keyless', description: 'Anonymous Firecrawl result' }] } };
    if (provider === 'anysearch') return { code: 0, data: { results: [{ title: 'Keyless result', url: 'https://example.com/keyless', snippet: 'Anonymous AnySearch result' }] } };
    return { results: [{ title: 'Keyless result', url: 'https://example.com/keyless', content: 'Anonymous Tavily result' }] };
  });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
    { choices: [{ delta: { content: '免 Key 搜索完成。' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '请搜索');
  await generate(connection('chat'), model, { ...c.branches[0].config, search: provider }, c.messages, state.settings, new AbortController().signal);
  const rawHeaders = JSON.stringify(searchHeaders);
  assert.doesNotMatch(rawHeaders, /authorization/i);
  if (provider === 'tavily') assert.match(rawHeaders, /x-tavily-access-mode.{0,30}keyless/i);
  else assert.match(rawHeaders, /content-type/i);
  await agent.close();
});
test('web_fetch works independently of search and receives the selected reading mode', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let firstBody: any, secondBody: any, selectedMode: string | undefined;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    firstBody = JSON.parse(String(options.body));
    return [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fetch-only', function: { name: 'web_fetch', arguments: '{"url":"https://example.com/article"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '网页已读。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '请读网页');
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'off', webFetch: 'local' }, c.messages, state.settings, new AbortController().signal, undefined, async (url, _signal, _settings, mode) => {
    selectedMode = mode; return { url, title: 'Page', content: '# Page\n\nLocal Markdown.', contentType: 'text/markdown', truncated: false, provider: 'local' };
  });
  assert.deepEqual(firstBody.tools.map((tool: any) => tool.function.name), ['web_fetch', 'datetime']);
  assert.equal(selectedMode, 'local'); assert.equal(secondBody.messages.at(-1).tool_call_id, 'fetch-only');
  assert.match(secondBody.messages.at(-1).content, /Local Markdown/); assert.equal(result.sources[0].url, 'https://example.com/article');
  await agent.close();
});

test('web_fetch is offered beside search, records its source and returns Markdown to the model', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let firstBody: any, secondBody: any, fetched = '';
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    firstBody = JSON.parse(String(options.body));
    return [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'fetch-1', function: { name: 'web_fetch', arguments: '{"url":"https://example.com/article"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '根据网页正文回答。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaKey = 'fixture';
  const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '读取这篇文章'); const tools: string[] = [];
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'exa' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool: e => tools.push(e.status), sources() {} }, async (url) => {
    fetched = url; return { url, title: 'Fetched article', content: '# Article\n\nFull article body.', contentType: 'text/html', truncated: false };
  });
  assert.deepEqual(firstBody.tools.map((tool: any) => tool.function.name), ['exa_search', 'web_fetch', 'datetime']);
  assert.equal(fetched, 'https://example.com/article');
  const returned = secondBody.messages.at(-1);
  assert.equal(returned.role, 'tool'); assert.equal(returned.tool_call_id, 'fetch-1'); assert.match(returned.content, /Full article body/);
  assert.deepEqual(tools, ['pending', 'running', 'done']); assert.equal(result.sources[0].url, 'https://example.com/article');
  await agent.close();
});
for (const protocol of ['responses', 'anthropic'] as const) test(`${protocol} can call web_fetch and receive the converted page`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let firstBody: any, secondBody: any;
  const call = { type: 'function_call', call_id: 'fetch-2', name: 'web_fetch', arguments: '{"url":"https://example.com/page"}' };
  const firstFrames = protocol === 'responses' ? [
    { type: 'response.output_item.done', item: call },
    { type: 'response.completed', response: { output: [call], usage: { input_tokens: 12, output_tokens: 1 } } }
  ] : [
    { type: 'message_start', message: { usage: { input_tokens: 12 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'fetch-2', name: 'web_fetch', input: { url: 'https://example.com/page' } } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' }
  ];
  const finalFrames = protocol === 'responses' ? [
    { type: 'response.output_text.delta', delta: '已读取网页。' },
    { type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已读取网页。', annotations: [] }] }], usage: { input_tokens: 18, output_tokens: 3 } } }
  ] : [
    { type: 'message_start', message: { usage: { input_tokens: 18 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已读取网页。' } },
    { type: 'message_stop' }
  ];
  const path = protocol === 'responses' ? '/v1/responses' : '/v1/messages';
  pool.intercept({ path, method: 'POST' }).reply(200, options => { firstBody = JSON.parse(String(options.body)); return firstFrames.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''); }, { headers: { 'content-type': 'text/event-stream' } });
  pool.intercept({ path, method: 'POST' }).reply(200, options => { secondBody = JSON.parse(String(options.body)); return finalFrames.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''); }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaKey = 'fixture'; const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '打开文章');
  const result = await generate(connection(protocol), model, { ...c.branches[0].config, search: 'exa' }, c.messages, state.settings, new AbortController().signal, undefined, async url => ({ url, title: 'Page', content: '# Fetched page\n\nBody from Defuddle.', contentType: 'text/html', truncated: false }));
  if (protocol === 'responses') {
    assert.ok(firstBody.tools.some((tool: any) => tool.type === 'function' && tool.name === 'web_fetch'));
    assert.equal(secondBody.input.at(-1).type, 'function_call_output'); assert.match(secondBody.input.at(-1).output, /Body from Defuddle/);
  } else {
    assert.ok(firstBody.tools.some((tool: any) => tool.name === 'web_fetch'));
    assert.equal(secondBody.messages.at(-1).content[0].type, 'tool_result'); assert.match(secondBody.messages.at(-1).content[0].content, /Body from Defuddle/);
  }
  assert.equal(result.sources[0].url, 'https://example.com/page');
  await agent.close();
});

test('datetime is offered outside search and returns the machine clock without sources', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let firstBody: any, secondBody: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    firstBody = JSON.parse(String(options.body));
    return [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'clock-1', type: 'function', function: { name: 'datetime', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '现在是本机当前时间。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '现在几点');
  const tools: string[] = [];
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool: t => tools.push(t.status), sources() {} });
  assert.deepEqual(firstBody.tools.map((tool: any) => tool.function.name), ['datetime']);
  assert.equal(firstBody.messages[0].content, c.branches[0].config.system, '系统提示原样发送，不追加片段');
  assert.match(firstBody.tools[0].function.description, /不要凭记忆回答/, '要求调用 datetime 避免凭记忆作答，改由工具描述承担');
  const returned = secondBody.messages.at(-1);
  assert.equal(returned.role, 'tool'); assert.equal(returned.tool_call_id, 'clock-1');
  assert.match(returned.content, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 星期[日一二三四五六] \| .+ UTC[+-]\d{2}:\d{2} \| UTC \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.deepEqual(tools, ['pending', 'running', 'done']);
  assert.equal(result.sources.length, 0, 'a local clock reading is not a source');
  await agent.close();
});

for (const protocol of ['chat', 'responses', 'anthropic'] as const) test(`${protocol} declares search and web_fetch as untrusted content`, async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent); let body: any;
  const events = protocol === 'chat' ? [{ choices: [{ delta: { content: '好。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
    : protocol === 'responses' ? [{ type: 'response.output_text.delta', delta: '好。' }, { type: 'response.completed', response: { output: [], usage: { input_tokens: 1, output_tokens: 1 } } }]
    : [{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好。' } }, { type: 'content_block_stop', index: 0 }, { type: 'message_delta', usage: { output_tokens: 1 } }, { type: 'message_stop' }];
  const path = protocol === 'chat' ? 'chat/completions' : protocol === 'responses' ? 'responses' : 'messages';
  agent.get('https://fixture.invalid').intercept({ path: `/v1/${path}`, method: 'POST' }).reply(200, options => {
    body = JSON.parse(String(options.body)); return events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaKey = 'exa-fixture';
  const c = createConversation(state.settings), b = c.branches[0]; addMessage(c, b, 'user', '查一下');
  await generate(connection(protocol), model, { ...b.config, search: 'exa', webFetch: 'exa' }, c.messages, state.settings, new AbortController().signal, undefined,
    async url => ({ url, title: 'Page', content: 'body', contentType: 'text/html', truncated: false, provider: 'exa' }));
  // 系统提示由用户随意改写，外部资料提示必须长在工具描述里，改提示词才删不掉它。
  const declared = body.tools.map((tool: any) => tool.function ?? tool);
  const names = declared.map((tool: any) => tool.name);
  assert.ok(names.includes('exa_search') && names.includes('web_fetch'), `两种工具都应被声明：${names}`);
  const guarded = declared.filter((tool: any) => tool.name === 'exa_search' || tool.name === 'web_fetch');
  assert.equal(guarded.length, 2, `搜索与抓取工具都应被声明：${names}`);
  for (const tool of guarded) assert.match(tool.description, /外部资料/, `${protocol} 的 ${tool.name} 描述缺少外部资料提示`);
  await agent.close();
});
test('unknown tools are rejected softly once, then stop a repeating request', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  const round = (index: number) => [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: `junk-${index}`, type: 'function', function: { name: 'not_a_real_tool', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  for (let index = 0; index < 3; index++) pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, round(index), { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '你好');
  await assert.rejects(generate(connection('chat'), model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, new AbortController().signal), /重复请求不可用/);
  await agent.close();
});

test('a no-argument tool call is replayed with valid JSON arguments', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let secondBody: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
    // Gateways omit arguments entirely (or send an object) for tools that take none.
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'clock-1', type: 'function', function: { name: 'datetime' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '现在时间已获取。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '现在几点');
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, new AbortController().signal);
  const replayed = secondBody.messages[2].tool_calls[0].function;
  assert.equal(replayed.arguments, '{}', 'an empty argument string is invalid JSON for OpenAI-compatible gateways');
  assert.doesNotThrow(() => JSON.parse(replayed.arguments));
  assert.match(secondBody.messages.at(-1).content, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} 星期/);
  assert.equal(result.text, '现在时间已获取。'); assert.equal(result.sources.length, 0);
  await agent.close();
});

test('object-shaped tool arguments from a gateway are replayed as JSON text', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let secondBody: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-obj', type: 'function', function: { name: 'exa_search', arguments: { query: '广州天气' } } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  agent.get('https://api.exa.ai').intercept({ path: '/search', method: 'POST' }).reply(200, { results: [{ title: '天气', url: 'https://example.com/weather', text: '多云' }] });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '广州多云。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaKey = 'fixture'; const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '广州天气');
  await generate(connection('chat'), model, { ...c.branches[0].config, search: 'exa' }, c.messages, state.settings, new AbortController().signal);
  const replayed = secondBody.messages[2].tool_calls[0].function;
  assert.deepEqual(JSON.parse(replayed.arguments), { query: '广州天气' });
  await agent.close();
});

test('responses replays an empty function_call argument string as valid JSON', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let secondBody: any;
  const call = { type: 'function_call', call_id: 'clock-r', name: 'datetime', arguments: '' };
  pool.intercept({ path: '/v1/responses', method: 'POST' }).reply(200, [
    { type: 'response.output_item.done', item: call },
    { type: 'response.completed', response: { output: [call], usage: { input_tokens: 10, output_tokens: 1 } } }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  pool.intercept({ path: '/v1/responses', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ type: 'response.output_text.delta', delta: '已获取时间。' }, { type: 'response.completed', response: { output: [], usage: { input_tokens: 12, output_tokens: 2 } } }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '现在几点');
  await generate(connection('responses'), model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, new AbortController().signal);
  const replayed = secondBody.input.find((item: any) => item.type === 'function_call');
  assert.equal(replayed.arguments, '{}'); assert.doesNotThrow(() => JSON.parse(replayed.arguments));
  await agent.close();
});

test('attachments without stored bytes fall back to Markdown instead of an empty native part', () => {
  const state = initialState(), c = createConversation(state.settings), message = addMessage(c, c.branches[0], 'user', '看这个文件');
  const attachment = { id: crypto.randomUUID(), name: 'report.pdf', mime: 'application/pdf', size: 12, data: '', markdown: '# 转换后的正文' };
  message.attachments = [attachment];
  const pdfModel = { ...model, pdfInput: true };
  const input = buildInput('gemini', [message], pdfModel);
  assert.match(JSON.stringify(input), /转换后的正文/);
  assert.doesNotMatch(JSON.stringify(input), /inlineData/, 'a blob without bytes must never reach the provider');
  assert.doesNotMatch(JSON.stringify(input), /"data"/);
  attachment.markdown = '';
  assert.throws(() => buildInput('gemini', [message], pdfModel), /内容已缺失/);
});

test('stored raw entries are repaired when they are replayed', () => {
  const state = initialState(), c = createConversation(state.settings);
  const chatAnswer = addMessage(c, c.branches[0], 'assistant', '时间已获取');
  chatAnswer.status = 'complete';
  chatAnswer.raw = { protocol: 'chat', entries: [{ role: 'assistant', content: null, tool_calls: [{ id: 'clock', type: 'function', function: { name: 'datetime', arguments: '' } }] }] };
  const replayed = buildInput('chat', [chatAnswer])[0];
  assert.equal(replayed.tool_calls[0].function.arguments, '{}');
  const responsesAnswer = addMessage(c, c.branches[0], 'assistant', '时间已获取');
  responsesAnswer.status = 'complete';
  responsesAnswer.raw = { protocol: 'responses', entries: [{ type: 'function_call', call_id: 'clock', name: 'datetime', arguments: '' }] };
  assert.equal(buildInput('responses', [responsesAnswer])[0].arguments, '{}');
  const geminiAnswer = addMessage(c, c.branches[0], 'assistant', '时间已获取');
  geminiAnswer.status = 'complete';
  geminiAnswer.raw = { protocol: 'gemini', entries: [{ role: 'model', parts: [{ thought: true }, { text: '先想一下。', thoughtSignature: 'signed' }, { thoughtSignature: 'trailing' }] }] };
  const parts = buildInput('gemini', [geminiAnswer])[0].parts;
  assert.deepEqual(parts.map((part: any) => Object.keys(part).filter(key => ['text', 'inlineData', 'functionCall'].includes(key))), [['text']]);
  assert.equal(parts[0].thoughtSignature, 'signed');
});

test('parallel tool calls that reuse one index stay separate calls', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let secondBody: any;
  // New API converts Gemini function calls into one chunk where every call reports index 0 and no
  // id; merging them by index produced "datetimeexa_search" with concatenated arguments.
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
    { choices: [{ delta: { tool_calls: [
      { index: 0, type: 'function', function: { name: 'datetime', arguments: '{}' } },
      { index: 0, type: 'function', function: { name: 'exa_search', arguments: '{"query":"广州实时天气"}' } },
      { index: 0, type: 'function', function: { name: 'exa_search', arguments: '{"query":"亚运会奖牌榜"}' } }
    ] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  agent.get('https://api.exa.ai').intercept({ path: '/search', method: 'POST' }).reply(200, { results: [{ title: '结果', url: 'https://example.com/one', text: '第一条' }] }).times(2);
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '已经查好了。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaKey = 'fixture'; const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '现在几点，广州下雨吗，奖牌榜呢');
  const events: Array<{ id: string; name: string; status: string }> = [];
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'exa' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool: t => events.push(t), sources() {} });
  const replayed = secondBody.messages[2].tool_calls;
  assert.deepEqual(replayed.map((call: any) => call.function.name), ['datetime', 'exa_search', 'exa_search']);
  assert.deepEqual(replayed.map((call: any) => JSON.parse(call.function.arguments)), [{}, { query: '广州实时天气' }, { query: '亚运会奖牌榜' }]);
  assert.equal(new Set(replayed.map((call: any) => call.id)).size, 3, '每个调用都必须有独立 id');
  for (const call of replayed) assert.ok(call.id, '回灌的 tool_call 必须带 id');
  const results = secondBody.messages.slice(-3);
  assert.deepEqual(results.map((message: any) => message.role), ['tool', 'tool', 'tool']);
  assert.deepEqual(results.map((message: any) => message.tool_call_id), replayed.map((call: any) => call.id));
  assert.equal(results[0].content.startsWith('20'), true, 'datetime 返回本机时间');
  assert.match(results[1].content, /第一条/);
  assert.equal(result.sources.length, 1);
  assert.equal(new Set(events.filter(event => event.status === 'pending').map(event => event.id)).size, 3, '三个调用各自有独立的待执行事件');
  assert.equal(events.filter(event => event.name === 'datetime').length, 3, 'datetime 经历 pending/running/done');
  assert.equal(events.filter(event => event.name === 'exa_search').length, 6, '两个搜索调用各自经历 pending/running/done');
  await agent.close();
});

test('fragmented arguments under one index still merge into a single call', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let secondBody: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-frag', type: 'function', function: { name: 'exa_search', arguments: '{"query"' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':"广州天气"}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  agent.get('https://api.exa.ai').intercept({ path: '/search', method: 'POST' }).reply(200, { results: [{ title: '天气', url: 'https://example.com/weather', text: '多云' }] });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '广州多云。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaKey = 'fixture'; const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '广州天气');
  await generate(connection('chat'), model, { ...c.branches[0].config, search: 'exa' }, c.messages, state.settings, new AbortController().signal);
  const replayed = secondBody.messages[2].tool_calls;
  assert.equal(replayed.length, 1);
  assert.deepEqual(JSON.parse(replayed[0].function.arguments), { query: '广州天气' });
  assert.equal(replayed[0].id, 'call-frag');
  await agent.close();
});

test('debug headers mask built-in and custom credential headers', () => {
  const masked = debugHeaders({ ...connection('anthropic'), headers: { 'X-Tenant': 'acme' } }, {
    'content-type': 'application/json', authorization: 'Bearer fixture-only', 'x-api-key': 'fixture-only',
    'x-goog-api-key': 'fixture-only', 'x-tenant': 'acme', 'anthropic-version': '2023-06-01'
  });
  assert.deepEqual(masked, {
    'content-type': 'application/json', authorization: '••••••••', 'x-api-key': '••••••••',
    'x-goog-api-key': '••••••••', 'x-tenant': '••••••••', 'anthropic-version': '2023-06-01'
  });
});

test('debug records carry the redacted request and attach upstream failures', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '现在几点');
  const chat = { ...connection('chat'), headers: { 'x-trace': 'trace-fixture' } };
  try {
    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
      { choices: [{ delta: { content: '不知道。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const ok: RequestRecord[] = [];
    await generate(chat, model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool() {}, sources() {}, record: entry => ok.push(entry) });
    assert.equal(ok.length, 1);
    const [sent] = ok;
    assert.match(sent.url, /\/v1\/chat\/completions$/); assert.equal(sent.method, 'POST');
    assert.equal(sent.headers.Authorization, '••••••••', 'API Key 不得出现在调试记录里');
    assert.equal(sent.headers['x-trace'], '••••••••', '自定义请求头按密钥处理');
    assert.equal(sent.headers['Content-Type'], 'application/json');
    assert.equal(JSON.parse(sent.body).messages.at(-1).content, '现在几点');
    assert.equal(sent.error, undefined);

    pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(400, { error: { message: 'invalid arguments' } });
    const failed: RequestRecord[] = [];
    await assert.rejects(generate(chat, model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool() {}, sources() {}, record: entry => failed.push(entry) }), /服务请求失败/);
    assert.equal(failed.length, 1);
    assert.match(failed[0].error!, /^400 /); assert.match(failed[0].error!, /invalid arguments/);
    assert.equal(JSON.parse(failed[0].body).model, 'fixture');
  } finally { await agent.close(); }
});

test('debug records collapse attachment bytes instead of storing them', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://fixture.invalid'); pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, [
      { choices: [{ delta: { content: '看到了。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    const state = initialState(), c = createConversation(state.settings), message = addMessage(c, c.branches[0], 'user', '看看这张图');
    message.attachments = [{ id: crypto.randomUUID(), name: 'shot.png', mime: 'image/png', size: 4096, data: `data:image/png;base64,${'A'.repeat(4096)}` }];
    const records: RequestRecord[] = [];
    await generate(connection('chat'), model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning() {}, tool() {}, sources() {}, record: entry => records.push(entry) });
    const body = records[0].body;
    assert.doesNotMatch(body, /A{64}/, 'base64 数据不应进入调试记录');
    assert.match(body, /data:image\/png;base64,<已省略 \d+ 字符的 base64 数据>/);
    assert.match(body, /image_url/, '附件所在的结构必须完整保留');
    assert.ok(body.length < 4000, `记录应保持精简，实际 ${body.length}`);
  } finally { await agent.close(); }
});

test('request diagnostics record what was sent and what the upstream answered', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const directory = mkdtempSync(join(tmpdir(), 'deepchan-dump-')), previous = process.env.DEEPCHAN_DEBUG_REQUESTS;
  process.env.DEEPCHAN_DEBUG_REQUESTS = directory;
  try {
    agent.get('https://fixture.invalid').intercept({ path: '/v1/models', method: 'GET' }).reply(200, { data: [] });
    const ok = await request(connection('chat'), 'models', undefined, new AbortController().signal); await ok.response.json(); ok.close();
    agent.get('https://fixture.invalid').intercept({ path: '/v1/responses', method: 'POST' }).reply(400, { error: { message: 'Please enable tool_config.include_server_side_tool_invocations' } });
    await assert.rejects(request(connection('responses'), 'responses', { model: 'm' }, new AbortController().signal), /include_server_side_tool_invocations/);
    const files = readdirSync(directory).sort();
    // The failing request is recorded twice: what was sent, plus the upstream answer for it.
    // File names carry a timestamp and a random suffix, so pick by content, never by sort order.
    const errors = files.filter(name => name.startsWith('error-'));
    const requests = files.filter(name => name.startsWith('request-')).map(name => JSON.parse(readFileSync(join(directory, name), 'utf8')) as { url: string; error?: string });
    assert.equal(errors.length, 1); assert.equal(requests.length, 2);
    const sent = requests.find(item => /\/v1\/models$/.test(item.url));
    assert.ok(sent, `成功的请求也应被记录：${requests.map(item => item.url).join(', ')}`); assert.equal(sent.error, undefined);
    const failed = JSON.parse(readFileSync(join(directory, errors[0]), 'utf8'));
    assert.match(failed.url, /\/v1\/responses$/);
    assert.match(failed.error, /^400 /); assert.match(failed.error, /include_server_side_tool_invocations/);
    assert.deepEqual(failed.body, { model: 'm' });
  } finally {
    if (previous === undefined) delete process.env.DEEPCHAN_DEBUG_REQUESTS; else process.env.DEEPCHAN_DEBUG_REQUESTS = previous;
    rmSync(directory, { recursive: true, force: true }); await agent.close();
  }
});

test('background requests disable local tools so title and compression stay single round', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  let body: any;
  agent.get('https://fixture.invalid').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    body = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '标题' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '你好');
  await generate(connection('chat'), model, { ...c.branches[0].config, search: 'off', webFetch: 'off', localTools: false }, c.messages, state.settings, new AbortController().signal);
  assert.equal(body.tools, undefined);
  assert.doesNotMatch(body.messages[0].content, /datetime/);
  await agent.close();
});

test('a connection proxy is used for its own requests', async () => {
  // A real (localhost) proxy proves the wiring without touching the network: undici tunnels through
  // CONNECT even for plain http targets, so the test proxy implements that tunnel.
  const target = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ data: [{ id: 'through-proxy' }] })); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const targetPort = (target.address() as AddressInfo).port;
  const tunnels: string[] = [];
  const proxy = createServer();
  proxy.on('connect', (request, clientSocket, head) => {
    tunnels.push(request.url || '');
    const [host, port] = (request.url || '').split(':');
    const upstream = connect(Number(port), host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket); clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = (proxy.address() as AddressInfo).port;
  setGlobalDispatcher(new Agent());
  try {
    const configured = { ...connection('chat'), apiKey: '', baseUrl: `http://127.0.0.1:${targetPort}/v1`, proxy: `http://127.0.0.1:${proxyPort}` };
    assert.deepEqual((await listModels(configured)).map(model => model.id), ['through-proxy']);
    assert.deepEqual(tunnels, [`127.0.0.1:${targetPort}`], '请求必须经由代理的 CONNECT 隧道');
  } finally {
    setGlobalDispatcher(new Agent());
    await new Promise(resolve => target.close(resolve)); await new Promise(resolve => proxy.close(resolve));
  }
});

test('an aborted signal stops a request instead of hanging', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const controller = new AbortController();
    controller.abort();
    const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '你好');
    await assert.rejects(generate(connection('chat'), model, { ...c.branches[0].config, search: 'off', webFetch: 'off' }, c.messages, state.settings, controller.signal), /abort/i);
  } finally { await agent.close(); }
});

test('a described model list keeps names, limits and modalities', () => {
  // The shape DeepSeek documents for GET /models.
  assert.deepEqual(parseServerModel({
    id: 'deepseek-chat', object: 'model', owned_by: 'deepseek', name: 'DeepSeek Chat',
    context_window: 128_000, max_output_tokens: 8_192, input_modalities: ['text', 'image'], output_modalities: ['text'],
    effort: { supported_levels: ['low', 'high'], default_level: 'high' },
    api_capabilities: { anthropic_messages: { system_prompt_update: 'leading-only' } }
  }), {
    id: 'deepseek-chat', name: 'DeepSeek Chat', contextWindow: 128_000, maxOutput: 8_192,
    inputModalities: ['text', 'image'], outputModalities: ['text'], efforts: ['low', 'high'], defaultEffort: 'high'
  });
  // none is a first-class level that actually turns thinking off (DeepSeek and Ollama both define
  // it that way), so it must survive parsing rather than be folded into auto.
  assert.deepEqual(parseServerModel({ id: 'deepseek-flash', effort: { supported_levels: ['none', 'low', 'high', 'max'] } }),
    { id: 'deepseek-flash', efforts: ['none', 'low', 'high', 'max'] });
  assert.deepEqual(parseServerModel({ id: 'gemma4:31b', effort: { supported_levels: ['none', 'low'], default_level: 'low' } }), { id: 'gemma4:31b', efforts: ['none', 'low'], defaultEffort: 'low' });
  // A plain OpenAI entry describes nothing beyond its id.
  assert.deepEqual(parseServerModel({ id: 'gpt-4o', object: 'model', created: 1, owned_by: 'openai' }), { id: 'gpt-4o' });
  // Camel case gateways and bare strings are accepted, and display names win over resource names.
  assert.deepEqual(parseServerModel({ id: 'x', displayName: 'X 展示名', contextWindow: 200_000, maxOutputTokens: 4_096, inputModalities: ['text'] }), { id: 'x', name: 'X 展示名', contextWindow: 200_000, maxOutput: 4_096, inputModalities: ['text'] });
  assert.deepEqual(parseServerModel('plain-model'), { id: 'plain-model' });
  // Anthropic entries carry an id plus a display name; an entry without any id is useless but safe.
  assert.deepEqual(parseServerModel({ id: 'claude-x', display_name: 'Claude 展示名', created_at: 1, type: 'model' }), { id: 'claude-x', name: 'Claude 展示名' });
  assert.deepEqual(parseServerModel({ display_name: '仅展示名' }), { id: '', name: '仅展示名' });
  // Values that make no sense are dropped instead of being trusted.
  assert.deepEqual(parseServerModel({ id: 'odd', context_window: -5, max_output_tokens: 'many', input_modalities: 'text', output_modalities: [], effort: { supported_levels: [] } }), { id: 'odd' });
  assert.deepEqual(parseServerModel(null), { id: '' });
});

test('deepseek search uses its own endpoint and prefers summary over snippet', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  let firstBody: any, searchBody: any, searchHeaders: any, toolResult = '';
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    firstBody = JSON.parse(String(options.body));
    return [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-deepseek', function: { name: 'deepseek_search', arguments: '{"query":"deepseek search API"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  agent.get('https://api.deepseek.com').intercept({ path: '/v1/tools/search', method: 'POST' }).reply(200, options => {
    searchBody = JSON.parse(String(options.body)); searchHeaders = options.headers;
    // need_content 未开启时 content 恒为空串；summary 是文档标注"适用于给模型阅读"的字段。
    return { results: [{ title: 'DeepSeek result', url: 'https://example.com/result', snippet: '短摘要', summary: 'DeepSeek 长摘要', content: '' }] };
  });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    toolResult = String(JSON.parse(String(options.body)).messages.at(-1).content);
    return [{ choices: [{ delta: { content: '根据搜索结果回答。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.exaResults = 3;
  state.settings.deepseekKey = 'deepseek-fixture';
  const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '请搜索');
  const result = await generate(connection('chat'), model, { ...c.branches[0].config, search: 'deepseek' }, c.messages, state.settings, new AbortController().signal);
  assert.equal(firstBody.tools[0].function.name, 'deepseek_search', 'DeepSeek 搜索的工具名');
  assert.equal(searchBody.query, 'deepseek search API');
  assert.equal(searchBody.count, 3, 'count 只影响条数，不影响单次价格');
  assert.equal(searchBody.need_content, false, '默认只要 summary，正文交给 Fetch');
  assert.match(JSON.stringify(searchHeaders), /Bearer deepseek-fixture/i);
  assert.match(toolResult, /DeepSeek 长摘要/, '应优先把 summary 送进上下文而不是 snippet');
  assert.doesNotMatch(toolResult, /短摘要/);
  assert.equal(result.sources[0].url, 'https://example.com/result');
  await agent.close();
});

test('deepseek search falls back to the connection key and reports an empty balance', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    const body = JSON.parse(String(options.body));
    // 工具结果回灌后模型应当收尾；否则会一直重复调用同一个失败的工具。
    if (body.messages.at(-1)?.role === 'tool') return [{ choices: [{ delta: { content: '没有搜索到结果。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
    return [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-deepseek', function: { name: 'deepseek_search', arguments: '{"query":"余额"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } }).persist();
  let searchHeaders: any;
  agent.get('https://api.deepseek.com').intercept({ path: '/v1/tools/search', method: 'POST' }).reply(402, options => { searchHeaders = options.headers; return { error: { message: 'insufficient balance' } }; });
  const state = initialState();
  // 没有单独填密钥时复用主机名为 api.deepseek.com 的连接密钥，与 Ollama Cloud 搜索一致。
  state.settings.connections.push({ id: 'deepseek', name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'deepseek-connection-key', headers: {}, timeout: 30, proxy: '' });
  const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '请搜索');
  const events: any[] = [];
  const hooks = { text() {}, reasoning() {}, tool: (t: any) => events.push({ ...t }), sources() {}, notice() {}, record() {} };
  await generate(connection('chat'), model, { ...c.branches[0].config, search: 'deepseek' }, c.messages, state.settings, new AbortController().signal, hooks);
  // 402 会被转成工具错误回灌给模型，而不是中断整个回答。
  const failed = events.filter(event => event.status === 'error');
  assert.equal(failed.length, 1, '402 应作为工具错误回灌');
  assert.match(failed[0].output, /余额不足/);
  assert.match(JSON.stringify(searchHeaders), /Bearer deepseek-connection-key/i, '应复用 DeepSeek 连接密钥');
  await agent.close();
});

test('deepseek search returns page bodies when the setting asks for them', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid');
  const turn = (body: any) => body.messages.at(-1)?.role === 'tool'
    ? [{ choices: [{ delta: { content: '已阅读正文。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }]
    : [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-ds', function: { name: 'deepseek_search', arguments: '{"query":"正文"}' } }] } }] },
       { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
  let searchBody: any, toolResult = '';
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => turn(JSON.parse(String(options.body))).map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  agent.get('https://api.deepseek.com').intercept({ path: '/v1/tools/search', method: 'POST' }).reply(200, options => {
    searchBody = JSON.parse(String(options.body));
    // need_content 开启时 content 才有内容，而解析链里 content 排在 summary 之前。
    return { results: [{ title: 'DeepSeek result', url: 'https://example.com/result', snippet: '短摘要', summary: '长摘要', content: '网页正文全文' }] };
  });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    toolResult = String(JSON.parse(String(options.body)).messages.at(-1).content);
    return turn({ messages: [{ role: 'tool' }] }).map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(); state.settings.deepseekKey = 'deepseek-fixture';
  state.settings.deepseekNeedContent = true;
  const c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '请搜索');
  await generate(connection('chat'), model, { ...c.branches[0].config, search: 'deepseek' }, c.messages, state.settings, new AbortController().signal);
  assert.equal(searchBody.need_content, true, '开关开启后应请求网页正文');
  assert.equal(searchBody.count, 10, '未单独设置时使用默认结果数');
  assert.match(toolResult, /网页正文全文/, '开启后正文优先于 summary');
  await agent.close();
});

test('Ollama thinking arrives under delta.reasoning, not reasoning_content', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  const pool = agent.get('https://fixture.invalid'); let firstBody: any, secondBody: any;
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    firstBody = JSON.parse(String(options.body));
    // Ollama 的 OpenAI 兼容端点把思考放在 reasoning 字段，DeepSeek 等用 reasoning_content。
    return [
      { choices: [{ delta: { reasoning: 'Confirm the capital first.' } }] },
      // 带一次工具调用，才能走第二轮并验证思考内容的回放。
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'clock-o', type: 'function', function: { name: 'datetime', arguments: '{}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  pool.intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    secondBody = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: 'Canberra.' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '澳大利亚首都在哪');
  const reasoning: string[] = [];
  const gemma = { ...model, model: 'gemma4:31b', reasoning: 'effort' as const, efforts: ['none', 'low', 'medium', 'high'] };
  const result = await generate(connection('chat'), gemma, { ...c.branches[0].config, search: 'off', webFetch: 'off', effort: 'low' }, c.messages, state.settings, new AbortController().signal, { text() {}, reasoning: s => reasoning.push(s), tool() {}, sources() {} });
  assert.equal(firstBody.reasoning_effort, 'low', 'Ollama 通过 reasoning_effort 控制思考');
  assert.equal(reasoning.join(''), 'Confirm the capital first.', 'Ollama 的 reasoning 字段必须被当成思考内容读出来');
  assert.equal(result.reasoning, 'Confirm the capital first.');
  assert.equal(result.text, 'Canberra.');
  // 回放时用标准的 reasoning_content，避免把 Ollama 的 reasoning 字段原样塞回去。
  const replayed = secondBody.messages.findLast((m: any) => m.role === 'assistant');
  assert.equal(replayed.reasoning_content, 'Confirm the capital first.');
  assert.equal(replayed.reasoning, undefined, '不要把 Ollama 的字段名带进回放请求');
  await agent.close();
});

test('reasoning_effort none is sent when the user turns thinking off', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  let body: any;
  agent.get('https://fixture.invalid').intercept({ path: '/v1/chat/completions', method: 'POST' }).reply(200, options => {
    body = JSON.parse(String(options.body));
    return [{ choices: [{ delta: { content: '好。' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }].map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  }, { headers: { 'content-type': 'text/event-stream' } });
  const state = initialState(), c = createConversation(state.settings); addMessage(c, c.branches[0], 'user', '你好');
  const gemma = { ...model, model: 'gemma4:31b', reasoning: 'effort' as const, efforts: ['none', 'low', 'medium', 'high'] };
  await generate(connection('chat'), gemma, { ...c.branches[0].config, search: 'off', webFetch: 'off', effort: 'none' }, c.messages, state.settings, new AbortController().signal);
  assert.equal(body.reasoning_effort, 'none', 'auto 是"不发字段"（服务会自行开启），none 才是明确关闭');
  await agent.close();
});
