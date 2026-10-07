import { fetch, ProxyAgent } from 'undici';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateGemini, sanitizeStoredParts } from './gemini';
import { UsageCounter } from './usage';
import { attachmentBase64, canSendNative, convertUnsupportedAttachments, markdownForUnsupported } from './attachments';
import { effectiveProtocol, EXTERNAL_SEARCH_MODES, externalSearchKey, resolveSearch, UNTRUSTED_CONTENT_NOTE } from '../src/domain';
import { currentDateTime, datetimeTool, localToolsEnabled, MAX_UNPRODUCTIVE_TOOL_ROUNDS, recordToolCall, remainingToolCalls, toolCallLimitError, toolRoundBudget, unproductiveToolRoundsError } from './local_tools';
import type { ChatConfig, Connection, ExternalSearchMode, Message, Model, RequestRecord, SearchMode, ServerModel, Settings, Source, ToolEvent, Usage, WebFetchMode } from '../src/types';
import type { FetchedPage } from './web_fetch';
export interface Result { text: string; reasoning: string; raw: { protocol: string; entries: any[] }; usage: Usage; sources: Source[] }
export interface Hooks { text: (s: string) => void; reasoning: (s: string) => void; tool: (t: ToolEvent) => void; sources: (s: Source[]) => void; notice?: (message: string) => void; record?: (entry: RequestRecord) => void }
export type WebFetch = (url: string, signal: AbortSignal, settings: Settings, mode: WebFetchMode | undefined) => Promise<FetchedPage>;
const noop: Hooks = { text() {}, reasoning() {}, tool() {}, sources() {}, notice() {}, record() {} };
const CODEX_ORIGINATOR = 'codex_cli_rs';
// Same placeholder the store uses for secrets; the debug view must never carry a real credential.
const REDACTED = '••••••••';
const SECRET_HEADERS = /^(authorization|proxy-authorization|x-api-key|x-goog-api-key|api-key)$/i;
const MAX_RECORDED_BODY = 200_000;
// 上游返回的原文同样只留这么多：长回答的流式原文能到几百 KB，调试看个开头就够。
const MAX_RECORDED_RESPONSE = 200_000;
// Custom headers are treated as secrets everywhere else, so their values are masked here too.
export function debugHeaders(connection: Connection, headers: Record<string, string>) {
  const custom = new Set(Object.keys(connection.headers).map(name => name.toLowerCase()));
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) copy[name] = SECRET_HEADERS.test(name) || custom.has(name.toLowerCase()) ? REDACTED : value;
  return copy;
}
const BASE64_PAYLOAD = /data:([^;,]{1,80});base64,[A-Za-z0-9+/=]{64,}/g;
function recordedBody(body: unknown) {
  // Attachment bytes dominate a request body and are useless for debugging, so each blob collapses
  // to its size; the surrounding structure stays readable and the record stays small.
  const text = JSON.stringify(body, null, 2).replace(BASE64_PAYLOAD, (match, mime: string) => `data:${mime};base64,<已省略 ${match.length} 字符的 base64 数据>`);
  return text.length > MAX_RECORDED_BODY ? `${text.slice(0, MAX_RECORDED_BODY)}\n…（请求体过长，仅记录前 ${MAX_RECORDED_BODY} 字符）` : text;
}
// Opt-in diagnostics for opaque upstream rejections: with SEEKIE_DEBUG_REQUESTS=<dir> every
// outgoing body is dumped there, and rejected requests also record what the upstream answered
// (credentials live in headers and are never written). Off by default, and a diagnostics failure
// must never break a request.
function dumpRequest(url: string, body: unknown, error?: string) {
  const directory = process.env.SEEKIE_DEBUG_REQUESTS;
  if (!directory) return;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const name = `${error ? 'error' : 'request'}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`;
    writeFileSync(join(directory, name), JSON.stringify(error ? { url, error, body } : { url, body }, null, 2), { mode: 0o600 });
  } catch { /* Diagnostics are best effort. */ }
}
export function endpoint(connection: Connection, path: string) {
  const base = connection.baseUrl.replace(/\/+$/, '');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API 地址必须使用 HTTP 或 HTTPS');
  const version = connection.protocol === 'gemini' ? '/v1beta' : '/v1';
  return `${base}${url.pathname !== '/' ? '' : version}/${path}`;
}
function isCodexModel(modelNames: string[]) { return modelNames.some(name => /(?:^|\/)gpt(?:[-_/\s]|$)/i.test(name.trim())); }
function hasHeader(headers: Record<string, string>, name: string) { return Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase()); }
export function authHeaders(connection: Connection, model?: string | Pick<Model, 'model' | 'name'>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...connection.headers };
  const modelNames = typeof model === 'string' ? [model] : model ? [model.model, model.name] : [];
  // 只按自定义请求头发 User-Agent，不再冒充 Codex CLI 或 Claude Code。
  const codexModel = isCodexModel(modelNames);
  if (codexModel && !hasHeader(connection.headers, 'originator')) headers.originator = CODEX_ORIGINATOR;
  if (codexModel && connection.protocol === 'responses' && !hasHeader(connection.headers, 'openai-beta')) headers['OpenAI-Beta'] = 'responses=experimental';
  if (connection.protocol === 'anthropic') { headers['anthropic-version'] = '2023-06-01'; if (connection.apiKey) headers['x-api-key'] = connection.apiKey; }
  else if (connection.protocol === 'gemini') { if (connection.apiKey) headers['x-goog-api-key'] = connection.apiKey; }
  else if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;
  return headers;
}
async function requestUrl(connection: Connection, url: string, body: unknown, signal: AbortSignal, model?: string | Pick<Model, 'model' | 'name'>, record?: (entry: RequestRecord) => void) {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('API 地址必须使用 HTTP 或 HTTPS');
  dumpRequest(url, body);
  // The entry is handed over before the request so a failure can be attached to it in place.
  const headers = authHeaders(connection, model);
  const entry: RequestRecord | undefined = record ? { url, method: body ? 'POST' : 'GET', headers: debugHeaders(connection, headers), body: recordedBody(body) } : undefined;
  record?.(entry!);
  const dispatcher = connection.proxy ? new ProxyAgent(connection.proxy) : undefined;
  try {
    const response = await fetch(parsed, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(10, connection.timeout) * 1000)]), dispatcher });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 1200);
      if (entry) entry.error = `${response.status} ${detail}`;
      dumpRequest(url, body, `${response.status} ${detail}`);
      const labels: Record<number, string> = { 401: '认证失败，请检查 API Key', 403: '没有权限访问该服务', 404: '模型或 API 路径不存在', 429: '服务限流或余额不足' };
      throw new Error(`${labels[response.status] || '服务请求失败'} (${response.status})：${detail}`);
    }
    // Keep the proxy alive until the response body has been consumed.
    // The entry is returned so the caller can hand it to the stream parser, which fills in the
    // upstream response text for the debug view.
    return { response, close: () => dispatcher?.close(), entry };
  } catch (error) { if (entry && !entry.error) entry.error = String(error); await dispatcher?.close(); throw error; }
}
export async function request(connection: Connection, path: string, body: unknown, signal: AbortSignal, model?: string | Pick<Model, 'model' | 'name'>, record?: (entry: RequestRecord) => void) {
  return requestUrl(connection, endpoint(connection, path), body, signal, model, record);
}
export async function* sse(body: AsyncIterable<Uint8Array>, sink?: { response?: string }) {
  const decoder = new TextDecoder(); let buffer = '';
  // 上游返回的原文也留下来：调试时能看到服务到底返回了什么，而不只是我们发出去的。
  let captured = sink?.response ?? '', truncated = false;
  for await (const chunk of body) {
    const text = decoder.decode(chunk, { stream: true });
    if (sink) {
      if (!truncated) {
        captured += text;
        if (captured.length > MAX_RECORDED_RESPONSE) { captured = captured.slice(0, MAX_RECORDED_RESPONSE); truncated = true; }
      }
      sink.response = truncated ? `${captured}\n…（响应过长，仅记录前 ${MAX_RECORDED_RESPONSE} 字符）` : captured;
    }
    buffer += text;
    buffer = buffer.replace(/\r\n/g, '\n');
    let i: number;
    while ((i = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, i); buffer = buffer.slice(i + 2);
      const data = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      try { yield JSON.parse(data); } catch { throw new Error('服务返回了无效的流式数据'); }
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith('data:') && tail.slice(5).trim() !== '[DONE]') yield JSON.parse(tail.slice(5).trim());
}
function isExternalSearch(mode: SearchMode): mode is ExternalSearchMode { return EXTERNAL_SEARCH_MODES.includes(mode as ExternalSearchMode); }
function searchToolName(mode: ExternalSearchMode) { return mode === 'exa' ? 'exa_search' : mode === 'ollama' ? 'ollama_web_search' : mode === 'tavily' ? 'tavily_search' : mode === 'firecrawl' ? 'firecrawl_search' : mode === 'deepseek' ? 'deepseek_search' : 'anysearch_search'; }
function searchProviderName(mode: ExternalSearchMode) { return mode === 'exa' ? 'Exa' : mode === 'ollama' ? 'Ollama Cloud' : mode === 'tavily' ? 'Tavily' : mode === 'firecrawl' ? 'Firecrawl' : mode === 'deepseek' ? 'DeepSeek' : 'AnySearch'; }
function externalSearchTool(mode: ExternalSearchMode) { return { name: searchToolName(mode), description: `搜索互联网获取当前信息。结果包含标题、URL 和正文片段。${UNTRUSTED_CONTENT_NOTE}`, parameters: { type: 'object', properties: { query: { type: 'string', description: '搜索查询' } }, required: ['query'], additionalProperties: false } }; }
const webFetchTool = { name: 'web_fetch', description: `读取公开网页正文并转换为 Markdown。输入应是搜索结果或用户提供的完整网页 URL。${UNTRUSTED_CONTENT_NOTE}`, parameters: { type: 'object', properties: { url: { type: 'string', description: '要抓取的 HTTP 或 HTTPS 网页 URL' } }, required: ['url'], additionalProperties: false } };
function searchParameters(value: unknown) {
  return value && typeof value === 'object' && Object.keys(value).length ? JSON.stringify(value, null, 2) : '服务端没有返回显式搜索参数';
}
// A no-argument tool call arrives with empty arguments, and some gateways send the arguments as
// an object instead of a JSON string. Replaying "" breaks OpenAI-compatible gateways
// (OpenRouter / New API answer 400 "arguments must contain valid JSON") and stops the request.
function replayArguments(value: unknown) {
  if (typeof value === 'string') return value.trim() || '{}';
  if (value && typeof value === 'object') return JSON.stringify(value);
  return '{}';
}
interface PendingToolCall { index?: number; id: string; type: string; function: { name: string; arguments: string }; pendingStarted: number }
function isCompleteJson(value: string) {
  if (!value.trim()) return false;
  try { JSON.parse(value); return true; } catch { return false; }
}
function lastToolCall(calls: PendingToolCall[], match: (call: PendingToolCall) => boolean) {
  for (let index = calls.length - 1; index >= 0; index--) if (match(calls[index])) return calls[index];
  return undefined;
}
// OpenAI streams one call fragment at a time under a stable index, but compatible gateways
// (New API, OpenRouter) reuse that index, omit ids, or send several complete calls in one chunk.
// Keying only by index merged parallel calls into a single "datetimeexa_search" whose arguments
// were concatenated JSON objects, so the gateway rejected the whole request. Fall back to the id,
// then to the last still-open call, and start a new call when a delta cannot be a fragment.
function resolveToolCall(calls: PendingToolCall[], delta: any): PendingToolCall {
  const name = typeof delta.function?.name === 'string' ? delta.function.name : '';
  const args = typeof delta.function?.arguments === 'string' ? delta.function.arguments : '';
  const identified = delta.id ? lastToolCall(calls, call => call.id === delta.id) : undefined;
  if (identified) return identified;
  const candidate = (typeof delta.index === 'number' ? lastToolCall(calls, call => call.index === delta.index) : undefined)
    || (delta.id || typeof delta.index === 'number' ? undefined : calls.at(-1));
  if (candidate && !(
    // A different function name, a fresh complete JSON object, or another id means a new call.
    (!!name && !!candidate.function.name && !candidate.function.name.endsWith(name))
    || (isCompleteJson(candidate.function.arguments) && isCompleteJson(args))
    || (!!delta.id && !!candidate.id && delta.id !== candidate.id)
  )) return candidate;
  const created: PendingToolCall = { index: typeof delta.index === 'number' ? delta.index : undefined, id: delta.id || `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`, type: delta.type || 'function', function: { name: '', arguments: '' }, pendingStarted: Date.now() };
  calls.push(created);
  return created;
}
function compatibleRaw(m: Message, protocol: string): any[] | undefined {
  const raw = m.raw as Result['raw'] | undefined;
  if (m.edited || m.status !== 'complete' || raw?.protocol !== protocol) return undefined;
  return raw.entries.map(entry => {
    // Entries stored by an earlier release (or produced by a gateway) can carry payloads that the
    // provider rejects on replay: an empty tool-call argument string, or a Gemini part with no
    // content field. Repair them here so an existing conversation keeps working.
    if (Array.isArray(entry?.tool_calls)) return { ...entry, tool_calls: entry.tool_calls.map((call: any) => call?.function ? { ...call, function: { ...call.function, arguments: replayArguments(call.function.arguments) } } : call) };
    if (entry?.type === 'function_call') return { ...entry, arguments: replayArguments(entry.arguments) };
    if (entry?.role === 'model' && Array.isArray(entry.parts)) return { ...entry, parts: sanitizeStoredParts(entry.parts) };
    if (Array.isArray(entry?.parts)) return { ...entry, parts: sanitizeStoredParts(entry.parts) };
    return entry;
  });
}
export function buildInput(protocol: string, messages: Message[], model?: Model): any[] {
  return messages.flatMap(m => {
    const raw = compatibleRaw(m, protocol); if (m.role === 'assistant' && raw?.length) return raw;
    // A stored attachment can lose its bytes and keep only the converted Markdown. Never turn
    // that into a native part with no payload: providers reject the opaque empty blob with a
    // 400 ("required oneof field 'data' must have one initialized field") and stop the request.
    const items = m.attachments.map(attachment => {
      const data = attachmentBase64(attachment);
      const native = !!data && canSendNative(protocol, model, attachment);
      return { attachment, data, native, markdown: native ? '' : attachment.markdown || markdownForUnsupported(attachment, protocol, model) };
    });
    const lost = items.find(item => !item.native && !item.markdown);
    if (lost) throw new Error(`附件“${lost.attachment.name}”的内容已缺失，请重新添加该附件后再发送`);
    const text = [m.text || (m.attachments.length ? '请查看附件。' : '（空消息）'), ...items.filter(item => item.markdown).map(({ attachment, markdown }) => `附件“${attachment.name}”的 Markdown 内容：\n${markdown}`)].join('\n\n');
    const payload = items.filter(item => item.native).map(({ attachment: a, data }) => {
      const format = a.name.split('.').at(-1)?.toLowerCase();
      if (protocol === 'gemini') return { inlineData: { mimeType: a.mime, data } };
      if (protocol === 'anthropic') return a.mime === 'application/pdf'
        ? { type: 'document', source: { type: 'base64', media_type: a.mime, data } }
        : { type: 'image', source: { type: 'base64', media_type: a.mime, data } };
      if (protocol === 'responses') {
        if (a.mime === 'application/pdf') return { type: 'input_file', filename: a.name, file_data: a.data };
        if (a.mime.startsWith('audio/')) return { type: 'input_audio', input_audio: { data, format } };
        return { type: 'input_image', image_url: a.data };
      }
      if (a.mime === 'application/pdf') return { type: 'file', file: { filename: a.name, file_data: a.data } };
      if (a.mime.startsWith('video/')) return { type: 'video_url', video_url: { url: a.data } };
      if (a.mime.startsWith('audio/')) return { type: 'input_audio', input_audio: { data, format } };
      return { type: 'image_url', image_url: { url: a.data } };
    });
    if (protocol === 'gemini') return [{ role: m.role === 'assistant' ? 'model' : 'user', parts: [...payload, { text }] }];
    if (protocol === 'anthropic') return [{ role: m.role, content: [...payload, { type: 'text', text }] }];
    if (protocol === 'responses') return [{ role: m.role, content: [...payload, { type: m.role === 'user' ? 'input_text' : 'output_text', text }] }];
    return [{ role: m.role, content: m.attachments.length ? [{ type: 'text', text }, ...payload] : text }];
  });
}
function configuredSearchKey(mode: ExternalSearchMode, settings: Settings) {
  return externalSearchKey(mode, settings);
}
async function externalSearch(mode: ExternalSearchMode, args: string, settings: Settings, signal: AbortSignal) {
  const key = configuredSearchKey(mode, settings);
  if (!key && (mode === 'exa' || mode === 'ollama' || mode === 'deepseek')) throw new Error(`请在设置中配置${mode === 'exa' ? 'Exa' : mode === 'ollama' ? 'Ollama Cloud' : 'DeepSeek'} API Key`);
  let parsed: any;
  try { parsed = JSON.parse(args); } catch { throw new Error('搜索参数格式无效'); }
  const query = parsed?.query;
  if (typeof query !== 'string' || !query.trim() || query.length > (mode === 'firecrawl' ? 500 : mode === 'deepseek' ? 128 : 2000)) throw new Error('搜索查询无效');
  const count = Math.min(10, Math.max(1, Number(settings.exaResults) || 10));
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let url: string, body: unknown;
  if (mode === 'exa') {
    url = 'https://api.exa.ai/search'; headers['x-api-key'] = key;
    body = { query, numResults: count, contents: { text: { maxCharacters: 2500 } } };
  } else if (mode === 'ollama') {
    url = 'https://ollama.com/api/web_search'; headers.Authorization = `Bearer ${key}`;
    body = { query, max_results: count };
  } else if (mode === 'tavily') {
    url = 'https://api.tavily.com/search';
    if (key) headers.Authorization = `Bearer ${key}`; else headers['X-Tavily-Access-Mode'] = 'keyless';
    body = { query, search_depth: 'basic', max_results: count, topic: 'general', include_answer: false, include_raw_content: false };
  } else if (mode === 'firecrawl') {
    url = 'https://api.firecrawl.dev/v2/search'; if (key) headers.Authorization = `Bearer ${key}`;
    body = { query, limit: count, sources: [{ type: 'web' }], scrapeOptions: { formats: ['markdown'], onlyMainContent: true } };
  } else if (mode === 'deepseek') {
    // Search 是只读的按次计费接口：只有 200 且 results 非空才计费，count 只影响条数不影响单价。
    // need_content 决定是否随结果返回网页正文；关闭时 content 恒为空串，正文交给 Fetch。
    url = 'https://api.deepseek.com/v1/tools/search'; headers.Authorization = `Bearer ${key}`;
    body = { query, count, need_content: settings.deepseekNeedContent === true };
  } else {
    url = 'https://api.anysearch.com/v1/search'; if (key) headers.Authorization = `Bearer ${key}`;
    body = { query, max_results: count, format: 'markdown' };
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
  // DeepSeek 用 402 表示余额不足，与其它服务的 429 限流不同，值得单独提示。
  if (!response.ok) throw new Error(mode === 'deepseek' && response.status === 402 ? 'DeepSeek 余额不足，请充值后再试 (402)'
    : `${searchProviderName(mode)} 搜索失败 (${response.status})`);
  const data: any = await response.json();
  if (mode === 'anysearch' && data?.code !== 0) throw new Error('AnySearch 搜索失败');
  if (mode === 'firecrawl' && data?.success === false) throw new Error('Firecrawl 搜索失败');
  const results = mode === 'firecrawl' ? data?.data?.web : mode === 'anysearch' ? data?.data?.results : data?.results;
  return (Array.isArray(results) ? results : []).map((r: any) => ({
    title: String(r.title || r.url || ''), url: String(r.url || ''),
    // summary 排在 description/snippet 之前：DeepSeek 文档明确它是"适用于给模型阅读"的
    // 长摘要，比 100~200 字的 snippet 更适合直接送进上下文。
    text: String(r.text || r.markdown || r.content || r.summary || r.description || r.snippet || (Array.isArray(r.highlights) ? r.highlights.join('\n') : '')).slice(0, 2500)
  })).filter((r: Source) => /^https?:\/\//.test(r.url));
}
export async function generate(connection: Connection, model: Model, config: ChatConfig, messages: Message[], settings: Settings, signal: AbortSignal, hooks = noop, webFetch?: WebFetch): Promise<Result> {
  // 连接勾选了"gpt 自动使用 Responses"时，gpt-数字* 的模型改走 Responses 协议。整段请求逻辑
  // 都按生效后的协议走，所以直接换掉 connection：请求路径、请求体、流式解析与工具回放
  // 会一并切到 Responses 的形状。
  connection = { ...connection, protocol: effectiveProtocol(connection, model) };
  config = {
    ...config,
    webFetch: config.webFetch || (config.search === 'off' ? 'off' : 'auto'),
    temperature: Number.isFinite(config.temperature) ? Math.max(0, Math.min(2, config.temperature!)) : 1,
    topP: Number.isFinite(config.topP) ? Math.max(0, Math.min(1, config.topP!)) : 1
  };
  config = { ...config, search: resolveSearch({ ...settings, models: [model] }, model.id, config.search) };
  if (model.reasoning === 'effort' && config.effort !== 'auto' && !model.efforts.includes(config.effort)) throw new Error('当前模型不支持此思考等级，请在会话选项中重新选择');
  if (isExternalSearch(config.search) && !model.tools) throw new Error('外部联网搜索需要支持工具调用的模型');
  if (config.search === 'native' && (!model.nativeSearch || connection.protocol === 'chat')) throw new Error('当前协议或模型不支持原生搜索，请改用已配置的外部搜索服务');
  if ((config.search === 'exa' || config.search === 'ollama') && !configuredSearchKey(config.search, settings)) throw new Error(`请先配置${config.search === 'exa' ? ' Exa' : ' Ollama Cloud'} API Key`);
  await convertUnsupportedAttachments(messages, connection.protocol, model);
  const record = hooks.record ? (entry: RequestRecord) => hooks.record!(entry) : undefined;
  if (connection.protocol === 'gemini') return generateGemini(connection, model, config, messages, settings, signal, hooks, { request, buildInput, search: externalSearch, webFetch: model.tools ? webFetch : undefined, sse, record });
  let text = '', reasoning = ''; const entries: any[] = [], sources: Source[] = []; const counter = new UsageCounter(), usage = counter.total;
  const input = buildInput(connection.protocol, messages, model);
  const restrictedSampling = connection.protocol === 'responses' || connection.protocol === 'anthropic';
  const supportsSampling = model.temperature && (!restrictedSampling || model.reasoning === 'none');
  const sampling = supportsSampling ? { temperature: config.temperature, top_p: config.topP } : {};
  const addText = (s: string) => { text += s; hooks.text(s); };
  const addReason = (s: string) => { reasoning += s; hooks.reasoning(s); };
  const addSources = (items: Source[]) => { for (const s of items) if (/^https?:\/\//.test(s.url) && !sources.some(x => x.url === s.url)) sources.push(s); hooks.sources([...sources]); };
  const anthropicSearchInputs = new Map<string, string>(), anthropicServerSearchStarted = new Map<string, number>();
  const hasWebFetch = model.tools && config.webFetch !== 'off' && !!webFetch;
  const hasLocalTools = localToolsEnabled(model, config);
  // Per-answer quotas are tracked per tool name; native search stays provider-side.
  const toolCounts = new Map<string, number>();
  // The budget must still leave room for the tolerated rounds of unusable tool calls.
  const maxRounds = Math.max(toolRoundBudget([
    ...(hasLocalTools ? ['datetime'] : []),
    ...(isExternalSearch(config.search) ? [searchToolName(config.search)] : []),
    ...(hasWebFetch ? ['web_fetch'] : [])
  ]), MAX_UNPRODUCTIVE_TOOL_ROUNDS + 1);
  let unproductiveRounds = 0;
  const responseSearchEvents = new Map<string, ToolEvent>();
  const updateResponseSearch = (id: string, changes: Partial<ToolEvent>) => {
    if (!id) return;
    const previous = responseSearchEvents.get(id), started = previous?.started ?? Date.now();
    const status = changes.status ?? previous?.status ?? 'running';
    const event: ToolEvent = {
      id, name: 'web_search', input: changes.input ?? previous?.input ?? '等待服务端返回搜索参数',
      output: changes.output ?? previous?.output ?? '', status, started,
      ...((changes.elapsed ?? previous?.elapsed) !== undefined ? { elapsed: changes.elapsed ?? previous?.elapsed } : status !== 'running' ? { elapsed: Date.now() - started } : {})
    };
    responseSearchEvents.set(id, event); hooks.tool(event);
  };
  for (let round = 0; round < maxRounds; round++) {
    // The system prompt goes out exactly as the user wrote it. Tool guidance belongs in the tool
    // descriptions instead: datetime's already was, and UNTRUSTED_CONTENT_NOTE now rides along with
    // search and web_fetch, so a prompt edit can no longer drop either one.
    const system = config.system;
    // A tool stops being offered once its own quota is used up, so quotas never need a round cap.
    const offerDatetime = hasLocalTools && remainingToolCalls(toolCounts, 'datetime') > 0;
    const offerWebFetch = hasWebFetch && remainingToolCalls(toolCounts, 'web_fetch') > 0;
    let body: any; let path: string;
    if (connection.protocol === 'chat') {
      path = 'chat/completions'; body = { model: model.model, messages: [{ role: 'system', content: system }, ...input], stream: true, ...sampling, ...(model.streamUsage !== false ? { stream_options: { include_usage: true } } : {}), [model.outputTokenField || 'max_completion_tokens']: model.maxOutput };
      const tools: any[] = [];
      if (isExternalSearch(config.search) && remainingToolCalls(toolCounts, searchToolName(config.search)) > 0) tools.push({ type: 'function', function: externalSearchTool(config.search) });
      if (offerWebFetch) tools.push({ type: 'function', function: webFetchTool });
      if (offerDatetime) tools.push({ type: 'function', function: datetimeTool });
      if (tools.length) body.tools = tools;
      if (model.reasoning === 'effort' && config.effort && config.effort !== 'auto') body.reasoning_effort = config.effort;
    } else if (connection.protocol === 'responses') {
      path = 'responses'; body = { model: model.model, instructions: system, input, stream: true, ...sampling, max_output_tokens: model.maxOutput, store: false };
      const tools: any[] = [];
      if (config.search === 'native') tools.push({ type: 'web_search' });
      if (isExternalSearch(config.search) && remainingToolCalls(toolCounts, searchToolName(config.search)) > 0) tools.push({ type: 'function', ...externalSearchTool(config.search) });
      if (offerWebFetch) tools.push({ type: 'function', ...webFetchTool });
      if (offerDatetime) tools.push({ type: 'function', ...datetimeTool });
      if (tools.length) body.tools = tools;
      if (model.reasoning === 'effort') body.reasoning = { ...(config.effort !== 'auto' ? { effort: config.effort } : {}), summary: 'auto' };
      // store 省略时默认是 true：OpenAI 会把这次回答存在服务端，并且不再把思考内容交回来
      // （连 include: reasoning.encrypted_content 都取不到东西），于是思考摘要不显示。
      // 本客户端是本地优先的，对话本来就不该留在 OpenAI 那边，所以显式关掉。
      body.store = false;
      // 不请求 reasoning.encrypted_content：那段密文本应用不到（没有回放推理项的机制），
      // 有了 store: false 它反而会真的传回来，白白多占一份带宽。
    } else {
      path = 'messages'; body = { model: model.model, system, messages: input, stream: true, ...sampling, max_tokens: model.maxOutput };
      const tools: any[] = [];
      if (config.search === 'native') tools.push({ type: 'web_search_20250305', name: 'web_search', max_uses: 3 });
      if (isExternalSearch(config.search) && remainingToolCalls(toolCounts, searchToolName(config.search)) > 0) { const tool = externalSearchTool(config.search); tools.push({ name: tool.name, description: tool.description, input_schema: tool.parameters }); }
      if (offerWebFetch) tools.push({ name: webFetchTool.name, description: webFetchTool.description, input_schema: webFetchTool.parameters });
      if (offerDatetime) tools.push({ name: datetimeTool.name, description: datetimeTool.description, input_schema: datetimeTool.parameters });
      if (tools.length) body.tools = tools;
      if (model.reasoning === 'budget') {
        if (config.budget >= model.maxOutput) throw new Error('思考预算必须小于最大输出 token');
        body.thinking = { type: 'enabled', budget_tokens: Math.max(1024, config.budget) };
      }
      if (model.reasoning === 'effort') { body.thinking = { type: 'adaptive' }; if (config.effort !== 'auto') body.output_config = { effort: config.effort }; }
    }
    const { response, close, entry } = await request(connection, path, body, signal, model, record);
    const calls: { id: string; name: string; args: string }[] = [];
    const blocks: any[] = []; let responseItems: any[] = [], chatText = '', chatReason = ''; const chatCalls: PendingToolCall[] = [];
    let finished = false;
    const anthropicUsage: Record<string, number> = {};
    const observeAnthropic = (snapshot: any) => {
      Object.assign(anthropicUsage, snapshot);
      counter.observe({
        // Anthropic input_tokens excludes both cache reads and cache writes.
        input: (anthropicUsage.input_tokens || 0) + (anthropicUsage.cache_read_input_tokens || 0) + (anthropicUsage.cache_creation_input_tokens || 0),
        output: anthropicUsage.output_tokens,
        cachedInput: anthropicUsage.cache_read_input_tokens
      });
    };
    try {
      if (!response.body) throw new Error('服务没有返回响应内容');
      for await (const ev of sse(response.body, entry)) {
        if (ev.error || ev.type === 'error' || ev.type === 'response.failed') throw new Error(ev.error?.message || ev.response?.error?.message || '模型生成失败');
        if (connection.protocol === 'chat') {
          const choice = ev.choices?.[0], d = choice?.delta;
          for (const [key, value] of Object.entries(d || {})) {
            if (key === 'content' && typeof value === 'string' && value) { chatText += value; addText(value); }
            // Ollama 的 OpenAI 兼容端点把思考放在 `reasoning` 而不是 `reasoning_content`
            // （见 docs.ollama.com/api/openai-compatibility），只读后者会让 gemma4 的思考
            // 整段消失——模型在想，界面看不到。
            if ((key === 'reasoning_content' || key === 'reasoning') && typeof value === 'string' && value) { chatReason += value; addReason(value); }
            if (key === 'tool_calls' && Array.isArray(value)) for (const c of value) {
              const old = resolveToolCall(chatCalls, c);
              if (c.id) old.id = c.id;
              // Gateways may repeat the whole function name and may stream arguments as an object.
              if (c.function?.name && !old.function.name.endsWith(c.function.name)) old.function.name += c.function.name;
              if (typeof c.function?.arguments === 'string') old.function.arguments += c.function.arguments;
              else if (c.function?.arguments) old.function.arguments = replayArguments(c.function.arguments);
              if (old.id && old.function.name) hooks.tool({ id: old.id, name: old.function.name, input: replayArguments(old.function.arguments), output: '', status: 'pending', started: old.pendingStarted });
            }
          }
          if (choice?.finish_reason) finished = true;
          if (ev.usage) counter.observe({ input: ev.usage.prompt_tokens, output: ev.usage.completion_tokens, cachedInput: ev.usage.prompt_tokens_details?.cached_tokens ?? ev.usage.prompt_cache_hit_tokens });
        } else if (connection.protocol === 'responses') {
          if (ev.type === 'response.output_text.delta') addText(ev.delta);
          // 两家的事件名不同：OpenAI 发 reasoning_summary_text.delta（摘要），DeepSeek 的
          // Responses 接口发 reasoning_text.delta（思维链原文，其文档明确说 summary 可传入
          // 但不生成摘要）。只认前者，DeepSeek 的思考内容就整段丢了。
          if (ev.type === 'response.reasoning_summary_text.delta' || ev.type === 'response.reasoning_text.delta') addReason(ev.delta);
          if (ev.type === 'response.output_item.added' && ev.item?.type === 'web_search_call') updateResponseSearch(ev.item.id, { input: searchParameters(ev.item.action) });
          if (ev.type === 'response.output_item.added' && ev.item?.type === 'function_call') hooks.tool({ id: ev.item.call_id || ev.item.id, name: ev.item.name || 'tool', input: replayArguments(ev.item.arguments), output: '', status: 'pending', started: Date.now() });
          if (ev.type === 'response.output_item.done') responseItems.push(ev.item);
          if (ev.type === 'response.output_item.done' && ev.item?.type === 'web_search_call') updateResponseSearch(ev.item.id, { input: searchParameters(ev.item.action) });
          if (ev.type === 'response.output_item.done' && ev.item?.type === 'function_call') hooks.tool({ id: ev.item.call_id || ev.item.id, name: ev.item.name || 'tool', input: replayArguments(ev.item.arguments), output: '', status: 'pending', started: Date.now() });
          if (ev.type === 'response.output_text.annotation.added' && ev.annotation?.url) addSources([{ title: ev.annotation.title || ev.annotation.url, url: ev.annotation.url }]);
          if (ev.type === 'response.web_search_call.in_progress') updateResponseSearch(ev.item_id, { input: searchParameters(ev.action), status: 'running' });
          if (ev.type === 'response.web_search_call.searching' && (ev.action || ev.query)) updateResponseSearch(ev.item_id, { input: searchParameters(ev.action || { query: ev.query }) });
          if (ev.type === 'response.web_search_call.completed') updateResponseSearch(ev.item_id, { input: ev.action ? searchParameters(ev.action) : undefined, output: '搜索完成，来源见回答引用', status: 'done' });
          if (ev.type === 'response.completed') {
            finished = true; responseItems = ev.response.output || responseItems;
            for (const item of responseItems) if (item?.type === 'web_search_call') {
              const status = item.status === 'failed' ? 'error' : item.status === 'completed' ? 'done' : 'running';
              updateResponseSearch(item.id, { input: searchParameters(item.action), status, ...(status === 'done' ? { output: '搜索完成，来源见回答引用' } : status === 'error' ? { output: '原生搜索失败' } : {}) });
            }
            counter.observe({ input: ev.response.usage?.input_tokens, output: ev.response.usage?.output_tokens, cachedInput: ev.response.usage?.input_tokens_details?.cached_tokens });
          }
          if (ev.type === 'response.incomplete') throw new Error('回答未完整生成：' + (ev.response?.incomplete_details?.reason || '输出限制'));
        } else {
          if (ev.type === 'message_start') observeAnthropic(ev.message.usage);
          if (ev.type === 'content_block_start') {
            const block = structuredClone(ev.content_block); blocks[ev.index] = block;
            if (block.type === 'text' && block.text) addText(block.text);
            if (['tool_use', 'server_tool_use'].includes(block.type)) {
              block._json = '';
              const input = JSON.stringify(block.input || {}, null, 2);
              if (block.name === 'web_search') anthropicSearchInputs.set(block.id, input);
              const started = Date.now();
              if (block.type === 'server_tool_use') anthropicServerSearchStarted.set(block.id, started);
              hooks.tool({ id: block.id, name: block.name, input, output: '', status: block.type === 'server_tool_use' ? 'running' : 'pending', started });
            }
            if (block.type === 'web_search_tool_result') {
              const results = Array.isArray(block.content) ? block.content : [];
              addSources(results.filter((r: any) => r.url).map((r: any) => ({ title: r.title || r.url, url: r.url })));
              const started = anthropicServerSearchStarted.get(block.tool_use_id) || Date.now();
              hooks.tool({ id: block.tool_use_id, name: 'web_search', input: anthropicSearchInputs.get(block.tool_use_id) || '服务端没有返回显式搜索参数', output: JSON.stringify(block.content).slice(0, 3000), status: block.content?.type === 'web_search_tool_result_error' ? 'error' : 'done', started, elapsed: Date.now() - started });
            }
          }
          if (ev.type === 'content_block_delta') {
            const b = blocks[ev.index], d = ev.delta;
            if (d.type === 'text_delta') { b.text = (b.text || '') + d.text; addText(d.text); }
            if (d.type === 'thinking_delta') { b.thinking = (b.thinking || '') + d.thinking; addReason(d.thinking); }
            if (d.type === 'signature_delta') b.signature = (b.signature || '') + d.signature;
            if (d.type === 'input_json_delta') b._json += d.partial_json;
            if (d.type === 'citations_delta' && d.citation?.url) { b.citations = [...(b.citations || []), d.citation]; addSources([{ title: d.citation.title || d.citation.url, url: d.citation.url }]); }
          }
          if (ev.type === 'content_block_stop') {
            const b = blocks[ev.index];
            if (b?._json !== undefined) {
              if (b._json) b.input = JSON.parse(b._json);
              delete b._json;
              if (b.name === 'web_search') {
                const input = JSON.stringify(b.input || {}, null, 2);
                anthropicSearchInputs.set(b.id, input);
                hooks.tool({ id: b.id, name: b.name, input, output: '', status: b.type === 'server_tool_use' ? 'running' : 'pending', started: b.type === 'server_tool_use' ? anthropicServerSearchStarted.get(b.id) || Date.now() : Date.now() });
              }
            }
          }
          if (ev.type === 'message_delta') observeAnthropic(ev.usage);
          if (ev.type === 'message_stop') finished = true;
        }
      }
    } finally { await close(); }
    if (!finished) throw new Error('流式连接提前结束，已收到的内容已保留');
    counter.finishRound();
    if (connection.protocol === 'chat') {
      const toolCalls = chatCalls.map(c => ({ id: c.id, type: c.type, function: { name: c.function.name, arguments: replayArguments(c.function.arguments) } })); const assistant = { role: 'assistant', content: chatText || null, ...(chatReason ? { reasoning_content: chatReason } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) };
      input.push(assistant); entries.push(assistant);
      calls.push(...toolCalls.map(c => ({ id: c.id, name: c.function.name, args: c.function.arguments })));
    } else if (connection.protocol === 'responses') {
      for (const item of responseItems) {
        for (const c of item.content || []) for (const a of c.annotations || []) if (a.url) addSources([{ title: a.title || a.url, url: a.url }]);
        if (item.type === 'function_call') item.arguments = replayArguments(item.arguments);
        // Native search records aren't needed for reconstructed stateless input.
        if (['message', 'reasoning', 'function_call'].includes(item.type)) { input.push(item); entries.push(item); }
        if (item.type === 'function_call') calls.push({ id: item.call_id || item.id, name: item.name, args: item.arguments });
      }
    } else {
      const assistant = { role: 'assistant', content: blocks.filter(Boolean) }; input.push(assistant); entries.push(assistant);
      calls.push(...blocks.filter(b => b?.type === 'tool_use').map(b => ({ id: b.id, name: b.name, args: JSON.stringify(b.input) })));
    }
    if (!calls.length) return { text, reasoning, raw: { protocol: connection.protocol, entries }, usage, sources };
    const anthropicResults: any[] = [];
    let productive = false;
    for (const call of calls) {
      const event: ToolEvent = { id: call.id, name: call.name, input: call.args, output: '', status: 'running', started: Date.now() }; hooks.tool(event);
      try {
        if (call.name === 'datetime' && hasLocalTools) {
          if (!recordToolCall(toolCounts, 'datetime')) throw new Error(toolCallLimitError('datetime'));
          productive = true;
          event.output = currentDateTime(); event.status = 'done';
        } else if (call.name === 'web_fetch' && hasWebFetch && webFetch) {
          if (!recordToolCall(toolCounts, 'web_fetch')) throw new Error(toolCallLimitError('web_fetch'));
          productive = true;
          const args = JSON.parse(call.args), page = await webFetch(String(args.url || ''), signal, settings, config.webFetch);
          addSources([{ title: page.title || page.url, url: page.url }]);
          event.output = JSON.stringify(page); event.status = 'done';
        } else if (isExternalSearch(config.search) && call.name === searchToolName(config.search)) {
          if (!recordToolCall(toolCounts, call.name)) throw new Error(toolCallLimitError(call.name));
          productive = true;
          const results = await externalSearch(config.search, call.args, settings, signal); addSources(results);
          event.output = JSON.stringify(results); event.status = 'done';
        } else throw new Error('不支持的工具调用');
      } catch (error) { if (signal.aborted) throw error; event.output = JSON.stringify({ error: String(error), instruction: '网页抓取或搜索未成功。明确告诉用户，不要虚构网页内容、搜索结果或引用。' }); event.status = 'error'; }
      event.elapsed = Date.now() - event.started; hooks.tool({ ...event });
      if (connection.protocol === 'anthropic') anthropicResults.push({ type: 'tool_result', tool_use_id: call.id, content: event.output, is_error: event.status === 'error' });
      else { const item = connection.protocol === 'chat' ? { role: 'tool', tool_call_id: call.id, content: event.output } : { type: 'function_call_output', call_id: call.id, output: event.output }; input.push(item); entries.push(item); }
    }
    if (anthropicResults.length) { const item = { role: 'user', content: anthropicResults }; input.push(item); entries.push(item); }
    if (productive) unproductiveRounds = 0;
    else if (++unproductiveRounds > MAX_UNPRODUCTIVE_TOOL_ROUNDS) throw new Error(unproductiveToolRoundsError());
  }
  throw new Error('工具调用未能在限定轮数内完成');
}
/**
 * Reads one entry of a model list. Services differ in what they describe and in casing, so the known
 * spellings are accepted and anything missing is simply left absent; the settings page then falls
 * back to its own defaults. A bare string is a valid entry too.
 */
export function parseServerModel(entry: unknown): ServerModel {
  if (typeof entry === 'string') return { id: entry };
  const model = (entry || {}) as Record<string, any>;
  const text = (...values: unknown[]) => { for (const value of values) if (typeof value === 'string' && value.trim()) return value.trim(); return undefined; };
  const count = (...values: unknown[]) => { for (const value of values) { const number = Number(value); if (Number.isFinite(number) && number > 0) return Math.floor(number); } return undefined; };
  const list = (...values: unknown[]) => { for (const value of values) if (Array.isArray(value) && value.length) return value.filter(item => typeof item === 'string' && item.trim()).map(item => String(item).trim()); return undefined; };
  const effort = (model.effort ?? model.reasoning ?? {}) as Record<string, any>;
  // OpenRouter 把上下文长度放在 context_length、模态放在嵌套的 architecture 里。
  const architecture = (model.architecture ?? {}) as Record<string, any>;
  const parsed: ServerModel = {
    id: text(model.id, model.model, model.name) || '',
    // `displayName`/`display_name` win: Gemini uses `name` for the resource path, not for display.
    name: text(model.display_name, model.displayName, model.name),
    contextWindow: count(model.context_window, model.contextWindow, model.context_length, model.inputTokenLimit, model.input_token_limit),
    maxOutput: count(model.max_output_tokens, model.maxOutputTokens, model.outputTokenLimit, model.output_token_limit, model.max_tokens),
    inputModalities: list(model.input_modalities, model.inputModalities, architecture.input_modalities),
    outputModalities: list(model.output_modalities, model.outputModalities, architecture.output_modalities),
    // `none` 保留：它是"关闭思考"的一等档位（DeepSeek、Ollama 都这样定义），不是可以丢的同义词。
    efforts: list(effort.supported_levels, effort.supportedLevels),
    defaultEffort: text(effort.default_level, effort.defaultLevel)
  };
  // Absent descriptions stay absent: the settings page falls back per field, and callers that compare
  // whole entries should not have to distinguish "missing" from "explicitly undefined".
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as ServerModel;
}
export async function listModels(connection: Connection): Promise<ServerModel[]> {
  const models: ServerModel[] = [], seenPosts = new Set<string>(), seenPages = new Set<string>(); let pageToken = '';
  if (connection.protocol === 'anthropic') {
    const primaryUrl = endpoint(connection, 'models');
    const url = new URL(connection.baseUrl);
    const basePath = url.pathname.replace(/\/+$/, '');
    const parentPath = basePath.slice(0, basePath.lastIndexOf('/'));
    url.pathname = `${parentPath}/models`;
    url.search = ''; url.hash = '';
    const fallbackUrl = url.toString();
    const read = async (target: string, bearerAuth = false) => {
      const requestConnection = bearerAuth ? { ...connection, protocol: 'chat' as const } : connection;
      const { response, close } = await requestUrl(requestConnection, target, undefined, new AbortController().signal);
      let json: any;
      try { json = await response.json(); } finally { await close(); }
      return (json.data || json.models || []).map((entry: any) => parseServerModel(entry)).filter((model: ServerModel) => model.id);
    };
    try {
      const models = await read(primaryUrl);
      if (models.length) return models;
      throw new Error('服务未返回模型列表');
    } catch (primaryError) {
      if (fallbackUrl === primaryUrl) throw primaryError;
      try {
        const models = await read(fallbackUrl, true);
        if (models.length) return models;
        throw new Error('服务未返回模型列表');
      } catch (fallbackError) {
        const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
        throw new Error(`模型列表请求失败（${primaryUrl}）：${describe(primaryError)}；回退地址 ${fallbackUrl} 也失败：${describe(fallbackError)}`);
      }
    }
  }
  do {
    const path = connection.protocol === 'gemini' ? `models?pageSize=1000${pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''}` : 'models';
    const { response, close } = await request(connection, path, undefined, new AbortController().signal);
    let json: any;
    try { json = await response.json(); } finally { await close(); }
    if (connection.protocol !== 'gemini') return (json.data || json.models || []).map((entry: any) => parseServerModel(entry)).filter((model: ServerModel) => model.id);
    // Gemini lists models as `models/<id>` and describes limits as input/outputTokenLimit.
    for (const entry of (json.models || []) as any[]) {
      if (entry?.supportedGenerationMethods && !entry.supportedGenerationMethods.includes('generateContent')) continue;
      const resource = typeof entry?.name === 'string' ? entry.name : '';
      const model = parseServerModel(entry);
      model.id = model.id.replace(/^models\//, '');
      // The resource path (`models/gemini-x`) is an id, not a name to show in the picker.
      if (resource && model.name === resource) delete model.name;
      if (model.id) models.push(model);
    }
    pageToken = json.nextPageToken || '';
    if (pageToken && seenPages.has(pageToken)) throw new Error('Gemini 模型列表分页重复，请稍后重试');
    if (pageToken) seenPages.add(pageToken);
    if (seenPages.size > 100) throw new Error('Gemini 模型列表页数超过限制');
  } while (pageToken);
  // A model may be listed twice (pagination boundaries); the first description wins.
  const unique = new Map(models.map(model => [model.id, model]));
  return [...unique.values()];
}
