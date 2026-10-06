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
    const result = await generate(connection, model, { ...branch.config, search: 'off', effort: 'low', system: '你是图像助手。' }, conversation.messages, state.settings, new AbortController().signal);
    assert.equal(body.systemInstruction.parts[0].text, '你是图像助手。'); assert.deepEqual(body.generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: 'LOW' });
    assert.deepEqual(body.contents[0].parts[0], { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } });
    assert.equal(result.text, '图片中有树。'); assert.equal(result.reasoning, '观察图片。'); assert.deepEqual(result.usage, { input: 10, output: 7 });
    const answer = addMessage(conversation, branch, 'assistant', result.text); answer.status = 'complete'; answer.raw = result.raw;
    assert.equal(buildInput('gemini', [answer])[0].parts[1].thoughtSignature, 'signed-text');
    answer.edited = true; assert.deepEqual(buildInput('gemini', [answer]), [{ role: 'model', parts: [{ text: result.text }] }]);
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
    assert.deepEqual(body.tools, [{ googleSearch: {} }]); assert.equal(result.sources[0].title, 'Electron'); assert.equal(tools[0].name, 'google_search'); assert.equal(tools[0].status, 'done');
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
test('Gemini model discovery paginates, filters unsupported models and strips models/ prefixes', async () => {
  const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
  try {
    const pool = agent.get('https://gemini.fixture.invalid');
    pool.intercept({ path: '/v1beta/models?pageSize=1000', method: 'GET' }).reply(200, { models: [{ name: 'models/gemini-a', supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }], nextPageToken: 'next page' });
    pool.intercept({ path: '/v1beta/models?pageSize=1000&pageToken=next%20page', method: 'GET' }).reply(200, { models: [{ name: 'models/gemini-b', supportedGenerationMethods: ['generateContent'] }] });
    assert.deepEqual(await listModels(connection), ['gemini-a', 'gemini-b']);
  } finally { await agent.close(); }
});
