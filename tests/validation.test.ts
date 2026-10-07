import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settingsProblems, validateState } from '../src/validation';
import { addMessage, createConversation, initialState, uid } from '../src/domain';
import type { AppState, Connection, Model, Settings } from '../src/types';

const connection = (): Connection => ({ id: uid(), name: '本地', protocol: 'chat', baseUrl: 'https://example.com/v1', apiKey: '', headers: {}, timeout: 30, proxy: '' });
const model = (connectionId: string): Model => ({ id: uid(), connectionId, name: '模型', model: 'fixture', contextWindow: 1000, maxOutput: 100, vision: false, tools: true, nativeSearch: false, reasoning: 'none', efforts: [], temperature: true });
function fixture() {
  const state = initialState(), c = createConversation(state.settings);
  state.conversations = [c]; state.selectedId = c.id;
  const link = connection(); state.settings.connections = [link];
  const entry = model(link.id); state.settings.models = [entry]; state.settings.defaultModel = entry.id;
  addMessage(c, c.branches[0], 'user', '你好');
  return state;
}

test('settings validation is shared by the settings page and the save path', () => {
  const state = fixture();
  assert.deepEqual(settingsProblems(state.settings), []);
  const settings = (mutate: (value: Settings) => void) => { const copy = structuredClone(state.settings); mutate(copy); return settingsProblems(copy); };
  assert.deepEqual(settings(value => { value.connections[0].name = '  '; }), ['请填写连接名称']);
  assert.deepEqual(settings(value => { value.connections[0].baseUrl = 'not a url'; }), ['连接地址无效']);
  assert.deepEqual(settings(value => { value.connections[0].proxy = 'socks5://127.0.0.1:1080'; }), ['当前版本的代理需使用 HTTP/HTTPS 地址']);
  assert.deepEqual(settings(value => { value.connections[0].timeout = 5; }), ['连接配置无效']);
  assert.deepEqual(settings(value => { value.models[0].model = ''; }), ['请填写每个模型的模型 ID']);
  assert.deepEqual(settings(value => { value.models[0].maxOutput = 2000; }), ['上下文窗口不能小于最大输出 token']);
  assert.deepEqual(settings(value => { value.promptPresets = [...value.promptPresets, { id: 'general', name: '重复', content: 'x' }]; }), ['系统提示词预设无效']);
  assert.deepEqual(settings(value => { value.defaultPromptPresetId = 'missing'; }), ['默认系统提示词预设不存在']);
});

test('backup validation rejects a broken message graph and out of range sampling', () => {
  const state = fixture();
  assert.doesNotThrow(() => validateState(structuredClone(state)));
  const broken = (mutate: (value: AppState) => void) => { const copy = structuredClone(state); mutate(copy); return copy; };
  assert.throws(() => validateState(broken(value => { value.conversations[0].messages[0].parentId = 'f'.repeat(36); })), /缺少父消息/);
  assert.throws(() => validateState(broken(value => { value.conversations[0].branches[0].config.temperature = 3; })), /分支结构无效/);
  assert.throws(() => validateState(broken(value => { value.conversations[0].branches[0].config.topP = 1.5; })), /分支结构无效/);
  assert.throws(() => validateState(broken(value => { value.conversations[0].activeBranchId = uid(); })), /当前分支无效/);
  assert.throws(() => validateState(broken(value => { (value.conversations[0] as unknown as { archived: string }).archived = 'yes'; })), /会话归档状态无效/);
  assert.throws(() => validateState(broken(value => { value.conversations[0].messages = []; value.conversations[0].branches[0].leafId = null; value.settings.connections[0].baseUrl = 'x'; })), /连接地址无效/);
  assert.throws(() => validateState({ settings: { connections: [], models: [] } }), /备份或设置格式无效/);
});
