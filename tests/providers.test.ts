import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, setGlobalDispatcher } from 'undici';
import { buildInput, endpoint, generate, sse } from '../electron/providers';
import { addMessage, createConversation, initialState } from '../src/domain';
import type { Connection, Model } from '../src/types';
const connection = (protocol: Connection['protocol']): Connection => ({ id: 'c', name: 'Mock', protocol, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only', headers: {}, timeout: 10, proxy: '' });
const model: Model = { id: 'm', connectionId: 'c', name: 'Mock', model: 'fixture', contextWindow: 100000, maxOutput: 4096, vision: true, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true };
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
