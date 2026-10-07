import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMessage, contextMessages, createConversation, editMessage, fork, initialState, pathTo, removeBranch } from '../src/domain';
function fixture() {
  const c = createConversation(initialState().settings), b = c.branches[0];
  const u = addMessage(c, b, 'user', '比较桌面框架'); const a = addMessage(c, b, 'assistant', 'Electron 和 Tauri'); a.status = 'complete';
  return { c, b, u, a };
}
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
  assert.equal(resolveSearch(state.settings, 'm', 'auto'), 'off');
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
