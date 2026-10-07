import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Connection, Model } from '../src/types';
import { uid } from '../src/domain';
import type { Message, Settings } from '../src/types';
import { addMessage, appendAssistantSegment, appendReasoningDuration, applyBodies, assistantBody, defaultModelEffort, editableBodies, compressionCut, contextMessages, connectionEnabled, createConversation, deepseekWebSearchKey, defaultModelEfforts, defaultPromptPresets, editMessage, effectiveProtocol, enabledModels, externalSearchAvailable, estimateTokens, fallbackModelId, formatToolOutput, fork, freeModelSettings, initialState, MAX_RECENT_MODELS, messageDateTime, messageModelLabel, newChatModelId, normalizeSettings, rememberRecentModel, resetBuiltInPresets, resolveSearch, resolveDefaultWebFetch, sameMessage, pathTo, removeBranch, shouldDefaultVisionAndTools, toolQuery, uniqueBranchName } from '../src/domain';
import { settingsProblems } from '../src/validation';
function fixture() {
  const c = createConversation(initialState().settings), b = c.branches[0];
  const u = addMessage(c, b, 'user', '比较桌面框架'); const a = addMessage(c, b, 'assistant', 'Electron 和 Tauri'); a.status = 'complete';
  return { c, b, u, a };
}
test('new model thinking levels use sensible defaults when the model is unknown', () => {
  assert.deepEqual(defaultModelEfforts('chat', 'local-custom-model'), ['none', 'minimal', 'low', 'medium', 'high']);
  assert.deepEqual(defaultModelEfforts('chat', 'deepseek-v4'), ['none', 'low', 'high', 'max'], 'DeepSeek 按官方文档的四档，不再跟随 GPT');
  assert.deepEqual(defaultModelEfforts('gemini', 'gemini-fixture'), ['none', 'minimal', 'low', 'medium', 'high']);
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
  // 内置顺序是 Tavily、Exa、Ollama Cloud、AnySearch、Firecrawl：配了 Key 的里挑最靠前的一家。
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
  // 一个 Key 都没配时用免 Key 的那家：内置顺序里第一个免 Key 可用的是 Tavily。
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'tavily');
  state.settings.anysearchKey = 'anysearch-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'anysearch');
  state.settings.firecrawlKey = 'firecrawl-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'anysearch', 'AnySearch 排在 Firecrawl 前面');
  state.settings.tavilyKey = 'tavily-fixture';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'tavily', 'Tavily 排在内置顺序最前');
  state.settings.firecrawlKey = '';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'tavily');
  state.settings.anysearchKey = '';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'tavily');
  state.settings.tavilyKey = '';
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'tavily', '都没有 Key 时用免 Key 的 Tavily');
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
  normalizePromptSettings(settings); assert.equal(settings.promptPresets.length, 5); assert.equal(c.branches[0].config.system, '用户自己的旧提示词');
  settings.promptPresets = []; settings.defaultPromptPresetId = ''; normalizePromptSettings(settings);
  assert.equal(settings.promptPresets.length, 0);
});

test('the whale role reaches new users through the defaults and old users through a reset', async () => {
  const { normalizePromptSettings, resetBuiltInPresets } = await import('../src/domain');
  // 新用户：没有角色库，加载时按内置列表填充，因此直接看到鲸鱼娘。
  const fresh = initialState().settings;
  delete (fresh as any).promptPresets; delete (fresh as any).defaultPromptPresetId;
  normalizePromptSettings(fresh);
  assert.ok(fresh.promptPresets.some(p => p.id === 'whale_lady' && p.name === '鲸鱼娘'), '新用户应看到鲸鱼娘');
  assert.ok(fresh.promptPresets.find(p => p.id === 'whale_lady')!.content.startsWith('【PERSONA_LOAD】\nCETACEA_LOLI\n'));
  // 旧用户：角色库已经存在，升级不动它——不自动补新角色。
  const existing = initialState().settings;
  existing.promptPresets = defaultPromptPresets().filter(p => p.id !== 'whale_lady');
  normalizePromptSettings(existing);
  assert.ok(!existing.promptPresets.some(p => p.id === 'whale_lady'), '升级不应自动给旧用户加新角色');
  // 旧用户点一次"重置预设角色"就补上。
  const reset = resetBuiltInPresets(existing.promptPresets);
  assert.ok(reset.some(p => p.id === 'whale_lady' && p.name === '鲸鱼娘'), '重置预设角色应补上鲸鱼娘');
  assert.equal(reset.length, existing.promptPresets.length + 1);
});

test('the built-in general role replaces the duplicate fallback entry in the default role list', async () => {
  const { normalizePromptSettings } = await import('../src/domain');
  const settings = initialState().settings;
  // 库里有"通用助手"时，空值（用内置提示词）与它内容相同，统一指向角色本身。
  settings.defaultPromptPresetId = '';
  normalizePromptSettings(settings);
  assert.equal(settings.defaultPromptPresetId, 'general');
  // 库里没有"通用助手"时，空值仍然表示"用内置提示词"，不能改。
  settings.promptPresets = settings.promptPresets.filter(p => p.id !== 'general');
  settings.defaultPromptPresetId = '';
  normalizePromptSettings(settings);
  assert.equal(settings.defaultPromptPresetId, '');
  // 指向已被删除的角色的默认值不受影响：它只是失效后回落到内置提示词。
  settings.promptPresets = defaultPromptPresets();
  settings.defaultPromptPresetId = 'deleted-role';
  normalizePromptSettings(settings);
  assert.equal(settings.defaultPromptPresetId, 'deleted-role');
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
  assert.deepEqual(defaultModelEfforts('chat', 'gpt-6-luna'), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(defaultModelEfforts('responses', 'gpt-5.1'), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(defaultModelEfforts('chat', 'deepseek-flash'), ['none', 'low', 'high', 'max']);
  assert.deepEqual(defaultModelEfforts('chat', 'gemini-3.1-pro'), ['none', 'minimal', 'low', 'medium', 'high']);
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

test('a model starts at the effort its service recommends', () => {
  const base = { id: 'm', connectionId: 'c', name: 'm', model: 'm', contextWindow: 1000, maxOutput: 100, vision: false, tools: false, nativeSearch: false, reasoning: 'effort' as const, temperature: true };
  // The service's own recommendation wins over the usual middle level…
  assert.equal(defaultModelEffort({ ...base, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }), 'high');
  // …then the middle level, then whatever comes first, and an unusable recommendation is ignored.
  assert.equal(defaultModelEffort({ ...base, efforts: ['low', 'medium', 'high'] }), 'medium');
  assert.equal(defaultModelEffort({ ...base, efforts: ['minimal', 'low'] }), 'minimal');
  assert.equal(defaultModelEffort({ ...base, efforts: [] }), 'auto');
  assert.equal(defaultModelEffort({ ...base, efforts: ['low'], defaultEffort: 'max' }), 'low', '不在支持列表里的默认档位不得使用');
  assert.equal(defaultModelEffort(undefined), 'auto');
});

test('every text block of an answer is editable, not only the last one', () => {
  const state = initialState(), c = createConversation(state.settings), b = c.branches[0];
  const answer = addMessage(c, b, 'assistant', '第一段正文。');
  answer.segments = [
    { type: 'text', text: '第一段正文。' },
    { type: 'reasoning', text: '中间想了想。', ms: 10 },
    { type: 'text', text: '第二段正文。' }
  ];
  answer.reasoning = '中间想了想。';
  answer.text = '第一段正文。第二段正文。';
  assert.deepEqual(editableBodies(answer), ['第一段正文。', '第二段正文。']);
  assert.equal(assistantBody(answer), '第一段正文。\n\n第二段正文。');
  // A question keeps its single text, and an answer without segments falls back to its text.
  const question = addMessage(c, b, 'user', '问题');
  assert.deepEqual(editableBodies(question), ['问题']);
  const legacy = addMessage(c, b, 'assistant', '旧回答');
  assert.deepEqual(editableBodies(legacy), ['旧回答']);

  // Editing writes each block back, keeps reasoning and tools, and recomputes the summaries.
  applyBodies(answer, ['改写第一段。', '改写第二段。']);
  assert.deepEqual(answer.segments, [
    { type: 'text', text: '改写第一段。' },
    { type: 'reasoning', text: '中间想了想。', ms: 10 },
    { type: 'text', text: '改写第二段。' }
  ]);
  assert.equal(answer.text, '改写第一段。\n\n改写第二段。');
  assert.equal(answer.reasoning, '中间想了想。');
  // Emptying a box removes its block; a question edit replaces its text.
  applyBodies(answer, ['只留这一段。', '   ']);
  assert.deepEqual(answer.segments, [{ type: 'text', text: '只留这一段。' }, { type: 'reasoning', text: '中间想了想。', ms: 10 }]);
  assert.equal(answer.text, '只留这一段。');
  applyBodies(question, ['改后的问题']);
  assert.equal(question.text, '改后的问题');
});

test('settings written before favourites and search preferences keep the previous behaviour', () => {
  // Destructuring the new fields away is what an older release's settings object looks like here.
  const { favoriteModels, recentModels, useRecentModel, defaultSearch, preferNativeSearch, ...before } = initialState().settings;
  const settings = before as Settings;
  normalizeSettings(settings);
  assert.deepEqual(settings.favoriteModels, [], '旧数据应补上空的收藏列表');
  assert.deepEqual(settings.recentModels, []);
  assert.equal(settings.useRecentModel, true, '新对话默认接着最近用过的模型');
  assert.equal(settings.defaultSearch, 'auto', '新对话默认仍是自动联网');
  assert.equal(settings.preferNativeSearch, true, '自动模式默认原生搜索优先，与改动前一致');
  settings.defaultSearch = 'nonsense' as typeof settings.defaultSearch;
  normalizeSettings(settings);
  assert.equal(settings.defaultSearch, 'auto', '无法识别的搜索模式退回自动');
});

test('new chats start from the most recently used model, and the switch can be turned off', () => {
  const state = initialState(), settings = state.settings;
  settings.connections = [{ id: 'c', name: 'fixture', protocol: 'chat', baseUrl: 'https://fixture.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }];
  const model = (id: string): Model => ({ id, connectionId: 'c', name: id, model: id, contextWindow: 10000, maxOutput: 4096, vision: false, tools: false, nativeSearch: false, reasoning: 'none', efforts: [], temperature: false });
  settings.models = [model('first'), model('second')];
  settings.defaultModel = 'first';
  assert.equal(newChatModelId(settings), 'first', '没有使用记录时用默认聊天模型');
  rememberRecentModel(settings, 'second');
  assert.equal(newChatModelId(settings), 'second', '最近使用过的模型优先');
  assert.equal(createConversation(settings).branches[0].config.modelId, 'second');
  settings.useRecentModel = false;
  assert.equal(newChatModelId(settings), 'first', '关闭开关后严格按默认聊天模型');
  settings.useRecentModel = true;
  settings.models = [model('first')];
  assert.equal(newChatModelId(settings), 'first', '记录里的模型已被删除时不能选它');
});

test('a branch whose model is gone falls back to a model that is still there', () => {
  const state = initialState(), settings = state.settings;
  settings.connections = [{ id: 'c', name: 'fixture', protocol: 'chat', baseUrl: 'https://fixture.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }];
  const model = (id: string, name = id): Model => ({ id, connectionId: 'c', name, model: id, contextWindow: 10000, maxOutput: 4096, vision: false, tools: false, nativeSearch: false, reasoning: 'none', efforts: [], temperature: false });
  assert.equal(fallbackModelId(settings), '', '一个模型都没有时没有可兜底的');
  settings.models = [model('heavy', 'gpt-6-astra'), model('fast', 'DeepSeek-Flash')];
  settings.defaultModel = 'heavy';
  assert.equal(fallbackModelId(settings), 'heavy', '默认聊天模型是明确的选择，优先用它');
  // 分支自己的模型没了：对话建在还没有模型的时候，或那个模型在设置里被删了。
  settings.models = [model('fast', 'DeepSeek-Flash')];
  settings.defaultModel = '';
  assert.equal(fallbackModelId(settings), 'fast', '没有明确选择时用还在的模型');
  // 快的优先：flash、luna 这类是便宜又快的型号，替用户拿主意时先挑它们。
  settings.models = [model('heavy', 'gpt-6-astra'), model('fast', 'DeepSeek-Flash'), model('luna', 'gpt-6-luna')];
  settings.defaultModel = '';
  assert.equal(fallbackModelId(settings), 'fast', '同名与模型 ID 里带 flash / luna 的排在前面');
  // 最近使用过的仍然优先——那是用户自己选过的。
  rememberRecentModel(settings, 'heavy');
  assert.equal(fallbackModelId(settings), 'heavy', '最近使用过的模型优先于快的');
  // 停用只是不参与选择，并不阻断发送：全停用了也得挑得出一个。
  settings.connections[0].disabled = true;
  settings.recentModels = [];
  assert.equal(fallbackModelId(settings), 'fast', '连接全停用时也还能兜底');
  // 新建对话同样偏向快的型号。
  settings.connections[0].disabled = false;
  settings.defaultModel = '';
  assert.equal(newChatModelId(settings), 'fast', '新对话没有明确选择时也挑快的');
});

test('recent models are recorded on switch and moved to the front only after a finished answer', () => {
  const settings = initialState().settings;
  rememberRecentModel(settings, 'a');
  rememberRecentModel(settings, 'b');
  assert.deepEqual(settings.recentModels, ['a', 'b'], '切换只按顺序追加');
  rememberRecentModel(settings, 'b');
  assert.deepEqual(settings.recentModels, ['a', 'b'], '再次切换同一个模型不改变它的位置');
  rememberRecentModel(settings, 'a', true);
  assert.deepEqual(settings.recentModels, ['a', 'b'], '置顶的模型已经在最前面');
  rememberRecentModel(settings, 'b', true);
  assert.deepEqual(settings.recentModels, ['b', 'a'], '回答跑完把它的模型置顶');
  for (let index = 0; index < 20; index++) rememberRecentModel(settings, `m${index}`, true);
  assert.equal(settings.recentModels.length, MAX_RECENT_MODELS, '最近使用列表有上限');
  assert.equal(settings.recentModels[0], 'm19');
});

test('automatic search prefers external providers when native search is not preferred', () => {
  const state = initialState(), settings = state.settings;
  settings.connections = [{ id: 'c', name: 'fixture', protocol: 'responses', baseUrl: 'https://fixture.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }];
  settings.models = [{ id: 'm', connectionId: 'c', name: 'fixture', model: 'fixture', contextWindow: 10000, maxOutput: 4096, vision: false, tools: true, nativeSearch: true, reasoning: 'none', efforts: [], temperature: false }];
  settings.exaKey = 'exa-fixture';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'native', '默认原生搜索优先');
  settings.preferNativeSearch = false;
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'exa', '关掉后外部服务优先，原生只作兜底');
  settings.exaKey = '';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', '没有 Key 时用 Tavily 免 Key');
  settings.models[0].tools = false;
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'native', '模型不支持工具调用时回到原生搜索');
  settings.models[0].nativeSearch = false;
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'off', '两侧都拿不出来才真的关闭');
  assert.equal(resolveSearch(settings, 'm', 'tavily'), 'tavily', '会话里显式指定的模式不受偏好影响');
});

test('automatic search starts from the preferred external provider and skips it without a key', () => {
  const state = initialState(), settings = state.settings;
  settings.connections = [{ id: 'c', name: 'fixture', protocol: 'responses', baseUrl: 'https://fixture.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }];
  settings.models = [{ id: 'm', connectionId: 'c', name: 'fixture', model: 'fixture', contextWindow: 10000, maxOutput: 4096, vision: false, tools: true, nativeSearch: true, reasoning: 'none', efforts: [], temperature: false }];
  // Native first, so the preference only decides the head of the external chain.
  settings.exaKey = 'exa-fixture';
  settings.preferredExternalSearch = 'auto';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'native', '原生搜索优先');
  settings.preferNativeSearch = false;
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'exa', '默认顺序里只有 Exa 配了 Key');
  settings.tavilyKey = 'tavily-fixture';
  settings.preferredExternalSearch = 'tavily';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', '指定的外部搜索应排在最前');
  // Tavily、Firecrawl、AnySearch 免 Key 也能用，所以优先项在无密钥时依然生效。
  settings.preferredExternalSearch = 'anysearch';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'anysearch', 'AnySearch 免 Key 可用，优先项依然生效');
  // Exa 与 Ollama Cloud 必须有密钥：缺密钥时跳过这一家，继续走内置顺序。
  settings.preferredExternalSearch = 'exa';
  settings.exaKey = '';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', '没有 Exa 密钥时应跳过它并继续降级');
  settings.preferredExternalSearch = 'ollama';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', '没有 Ollama 密钥时同样跳过');
  settings.ollamaKey = 'ollama-fixture';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'ollama', '配好密钥后优先的那家才生效');
});

test('the built-in external search order starts with Tavily and prefers providers that have a key', () => {
  const state = initialState(), settings = state.settings;
  settings.connections = [{ id: 'c', name: 'fixture', protocol: 'chat', baseUrl: 'https://fixture.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }];
  settings.models = [{ id: 'm', connectionId: 'c', name: 'fixture', model: 'fixture', contextWindow: 10000, maxOutput: 4096, vision: false, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: false }];
  // 一个 Key 都没配：内置顺序里第一个免 Key 可用的是 Tavily。
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily');
  // 全部配齐时，按 Tavily、Exa、Ollama Cloud、AnySearch、Firecrawl 取最靠前的一家。
  settings.tavilyKey = 'tavily-fixture';
  settings.exaKey = 'exa-fixture';
  settings.ollamaKey = 'ollama-fixture';
  settings.anysearchKey = 'anysearch-fixture';
  settings.firecrawlKey = 'firecrawl-fixture';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily');
  settings.tavilyKey = '';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'exa');
  settings.exaKey = '';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'ollama');
  settings.ollamaKey = '';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'anysearch');
  settings.anysearchKey = '';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'firecrawl');
  settings.firecrawlKey = '';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', '都没有 Key 时回到免 Key 的 Tavily');
  // DeepSeek 按次计费，配了密钥也不自动启用。
  settings.deepseekKey = 'deepseek-fixture';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', 'DeepSeek 不参与自动降级链');
  settings.preferredExternalSearch = 'deepseek';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'deepseek', '显式设为优先项时才用 DeepSeek');
});

test('a new chat can follow the webpage reader that was last used', () => {
  const settings = initialState().settings;
  const start = () => createConversation(settings).branches[0].config.webFetch;
  assert.equal(start(), 'auto');
  settings.defaultWebFetch = 'local';
  assert.equal(start(), 'local');
  settings.defaultWebFetch = 'last';
  settings.lastWebFetch = 'local';
  assert.equal(start(), 'local', '“上次使用”应取最近一次在会话里选择的读取方式');
  settings.lastWebFetch = 'firecrawl';
  assert.equal(start(), 'firecrawl');
  settings.lastWebFetch = 'nonsense' as typeof settings.lastWebFetch;
  normalizeSettings(settings);
  assert.equal(settings.lastWebFetch, 'auto', '无法识别的记录退回自动');
  assert.equal(start(), 'auto');
});

test('settings written before the search preferences existed get working defaults', () => {
  const { preferredExternalSearch, defaultWebFetch, lastWebFetch, ...before } = initialState().settings;
  const settings = before as Settings;
  normalizeSettings(settings);
  assert.equal(settings.preferredExternalSearch, 'auto', '旧数据应保持默认的外部搜索顺序');
  assert.equal(settings.defaultWebFetch, 'auto', '旧数据的新对话仍默认自动读取网页');
  assert.equal(settings.lastWebFetch, 'auto');
  settings.preferredExternalSearch = 'nonsense' as typeof settings.preferredExternalSearch;
  settings.defaultWebFetch = 'nonsense' as typeof settings.defaultWebFetch;
  normalizeSettings(settings);
  assert.equal(settings.preferredExternalSearch, 'auto');
  assert.equal(settings.defaultWebFetch, 'auto');
});

test('deepseek search stays out of the automatic chain unless it is picked explicitly', () => {
  const state = initialState(), settings = state.settings;
  settings.connections = [{ id: 'c', name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'deepseek-connection-key', headers: {}, timeout: 30, proxy: '' }];
  settings.models = [{ id: 'm', connectionId: 'c', name: 'fixture', model: 'deepseek-flash', contextWindow: 100000, maxOutput: 4096, vision: false, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: false }];
  // 连接密钥即可用，但没有专用密钥时也应视为可用。
  assert.equal(deepseekWebSearchKey(settings), 'deepseek-connection-key');
  assert.equal(externalSearchAvailable('deepseek', settings), true);
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', '自动模式不应因为配了 DeepSeek 密钥就改用它');
  settings.deepseekKey = 'deepseek-dedicated';
  assert.equal(deepseekWebSearchKey(settings), 'deepseek-dedicated', '专用密钥优先于连接密钥');
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'tavily', '配了密钥也仍然不进自动降级链');
  // 显式设为优先项才会被自动模式用到。
  settings.preferredExternalSearch = 'deepseek';
  assert.equal(resolveSearch(settings, 'm', 'auto'), 'deepseek');
  settings.deepseekKey = '';
  assert.equal(deepseekWebSearchKey(settings), 'deepseek-connection-key');
  assert.equal(externalSearchAvailable('deepseek', settings), true);
  // 会话里直接选它也照常工作。
  assert.equal(resolveSearch(settings, 'm', 'deepseek'), 'deepseek');
});

test('the one-click free model adds the agreed connection and model and passes validation', () => {
  const settings = initialState().settings;
  const next = freeModelSettings(settings);
  assert.equal(next.connections.length, 1);
  assert.equal(next.models.length, 1);
  const connection: Connection = next.connections[0], model: Model = next.models[0];
  assert.equal(connection.name, 'OpenRouter·Kilo');
  assert.equal(connection.protocol, 'chat');
  assert.equal(connection.baseUrl, 'https://api.kilo.ai/api/openrouter');
  assert.equal(connection.apiKey, 'anonymous');
  assert.equal(model.connectionId, connection.id);
  assert.equal(model.name, 'Auto Free');
  assert.equal(model.model, 'kilo-auto/free');
  assert.equal(model.contextWindow, 256_000);
  assert.equal(model.maxOutput, 65_536);
  assert.equal(model.vision, true);
  assert.equal(model.tools, true);
  assert.equal(model.reasoning, 'effort');
  assert.equal(model.defaultEffort, 'low');
  assert.equal(defaultModelEffort(model), 'low', '切换到这个模型时应默认用 low');
  assert.equal(next.defaultModel, model.id, '还没有默认模型时选它');
  // 落盘要过校验：id、地址、上下文与输出上限都得立即可用。
  assert.deepEqual(settingsProblems(next), []);
  // 已经有默认模型时不覆盖用户的选择。
  assert.equal(freeModelSettings({ ...settings, defaultModel: 'existing' }).defaultModel, 'existing');
});

test('a search tool card shows the query it ran, and nothing when the service gave no parameters', () => {
  assert.equal(toolQuery('tavily_search', '{"query":"广州天气"}'), '广州天气');
  assert.equal(toolQuery('web_search', '{\n  "type": "search",\n  "query": "Electron docs"\n}'), 'Electron docs');
  // Gemini 原生搜索给的是字符串数组，一轮可能带多个查询。
  assert.equal(toolQuery('google_search', '["广州天气","广州 天河 天气"]'), '广州天气、广州 天河 天气');
  // 服务端没返回参数时是一句占位中文，不是查询词。
  assert.equal(toolQuery('web_search', '服务端没有返回显式搜索参数'), '');
  assert.equal(toolQuery('web_search', '等待服务端返回搜索参数'), '');
  // 非搜索工具不显示查询词：网页读取的输入是地址，日期时间没有输入。
  assert.equal(toolQuery('web_fetch', '{"url":"https://example.com"}'), '');
  assert.equal(toolQuery('datetime', '{}'), '');
  assert.equal(toolQuery('tavily_search', ''), '');
});

test('tool output that happens to be JSON is indented for reading, and only for reading', () => {
  const page = JSON.stringify({ url: 'https://example.com/a', title: '示例', content: '正文', truncated: false });
  assert.equal(formatToolOutput(page), '{\n  "url": "https://example.com/a",\n  "title": "示例",\n  "content": "正文",\n  "truncated": false\n}');
  assert.equal(formatToolOutput('[{"a":1}]'), '[\n  {\n    "a": 1\n  }\n]');
  // 不是 JSON、或解析失败的内容一律原样返回，不能把模型的工具输出改坏。
  assert.equal(formatToolOutput('读取完成'), '读取完成');
  assert.equal(formatToolOutput('{"error":"截断的 JSON'), '{"error":"截断的 JSON');
  assert.equal(formatToolOutput(''), '');
  assert.equal(formatToolOutput('网页正文里有 { 和 } 但不是 JSON'), '网页正文里有 { 和 } 但不是 JSON');
});

test('the preferred starting effort wins even when the list has no medium level', () => {
  // DeepSeek 预设的等级里没有 medium，defaultModelEffort 本会落到首项 low。
  const model: Model = { id: 'm', connectionId: 'c', name: 'm', model: 'm', contextWindow: 1000, maxOutput: 100, vision: false, tools: false, nativeSearch: false, reasoning: 'effort', efforts: ['low', 'high', 'max'], temperature: true };
  assert.equal(defaultModelEffort(model), 'low', '没有指定时落到首项');
  assert.equal(defaultModelEffort({ ...model, defaultEffort: 'high' }), 'high', '指定的起始档位优先');
  assert.equal(defaultModelEffort({ ...model, defaultEffort: 'medium' }), 'low', '不在支持列表里的指定一律忽略');
});

test('none is a real effort level and is never picked as the implicit default', () => {
  // DeepSeek 与 Ollama 都用 reasoning_effort: "none" 明确关闭思考；auto 只是不发这个字段，
  // 而 DeepSeek 的 thinking 默认 enabled、Ollama 更会自动开启，所以 auto 关不掉思考。
  const deepseek: Model = { id: 'd', connectionId: 'c', name: 'deepseek-flash', model: 'deepseek-flash', contextWindow: 128000, maxOutput: 8192, vision: true, tools: true, nativeSearch: false, reasoning: 'effort', efforts: ['none', 'low', 'high', 'max'], temperature: true };
  assert.equal(defaultModelEffort(deepseek), 'high', '服务端列表添加：等级表里没有 medium，按 DeepSeek 的起点走');
  assert.equal(defaultModelEffort({ ...deepseek, defaultEffort: 'none' }), 'high', '服务端把 none 报成默认档位时应当忽略，否则新对话一上来就不思考');
  assert.equal(defaultModelEffort({ ...deepseek, defaultEffort: 'high' }), 'high');
  assert.equal(defaultModelEffort({ ...deepseek, efforts: ['minimal', 'low', 'medium', 'high'] }), 'medium', '用户自己配的等级表仍然按 medium 起步');
  // 兜底也跳过 none：没有依据时替用户关掉思考是最糟的默认。
  assert.equal(defaultModelEffort({ ...deepseek, efforts: ['none'] }), 'auto', '只有 none 可选时退回 auto，而不是替用户关掉思考');
});

test('a disabled connection drops out of selection but keeps existing conversations usable', () => {
  const settings = initialState().settings;
  settings.connections = [
    { id: 'a', name: 'A', protocol: 'chat', baseUrl: 'https://a.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' },
    { id: 'b', name: 'B', protocol: 'chat', baseUrl: 'https://b.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }
  ];
  const model = (id: string, connectionId: string): Model => ({ id, connectionId, name: id, model: id, contextWindow: 10000, maxOutput: 4096, vision: false, tools: false, nativeSearch: false, reasoning: 'none', efforts: [], temperature: false });
  settings.models = [model('ma', 'a'), model('mb', 'b')];
  settings.defaultModel = 'ma';
  settings.recentModels = ['ma'];
  assert.deepEqual(enabledModels(settings).map(m => m.id), ['ma', 'mb']);
  // 陷阱：停用默认模型所属的连接之后，新对话不能静默地继续开在它上面。
  settings.connections[0].disabled = true;
  assert.deepEqual(enabledModels(settings).map(m => m.id), ['mb'], '停用连接的模型不再参与选择');
  assert.equal(newChatModelId(settings), 'mb', '默认模型与最近使用都停用时改选启用的模型');
  assert.deepEqual(settings.recentModels, ['ma'], '最近使用记录本身不被清理，停用后重新启用即可恢复');
  assert.equal(connectionEnabled(settings, 'b'), true, '未设置该字段视为启用');
  assert.equal(connectionEnabled(settings, 'a'), false);
  assert.equal(connectionEnabled(settings, 'missing'), true, '连接已被删除时不当成停用');
  // 全部停用时退回原顺序：禁用不阻断发送，应用不能退化成没有模型可选的空白。
  settings.connections[1].disabled = true;
  assert.equal(newChatModelId(settings), 'ma');
  // 旧数据没有该字段，加载后一律视为启用。
  const legacy = initialState().settings;
  legacy.connections = [{ id: 'c', name: 'legacy', protocol: 'chat', baseUrl: 'https://c.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' }];
  normalizeSettings(legacy);
  assert.equal(legacy.connections[0].disabled, false);
});

test('gpt models can be routed to the Responses protocol on an OpenAI-compatible connection', () => {
  const base: Connection = { id: 'c', name: 'compat', protocol: 'chat', baseUrl: 'https://fixture.invalid/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' };
  const gpt = (model: string): Model => ({ id: model, connectionId: 'c', name: model, model, contextWindow: 1000, maxOutput: 100, vision: false, tools: false, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true });
  assert.equal(effectiveProtocol(base, gpt('gpt-6-luna')), 'chat', '未开启时按连接的协议');
  const opted = { ...base, responsesForGpt: true };
  assert.equal(effectiveProtocol(opted, gpt('gpt-6-luna')), 'responses');
  assert.equal(effectiveProtocol(opted, gpt('gpt-6-astra')), 'responses');
  assert.equal(effectiveProtocol(opted, gpt('gpt-6.1-sol')), 'responses');
  assert.equal(effectiveProtocol(opted, gpt('gpt4')), 'responses');
  assert.equal(effectiveProtocol(opted, gpt('gpt-oss')), 'chat', 'gpt-oss 不是 gpt-数字*，不切换');
  assert.equal(effectiveProtocol(opted, gpt('deepseek-flash')), 'chat', '非 gpt 模型不切换');
  assert.equal(effectiveProtocol({ ...opted, protocol: 'anthropic' }, gpt('gpt-6-luna')), 'anthropic', '只有 OpenAI 兼容协议适用');
  assert.equal(effectiveProtocol(opted, undefined), 'chat', '没有模型时按连接的协议');
  // 旧数据没有该字段，加载后视为未开启。
  const legacy = initialState().settings;
  legacy.connections = [{ ...base }];
  normalizeSettings(legacy);
  assert.equal(legacy.connections[0].responsesForGpt, true, '该选项默认开启');
});

test('resetting the built-in roles restores them and leaves user roles alone', () => {
  const builtIns = defaultPromptPresets();
  const userRole = { id: 'mine', name: '我的角色', content: '自定义提示词。' };
  const library = [
    userRole,
    { id: 'general', name: '被我改过的名字', content: '被我改过的提示词。' },
    { id: 'coding', name: '编程助手', content: '也被我改过。' }
  ];
  const reset = resetBuiltInPresets(library);
  assert.deepEqual(reset.map(p => p.id), ['mine', 'general', 'coding', 'writing', 'translator', 'whale_lady'], '用户角色位置不变，缺失的内置角色补在末尾');
  assert.deepEqual(reset[0], userRole, '用户添加的角色原样保留');
  assert.equal(reset[1].name, '通用助手', '内置角色的名称恢复默认');
  assert.equal(reset[1].content, builtIns[0].content, '内置角色的提示词恢复默认');
  assert.equal(reset[2].content, builtIns[1].content);
  // 原对象不能被就地改写，设置页的草稿与已保存的数据不能被这次重置串改。
  assert.equal(library[1].content, '被我改过的提示词。');
  // 一个内置角色都没了时，四个全部补回。
  const all = resetBuiltInPresets([userRole]);
  assert.deepEqual(all.map(p => p.id), ['mine', 'general', 'coding', 'writing', 'translator', 'whale_lady']);
  // 库是空的也照常补回。
  assert.deepEqual(resetBuiltInPresets([]).map(p => p.id), ['general', 'coding', 'writing', 'translator', 'whale_lady']);
});

test('the whale prompt is a built-in constant that outlives the role library', async () => {
  const { WHALELADY_SYSTEM_PROMPT, defaultPromptPresets, resetBuiltInPresets } = await import('../src/domain');
  assert.ok(WHALELADY_SYSTEM_PROMPT.startsWith('【PERSONA_LOAD】'), '内置提示词应是这段人格说明');
  assert.match(WHALELADY_SYSTEM_PROMPT, /TIMEOUT_SIGNAL$/);
  const whale = defaultPromptPresets().find(p => p.id === 'whale_lady');
  assert.equal(whale!.content, WHALELADY_SYSTEM_PROMPT, '角色库里的鲸鱼娘应直接用这个内置提示词');
  // 即使用户把角色删了，内置提示词依然在，将来那个"用鲸鱼娘开始对话"的按钮仍能取到。
  const withoutRole = defaultPromptPresets().filter(p => p.id !== 'whale_lady');
  assert.ok(!withoutRole.some(p => p.content === WHALELADY_SYSTEM_PROMPT), '删掉角色后库里不该再有它');
  assert.equal(resetBuiltInPresets(withoutRole).find(p => p.id === 'whale_lady')!.content, WHALELADY_SYSTEM_PROMPT, '重置预设角色会把它按内置提示词补回');
});
