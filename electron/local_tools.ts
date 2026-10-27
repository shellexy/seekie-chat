import type { ChatConfig, Model } from '../src/types';

// Client-executed tools keep separate per-answer budgets. A tool the model calls often
// (datetime needs no arguments and always succeeds) must not consume the quota that
// search or web_fetch still needs, and adding a tool must not require editing every loop.
// 60 is sized for research-style answers that chain dozens of searches and fetches; the
// round budget scales with it, so raising this never breaks the loop cap.
export const DEFAULT_TOOL_CALL_LIMIT = 60;
const TOOL_CALL_LIMITS: Record<string, number> = { datetime: DEFAULT_TOOL_CALL_LIMIT };

export const datetimeTool = {
  name: 'datetime',
  description: '获取当前日期和时间，返回本机时间、星期、时区偏移和 UTC 时刻。无需参数。涉及“现在”“今天”“本周”等当前时间的问题时必须调用，不要凭记忆回答。',
  parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }
};

// Gemini uses its own uppercase schema dialect and cannot reuse the JSON-Schema object.
export const geminiDatetimeTool = {
  name: datetimeTool.name,
  description: datetimeTool.description,
  parameters: { type: 'OBJECT', properties: {} }
};

export function toolCallLimit(name: string) { return TOOL_CALL_LIMITS[name] ?? DEFAULT_TOOL_CALL_LIMIT; }
export function toolCallsUsed(counts: Map<string, number>, name: string) { return counts.get(name) ?? 0; }
export function remainingToolCalls(counts: Map<string, number>, name: string) { return Math.max(0, toolCallLimit(name) - toolCallsUsed(counts, name)); }
export function recordToolCall(counts: Map<string, number>, name: string) {
  const used = toolCallsUsed(counts, name);
  if (used >= toolCallLimit(name)) return false;
  counts.set(name, used + 1);
  return true;
}

const TOOL_LABELS: Record<string, string> = {
  datetime: '日期时间', web_fetch: '网页读取',
  exa_search: 'Exa 搜索', ollama_web_search: 'Ollama Cloud 搜索', tavily_search: 'Tavily 搜索',
  firecrawl_search: 'Firecrawl 搜索', anysearch_search: 'AnySearch 搜索', deepseek_search: 'DeepSeek 搜索',
  web_search: '搜索'
};
export function toolCallLimitError(name: string) {
  return `已达到「${TOOL_LABELS[name] || name}」工具每次回答 ${toolCallLimit(name)} 次的调用上限`;
}

// Every round consumes at least one call from some tool, so a request can never outlive
// the sum of the exposed quotas; the extra round lets the model answer after the last call.
export function toolRoundBudget(names: string[]) { return names.reduce((total, name) => total + toolCallLimit(name), 1); }

// A model can keep asking for an unknown or already exhausted tool. Those rounds consume no
// quota, so the round budget alone cannot stop them; tolerate a short run, then give up.
export const MAX_UNPRODUCTIVE_TOOL_ROUNDS = 2;
export function unproductiveToolRoundsError() { return '模型重复请求不可用或已达调用上限的工具，已停止生成'; }

export function localToolsEnabled(model: Model, config: ChatConfig) {
  return !!model.tools && config.localTools !== false;
}

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

// One concise line: wall clock, weekday, zone, offset and the UTC instant. Milliseconds and
// a Unix timestamp would only add noise the model may echo back as false precision.
export function currentDateTime(now = new Date()) {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const offset = -now.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-';
  const offsetText = `UTC${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
  const local = `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  return `${local} 星期${WEEKDAYS[now.getDay()]} | ${zone} ${offsetText} | UTC ${now.toISOString().replace(/\.\d+Z$/, 'Z')}`;
}
