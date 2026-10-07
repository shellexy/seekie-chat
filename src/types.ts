export type Protocol = 'chat' | 'responses' | 'anthropic' | 'gemini';
export type SearchMode = 'auto' | 'off' | 'native' | 'exa' | 'ollama' | 'tavily' | 'firecrawl' | 'anysearch' | 'deepseek';
// The providers that answer a search request themselves, as opposed to the model's own native search.
export type ExternalSearchMode = Exclude<SearchMode, 'auto' | 'off' | 'native'>;
export type WebFetchMode = 'auto' | 'off' | 'local' | 'exa' | 'ollama' | 'tavily' | 'firecrawl' | 'anysearch' | 'deepseek';
export type Role = 'user' | 'assistant';
export interface Connection {
  id: string; name: string; protocol: Protocol; baseUrl: string; apiKey: string;
  headers: Record<string, string>; timeout: number; proxy: string;
}
export interface Model {
  id: string; connectionId: string; name: string; model: string;
  contextWindow: number; maxOutput: number; vision: boolean; tools: boolean;
  videoInput?: boolean; audioInput?: boolean; pdfInput?: boolean;
  nativeSearch: boolean; reasoning: 'none' | 'effort' | 'budget';
  efforts: string[]; temperature: boolean; outputTokenField?: 'max_completion_tokens' | 'max_tokens'; streamUsage?: boolean;
  // The effort level to start at when switching to this model. Either the service's own
  // recommendation (default_level) or a level a preset picked, so it is not always a recommendation.
  defaultEffort?: string;
}
export interface ChatConfig {
  modelId: string; system: string; search: SearchMode; effort: string; budget: number;
  webFetch?: WebFetchMode;
  // Background requests (title, compression) disable client tools; absent means enabled.
  localTools?: boolean;
  temperature?: number; topP?: number;
}
export interface PromptPreset { id: string; name: string; content: string }
export interface Settings {
  promptPresets: PromptPreset[]; defaultPromptPresetId: string;
  connections: Connection[]; models: Model[]; defaultModel: string; titleModel: string;
  compressionModel: string; theme: 'light' | 'dark' | 'system'; fontSize: number;
  // 模型收藏与最近使用。收藏由用户手动标记；最近使用按"切换即记、成功置顶"维护。
  favoriteModels: string[]; recentModels: string[]; useRecentModel: boolean;
  // 新对话的搜索起点，以及自动模式下模型原生搜索是否优先于外部搜索服务。
  defaultSearch: SearchMode; preferNativeSearch: boolean;
  // 自动模式下外部搜索链的第一项：'auto' 保持内置顺序。缺 Key 时跳过该家继续降级。
  preferredExternalSearch: ExternalSearchMode | 'auto';
  // 新对话的默认读取网页方法，'last' 表示接着最近一次在会话里选择的；lastWebFetch 记录那个值。
  defaultWebFetch: WebFetchMode | 'last'; lastWebFetch: WebFetchMode;
  exaKey: string; ollamaKey: string; tavilyKey: string; firecrawlKey: string; anysearchKey: string;
  // DeepSeek Search/Fetch 按次计费，留空时复用主机名为 api.deepseek.com 的连接密钥。
  deepseekKey: string;
  // 开启后 DeepSeek Search 返回网页正文（content）；关闭时只拿 summary，网页正文交给 Fetch。
  deepseekNeedContent: boolean;
  exaResults: number; autoCompress: boolean; compressionThreshold: number;
  secureStorage: boolean; secretPolicy: 'file' | 'session' | 'encrypted'; credentialStorageVersion?: number;
}
export interface Attachment { id: string; name: string; mime: string; size: number; data: string; markdown?: string }
export interface ToolEvent {
  id: string; name: string; input: string; output: string; status: 'pending' | 'running' | 'done' | 'error';
  started: number; elapsed?: number;
}
// A reasoning segment records how long that segment streamed, so an answer with several of them
// can show a duration per card instead of one total on the last card.
export type AssistantSegment = { type: 'text'; text: string } | { type: 'reasoning'; text: string; ms?: number } | { type: 'tool'; toolId: string };
export interface Source { title: string; url: string }
export interface Usage {
  input: number; output: number; estimated?: boolean;
  // Cached reads are a subset of total input; absent means the service did not report them.
  cachedInput?: number;
  // Full chat request duration includes visible tool waits; generationMs excludes the union of measured tool intervals.
  elapsedMs?: number; generationMs?: number; firstTokenMs?: number;
}
export interface Message {
  id: string; parentId: string | null; role: Role; text: string; reasoning: string;
  // Ordered assistant output events. Missing on messages saved by older releases.
  segments?: AssistantSegment[];
  reasoningMs?: number;
  attachments: Attachment[]; tools: ToolEvent[]; sources: Source[];
  status: 'complete' | 'streaming' | 'interrupted' | 'error'; error?: string;
  created: number; edited?: boolean; modelId?: string; modelName?: string; connectionName?: string; config?: ChatConfig; usage?: Usage;
  // Protocol-native assistant payload, preserved for signed thinking and tool continuity.
  raw?: unknown;
  // Maintained by the main process while an answer streams. Patches and full states both carry it,
  // so a snapshot produced earlier can never overwrite newer streamed text.
  streamRevision?: number;
}
export interface Summary {
  text: string; nodeIds: string[]; modelId: string; created: number;
}
export interface Branch {
  id: string; name: string; leafId: string | null; originId: string | null;
  parentBranchId: string | null; config: ChatConfig; draft: string;
  draftAttachments: Attachment[]; scrollTop: number; updated: number; summary?: Summary;
}
export interface Conversation {
  id: string; title: string; manualTitle: boolean; titleState: 'idle' | 'pending' | 'done';
  archived?: boolean;
  created: number; updated: number; backgroundUsage?: { kind: 'title' | 'compression'; modelId: string; usage: Usage; created: number }[]; activeBranchId: string; branches: Branch[]; messages: Message[];
}
export interface AppState { settings: Settings; conversations: Conversation[]; selectedId: string | null }
// One outgoing API request as shown by the in-app debug view. Credentials are masked before the
// renderer ever receives the record, and the body is a pretty-printed (possibly truncated) string.
export interface RequestRecord { url: string; method: string; headers: Record<string, string>; body: string; error?: string }
// One entry of a provider's model list. Only the id is guaranteed: services such as DeepSeek also
// describe the display name, the context window, the output limit and the supported modalities, and
// those descriptions become the defaults of a newly added model.
export interface ServerModel {
  id: string;
  name?: string;
  contextWindow?: number;
  maxOutput?: number;
  inputModalities?: string[];
  outputModalities?: string[];
  efforts?: string[];
  defaultEffort?: string;
}
// One streaming answer, sent on its own instead of shipping the whole state.
export interface MessagePatch { conversationId: string; message: Message }
export interface RunRequest { conversationId: string; branchId: string; messageId: string }
export interface AppEvent { state?: AppState; patch?: MessagePatch; tasks?: { conversationId: string; branchId: string; kind: string }[]; task?: { conversationId: string; branchId: string; kind: string } | null; error?: string }
export interface Bridge {
  load(): Promise<AppState>; save(state: AppState): Promise<AppState>;
  run(request: RunRequest): Promise<void>; cancel(conversationId: string): Promise<void>;
  compress(conversationId: string, branchId: string): Promise<void>;
  test(connection: Connection): Promise<ServerModel[]>; title(conversationId: string): Promise<void>;
  debug(messageId: string): Promise<RequestRecord[]>;
  // Attachment payloads are fetched one at a time instead of travelling with every broadcast.
  attachment(id: string): Promise<string>;
  exportData(format: 'json' | 'markdown', conversationId?: string): Promise<boolean>;
  importData(): Promise<AppState | null>;
  openExternal(url: string): Promise<void>;
  minimizeWindow(): Promise<void>; toggleMaximizeWindow(): Promise<boolean>; isWindowMaximized(): Promise<boolean>; closeWindow(): Promise<void>;
  onWindowState(callback: (maximized: boolean) => void): () => void;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global { interface Window { deepchan?: Bridge } }
