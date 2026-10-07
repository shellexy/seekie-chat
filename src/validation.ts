import { normalizeSettings, SEARCH_MODES } from './domain';
import type { AppState, Settings } from './types';

// Settings and state validation live here, outside the Electron layer, so the settings page, the
// save path and backup import all enforce one set of rules and a drift between them cannot happen.
const validId = (id: string) => /^[a-f0-9-]{36}$/.test(id);

export function settingsProblems(settings: Settings): string[] {
  const problems: string[] = [];
  const presetIds = new Set<string>();
  for (const preset of settings.promptPresets || []) {
    if (!preset || typeof preset.id !== 'string' || !preset.id || presetIds.has(preset.id) || typeof preset.name !== 'string' || !preset.name.trim() || typeof preset.content !== 'string' || !preset.content.trim()) problems.push('系统提示词预设无效');
    else presetIds.add(preset.id);
  }
  if (settings.defaultPromptPresetId && !presetIds.has(settings.defaultPromptPresetId)) problems.push('默认系统提示词预设不存在');
  const idList = (values: unknown) => Array.isArray(values) && values.every(value => typeof value === 'string' && !!value);
  const modelIds = new Set<string>();
  for (const model of settings.models) {
    if (!model.model?.trim()) problems.push('请填写每个模型的模型 ID');
    if (!Number.isFinite(model.maxOutput) || model.maxOutput < 1 || !Number.isFinite(model.contextWindow) || model.contextWindow < model.maxOutput) problems.push('上下文窗口不能小于最大输出 token');
    modelIds.add(model.id);
  }
  if (!idList(settings.favoriteModels) || !idList(settings.recentModels)) problems.push('模型收藏或最近使用记录无效');
  else for (const id of [...settings.favoriteModels, ...settings.recentModels]) if (!modelIds.has(id)) problems.push('模型收藏或最近使用指向已删除的模型');
  if (!SEARCH_MODES.includes(settings.defaultSearch)) problems.push('默认联网搜索模式无效');
  for (const connection of settings.connections) {
    if (!connection.name?.trim()) problems.push('请填写连接名称');
    if (!validId(connection.id) || !['chat', 'responses', 'anthropic', 'gemini'].includes(connection.protocol) || typeof connection.apiKey !== 'string' || !Number.isFinite(connection.timeout) || connection.timeout < 10 || connection.timeout > 600) problems.push('连接配置无效');
    try {
      const url = new URL(connection.baseUrl);
      if (!['https:', 'http:'].includes(url.protocol)) problems.push('连接地址无效');
    } catch { problems.push('连接地址无效'); }
    if (connection.proxy && !/^https?:\/\//.test(connection.proxy)) problems.push('当前版本的代理需使用 HTTP/HTTPS 地址');
  }
  return problems;
}

export function validateState(value: unknown): asserts value is AppState {
  const s = value as AppState;
  if (!s || !s.settings || !Array.isArray(s.settings.connections) || !Array.isArray(s.settings.models) || !Array.isArray(s.conversations)) throw new Error('备份或设置格式无效');
  normalizeSettings(s.settings);
  const problem = settingsProblems(s.settings)[0];
  if (problem) throw new Error(problem);
  if (s.conversations.length > 10000) throw new Error('会话数量超过限制');
  for (const c of s.conversations) {
    if (!validId(c.id) || !Array.isArray(c.messages) || !Array.isArray(c.branches) || !c.branches.length) throw new Error('会话结构无效');
    if (c.archived !== undefined && typeof c.archived !== 'boolean') throw new Error('会话归档状态无效');
    const ids = new Set<string>();
    for (const m of c.messages) { if (!validId(m.id) || ids.has(m.id) || !['user', 'assistant'].includes(m.role) || typeof m.text !== 'string' || !Array.isArray(m.attachments) || !Array.isArray(m.tools) || !Array.isArray(m.sources)) throw new Error('消息结构无效'); ids.add(m.id); }
    const byId = new Map(c.messages.map(m => [m.id, m]));
    for (const m of c.messages) { const seen = new Set<string>(); let current: typeof m | undefined = m; while (current) { if (seen.has(current.id)) throw new Error('消息结构存在循环'); seen.add(current.id); if (!current.parentId) break; current = byId.get(current.parentId); if (!current) throw new Error('缺少父消息'); } }
    const branchIds = new Set(c.branches.map(b => b.id));
    if (!branchIds.has(c.activeBranchId)) throw new Error('当前分支无效');
    for (const b of c.branches) if (!validId(b.id) || (b.leafId && !ids.has(b.leafId)) || !b.config || !Array.isArray(b.draftAttachments) || (b.parentBranchId && !branchIds.has(b.parentBranchId)) || (b.config.temperature !== undefined && (!Number.isFinite(b.config.temperature) || b.config.temperature < 0 || b.config.temperature > 2)) || (b.config.topP !== undefined && (!Number.isFinite(b.config.topP) || b.config.topP < 0 || b.config.topP > 1))) throw new Error('分支结构无效');
  }
}
