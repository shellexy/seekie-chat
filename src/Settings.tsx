import { useState } from 'react';
import { ArrowLeft, Check, ChevronRight, ExternalLink, Plus, Trash2, Wifi } from 'lucide-react';
import { api } from './api';
import { uid } from './domain';
import type { Connection, Model, Settings as SettingsType } from './types';
const saved = '••••••••';
const templates = [
  { name: 'DeepSeek·anthropic', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' },
  { name: 'OpenAI · Responses', protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
  { name: 'OpenAI · Chat Completions', protocol: 'chat', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { name: 'Ollama', protocol: 'chat', baseUrl: 'http://localhost:11434/v1' },
  { name: 'Ollama Cloud', protocol: 'chat', baseUrl: 'https://ollama.com/' },
  { name: '自定义兼容服务', protocol: 'chat', baseUrl: 'http://localhost:8000/v1' }
] as const;
export default function Settings({ settings, onSave, onClose, toast }: { settings: SettingsType; onSave: (s: SettingsType) => Promise<void>; onClose: () => void; toast: (s: string) => void }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [tab, setTab] = useState('connections'), [selected, setSelected] = useState(settings.connections[0]?.id || '');
  const [testing, setTesting] = useState(false), [found, setFound] = useState<string[]>([]), [saving, setSaving] = useState(false);
  const [headersText, setHeadersText] = useState(''), [headersEditing, setHeadersEditing] = useState(false);
  const connection = draft.connections.find(c => c.id === selected);
  function change(values: Partial<SettingsType>) { setDraft(d => ({ ...d, ...values })); }
  function updateConnection(values: Partial<Connection>) { setDraft(d => ({ ...d, connections: d.connections.map(c => c.id === selected ? { ...c, ...values } : c) })); }
  function addConnection(index: number) {
    const t = templates[index];
    const c: Connection = { ...t, id: uid(), apiKey: '', headers: {}, timeout: 120, proxy: '' };
    const presetModel: Model | undefined = t.name === 'DeepSeek·anthropic' ? {
      id: uid(), connectionId: c.id, name: 'deepseek-flash', model: 'deepseek-flash',
      contextWindow: 1_000_000, maxOutput: 256_000, vision: true, tools: true,
      nativeSearch: true, videoInput: false, audioInput: false, pdfInput: false, reasoning: 'effort', efforts: ['low', 'medium', 'high', 'max'], temperature: true
    } : t.name === 'Ollama Cloud' ? {
      id: uid(), connectionId: c.id, name: 'gemma4:31b', model: 'gemma4:31b',
      contextWindow: 256_000, maxOutput: 256_000, vision: true, tools: true,
      nativeSearch: false, videoInput: true, audioInput: false, pdfInput: false, reasoning: 'none', efforts: [], temperature: true, outputTokenField: 'max_tokens'
    } : undefined;
    change({ connections: [...draft.connections, c], ...(presetModel ? { models: [...draft.models, presetModel], defaultModel: draft.defaultModel || presetModel.id } : {}) });
    setSelected(c.id); setFound([]); setHeadersEditing(false);
  }
  function addModel(model = '') {
    if (!connection) return;
    const supportsMax = /^(gpt(?:[-/]|$)|deepseek(?:[-/]|$))/i.test(model.trim());
    const gemini = connection.protocol === 'gemini';
    const qwen = /^qwen(?:\d|[-/]|$)/i.test(model.trim());
    const efforts = gemini ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high', ...(supportsMax ? ['max'] : [])];
    const m: Model = { id: uid(), connectionId: connection.id, name: model || '新模型', model, contextWindow: 1_000_000, maxOutput: 65_536, vision: gemini || qwen, tools: true, nativeSearch: gemini || qwen, videoInput: gemini || qwen, audioInput: gemini, pdfInput: gemini, reasoning: 'effort', efforts, temperature: true };
    change({ models: [...draft.models, m], defaultModel: draft.defaultModel || m.id });
  }
  function updateModel(id: string, values: Partial<Model>) { change({ models: draft.models.map(m => {
    if (m.id !== id) return m;
    const next = { ...m, ...values };
    if (typeof values.model === 'string') {
      if (/^(gpt(?:[-/]|$)|deepseek(?:[-/]|$))/i.test(values.model.trim()) && !next.efforts.includes('max')) next.efforts = [...next.efforts, 'max'];
      if (/^qwen(?:\d|[-/]|$)/i.test(values.model.trim())) Object.assign(next, { vision: true, tools: true, nativeSearch: true, videoInput: true });
    }
    return next;
  }) }); }
  async function save() {
    try {
      setSaving(true);
      for (const c of draft.connections) { new URL(c.baseUrl); if (!c.name.trim()) throw new Error('请填写连接名称'); }
      for (const m of draft.models) { if (!m.model.trim()) throw new Error('请填写每个模型的模型 ID'); if (m.maxOutput < 1 || m.contextWindow < m.maxOutput) throw new Error('上下文窗口不能小于最大输出 token'); }
      for (const p of draft.promptPresets) { if (!p.name.trim() || !p.content.trim()) throw new Error('请填写每个角色的名称和系统提示词'); }
      const ids = new Set(draft.models.map(m => m.id));
      const next = { ...draft, defaultModel: ids.has(draft.defaultModel) ? draft.defaultModel : draft.models[0]?.id || '', titleModel: ids.has(draft.titleModel) ? draft.titleModel : '', compressionModel: ids.has(draft.compressionModel) ? draft.compressionModel : '' };
      if (headersEditing && connection) { let headers: unknown; try { headers = JSON.parse(headersText); } catch { throw new Error('自定义请求头必须是有效 JSON'); } if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.values(headers).some(v => typeof v !== 'string')) throw new Error('请求头应为字符串值的 JSON 对象'); next.connections = next.connections.map(c => c.id === selected ? { ...c, headers: headers as Record<string,string> } : c); }
      await onSave(next); toast('设置已保存'); onClose();
    } catch (e) { toast(String(e instanceof Error ? e.message : e)); } finally { setSaving(false); }
  }
  const chooseModel = (label: string, key: 'defaultModel' | 'titleModel' | 'compressionModel', inherit = false) => <label className="field">{label}<select value={draft[key]} onChange={e => change({ [key]: e.target.value })}>{inherit && <option value="">继承当前聊天模型</option>}{!inherit && <option value="">请选择模型</option>}{draft.models.map(m => <option key={m.id} value={m.id}>{m.name} · {draft.connections.find(c => c.id === m.connectionId)?.name}</option>)}</select></label>;
  return <div className="settings-page"><header className="settings-header"><button className="icon-button" onClick={onClose} title="返回聊天"><ArrowLeft size={20}/></button><div><h1>设置</h1><p>连接你的模型，调整你的工作方式。</p></div><button className="primary" onClick={save} disabled={saving}><Check size={16}/>{saving ? '保存中…' : '保存设置'}</button></header>
    <div className="settings-body"><nav className="settings-nav">{[['connections', '连接与模型'], ['roles', '模型与上下文'], ['prompts', '系统提示词库'], ['search', '联网搜索'], ['appearance', '外观'], ['data', '数据与隐私']].map(([id, name]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{name}<ChevronRight size={15}/></button>)}</nav><main className="settings-content">
    {tab === 'connections' && <><h2>连接与模型</h2><p className="muted">选择接口协议，添加模型 ID。兼容服务的能力需要按实际情况配置。</p><div className="preset-row">{templates.map((t, i) => <button key={t.name} onClick={() => addConnection(i)}><Plus size={14}/>{t.name}</button>)}</div>
      {!!draft.connections.length && <div className="connection-tabs">{draft.connections.map(c => <button key={c.id} className={selected === c.id ? 'active' : ''} onClick={() => { setSelected(c.id); setFound([]); setHeadersEditing(false); }}>{c.name}</button>)}</div>}
      {connection ? <><div className="settings-card"><div className="card-heading"><h3>连接配置</h3><button className="icon-button danger" title="删除连接及其模型" onClick={() => { if (!confirm('删除该连接及其模型？已有消息仍保留。')) return; change({ connections: draft.connections.filter(c => c.id !== selected), models: draft.models.filter(m => m.connectionId !== selected) }); setSelected(draft.connections.find(c => c.id !== selected)?.id || ''); }}><Trash2 size={16}/></button></div>
      <div className="form-grid"><label className="field">连接名称<input value={connection.name} onChange={e => updateConnection({ name: e.target.value })}/></label><label className="field">接口协议<select value={connection.protocol} onChange={e => updateConnection({ protocol: e.target.value as Connection['protocol'] })}><option value="responses">OpenAI Responses</option><option value="chat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini GenerateContent</option></select></label></div>
      <label className="field">Base URL<input value={connection.baseUrl} onChange={e => updateConnection({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1"/><small>使用服务根地址或包含 /v1、/v1beta 的地址，不包含具体端点。Gemini 官方地址为 https://generativelanguage.googleapis.com/v1beta。</small></label>
      <label className="field">API Key<input type="password" autoComplete="off" value={connection.apiKey === saved ? '' : connection.apiKey} placeholder={connection.apiKey === saved ? '已设置，留空保持；输入新值替换' : '可选：本地服务可以不需要密钥'} onChange={e => updateConnection({ apiKey: e.target.value })}/>{connection.apiKey === saved && <button className="text-button" onClick={() => updateConnection({ apiKey: '' })}>清除已保存的密钥</button>}<small>请求将发送到 {connection.baseUrl || '上述地址'}。</small></label>
      <div className="form-grid"><label className="field">超时（秒）<input type="number" min="10" max="600" value={connection.timeout} onChange={e => updateConnection({ timeout: Number(e.target.value) })}/></label><label className="field">HTTP / HTTPS 代理<input placeholder="http://127.0.0.1:7890" value={connection.proxy} onChange={e => updateConnection({ proxy: e.target.value })}/></label></div>
      <details><summary>自定义请求头</summary><p className="muted">请求头中的值与 API Key 一起保存在数据目录。</p><textarea value={headersEditing ? headersText : JSON.stringify(connection.headers, null, 2)} onChange={e => { setHeadersText(e.target.value); setHeadersEditing(true); }}/></details>
      <button disabled={testing} onClick={async () => { setTesting(true); try { const ids = await api.test(connection); setFound(ids); toast(`连接成功，获取 ${ids.length} 个模型`); } catch (e) { toast('无法获取模型列表：' + String(e)); } finally { setTesting(false); } }}><Wifi size={15}/>{testing ? '测试中…' : '测试连接 / 获取模型'}</button>
      {!!found.length && <label className="field">添加服务端模型<select value="" onChange={e => addModel(e.target.value)}><option value="">选择模型添加…</option>{found.map(id => <option key={id}>{id}</option>)}</select></label>}</div>
      <div className="section-heading"><h3>此连接的模型</h3><button onClick={() => addModel()}><Plus size={15}/>手动添加</button></div>
      {draft.models.filter(m => m.connectionId === selected).map(m => <div className="settings-card" key={m.id}><div className="card-heading"><h3>{m.name || '新模型'}</h3><button className="icon-button danger" title="删除模型" onClick={() => change({ models: draft.models.filter(x => x.id !== m.id) })}><Trash2 size={16}/></button></div><div className="form-grid"><label className="field">展示名称<input value={m.name} onChange={e => updateModel(m.id, { name: e.target.value })}/></label><label className="field">模型 ID<input placeholder="供应商提供的准确模型 ID" value={m.model} onChange={e => updateModel(m.id, { model: e.target.value, name: m.name === '新模型' ? e.target.value : m.name })}/></label><label className="field">上下文窗口（token）<input type="number" value={m.contextWindow} onChange={e => updateModel(m.id, { contextWindow: Number(e.target.value) })}/></label><label className="field">最大输出（token）<input type="number" value={m.maxOutput} onChange={e => updateModel(m.id, { maxOutput: Number(e.target.value) })}/></label></div>
      <div className="check-row">{([['vision', '图片输入'], ['tools', '工具调用'], ['nativeSearch', '原生搜索'], ['videoInput', '视频输入'], ['audioInput', '音频输入'], ['pdfInput', 'PDF 输入']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={m[key] || false} onChange={e => updateModel(m.id, { [key]: e.target.checked })}/>{label}</label>)}</div><label className="field">思考参数<select value={m.reasoning} onChange={e => updateModel(m.id, { reasoning: e.target.value as Model['reasoning'] })}><option value="none">不发送思考参数</option><option value="effort">思考等级（effort）</option><option value="budget">思考预算（Anthropic / Gemini）</option></select></label>{m.reasoning === 'effort' && <label className="field">支持的等级（逗号分隔）<input value={m.efforts.join(',')} onChange={e => updateModel(m.id, { efforts: e.target.value.split(',').map(x => x.trim()) })}/></label>}{connection.protocol === 'chat' && <><label className="field">最大输出参数<select value={m.outputTokenField || 'max_completion_tokens'} onChange={e => updateModel(m.id, { outputTokenField: e.target.value as Model['outputTokenField'] })}><option value="max_completion_tokens">max_completion_tokens（OpenAI）</option><option value="max_tokens">max_tokens（部分兼容服务）</option></select></label><label className="toggle-row">请求流式 token 用量<input type="checkbox" checked={m.streamUsage !== false} onChange={e => updateModel(m.id, { streamUsage: e.target.checked })}/></label></>}<small className="muted">{connection.protocol === 'gemini' ? 'Gemini 3 及以上可使用思考等级，Gemini 2.5 使用思考预算；支持的等级因模型而异，请按模型文档配置。' : '根据供应商文档配置能力。Chat Completions 不提供统一的原生搜索接口。'}</small></div>)}</> : <div className="empty-card">先从上方添加一个连接，然后配置模型。</div>}</>}
    {tab === 'roles' && <><h2>模型与上下文</h2><div className="settings-card">{chooseModel('默认聊天模型', 'defaultModel')}{chooseModel('对话标题生成模型', 'titleModel', true)}{chooseModel('历史压缩模型', 'compressionModel', true)}<p className="muted">标题和压缩请求会发送到对应模型的连接，并产生独立 API 用量。修改默认模型仅影响新会话。</p></div><div className="settings-card"><label className="toggle-row">自动压缩历史<input type="checkbox" checked={draft.autoCompress} onChange={e => change({ autoCompress: e.target.checked })}/></label><label className="field">触发阈值：上下文窗口的 {Math.round(draft.compressionThreshold * 100)}%<input type="range" min="0.4" max="0.9" step="0.05" value={draft.compressionThreshold} onChange={e => change({ compressionThreshold: Number(e.target.value) })}/></label><p className="muted">按估算 token 预算触发，保留最近两轮；原始聊天记录始终保存在本地。</p></div></>}
    {tab === 'prompts' && <><h2>系统提示词库 / 角色预设</h2><p className="muted">在聊天输入框的“会话选项”中选择角色。提示词会复制到当前分支，可继续编辑；修改或删除库中的角色不会改变已有分支。</p>
      <div className="settings-card"><label className="field">新对话默认角色<select value={draft.defaultPromptPresetId} onChange={e => change({ defaultPromptPresetId: e.target.value })}><option value="">通用助手（内置提示词）</option>{draft.promptPresets.map(p => <option key={p.id} value={p.id}>{p.name || '未命名角色'}</option>)}</select></label></div>
      <div className="section-heading"><h3>角色预设</h3><button onClick={() => change({ promptPresets: [...draft.promptPresets, { id: uid(), name: '新角色', content: '' }] })}><Plus size={15}/>添加角色</button></div>
      {draft.promptPresets.map(p => <div className="settings-card" key={p.id}><div className="card-heading"><h3>{p.name || '新角色'}</h3><button className="icon-button danger" title={`删除角色：${p.name}`} onClick={() => change({ promptPresets: draft.promptPresets.filter(x => x.id !== p.id), defaultPromptPresetId: draft.defaultPromptPresetId === p.id ? '' : draft.defaultPromptPresetId })}><Trash2 size={16}/></button></div>
        <label className="field">角色名称<input aria-label="角色名称" value={p.name} onChange={e => change({ promptPresets: draft.promptPresets.map(x => x.id === p.id ? { ...x, name: e.target.value } : x) })}/></label>
        <label className="field">角色系统提示词<textarea aria-label="角色系统提示词" rows={6} value={p.content} onChange={e => change({ promptPresets: draft.promptPresets.map(x => x.id === p.id ? { ...x, content: e.target.value } : x) })} placeholder="描述这个角色的职责、回答风格和约束…"/></label>
      </div>)}{!draft.promptPresets.length && <div className="empty-card">还没有角色预设，点击“添加角色”创建。</div>}
    </>}
    {tab === 'search' && <><h2>联网搜索</h2><p className="muted">新对话默认自动联网：优先当前模型支持的原生搜索，然后按 Exa、Ollama Cloud、Tavily 的顺序选择已配置的工具型搜索。也可以在聊天输入框中指定提供方。</p>
      <div className="settings-card"><h3>搜索结果</h3><label className="field">每次搜索最多返回结果数<input type="number" min="1" max="10" value={draft.exaResults} onChange={e => change({ exaResults: Math.min(10, Math.max(1, Number(e.target.value))) })}/></label><p className="muted">工具型搜索最多执行三轮，每轮最多三个查询。原生搜索的限制由模型服务决定。</p></div>
      <div className="settings-card"><h3>Exa</h3><label className="field">API Key<input type="password" autoComplete="off" value={draft.exaKey === saved ? '' : draft.exaKey} placeholder={draft.exaKey === saved ? '已设置，输入新值替换' : '输入 Exa API Key'} onChange={e => change({ exaKey: e.target.value })}/>{draft.exaKey === saved && <button className="text-button" onClick={() => change({ exaKey: '' })}>清除密钥</button>}</label><p className="muted">向 api.exa.ai 发送查询并读取正文片段。</p><button onClick={() => api.openExternal('https://exa.ai')}><ExternalLink size={14}/>访问 Exa</button></div>
      <div className="settings-card"><h3>Ollama Cloud Web Search</h3><label className="field">Ollama API Key<input type="password" autoComplete="off" value={draft.ollamaKey === saved ? '' : draft.ollamaKey} placeholder={draft.ollamaKey === saved ? '已设置，输入新值替换' : '输入 Ollama API Key'} onChange={e => change({ ollamaKey: e.target.value })}/>{draft.ollamaKey === saved && <button className="text-button" onClick={() => change({ ollamaKey: '' })}>清除密钥</button>}<small>留空时会尝试复用“连接与模型”中 Ollama Cloud 连接的 API Key。</small></label><p className="muted">向 ollama.com/api/web_search 发送查询。</p><button onClick={() => api.openExternal('https://ollama.com/settings/keys')}><ExternalLink size={14}/>管理 Ollama API Key</button></div>
      <div className="settings-card"><h3>Tavily</h3><label className="field">API Key<input type="password" autoComplete="off" value={draft.tavilyKey === saved ? '' : draft.tavilyKey} placeholder={draft.tavilyKey === saved ? '已设置，输入新值替换' : '输入 Tavily API Key'} onChange={e => change({ tavilyKey: e.target.value })}/>{draft.tavilyKey === saved && <button className="text-button" onClick={() => change({ tavilyKey: '' })}>清除密钥</button>}</label><p className="muted">使用 basic 搜索深度，返回网页标题、链接和内容片段。</p><button onClick={() => api.openExternal('https://tavily.com')}><ExternalLink size={14}/>访问 Tavily</button></div>
      <div className="settings-card"><h3>模型原生搜索</h3><p className="muted">Responses 使用 web_search，Anthropic 使用 web_search_20250305，Gemini 使用 Google Search。需在模型配置中启用原生搜索能力，兼容服务可能不支持。</p></div></>}
    {tab === 'appearance' && <><h2>外观</h2><div className="settings-card"><label className="field">主题<select value={draft.theme} onChange={e => change({ theme: e.target.value as SettingsType['theme'] })}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><label className="field">文字大小：{draft.fontSize}px<input type="range" min="13" max="20" value={draft.fontSize} onChange={e => change({ fontSize: Number(e.target.value) })}/></label></div></>}
    {tab === 'data' && <><h2>数据与隐私</h2><div className="settings-card"><h3>密钥保存</h3><p className="muted">模型连接 API Key、Exa、Ollama、Tavily 密钥和自定义请求头默认保存在数据目录的 credentials.json 中，重启后自动读取。该文件以明文保存，权限为仅当前用户读写（0600）。</p><label className="field">保存方式<select value={draft.secretPolicy} onChange={e => change({ secretPolicy: e.target.value as SettingsType['secretPolicy'] })}><option value="file">保存到数据目录（默认）</option><option value="session">仅当前运行</option><option value="encrypted" disabled={!draft.secureStorage}>使用系统安全存储加密保存</option></select></label></div><div className="settings-card"><h3>备份与恢复</h3><p className="muted">结构化备份包含会话、分支、图片与配置，不包含密钥和自定义请求头。导入会替换当前数据。</p><div className="button-row"><button onClick={() => api.exportData('json').then(ok => ok && toast('备份已导出')).catch(e => toast(String(e)))}>导出备份</button><button onClick={() => api.exportData('markdown').then(ok => ok && toast('Markdown 已导出')).catch(e => toast(String(e)))}>导出 Markdown</button><button onClick={() => api.importData().then(s => { if (s) { toast('备份已恢复'); onClose(); window.dispatchEvent(new Event('deepchan-reload')); } }).catch(e => toast(String(e)))}>导入备份</button></div></div><div className="settings-card"><h3>本地优先</h3><p className="muted">聊天记录与附件保存在本机。只有模型请求和已启用的搜索请求会访问对应服务。无遥测、无账号、无云同步。外链由系统浏览器打开。</p></div></>}
    </main></div></div>;
}
