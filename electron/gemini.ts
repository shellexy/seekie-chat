import type { ChatConfig, Connection, ExternalSearchMode, Message, Model, RequestRecord, SearchMode, Settings, Source, ToolEvent } from '../src/types';
import type { Hooks, Result, WebFetch } from './providers';
import type { request, buildInput } from './providers';
import { UsageCounter } from './usage';
import { currentDateTime, geminiDatetimeTool, localToolsEnabled, MAX_UNPRODUCTIVE_TOOL_ROUNDS, recordToolCall, remainingToolCalls, toolCallLimitError, toolRoundBudget, unproductiveToolRoundsError } from './local_tools';
import { EXTERNAL_SEARCH_MODES, resolveSearch, UNTRUSTED_CONTENT_NOTE } from '../src/domain';
type Dependencies = {
  request: typeof request; buildInput: typeof buildInput;
  search: (mode: ExternalSearchMode, args: string, settings: Settings, signal: AbortSignal) => Promise<Source[]>;
  webFetch?: WebFetch;
  sse: (body: AsyncIterable<Uint8Array>, sink?: { response?: string }) => AsyncGenerator<any>;
  record?: (entry: RequestRecord) => void;
};
function isExternalSearch(mode: SearchMode): mode is ExternalSearchMode { return EXTERNAL_SEARCH_MODES.includes(mode as ExternalSearchMode); }
const SEARCH_LABELS: Record<ExternalSearchMode, string> = { exa: 'Exa', ollama: 'Ollama Cloud', tavily: 'Tavily', firecrawl: 'Firecrawl', anysearch: 'AnySearch', deepseek: 'DeepSeek' };
function searchTool(mode: ExternalSearchMode) {
  return {
  name: mode === 'exa' ? 'exa_search' : mode === 'ollama' ? 'ollama_web_search' : mode === 'tavily' ? 'tavily_search' : mode === 'firecrawl' ? 'firecrawl_search' : mode === 'deepseek' ? 'deepseek_search' : 'anysearch_search', description: `搜索互联网获取当前信息，返回真实来源和正文片段。${UNTRUSTED_CONTENT_NOTE}`,
  parameters: { type: 'OBJECT', properties: { query: { type: 'STRING', description: '搜索查询' } }, required: ['query'] }
  };
}
const webFetchTool = {
  name: 'web_fetch', description: `抓取公开网页正文并转换为 Markdown。输入应是搜索结果或用户提供的完整网页 URL。${UNTRUSTED_CONTENT_NOTE}`,
  parameters: { type: 'OBJECT', properties: { url: { type: 'STRING', description: '要抓取的 HTTP 或 HTTPS 网页 URL' } }, required: ['url'] }
};

// A Part must set exactly one content field, and the provider treats an EMPTY value as "oneof not
// initialized" (400 "required oneof field 'data' must have one initialized field"). Streaming can
// deliver a chunk with only thought metadata or a `{"text": ""}` chunk, so neither counts as
// content: such chunks are folded into the neighbouring part instead of being stored and replayed.
function hasPartContent(part: any) {
  return (typeof part?.text === 'string' && part.text.length > 0)
    || !!part?.inlineData?.data || !!part?.fileData?.fileUri
    || !!part?.functionCall || !!part?.functionResponse
    || !!part?.executableCode || !!part?.codeExecutionResult || !!part?.toolCall || !!part?.toolResponse;
}
// Streaming chunks can split a text part's signature from its text. Keep them together
// for the next request, and never merge across an already signed part.
function appendPart(parts: any[], part: any, pending: { thoughtSignature?: string }) {
  const previous = parts.at(-1);
  if (!hasPartContent(part)) {
    // A signature that arrives before any content belongs to the part that follows it.
    if (part.thoughtSignature) { if (previous) previous.thoughtSignature = part.thoughtSignature; else pending.thoughtSignature = part.thoughtSignature; }
    return;
  }
  if (typeof part.text === 'string' && typeof previous?.text === 'string' && !!previous.thought === !!part.thought && !previous.thoughtSignature) {
    previous.text += part.text;
    const signature = part.thoughtSignature || pending.thoughtSignature;
    if (signature) { previous.thoughtSignature = signature; pending.thoughtSignature = undefined; }
    return;
  }
  const stored = structuredClone(part);
  if (pending.thoughtSignature) { stored.thoughtSignature = stored.thoughtSignature || pending.thoughtSignature; pending.thoughtSignature = undefined; }
  parts.push(stored);
}
// Tool outputs are JSON strings except datetime, which returns a readable line.
function parseToolOutput(value: string) {
  try { return JSON.parse(value); } catch { return { text: value }; }
}
// Older releases stored parts that carry no content field. Replaying them fails the request, so
// drop them while keeping their signature on the neighbouring part.
export function sanitizeStoredParts(parts: any[]): any[] {
  const clean: any[] = []; let pending: string | undefined;
  for (const part of parts) {
    if (!hasPartContent(part)) { if (part?.thoughtSignature) { const previous = clean.at(-1); if (previous) previous.thoughtSignature ||= part.thoughtSignature; else pending = part.thoughtSignature; } continue; }
    const stored = { ...part };
    if (pending && !stored.thoughtSignature) stored.thoughtSignature = pending;
    pending = undefined;
    clean.push(stored);
  }
  return clean;
}
// Last line of defence before sending: every Part must set exactly one content field, whatever the
// source (streamed chunk, stored history or a tool round). Repairing here keeps a single bad part
// from failing the whole request with an opaque upstream 400.
export function sanitizeContents(contents: any[]) {
  return contents.map(entry => Array.isArray(entry?.parts) ? { ...entry, parts: sanitizeStoredParts(entry.parts) } : entry);
}
// Google requires the opt-in whenever built-in tools meet function calling, and history that already
// contains function calls counts even when this round declares no functions.
function usesFunctionCalling(contents: any[], declarations: any[]) {
  if (declarations.length) return true;
  return contents.some(entry => Array.isArray(entry?.parts) && entry.parts.some((part: any) => part?.functionCall || part?.functionResponse));
}
export async function generateGemini(connection: Connection, model: Model, config: ChatConfig, messages: Message[], settings: Settings, signal: AbortSignal, hooks: Hooks, deps: Dependencies): Promise<Result> {
  config = { ...config, webFetch: config.webFetch || (config.search === 'off' ? 'off' : 'auto') };
  const modelId = model.model.replace(/^models\//, '');
  if (!modelId || /[/?#]/.test(modelId)) throw new Error('Gemini 模型 ID 无效，请填写模型名称或 models/模型名称');
  const path = `models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`;
  // Google only allows built-in tools (Google Search) together with function declarations when the
  // request opts in and the model supports the combination; older models must use one or the other.
  const supportsBuiltInToolCombination = /^gemini-[3-9](?:[.-]|$)/i.test(modelId);
  const functionsAllowed = config.search !== 'native' || supportsBuiltInToolCombination;
  const hasWebFetch = functionsAllowed && model.tools && config.webFetch !== 'off' && !!deps.webFetch;
  const hasLocalTools = functionsAllowed && localToolsEnabled(model, config);
  // Per-answer quotas are tracked per tool name; Google Search stays provider-side.
  const toolCounts = new Map<string, number>();
  const budget = (externalSearch: string) => Math.max(toolRoundBudget([
    ...(hasLocalTools ? ['datetime'] : []),
    ...(externalSearch ? [externalSearch] : []),
    ...(hasWebFetch ? ['web_fetch'] : [])
  ]), MAX_UNPRODUCTIVE_TOOL_ROUNDS + 1);
  // Native search can be traded for an external provider when a relay drops tool_config.
  let searchMode = config.search, externalSearchName = isExternalSearch(searchMode) ? searchTool(searchMode).name : '';
  let maxRounds = budget(externalSearchName);
  const input = deps.buildInput('gemini', messages, model), entries: any[] = [];
  let unproductiveRounds = 0;
  let text = '', reasoning = '';
  const sources: Source[] = [], counter = new UsageCounter(), usage = counter.total;
  const addSources = (items: Source[]) => {
    for (const item of items) if (/^https?:\/\//.test(item.url) && !sources.some(s => s.url === item.url)) sources.push({ title: item.title, url: item.url });
    hooks.sources([...sources]);
  };
  // A relay can drop tool_config while forwarding tools, which makes Google reject the built-in +
  // function combination. Keep the local tools and retry without the built-in one in that case.
  let builtInSearch = searchMode === 'native';
  for (let round = 0; round < maxRounds; round++) {
    const offerDatetime = hasLocalTools && remainingToolCalls(toolCounts, 'datetime') > 0;
    const offerWebFetch = hasWebFetch && remainingToolCalls(toolCounts, 'web_fetch') > 0;
    const generationConfig: any = { maxOutputTokens: model.maxOutput, ...(model.temperature ? { temperature: config.temperature ?? 1, topP: config.topP ?? 1 } : {}) };
    if (model.reasoning === 'effort') {
      const thinking: any = { includeThoughts: true };
      if (config.effort !== 'auto') {
        if (!['minimal', 'low', 'medium', 'high'].includes(config.effort)) throw new Error('Gemini 思考等级支持 minimal、low、medium、high，请按模型能力配置');
        thinking.thinkingLevel = config.effort.toUpperCase();
      }
      generationConfig.thinkingConfig = thinking;
    } else if (model.reasoning === 'budget') {
      if (!Number.isInteger(config.budget) || config.budget < 0 || config.budget >= model.maxOutput) throw new Error('Gemini 思考预算应为非负整数，并小于最大输出 token');
      generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: config.budget };
    }
    // See the same note in providers.ts: the prompt is sent verbatim and tool guidance lives in the
    // tool descriptions, where a prompt edit cannot remove it.
    const system = config.system;
    const body: any = { contents: sanitizeContents(input), generationConfig, ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}) };
    const tools: any[] = [];
    if (builtInSearch) tools.push({ googleSearch: {} });
    const declarations: any[] = [];
    if (isExternalSearch(searchMode) && remainingToolCalls(toolCounts, externalSearchName) > 0) declarations.push(searchTool(searchMode));
    if (offerWebFetch) declarations.push(webFetchTool);
    if (offerDatetime) declarations.push(geminiDatetimeTool);
    if (declarations.length) tools.push({ functionDeclarations: declarations });
    if (tools.length) body.tools = tools;
    // Required whenever built-in tools and function calling meet; the provider otherwise fails the
    // request with "Please enable tool_config.include_server_side_tool_invocations".
    if (builtInSearch && usesFunctionCalling(body.contents, declarations)) body.toolConfig = { includeServerSideToolInvocations: true };
    let request: Awaited<ReturnType<typeof deps.request>>;
    try { request = await deps.request(connection, path, body, signal, model, deps.record); }
    catch (error) {
      if (!builtInSearch || !/include_server_side_tool_invocations/i.test(String(error))) throw error;
      builtInSearch = false;
      // Prefer an external provider (including the keyless Tavily fallback) over losing search;
      // native is excluded because that is exactly what the relay refused to combine.
      const fallback = resolveSearch({ ...settings, models: [{ ...model, nativeSearch: false }] }, model.id, 'auto');
      if (isExternalSearch(fallback)) {
        searchMode = fallback; externalSearchName = searchTool(fallback).name; maxRounds = budget(externalSearchName);
        hooks.notice?.(`中转服务未转发 tool_config，本次改用 ${SEARCH_LABELS[fallback]} 搜索以保留日期时间和网页工具`);
      } else hooks.notice?.('中转服务未转发 tool_config，本次回答不含联网搜索');
      round--; continue;
    }
    const { response, close, entry } = request;
    const parts: any[] = [], pendingSignature: { thoughtSignature?: string } = {};
    let finishReason = '', callSequence = 0;
    const searchId = crypto.randomUUID(), searchStarted = Date.now();
    try {
      if (!response.body) throw new Error('服务没有返回响应内容');
      for await (const ev of deps.sse(response.body, entry)) {
        if (ev.error) throw new Error(ev.error.message || 'Gemini 生成失败');
        if (ev.promptFeedback?.blockReason) throw new Error('Gemini 拒绝了此请求：' + ev.promptFeedback.blockReason);
        const candidate = ev.candidates?.find((c: any) => c.index === 0 || c.index === undefined);
        if (candidate) {
          for (const part of candidate.content?.parts || []) {
            // The id must live on the part itself: appendPart may fold the chunk into the previous
            // part, which invalidates positional bookkeeping.
            if (part.functionCall && !part.functionCall.id) part.functionCall.id = `gemini-${round}-${callSequence++}`;
            appendPart(parts, part, pendingSignature);
            if (part.functionCall) hooks.tool({ id: part.functionCall.id, name: part.functionCall.name || 'tool', input: JSON.stringify(part.functionCall.args || {}), output: '', status: 'pending', started: Date.now() });
            if (typeof part.text === 'string') {
              if (part.thought) { reasoning += part.text; hooks.reasoning(part.text); }
              else { text += part.text; hooks.text(part.text); }
            }
          }
          const grounding = candidate.groundingMetadata;
          if (grounding) {
            addSources((grounding.groundingChunks || []).filter((c: any) => c.web?.uri).map((c: any) => ({ title: c.web.title || c.web.uri, url: c.web.uri })));
            if (grounding.webSearchQueries?.length || grounding.groundingChunks?.length) {
              hooks.tool({ id: searchId, name: 'google_search', input: JSON.stringify(grounding.webSearchQueries || []), output: '搜索完成，来源见回答引用', status: 'done', started: searchStarted, elapsed: Date.now() - searchStarted });
            }
          }
          addSources((candidate.citationMetadata?.citationSources || []).filter((c: any) => c.uri).map((c: any) => ({ title: c.title || c.uri, url: c.uri })));
          if (candidate.finishReason) finishReason = candidate.finishReason;
        }
        // Gemini usage metadata is cumulative within one streamed response.
        if (ev.usageMetadata) {
          counter.observe({ input: ev.usageMetadata.promptTokenCount, output: (ev.usageMetadata.candidatesTokenCount || 0) + (ev.usageMetadata.thoughtsTokenCount || 0), cachedInput: ev.usageMetadata.cachedContentTokenCount });
        }
      }
    } finally { await close(); }
    counter.finishRound();
    if (!finishReason) throw new Error('Gemini 流式连接提前结束，已收到的内容已保留');
    if (finishReason !== 'STOP') throw new Error('Gemini 回答未完整生成：' + finishReason);
    if (!parts.length) throw new Error('Gemini 未返回回答内容');
    const assistant = { role: 'model', parts }; input.push(assistant); entries.push(assistant);
    const calls = parts.flatMap(part => part.functionCall ? [{ ...part.functionCall, id: part.functionCall.id || crypto.randomUUID() }] : []);
    if (!calls.length) return { text, reasoning, raw: { protocol: 'gemini', entries }, usage, sources };
    const results: any[] = [];
    let productive = false;
    for (const call of calls) {
      const event: ToolEvent = { id: call.id, name: call.name, input: JSON.stringify(call.args || {}), output: '', status: 'running', started: Date.now() };
      hooks.tool(event);
      try {
        if (call.name === 'datetime' && hasLocalTools) {
          if (!recordToolCall(toolCounts, 'datetime')) throw new Error(toolCallLimitError('datetime'));
          productive = true;
          event.output = currentDateTime(); event.status = 'done';
        } else if (call.name === 'web_fetch' && hasWebFetch && deps.webFetch) {
          if (!recordToolCall(toolCounts, 'web_fetch')) throw new Error(toolCallLimitError('web_fetch'));
          productive = true;
          const page = await deps.webFetch(String(call.args?.url || ''), signal, settings, config.webFetch);
          addSources([{ title: page.title || page.url, url: page.url }]);
          event.output = JSON.stringify(page); event.status = 'done';
        } else if (isExternalSearch(searchMode) && call.name === searchTool(searchMode).name) {
          if (!recordToolCall(toolCounts, call.name)) throw new Error(toolCallLimitError(call.name));
          productive = true;
          const found = await deps.search(searchMode, event.input, settings, signal); addSources(found);
          event.output = JSON.stringify(found); event.status = 'done';
        } else throw new Error('不支持的工具调用');
      } catch (error) {
        if (signal.aborted) throw error;
        event.output = JSON.stringify({ error: String(error), instruction: '网页抓取或搜索未成功。明确告诉用户，不要虚构网页内容、搜索结果或引用。' }); event.status = 'error';
      }
      event.elapsed = Date.now() - event.started; hooks.tool({ ...event });
      // Gemini expects an object payload; datetime returns a plain line the model can quote.
      const payload = call.name === 'datetime' && event.status !== 'error' ? { datetime: event.output } : parseToolOutput(event.output);
      results.push({ functionResponse: { name: call.name, ...(parts.find(p => p.functionCall?.id === call.id) ? { id: call.id } : {}), response: event.status === 'error' || call.name === 'web_fetch' || call.name === 'datetime' ? payload : { results: payload } } });
    }
    const result = { role: 'user', parts: results }; input.push(result); entries.push(result);
    if (productive) unproductiveRounds = 0;
    else if (++unproductiveRounds > MAX_UNPRODUCTIVE_TOOL_ROUNDS) throw new Error(unproductiveToolRoundsError());
  }
  throw new Error('工具调用未能在限定轮数内完成');
}
