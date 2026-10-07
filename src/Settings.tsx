import { useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronRight, ExternalLink, ListPlus, Plus, Power, PowerOff, Trash2, Wifi, X } from 'lucide-react';
import { api } from './api';
import { settingsProblems } from './validation';
import { DEEPSEEK_PREFERRED_EFFORT, defaultModelEfforts, EXTERNAL_SEARCH_LABELS, EXTERNAL_SEARCH_MODES, externalSearchAvailable, resolveDefaultWebFetch, SEARCH_MODE_LABELS, SEARCH_MODES, shouldDefaultVisionAndTools, uid, WEB_FETCH_LABELS, WEB_FETCH_MODES } from './domain';
import type { Connection, Model, ServerModel, Settings as SettingsType } from './types';
import WindowControls from './WindowControls';
const saved = '••••••••';
const templates = [
  // DeepSeek 提供三种协议，但只有 Anthropic 协议带服务端内置搜索。默认给兼容面最广的
  // OpenAI Chat，搜索改用显式的 DeepSeek Search（按次计费、可见、可控）；仍想要服务端
  // 搜索的人再选旁边的 Anthropic 预设。
  { name: 'DeepSeek', protocol: 'chat', baseUrl: 'https://api.deepseek.com/' },
  { name: 'DeepSeek · Anthropic（内置搜索）', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic' },
  { name: 'OpenAI · Responses', protocol: 'responses', baseUrl: 'https://api.openai.com/v1' },
  { name: 'OpenAI · Chat Completions', protocol: 'chat', baseUrl: 'https://api.openai.com/v1' },
  { name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
  { name: 'Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { name: 'Ollama', protocol: 'chat', baseUrl: 'http://localhost:11434/v1' },
  { name: 'Ollama Cloud', protocol: 'chat', baseUrl: 'https://ollama.com/v1' },
  { name: '自定义兼容服务', protocol: 'chat', baseUrl: 'http://localhost:8000/v1' }
] as const;
export default function Settings({ settings, onSave, onClose, toast, windowMaximized, onWindowMaximized }: { settings: SettingsType; onSave: (s: SettingsType) => Promise<void>; onClose: () => void; toast: (s: string) => void; windowMaximized: boolean; onWindowMaximized: (maximized: boolean) => void }) {
  const [draft, setDraft] = useState(() => structuredClone(settings));
  const [tab, setTab] = useState('connections'), [selected, setSelected] = useState(settings.connections[0]?.id || '');
  const [testing, setTesting] = useState(false), [found, setFound] = useState<ServerModel[]>([]), [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(false), [picked, setPicked] = useState<Set<string>>(new Set());
  const [headersText, setHeadersText] = useState(''), [headersEditing, setHeadersEditing] = useState(false);
  const connection = draft.connections.find(c => c.id === selected);
  function change(values: Partial<SettingsType>) { setDraft(d => ({ ...d, ...values })); }
  function updateConnection(values: Partial<Connection>) { setDraft(d => ({ ...d, connections: d.connections.map(c => c.id === selected ? { ...c, ...values } : c) })); }
  function addConnection(index: number) {
    const t = templates[index];
    const c: Connection = { name: t.name, protocol: t.protocol, baseUrl: t.baseUrl, id: uid(), apiKey: '', headers: {}, timeout: 120, proxy: '' };
    const deepSeekPreset = t.name === 'DeepSeek' || t.name === 'DeepSeek · Anthropic（内置搜索）';
    const presetModel: Model | undefined = deepSeekPreset ? {
      id: uid(), connectionId: c.id, name: 'deepseek-flash', model: 'deepseek-flash',
      // 上下文与最大输出取服务端 /models 报告的值：1048576 / 393216（384K）。
      contextWindow: 1_048_576, maxOutput: 393_216, vision: true, tools: true,
      // 原生搜索只有 Anthropic 协议提供；OpenAI Chat 预设下改用显式的 DeepSeek 搜索。
      nativeSearch: t.name === 'DeepSeek · Anthropic（内置搜索）',
      // 思考等级跟随官方新版：none / low / high / max，没有 medium 也没有 xhigh。none 是明确
      // 关闭思考；等级里没有 medium 时 defaultModelEffort 会落到首项，因此预设显式指定
      // high——官方文档说明默认档位也正是 high。
      videoInput: false, audioInput: false, pdfInput: false, reasoning: 'effort', efforts: ['none', 'low', 'high', 'max'], defaultEffort: DEEPSEEK_PREFERRED_EFFORT, temperature: true
    } : t.name === 'Ollama Cloud' ? {
      id: uid(), connectionId: c.id, name: 'gemma4:31b', model: 'gemma4:31b',
      contextWindow: 256_000, maxOutput: 256_000, vision: true, tools: true,
      nativeSearch: false, videoInput: true, audioInput: false, pdfInput: false, reasoning: 'effort', efforts: defaultModelEfforts(c.protocol, 'gemma4:31b'), temperature: true, outputTokenField: 'max_tokens'
    } : undefined;
    change({ connections: [...draft.connections, c], ...(presetModel ? { models: [...draft.models, presetModel], defaultModel: draft.defaultModel || presetModel.id } : {}) });
    setSelected(c.id); setFound([]); setHeadersEditing(false);
  }
  // A model the service described arrives with its real limits and modalities; anything it did not
  // describe keeps the previous defaults, so behaviour for quiet services is unchanged.
  function modelFromServer(server: ServerModel): Model {
    const gemini = connection?.protocol === 'gemini';
    const qwen = /^qwen(?:\d|[-/]|$)/i.test(server.id.trim());
    const described = !!server.inputModalities?.length;
    const accepts = (modality: string) => !!server.inputModalities?.includes(modality);
    const efforts = server.efforts?.length ? server.efforts : defaultModelEfforts(connection?.protocol || 'chat', server.id);
    return {
      id: uid(), connectionId: connection?.id || '', name: server.name || server.id, model: server.id,
      contextWindow: server.contextWindow || 1_000_000, maxOutput: server.maxOutput || 65_536,
      vision: described ? accepts('image') : gemini || qwen || shouldDefaultVisionAndTools(server.id, server.name || ''),
      tools: true, nativeSearch: gemini || qwen,
      videoInput: described ? accepts('video') : gemini || qwen,
      audioInput: described ? accepts('audio') : gemini,
      pdfInput: described ? accepts('pdf') : gemini,
      reasoning: 'effort', efforts, temperature: true,
      defaultEffort: server.defaultEffort && efforts.includes(server.defaultEffort) ? server.defaultEffort : undefined
    };
  }
  function addServerModels(servers: ServerModel[]) {
    const existing = new Set(draft.models.filter(m => m.connectionId === selected).map(m => m.model));
    const created = servers.filter(server => !existing.has(server.id)).map(modelFromServer);
    if (!created.length) { toast('所选模型都已在此连接中'); return; }
    change({ models: [...draft.models, ...created], defaultModel: draft.defaultModel || created[0].id });
    toast(`已添加 ${created.length} 个模型`);
  }
  const sortedFound = [...found].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id, 'zh-Hans-CN', { numeric: true }) || a.id.localeCompare(b.id));
  const modelFacts = (server: ServerModel) => [
    server.contextWindow ? `上下文 ${server.contextWindow.toLocaleString('zh-CN')}` : '',
    server.maxOutput ? `输出上限 ${server.maxOutput.toLocaleString('zh-CN')}` : '',
    server.inputModalities?.length ? `输入 ${server.inputModalities.join(' / ')}` : '',
    server.outputModalities?.length ? `输出 ${server.outputModalities.join(' / ')}` : '',
    server.efforts?.length ? `思考 ${server.efforts.join(' / ')}${server.defaultEffort ? `（默认 ${server.defaultEffort}）` : ''}` : ''
  ].filter(Boolean).join(' · ');
  function addModel(model = '') {
    if (!connection) return;
    const gemini = connection.protocol === 'gemini';
    const qwen = /^qwen(?:\d|[-/]|$)/i.test(model.trim());
    const gptOrDeepSeekFlash = shouldDefaultVisionAndTools(model);
    const efforts = defaultModelEfforts(connection.protocol, model);
    const m: Model = { id: uid(), connectionId: connection.id, name: model || '新模型', model, contextWindow: 1_000_000, maxOutput: 65_536, vision: gemini || qwen || gptOrDeepSeekFlash, tools: true, nativeSearch: gemini || qwen, videoInput: gemini || qwen, audioInput: gemini, pdfInput: gemini, reasoning: 'effort', efforts, temperature: true };
    change({ models: [...draft.models, m], defaultModel: draft.defaultModel || m.id });
  }
  function updateModel(id: string, values: Partial<Model>) { change({ models: draft.models.map(m => {
    if (m.id !== id) return m;
    const next = { ...m, ...values };
    if (typeof values.model === 'string') {
      const previousDefaults = defaultModelEfforts(connection?.protocol || 'chat', m.model);
      const stillUsingDefaults = m.efforts.length === previousDefaults.length && m.efforts.every((effort, index) => effort === previousDefaults[index]);
      if (stillUsingDefaults) { next.efforts = defaultModelEfforts(connection?.protocol || 'chat', values.model); delete next.defaultEffort; }
      // 只有 GPT 保留 xhigh；DeepSeek 的官方档位是 none/low/high/max。
      else if (/^gpt(?:[-/]|$)/i.test(values.model.trim())) next.efforts = [...new Set([...next.efforts, 'xhigh', 'max'])];
      if (/^qwen(?:\d|[-/]|$)/i.test(values.model.trim())) Object.assign(next, { vision: true, tools: true, nativeSearch: true, videoInput: true });
    }
    if ((typeof values.model === 'string' || typeof values.name === 'string') && shouldDefaultVisionAndTools(next.model, next.name)) Object.assign(next, { vision: true, tools: true });
    return next;
  }) }); }
  async function save() {
    try {
      setSaving(true);
      const ids = new Set(draft.models.map(m => m.id));
      const next = { ...draft, defaultModel: ids.has(draft.defaultModel) ? draft.defaultModel : draft.models[0]?.id || '', titleModel: ids.has(draft.titleModel) ? draft.titleModel : '', compressionModel: ids.has(draft.compressionModel) ? draft.compressionModel : '',
        // A deleted model leaves its id behind in both shortcuts; dropping it here keeps the picker
        // sections and the new-chat default from carrying ids that resolve to nothing.
        favoriteModels: draft.favoriteModels.filter(id => ids.has(id)), recentModels: draft.recentModels.filter(id => ids.has(id)) };
      if (headersEditing && connection) { let headers: unknown; try { headers = JSON.parse(headersText); } catch { throw new Error('自定义请求头必须是有效 JSON'); } if (!headers || Array.isArray(headers) || typeof headers !== 'object' || Object.values(headers).some(v => typeof v !== 'string')) throw new Error('请求头应为字符串值的 JSON 对象'); next.connections = next.connections.map(c => c.id === selected ? { ...c, headers: headers as Record<string,string> } : c); }
      // One shared rule set for the settings page, the save path and backup import.
      const problem = settingsProblems(next)[0];
      if (problem) throw new Error(problem);
      await onSave(next); toast('设置已保存'); onClose();
    } catch (e) { toast(String(e instanceof Error ? e.message : e)); } finally { setSaving(false); }
  }
  const chooseModel = (label: string, key: 'defaultModel' | 'titleModel' | 'compressionModel', inherit = false) => <label className="field">{label}<select value={draft[key]} onChange={e => change({ [key]: e.target.value })}>{inherit && <option value="">继承当前聊天模型</option>}{!inherit && <option value="">请选择模型</option>}{draft.models.map(m => <option key={m.id} value={m.id}>{m.name} · {draft.connections.find(c => c.id === m.connectionId)?.name}</option>)}</select></label>;
  return <div className="settings-page"><header className="settings-header"><button className="icon-button" onClick={onClose} title="返回聊天"><ArrowLeft size={20}/></button><div><h1>设置</h1><p>连接你的模型，调整你的工作方式。</p></div><button className="primary" onClick={save} disabled={saving}><Check size={16}/>{saving ? '保存中…' : '保存设置'}</button><WindowControls maximized={windowMaximized} onMaximizedChange={onWindowMaximized} onError={toast}/></header>
    <div className="settings-body"><nav className="settings-nav">{[['connections', '模型服务'], ['roles', '模型与上下文'], ['prompts', '系统提示词库'], ['search', '联网搜索'], ['appearance', '外观'], ['data', '数据与隐私']].map(([id, name]) => <button className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{name}<ChevronRight size={15}/></button>)}</nav><main className={`settings-content ${tab}`}>
    {tab === 'connections' && <><h2>模型服务</h2><p className="muted">选择接口协议，添加模型 ID。兼容服务的能力需要按实际情况配置。</p><div className="preset-row">{templates.map((t, i) => <button key={t.name} onClick={() => addConnection(i)}><Plus size={14}/>{t.name}</button>)}</div>
      {!!draft.connections.length && <div className="connection-tabs">{draft.connections.map(c => <button key={c.id} className={`${selected === c.id ? 'active' : ''}${c.disabled ? ' stopped' : ''}`} title={c.disabled ? `${c.name}（已禁用）` : c.name} onClick={() => { setSelected(c.id); setFound([]); setHeadersEditing(false); }}>{c.name}{c.disabled && <span className="stopped-dot"/>}</button>)}</div>}
      {connection ? <><div className="settings-card"><div className="card-heading"><h3>连接配置</h3><div className="card-actions"><button className="icon-button danger" title="删除连接及其模型" onClick={() => { if (!confirm('删除该连接及其模型？已有消息仍保留。')) return; change({ connections: draft.connections.filter(c => c.id !== selected), models: draft.models.filter(m => m.connectionId !== selected) }); setSelected(draft.connections.find(c => c.id !== selected)?.id || ''); }}><Trash2 size={16}/></button><button className={`icon-button${connection?.disabled ? ' on' : ''}`} aria-label={connection?.disabled ? '启用连接' : '禁用连接'} title={connection?.disabled ? '启用该连接，其模型重新出现在模型选择器中' : '禁用该连接：配置与模型保留，但不再参与模型选择'} onClick={() => updateConnection({ disabled: !connection?.disabled })}>{connection?.disabled ? <PowerOff size={16}/> : <Power size={16}/>}</button></div></div>
      <div className="form-grid"><label className="field">连接名称<input value={connection.name} onChange={e => updateConnection({ name: e.target.value })}/></label><label className="field">接口协议<select value={connection.protocol} onChange={e => updateConnection({ protocol: e.target.value as Connection['protocol'] })}><option value="responses">OpenAI Responses</option><option value="chat">OpenAI Chat Completions</option><option value="anthropic">Anthropic Messages</option><option value="gemini">Gemini GenerateContent</option></select></label></div>
      <label className="field">Base URL<input value={connection.baseUrl} onChange={e => updateConnection({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1"/><small>使用服务根地址或包含 /v1、/v1beta 的地址，不包含具体端点。Gemini 官方地址为 https://generativelanguage.googleapis.com/v1beta。</small></label>
      <label className="field">API Key<input type="password" autoComplete="off" value={connection.apiKey === saved ? '' : connection.apiKey} placeholder={connection.apiKey === saved ? '已设置，留空保持；输入新值替换' : '可选：本地服务可以不需要密钥'} onChange={e => updateConnection({ apiKey: e.target.value })}/>{connection.apiKey === saved && <button className="text-button" onClick={() => updateConnection({ apiKey: '' })}>清除已保存的密钥</button>}<small>请求将发送到 {connection.baseUrl || '上述地址'}。</small></label>
      <div className="form-grid"><label className="field">超时（秒）<input type="number" min="10" max="600" value={connection.timeout} onChange={e => updateConnection({ timeout: Number(e.target.value) })}/></label><label className="field">HTTP / HTTPS 代理<input placeholder="http://127.0.0.1:7890" value={connection.proxy} onChange={e => updateConnection({ proxy: e.target.value })}/></label></div>
      <details><summary>自定义请求头</summary><p className="muted">请求头中的值与 API Key 一起保存在数据目录。</p><textarea value={headersEditing ? headersText : JSON.stringify(connection.headers, null, 2)} onChange={e => { setHeadersText(e.target.value); setHeadersEditing(true); }}/></details>
      <button disabled={testing} onClick={async () => { setTesting(true); try { const models = await api.test(connection); setFound(models); setPicked(new Set()); setPicker(true); toast(`连接成功，获取 ${models.length} 个模型`); } catch (e) { toast('无法获取模型列表：' + String(e)); } finally { setTesting(false); } }}><Wifi size={15}/>{testing ? '测试中…' : '测试连接 / 获取模型'}</button>
      {!!found.length && <button onClick={() => setPicker(true)}><ListPlus size={15}/>从服务端列表添加模型…</button>}</div>
      {picker && createPortal(<div className="model-picker-layer" onMouseDown={e => { if (e.target === e.currentTarget) setPicker(false); }}>
        <section className="attachment-viewer-window model-picker" role="dialog" aria-modal="true" aria-label="添加服务端模型">
          <header className="attachment-viewer-header"><div className="attachment-viewer-title"><ListPlus size={16}/><span>添加服务端模型</span></div><button className="icon-button" aria-label="关闭添加模型" title="关闭" onClick={() => setPicker(false)}><X size={16}/></button></header>
          <div className="model-picker-body">
          <p className="muted">共 {found.length} 个模型，按名称排序。服务端给出的上下文、输出上限与模态会作为默认值填入，添加后仍可修改。</p>
          <div className="model-picker-list">{sortedFound.map(server => {
            const already = draft.models.some(m => m.connectionId === selected && m.model === server.id);
            const facts = modelFacts(server);
            // 已添加的模型同样显示服务端给出的信息，否则同一行只有"已添加"三个字，看不出
            // 这个模型到底多大、支持什么。
            const detail = [already ? '已添加' : '', facts].filter(Boolean).join(' · ') || '服务端未提供更多信息';
            return <label key={server.id} className={`model-picker-row ${already ? 'used' : ''}`} title={already ? `该模型已在此连接中：${server.id}` : server.id}>
              <input type="checkbox" aria-label={`选择模型 ${server.id}`} disabled={already} checked={picked.has(server.id)} onChange={e => setPicked(current => { const next = new Set(current); if (e.target.checked) next.add(server.id); else next.delete(server.id); return next; })}/>
              <span className="model-picker-name">{server.name || server.id}{server.name && server.name !== server.id && <code>{server.id}</code>}</span>
              <span className="model-picker-facts">{detail}</span>
            </label>;
          })}</div>
          <div className="button-row">
            <button onClick={() => setPicked(new Set(sortedFound.filter(server => !draft.models.some(m => m.connectionId === selected && m.model === server.id)).map(server => server.id)))}>全选</button>
            <button onClick={() => setPicked(new Set())}>清空</button>
            <button onClick={() => setPicker(false)}>取消</button>
            <button className="primary" disabled={!picked.size} onClick={() => { addServerModels(sortedFound.filter(server => picked.has(server.id))); setPicker(false); }}>添加所选{picked.size ? `（${picked.size}）` : ''}</button>
          </div>
          </div>
        </section>
      </div>, document.body)}
      <div className="section-heading"><h3>此连接的模型</h3><button onClick={() => addModel()}><Plus size={15}/>手动添加</button></div>
      {[...draft.models].filter(m => m.connectionId === selected).sort((a, b) => (a.name || a.model).localeCompare(b.name || b.model, 'zh-Hans-CN', { numeric: true }) || a.id.localeCompare(b.id)).map(m => <div className="settings-card" key={m.id}><div className="card-heading"><h3>{m.name || '新模型'}</h3><button className="icon-button danger" title="删除模型" onClick={() => change({ models: draft.models.filter(x => x.id !== m.id) })}><Trash2 size={16}/></button></div><div className="form-grid"><label className="field">展示名称<input value={m.name} onChange={e => updateModel(m.id, { name: e.target.value })}/></label><label className="field">模型 ID<input placeholder="供应商提供的准确模型 ID" value={m.model} onChange={e => updateModel(m.id, { model: e.target.value, name: m.name === '新模型' ? e.target.value : m.name })}/></label><label className="field">上下文窗口（token）<input type="number" value={m.contextWindow} onChange={e => updateModel(m.id, { contextWindow: Number(e.target.value) })}/></label><label className="field">最大输出（token）<input type="number" value={m.maxOutput} onChange={e => updateModel(m.id, { maxOutput: Number(e.target.value) })}/></label></div>
      <div className="check-row">{([['vision', '图片输入'], ['tools', '工具调用'], ['nativeSearch', '原生搜索'], ['videoInput', '视频输入'], ['audioInput', '音频输入'], ['pdfInput', 'PDF 输入']] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={m[key] || false} onChange={e => updateModel(m.id, { [key]: e.target.checked })}/>{label}</label>)}</div><label className="field">思考参数<select value={m.reasoning} onChange={e => updateModel(m.id, { reasoning: e.target.value as Model['reasoning'] })}><option value="none">不发送思考参数</option><option value="effort">思考等级（effort）</option><option value="budget">思考预算（Anthropic / Gemini）</option></select></label>{m.reasoning === 'effort' && <label className="field">支持的等级（逗号分隔）<input value={m.efforts.join(',')} onChange={e => updateModel(m.id, { efforts: e.target.value.split(',').map(x => x.trim()) })}/></label>}{m.reasoning === 'effort' && m.defaultEffort && <small className="muted">切换到此模型时默认使用 {m.defaultEffort}</small>}{connection.protocol === 'chat' && <><label className="field">最大输出参数<select value={m.outputTokenField || 'max_completion_tokens'} onChange={e => updateModel(m.id, { outputTokenField: e.target.value as Model['outputTokenField'] })}><option value="max_completion_tokens">max_completion_tokens（OpenAI）</option><option value="max_tokens">max_tokens（部分兼容服务）</option></select></label><label className="toggle-row">请求流式 token 用量<input type="checkbox" checked={m.streamUsage !== false} onChange={e => updateModel(m.id, { streamUsage: e.target.checked })}/></label></>}<small className="muted">{connection.protocol === 'gemini' ? 'Gemini 3 及以上可使用思考等级，Gemini 2.5 使用思考预算；支持的等级因模型而异，请按模型文档配置。' : '根据供应商文档配置能力。Chat Completions 不提供统一的原生搜索接口。'}</small></div>)}</> : <div className="empty-card">先从上方添加一个连接，然后配置模型。</div>}</>}
    {tab === 'roles' && <><h2>模型与上下文</h2><div className="settings-card">{chooseModel('默认聊天模型', 'defaultModel')}{chooseModel('对话标题生成模型', 'titleModel', true)}{chooseModel('历史压缩模型', 'compressionModel', true)}<p className="muted">标题和压缩请求会发送到对应模型的连接，并产生独立 API 用量。修改默认聊天模型仅影响新会话。</p></div><div className="settings-card"><h3>新对话的模型</h3><label className="toggle-row">新对话使用最近使用的模型<input type="checkbox" checked={draft.useRecentModel} onChange={e => change({ useRecentModel: e.target.checked })}/></label><p className="muted">开启后新建对话会接着你最近用过的模型（切换模型即记入，一次回答跑完再置顶）；此时“默认聊天模型”只在还没有任何使用记录时生效。关闭后每个新对话都从“默认聊天模型”开始。已有会话不受影响。</p></div><div className="settings-card"><label className="toggle-row">自动压缩历史<input type="checkbox" checked={draft.autoCompress} onChange={e => change({ autoCompress: e.target.checked })}/></label><label className="field">触发阈值：上下文窗口的 {Math.round(draft.compressionThreshold * 100)}%<input type="range" min="0.4" max="0.9" step="0.05" value={draft.compressionThreshold} onChange={e => change({ compressionThreshold: Number(e.target.value) })}/></label><p className="muted">按估算 token 预算触发；压缩后至少保留最近两轮，并按当前聊天模型上下文窗口额外保留到 10% 预算，最多 50k token。原始聊天记录始终保存在本地。</p></div></>}
    {tab === 'prompts' && <><h2>系统提示词库 / 角色预设</h2><p className="muted">在聊天输入框的“会话选项”中选择角色。提示词会复制到当前分支，可继续编辑；修改或删除库中的角色不会改变已有分支。</p>
      <div className="settings-card"><label className="field">新对话默认角色<select value={draft.defaultPromptPresetId} onChange={e => change({ defaultPromptPresetId: e.target.value })}><option value="">通用助手（内置提示词）</option>{draft.promptPresets.map(p => <option key={p.id} value={p.id}>{p.name || '未命名角色'}</option>)}</select></label></div>
      <div className="section-heading"><h3>角色预设</h3><button onClick={() => change({ promptPresets: [...draft.promptPresets, { id: uid(), name: '新角色', content: '' }] })}><Plus size={15}/>添加角色</button></div>
      {draft.promptPresets.map(p => <div className="settings-card" key={p.id}><div className="card-heading"><h3>{p.name || '新角色'}</h3><button className="icon-button danger" title={`删除角色：${p.name}`} onClick={() => change({ promptPresets: draft.promptPresets.filter(x => x.id !== p.id), defaultPromptPresetId: draft.defaultPromptPresetId === p.id ? '' : draft.defaultPromptPresetId })}><Trash2 size={16}/></button></div>
        <label className="field">角色名称<input aria-label="角色名称" value={p.name} onChange={e => change({ promptPresets: draft.promptPresets.map(x => x.id === p.id ? { ...x, name: e.target.value } : x) })}/></label>
        <label className="field">角色系统提示词<textarea aria-label="角色系统提示词" rows={6} value={p.content} onChange={e => change({ promptPresets: draft.promptPresets.map(x => x.id === p.id ? { ...x, content: e.target.value } : x) })} placeholder="描述这个角色的职责、回答风格和约束…"/></label>
      </div>)}{!draft.promptPresets.length && <div className="empty-card">还没有角色预设，点击“添加角色”创建。</div>}
    </>}
    {tab === 'search' && <><h2>联网搜索</h2><p className="muted">新对话默认自动联网：搜索优先当前模型支持的原生搜索，然后按已配置的 Exa、Ollama Cloud、Firecrawl、AnySearch、Tavily 选择服务；没有配置搜索 Key 时自动使用 Firecrawl 免 Key 搜索。Firecrawl、AnySearch、Tavily 也支持在会话中手动选择免 Key 搜索。读取网页按已配置的 Exa、Ollama Cloud、Tavily、Firecrawl、AnySearch 顺序尝试；三家免 Key 服务无 Key 时也会自动尝试，失败后回退到本地读取网页。</p>
      <div className="settings-card"><h3>默认联网搜索</h3><label className="field">新对话的搜索模式<select value={draft.defaultSearch} onChange={e => change({ defaultSearch: e.target.value as SettingsType['defaultSearch'] })}>{SEARCH_MODES.map(mode => <option key={mode} value={mode}>{SEARCH_MODE_LABELS[mode]}</option>)}</select></label><label className="field">新对话的默认读取网页方法<select value={draft.defaultWebFetch} onChange={e => change({ defaultWebFetch: e.target.value as SettingsType['defaultWebFetch'] })}><option value="last">上次使用（当前：{WEB_FETCH_LABELS[resolveDefaultWebFetch(draft)]}）</option>{WEB_FETCH_MODES.map(mode => <option key={mode} value={mode}>{WEB_FETCH_LABELS[mode]}</option>)}</select></label><label className="toggle-row">自动模式下优先使用模型原生搜索<input type="checkbox" checked={draft.preferNativeSearch} onChange={e => change({ preferNativeSearch: e.target.checked })}/></label><label className="field">自动模式下优先使用的外部搜索<select aria-label="自动模式下优先使用的外部搜索" value={draft.preferredExternalSearch} onChange={e => change({ preferredExternalSearch: e.target.value as SettingsType['preferredExternalSearch'] })}><option value="auto">默认顺序（内置）</option>{EXTERNAL_SEARCH_MODES.map(mode => <option key={mode} value={mode} disabled={!externalSearchAvailable(mode, draft)}>{EXTERNAL_SEARCH_LABELS[mode]}{mode === 'deepseek' ? '（按次计费）' : mode === 'exa' || mode === 'ollama' ? '（需 API Key）' : ''}</option>)}</select></label><p className="muted">“{SEARCH_MODE_LABELS.auto}”会让新对话带上该模式，之后仍可在“会话选项”里逐个分支修改；“上次使用”则接着你在会话里最后选择的读取网页方式切换过的那一个。三项偏好只影响自动模式的降级顺序和新建对话的起点：会话里显式选择的搜索模式始终按你的指定执行。勾选“优先使用模型原生搜索”时，自动模式先尝试模型自带的原生搜索，再用外部服务；取消勾选则反过来，原生搜索只作最后兜底。“自动模式下优先使用的外部搜索”决定外部链先试哪一家 —— 它没有可用密钥时会跳过，继续走“默认顺序”；DeepSeek 排在内置链之后，只有这样显式指定才会被自动模式用到。当前模型不支持原生搜索、或不支持工具调用时，请求会自动落到可用的一侧。</p></div>
      <div className="settings-card"><h3>搜索结果</h3><label className="field">每次搜索最多返回结果数<input type="number" min="1" max="10" value={draft.exaResults} onChange={e => change({ exaResults: Math.min(10, Math.max(1, Number(e.target.value))) })}/></label><p className="muted">默认 10，适用于 Exa、Ollama Cloud、Tavily、Firecrawl、AnySearch 和 DeepSeek。工具型搜索最多执行三轮，每轮最多三个查询；每条结果的正文最多送入模型 2500 字。原生搜索的限制由模型服务决定。</p></div>
      <div className="settings-card"><h3>Exa</h3><label className="field">API Key<input type="password" autoComplete="off" value={draft.exaKey === saved ? '' : draft.exaKey} placeholder={draft.exaKey === saved ? '已设置，输入新值替换' : '输入 Exa API Key'} onChange={e => change({ exaKey: e.target.value })}/>{draft.exaKey === saved && <button className="text-button" onClick={() => change({ exaKey: '' })}>清除密钥</button>}</label><p className="muted">用于搜索和自动读取网页；读取网页时调用 api.exa.ai/contents 获取 Markdown。</p><button onClick={() => api.openExternal('https://exa.ai')}><ExternalLink size={14}/>访问 Exa</button></div>
      <div className="settings-card"><h3>Ollama Cloud Web Search</h3><label className="field">Ollama API Key<input type="password" autoComplete="off" value={draft.ollamaKey === saved ? '' : draft.ollamaKey} placeholder={draft.ollamaKey === saved ? '已设置，输入新值替换' : '输入 Ollama API Key'} onChange={e => change({ ollamaKey: e.target.value })}/>{draft.ollamaKey === saved && <button className="text-button" onClick={() => change({ ollamaKey: '' })}>清除密钥</button>}<small>留空时会尝试复用“模型服务”中 Ollama Cloud 连接的 API Key。</small></label><p className="muted">用于搜索和自动读取网页；读取网页调用 ollama.com/api/web_fetch。</p><button onClick={() => api.openExternal('https://ollama.com/settings/keys')}><ExternalLink size={14}/>管理 Ollama API Key</button></div>
      <div className="settings-card"><h3>Tavily</h3><label className="field">API Key（可选）<input type="password" autoComplete="off" value={draft.tavilyKey === saved ? '' : draft.tavilyKey} placeholder={draft.tavilyKey === saved ? '已设置，输入新值替换' : '输入 Tavily API Key（可选）'} onChange={e => change({ tavilyKey: e.target.value })}/>{draft.tavilyKey && draft.tavilyKey === saved && <button className="text-button" onClick={() => change({ tavilyKey: '' })}>清除密钥</button>}</label><p className="muted">联网搜索和读取网页均支持免 Key 模式；读取网页通过 Extract API 返回 Markdown，添加 API Key 可提高限额。</p><button onClick={() => api.openExternal('https://docs.tavily.com/documentation/keyless')}><ExternalLink size={14}/>Tavily 免 Key 文档</button></div>
      <div className="settings-card"><h3>Firecrawl</h3><label className="field">API Key（可选）<input type="password" autoComplete="off" value={draft.firecrawlKey === saved ? '' : draft.firecrawlKey} placeholder={draft.firecrawlKey === saved ? '已设置，输入新值替换' : '输入 Firecrawl API Key（可选）'} onChange={e => change({ firecrawlKey: e.target.value })}/>{draft.firecrawlKey && draft.firecrawlKey === saved && <button className="text-button" onClick={() => change({ firecrawlKey: '' })}>清除密钥</button>}</label><p className="muted">API Key 可选；搜索可返回 Markdown 正文，读取网页调用官方 Scrape API。留空时两项均使用免 Key 模式；添加 Key 可提高限额。</p><button onClick={() => api.openExternal('https://docs.firecrawl.dev/features/scrape')}><ExternalLink size={14}/>Firecrawl Scrape 文档</button></div><div className="settings-card"><h3>AnySearch</h3><label className="field">API Key（可选）<input type="password" autoComplete="off" value={draft.anysearchKey === saved ? '' : draft.anysearchKey} placeholder={draft.anysearchKey === saved ? '已设置，输入新值替换' : '输入 AnySearch API Key（可选）'} onChange={e => change({ anysearchKey: e.target.value })}/>{draft.anysearchKey && draft.anysearchKey === saved && <button className="text-button" onClick={() => change({ anysearchKey: '' })}>清除密钥</button>}</label><p className="muted">API Key 可选；留空时搜索和读取网页均使用 AnySearch 匿名额度，限额较低。添加 Key 可提高限额。</p><button onClick={() => api.openExternal('https://anysearch.com/docs/api-endpoints/v1-extract')}><ExternalLink size={14}/>AnySearch Extract 文档</button></div><div className="settings-card"><h3>DeepSeek 搜索与抓取</h3><label className="field">DeepSeek API Key（可选）<input type="password" autoComplete="off" value={draft.deepseekKey === saved ? '' : draft.deepseekKey} placeholder={draft.deepseekKey === saved ? '已设置，输入新值替换' : '留空时复用 DeepSeek 模型连接的 API Key'} onChange={e => change({ deepseekKey: e.target.value })}/>{draft.deepseekKey && draft.deepseekKey === saved && <button className="text-button" onClick={() => change({ deepseekKey: '' })}>清除密钥</button>}<small>留空时会尝试复用主机名为 api.deepseek.com 的连接密钥。</small></label><label className="toggle-row">在搜索结果中返回网页正文<input type="checkbox" checked={draft.deepseekNeedContent} onChange={e => change({ deepseekNeedContent: e.target.checked })}/></label><small>关闭时搜索结果只带 <code>summary</code>（约 600~800 字，官方标注为“适用于给模型阅读”），网页正文由“读取网页”单独抓取；开启后每条结果额外附带 <code>content</code> 全文，按每次搜索最多返回结果数逐条截断到 2500 字。</small><p className="muted">调用 DeepSeek 自研的 Search（搜索）与 Fetch（抓取网页 Markdown）接口。两者都<strong>按成功请求次数计费</strong>（每 1000 次 5 元，只有返回 200 且有结果才计费），账号级限速 5 QPS。因此它们<strong>不参与自动降级</strong>——自动联网和自动读取网页不会在你没有选择的情况下调用它们；需要时请在“会话选项”里显式选择，或把它设为“自动模式下优先使用的外部搜索”。</p><p className="muted">另外，DeepSeek 官方说明：通过 DeepSeek 服务端工具调用（包括 DeepSeek Anthropic API 里的原生联网搜索）目前不计费，将于北京时间 <strong>2026 年 11 月 1 日</strong>起按次收费。</p><button onClick={() => api.openExternal('https://api-docs.deepseek.com/zh-cn/guides/search')}><ExternalLink size={14}/>DeepSeek 搜索与抓取文档</button></div><div className="settings-card"><h3>模型原生搜索</h3><p className="muted">Responses 使用 web_search，Anthropic 使用 web_search_20250305，Gemini 使用 Google Search。需在模型配置中启用原生搜索能力，兼容服务可能不支持。</p></div></>}
    {tab === 'appearance' && <><h2>外观</h2><div className="settings-card"><label className="field">主题<select value={draft.theme} onChange={e => change({ theme: e.target.value as SettingsType['theme'] })}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></label><label className="field">文字大小：{draft.fontSize}px<input type="range" min="13" max="20" value={draft.fontSize} onChange={e => change({ fontSize: Number(e.target.value) })}/></label></div></>}
    {tab === 'data' && <><h2>数据与隐私</h2><div className="settings-card"><h3>密钥保存</h3><p className="muted">模型连接 API Key、Exa、Ollama、Tavily、Firecrawl、AnySearch 密钥和自定义请求头默认保存在数据目录的 credentials.json 中，重启后自动读取。该文件以明文保存，权限为仅当前用户读写（0600）。</p><label className="field">保存方式<select value={draft.secretPolicy} onChange={e => change({ secretPolicy: e.target.value as SettingsType['secretPolicy'] })}><option value="file">保存到数据目录（默认）</option><option value="session">仅当前运行</option><option value="encrypted" disabled={!draft.secureStorage}>使用系统安全存储加密保存</option></select></label></div><div className="settings-card"><h3>备份与恢复</h3><p className="muted">结构化备份包含会话、分支、图片与配置，不包含密钥和自定义请求头。导入会替换当前数据。</p><div className="button-row"><button onClick={() => api.exportData('json').then(ok => ok && toast('备份已导出')).catch(e => toast(String(e)))}>导出备份</button><button onClick={() => api.exportData('markdown').then(ok => ok && toast('Markdown 已导出')).catch(e => toast(String(e)))}>导出 Markdown</button><button onClick={() => api.importData().then(s => { if (s) { toast('备份已恢复'); onClose(); window.dispatchEvent(new Event('deepchan-reload')); } }).catch(e => toast(String(e)))}>导入备份</button></div></div><div className="settings-card"><h3>本地优先</h3><p className="muted">聊天记录与附件保存在本机。只有模型请求和已启用的搜索请求会访问对应服务。无遥测、无账号、无云同步。外链由系统浏览器打开。</p></div></>}
    </main></div></div>;
}
