export type Protocol = 'chat' | 'responses' | 'anthropic';
export type SearchMode = 'auto' | 'off' | 'native' | 'exa';
export type Role = 'user' | 'assistant';
export interface Connection {
  id: string; name: string; protocol: Protocol; baseUrl: string; apiKey: string;
  headers: Record<string, string>; timeout: number; proxy: string;
  defaultReasoning?: Model['reasoning'];
}
export interface Model {
  id: string; connectionId: string; name: string; model: string;
  contextWindow: number; maxOutput: number; vision: boolean; tools: boolean;
  nativeSearch: boolean; reasoning: 'none' | 'effort' | 'budget';
  efforts: string[]; temperature: boolean; outputTokenField?: 'max_completion_tokens' | 'max_tokens'; streamUsage?: boolean;
}
export interface ChatConfig {
  modelId: string; system: string; search: SearchMode; effort: string; budget: number;
}
export interface Settings {
  connections: Connection[]; models: Model[]; defaultModel: string; titleModel: string;
  compressionModel: string; theme: 'light' | 'dark' | 'system'; fontSize: number;
  exaKey: string; exaResults: number; autoCompress: boolean; compressionThreshold: number;
  secureStorage: boolean; secretPolicy: 'file' | 'session' | 'encrypted'; credentialStorageVersion?: number;
}
export interface Attachment { id: string; name: string; mime: string; size: number; data: string }
export interface ToolEvent {
  id: string; name: string; input: string; output: string; status: 'running' | 'done' | 'error';
  started: number; elapsed?: number;
}
export interface Source { title: string; url: string }
export interface Usage { input: number; output: number; estimated?: boolean }
export interface Message {
  id: string; parentId: string | null; role: Role; text: string; reasoning: string;
  attachments: Attachment[]; tools: ToolEvent[]; sources: Source[];
  status: 'complete' | 'streaming' | 'interrupted' | 'error'; error?: string;
  created: number; edited?: boolean; modelId?: string; config?: ChatConfig; usage?: Usage;
  // Protocol-native assistant payload, preserved for signed thinking and tool continuity.
  raw?: unknown;
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
  created: number; updated: number; backgroundUsage?: { kind: 'title' | 'compression'; modelId: string; usage: Usage; created: number }[]; activeBranchId: string; branches: Branch[]; messages: Message[];
}
export interface AppState { settings: Settings; conversations: Conversation[]; selectedId: string | null }
export interface RunRequest { conversationId: string; branchId: string; messageId: string }
export interface AppEvent { state?: AppState; tasks?: { conversationId: string; branchId: string; kind: string }[]; task?: { conversationId: string; branchId: string; kind: string } | null; error?: string }
export interface Bridge {
  load(): Promise<AppState>; save(state: AppState): Promise<AppState>;
  run(request: RunRequest): Promise<void>; cancel(conversationId: string): Promise<void>;
  compress(conversationId: string, branchId: string): Promise<void>;
  test(connection: Connection): Promise<string[]>; title(conversationId: string): Promise<void>;
  exportData(format: 'json' | 'markdown', conversationId?: string): Promise<boolean>;
  importData(): Promise<AppState | null>;
  openExternal(url: string): Promise<void>;
  onEvent(callback: (event: AppEvent) => void): () => void;
}
declare global { interface Window { deepchan?: Bridge } }
