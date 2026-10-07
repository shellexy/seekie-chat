import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Model } from '../src/types';
import { uid } from '../src/domain';
import type { Message } from '../src/types';
import { addMessage, appendAssistantSegment, appendReasoningDuration, compressionCut, contextMessages, createConversation, defaultModelEfforts, editMessage, estimateTokens, fork, initialState, messageDateTime, messageModelLabel, sameMessage, pathTo, removeBranch, shouldDefaultVisionAndTools, uniqueBranchName } from '../src/domain';
function fixture() {
  const c = createConversation(initialState().settings), b = c.branches[0];
  const u = addMessage(c, b, 'user', '比较桌面框架'); const a = addMessage(c, b, 'assistant', 'Electron 和 Tauri'); a.status = 'complete';
  return { c, b, u, a };
}
test('new model thinking levels use sensible defaults when the model is unknown', () => {
  assert.deepEqual(defaultModelEfforts('chat', 'local-custom-model'), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(defaultModelEfforts('chat', 'deepseek-v4'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(defaultModelEfforts('gemini', 'gemini-fixture'), ['minimal', 'low', 'medium', 'high']);
});
test('GPT and DeepSeek Flash names default to vision and tool support', () => {
  for (const name of ['gpt-4o', 'GPT-5', 'openai/gpt-4.1', 'gpt-oss-120b', 'models/deepseek-flash', 'deepseek/deepseek-flash-v2', 'DeepSeek Flash']) assert.equal(shouldDefaultVisionAndTools(name), true, name);
  for (const name of ['deepseek-r1', 'local-custom-model']) assert.equal(shouldDefaultVisionAndTools(name), false, name);
});
test('assistant stream segments keep event order while merging adjacent chunks and deduplicating tool updates', () => {
  const { a } = fixture();
  appendAssistantSegment(a, { type: 'text', text: '第一段' }); appendAssistantSegment(a, { type: 'text', text: '正文' });
  appendAssistantSegment(a, { type: 'reasoning', text: '第一次思考' }); appendAssistantSegment(a, { type: 'reasoning', text: '继续思考' });
  appendAssistantSegment(a, { type: 'tool', toolId: 'search-1' }); appendAssistantSegment(a, { type: 'tool', toolId: 'search-1' });
  appendAssistantSegment(a, { type: 'text', text: '第二段正文' }); appendAssistantSegment(a, { type: 'reasoning', text: '第二次思考' });
  assert.deepEqual(a.segments, [
    { type: 'text', text: '第一段正文' }, { type: 'reasoning', text: '第一次思考继续思考' },
    { type: 'tool', toolId: 'search-1' }, { type: 'text', text: '第二段正文' }, { type: 'reasoning', text: '第二次思考' }
  ]);
});
test('token estimates prefer reported assistant output and use the lightweight text and image fallback', () => {
  const { u, a } = fixture();
  u.text = 'a中';
  assert.equal(estimateTokens([u]), 13, 'ASCII and non-ASCII characters use 0.3 and 0.6 token estimates, plus message framing');
  u.text = '';
  u.attachments = [{ id: 'image', name: 'image.png', mime: 'image/png', size: 1, data: '' }];
  assert.equal(estimateTokens([u]), 196, 'a native image is estimated at 184 tokens plus message framing');
  a.usage = { input: 999, output: 77 };
  a.tools = [{ id: 'tool', name: 'web_fetch', input: '{}', output: 'x'.repeat(10), status: 'done', started: 0 }];
  assert.equal(estimateTokens([a]), 92, 'reported request input is not attributed to one message; exact output and estimated tool result are counted');
  a.usage.estimated = true;
  assert.equal(estimateTokens([a]), 21, 'estimated usage falls back to message text and tool arguments');
});
test('history compression retains at least two rounds and grows the suffix to 10% or 50k tokens', () => {
  const c = createConversation(initialState().settings), branch = c.branches[0];
  for (let turn = 0; turn < 7; turn++) {
    addMessage(c, branch, 'user', '问'.repeat(8000));
    const answer = addMessage(c, branch, 'assistant', '答'.repeat(8000)); answer.status = 'complete';
  }
  const path = pathTo(c, branch.leafId);
  const millionWindowCut = compressionCut(path, 1_000_000);
  assert.equal(millionWindowCut, 2, '50k budget should retain enough recent turns to reach the target');
  assert.equal(path[millionWindowCut].role, 'user');
  assert.ok(estimateTokens(path.slice(millionWindowCut)) >= 50_000);
  const mediumWindowCut = compressionCut(path, 320_000);
  assert.equal(mediumWindowCut, 6, '10% of a 320k context should retain four rounds');
  assert.ok(estimateTokens(path.slice(mediumWindowCut)) >= 32_000);
  const smallWindowCut = compressionCut(path, 100_000);
  assert.equal(smallWindowCut, 10, 'two rounds remain even when they exceed the 10% budget');
  assert.ok(estimateTokens(path.slice(smallWindowCut)) > 10_000);
});
test('forks share the selected prefix and isolate subsequent context', () => {
  const { c, b, a } = fixture(); addMessage(c, b, 'user', '原有后续');
  const first = fork(c, a.id, 'Electron'); addMessage(c, first, 'user', '讨论 Electron');
  c.activeBranchId = b.id; const second = fork(c, a.id, 'Tauri'); addMessage(c, second, 'user', '讨论 Tauri');
  assert.deepEqual(contextMessages(c, first).messages.map(m => m.text), ['比较桌面框架', 'Electron 和 Tauri', '讨论 Electron']);
  assert.deepEqual(contextMessages(c, second).messages.map(m => m.text), ['比较桌面框架', 'Electron 和 Tauri', '讨论 Tauri']);
  assert.equal(pathTo(c, b.leafId).at(-1)?.text, '原有后续');
});
test('editing a shared node preserves other branches and invalidates its summary', () => {
  const { c, b, u, a } = fixture(); const branch = fork(c, a.id);
  branch.summary = { text: '旧摘要', nodeIds: [u.id, a.id], modelId: '', created: Date.now() };
  const result = editMessage(c, u.id, '新的问题');
  assert.equal(result.message.parentId, null); assert.equal(result.message.edited, true);
  assert.equal(result.branch.summary, undefined); assert.equal(pathTo(c, b.leafId)[0].text, '比较桌面框架');
  assert.equal(contextMessages(c, branch).summary, '旧摘要');
});
test('summary from a sibling path cannot leak into a regenerated answer', () => {
  const { c, b, u, a } = fixture(); b.summary = { text: '旧回答摘要', nodeIds: [u.id, a.id], modelId: '', created: 1 };
  const alternative = addMessage(c, b, 'assistant', '不同回答', u.id); alternative.status = 'complete';
  assert.equal(contextMessages(c, b).summary, '');
  assert.equal(contextMessages(c, b).messages.at(-1)?.text, '不同回答');
});
test('deleting a child branch preserves shared nodes and remaining conversation', () => {
  const { c, b, a } = fixture(); const child = fork(c, a.id); const reply = addMessage(c, child, 'assistant', '子回答'); reply.status = 'complete'; const grandchild = fork(c, reply.id);
  removeBranch(c, child.id); assert.equal(c.branches.length, 1); assert.equal(c.branches[0].id, b.id); assert.ok(c.messages.some(m => m.id === a.id)); assert.ok(!c.branches.some(b => b.id === grandchild.id));
  assert.throws(() => removeBranch(c, b.id), /最后一个/);
});
test('unfinished answers cannot be forked and cycles are rejected', () => {
  const { c, a } = fixture(); a.status = 'streaming'; assert.throws(() => fork(c, a.id), /已完成/);
  a.parentId = a.id; assert.throws(() => pathTo(c, a.id), /循环/);
});
test('new chats enable automatic search and select only available providers', async () => {
  const { resolveSearch } = await import('../src/domain');
  const state = initialState();
  state.settings.connections = [{ id: 'c', name: 'fixture', protocol: 'responses', baseUrl: 'https://fixture.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }];
  state.settings.models = [{ id: 'm', connectionId: 'c', name: 'fixture', model: 'fixture', contextWindow: 10000, maxOutput: 4096, vision: false, tools: true, nativeSearch: true, reasoning: 'none', efforts: [], temperature: false }];
  state.settings.defaultModel = 'm';
  const conversation = createConversation(state.settings);
  assert.equal(conversation.branches[0].config.search, 'auto');
  assert.equal(conversation.branches[0].config.temperature, 1);
  assert.equal(conversation.branches[0].config.topP, 1);
  assert.equal(conversation.archived, false);
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'native');
  state.settings.connections[0].protocol = 'chat';
  state.settings.exaKey = 'fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'exa');
  state.settings.exaKey = '';
  state.settings.tavilyKey = 'tavily-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'tavily');
  state.settings.tavilyKey = '';
  state.settings.ollamaKey = 'ollama-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'ollama');
  state.settings.ollamaKey = '';
  state.settings.connections.push({ id: 'ollama', name: 'Ollama Cloud', protocol: 'chat', baseUrl: 'https://ollama.com/', apiKey: 'connection-key', headers: {}, timeout: 30, proxy: '' });
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'ollama');
  assert.equal(resolveSearch(state.settings, 'm', 'tavily'), 'tavily');
  state.settings.connections.pop();
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'firecrawl');
  state.settings.anysearchKey = 'anysearch-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'anysearch');
  state.settings.firecrawlKey = 'firecrawl-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'firecrawl');
  state.settings.tavilyKey = 'tavily-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'firecrawl');
  state.settings.firecrawlKey = '';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'anysearch');
  state.settings.anysearchKey = '';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'tavily');
  state.settings.tavilyKey = '';
  assert.equal(resolveSearch(state.settings, 'm', 'off'), 'off');
});

test('prompt presets are copied into new chats and branches rather than live-linked', () => {
  const settings = initialState().settings;
  settings.defaultPromptPresetId = 'coding';
  const c = createConversation(settings), b = c.branches[0], prompt = settings.promptPresets.find(p => p.id === 'coding')!;
  assert.equal(b.config.system, prompt.content);
  const a = addMessage(c, b, 'assistant', '回答'); a.status = 'complete';
  const child = fork(c, a.id); prompt.content = '后来修改的角色'; settings.promptPresets = [];
  assert.equal(child.config.system, b.config.system); assert.notEqual(b.config.system, prompt.content);
  child.config.system = '分支自己的提示词'; assert.notEqual(child.config.system, b.config.system);
});
test('old settings receive a prompt library without changing existing conversation prompts', async () => {
  const { normalizePromptSettings } = await import('../src/domain');
  const settings = initialState().settings, c = createConversation(settings); c.branches[0].config.system = '用户自己的旧提示词';
  delete (settings as any).promptPresets; delete (settings as any).defaultPromptPresetId;
  normalizePromptSettings(settings); assert.equal(settings.promptPresets.length, 4); assert.equal(c.branches[0].config.system, '用户自己的旧提示词');
  settings.promptPresets = []; settings.defaultPromptPresetId = ''; normalizePromptSettings(settings);
  assert.equal(settings.promptPresets.length, 0);
});

test('each reasoning segment records its own duration', () => {
  const state = initialState(), c = createConversation(state.settings), b = c.branches[0], m = addMessage(c, b, 'assistant', '');
  appendAssistantSegment(m, { type: 'reasoning', text: '第一段' });
  appendReasoningDuration(m, 1200);
  appendAssistantSegment(m, { type: 'tool', toolId: 't1' });
  appendAssistantSegment(m, { type: 'reasoning', text: '第二段' });
  appendReasoningDuration(m, 800);
  appendReasoningDuration(m, 200);
  appendAssistantSegment(m, { type: 'text', text: '回答' });
  appendReasoningDuration(m, 5000);
  assert.deepEqual(m.segments, [
    { type: 'reasoning', text: '第一段', ms: 1200 },
    { type: 'tool', toolId: 't1' },
    { type: 'reasoning', text: '第二段', ms: 1000 },
    { type: 'text', text: '回答' }
  ]);
  assert.equal(messageDateTime(new Date(2026, 9, 15, 23, 24).getTime()), '2026-10-15 23:24');
});

test('GPT thinking levels include xhigh and Gemini names default to vision and tools', () => {
  assert.deepEqual(defaultModelEfforts('chat', 'gpt-6-luna'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(defaultModelEfforts('responses', 'gpt-5.1'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(defaultModelEfforts('chat', 'deepseek-flash'), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(defaultModelEfforts('chat', 'gemini-3.1-pro'), ['minimal', 'low', 'medium', 'high']);
  assert.equal(shouldDefaultVisionAndTools('gemini-3.1-pro'), true);
  assert.equal(shouldDefaultVisionAndTools('models/gemini-3.8-flash'), true);
  assert.equal(shouldDefaultVisionAndTools('openrouter/gemini-3-flash'), true);
  assert.equal(shouldDefaultVisionAndTools('llama-3.1-70b'), false);
});

test('branch names stay unique after branches are renamed or deleted', () => {
  const { c, b, a } = fixture();
  const first = fork(c, a.id);
  assert.equal(first.name, '分支');
  const second = fork(c, a.id);
  assert.equal(second.name, '分支 2');
  assert.equal(uniqueBranchName(c.branches, '分支'), '分支 3', '已占用的名字必须跳过');
  first.name = '已重命名';
  removeBranch(c, second.id);
  assert.equal(uniqueBranchName(c.branches, '分支'), '分支', '重命名与删除后名字重新可用');
  assert.equal(uniqueBranchName(c.branches, '主线'), '主线 2', '“主线”与计数无关，同样要避让');
  assert.equal(editMessage(c, c.messages[0].id, '改写后的问题').branch.name, '编辑');
  assert.equal(editMessage(c, c.messages[0].id, '再改一次').branch.name, '编辑 2');
  assert.equal(b.leafId, a.id);
});

test('a deleted model still shows the name recorded on the answer', () => {
  const { c, b, a } = fixture();
  const entry: Model = { id: 'm1', connectionId: 'c1', name: 'GPT Luna', model: 'gpt-6-luna', contextWindow: 100, maxOutput: 10, vision: true, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true };
  a.modelId = entry.id; a.modelName = entry.name;
  assert.equal(messageModelLabel(a, [{ ...entry }]), 'GPT Luna');
  assert.equal(messageModelLabel(a, []), 'GPT Luna', '模型被删除后回退到消息记录的名字');
  assert.equal(messageModelLabel({ ...a, modelName: undefined }, []), '未知模型');
  assert.equal(messageModelLabel({ ...a, modelId: undefined, modelName: undefined }, []), '未知模型');
  assert.equal(b.leafId, a.id);
});

test('message comparison sees every field the row renders', () => {
  const state = initialState(), c = createConversation(state.settings), b = c.branches[0];
  const base = addMessage(c, b, 'assistant', '正文');
  base.status = 'complete'; base.reasoning = '推理'; base.reasoningMs = 1200;
  base.segments = [{ type: 'text', text: '正文' }, { type: 'reasoning', text: '推理', ms: 1200 }];
  base.tools = [{ id: 't1', name: 'exa_search', input: '{}', output: '结果', status: 'done', started: 1, elapsed: 20 }];
  base.sources = [{ title: '来源', url: 'https://example.com' }];
  base.attachments = [{ id: uid(), name: 'a.png', mime: 'image/png', size: 3, data: 'data:image/png;base64,AAA=' }];
  base.usage = { input: 10, output: 5, cachedInput: 2, elapsedMs: 100, generationMs: 90, firstTokenMs: 30 };
  base.modelId = 'm1'; base.modelName = 'GPT Luna'; base.connectionName = '中转';
  assert.equal(sameMessage(base, structuredClone(base)), true, '内容相同的新对象必须视为未变化');
  assert.equal(sameMessage(base, base), true);
  const changed = (mutate: (message: Message) => void) => { const copy = structuredClone(base); mutate(copy); return sameMessage(base, copy); };
  assert.equal(changed(m => { m.text = '正文改'; }), false);
  assert.equal(changed(m => { m.text = '正文字数相同'; }), false, '长度相同但内容不同也必须察觉');
  assert.equal(changed(m => { m.reasoning = '推理改'; }), false);
  assert.equal(changed(m => { m.reasoningMs = 1300; }), false);
  assert.equal(changed(m => { m.status = 'streaming'; }), false);
  assert.equal(changed(m => { m.edited = true; }), false);
  assert.equal(changed(m => { m.error = '失败'; }), false);
  assert.equal(changed(m => { m.modelName = '别的模型'; }), false);
  assert.equal(changed(m => { m.connectionName = '别的连接'; }), false);
  assert.equal(changed(m => { m.segments = [{ type: 'text', text: '正文改' }]; }), false);
  assert.equal(changed(m => { m.segments = [{ type: 'reasoning', text: '推理', ms: 1 }, { type: 'text', text: '正文' }]; }), false);
  assert.equal(changed(m => { m.tools[0].output = '结果改'; }), false);
  assert.equal(changed(m => { m.tools[0].status = 'running'; }), false);
  assert.equal(changed(m => { m.tools[0].elapsed = 21; }), false);
  assert.equal(changed(m => { m.tools = []; }), false);
  assert.equal(changed(m => { m.sources = []; }), false);
  assert.equal(changed(m => { m.sources[0].url = 'https://other.example'; }), false);
  assert.equal(changed(m => { m.attachments = []; }), false);
  assert.equal(changed(m => { m.attachments[0].markdown = '# 转换'; }), false);
  assert.equal(changed(m => { m.usage!.output = 6; }), false);
  assert.equal(changed(m => { m.usage!.cachedInput = undefined; }), false);
  assert.equal(changed(m => { m.usage = undefined; }), false);
}); 
