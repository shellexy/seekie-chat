import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, BookOpen, Check, ChevronDown, Globe2, ImagePlus, Paperclip, Plus, Settings as SettingsIcon, Square, X } from 'lucide-react';
import { useAttachmentPayload } from './attachment_cache';
import { modelLabel } from './domain';
import type { Attachment, Branch, Connection, Conversation, Model, PromptPreset } from './types';

// A draft image may still be in flight from the main process when a saved draft is restored.
function DraftImage({ attachment }: { attachment: Attachment }) {
  const payload = useAttachmentPayload(attachment);
  return <img src={payload} alt={attachment.name} title={attachment.name}/>;
}
// The input area of the chat: draft text and attachments, the model and effort selectors, the
// session options popover, the networking toggle, the send/stop button and its own height handle.
export default function Composer({ branch, model, models, connections, busy, pending, atBottom, messageCount, height, textareaRef,
  networkingEnabled, networkUnavailable, effectiveSearch, webFetchMode, samplingSupported, samplingHelp, ollamaSearchConfigured,
  hasExaKey, promptPresets, backgroundUsage, userTurnCount,
  onHeightChange, onDraftChange, onRemoveAttachment, onAttach, onSend, onStop, onCompress, onUpdateConfig, onScrollToBottom, onNewChat, onNotice
}: {
  branch: Branch | null; model?: Model; models: Model[]; connections: Connection[]; busy: boolean; pending: boolean;
  atBottom: boolean; messageCount: number; height: number; textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  networkingEnabled: boolean; networkUnavailable: boolean; effectiveSearch: string; webFetchMode: string; samplingSupported: boolean; samplingHelp: string; ollamaSearchConfigured: boolean;
  hasExaKey: boolean; promptPresets: PromptPreset[]; backgroundUsage?: Conversation['backgroundUsage']; userTurnCount: number;
  onHeightChange: (height: number) => void; onDraftChange: (text: string) => void; onRemoveAttachment: (attachment: Attachment) => void; onAttach: (files: File[]) => void;
  onSend: () => void; onStop: () => void; onCompress: () => void; onUpdateConfig: (values: Partial<Branch['config']>) => void; onScrollToBottom: () => void; onNewChat: () => void; onNotice: (message: string) => void;
}) {
  const composerDrag = useRef<{ y: number; height: number } | null>(null);
  const composing = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null), optionsPopoverRef = useRef<HTMLDivElement>(null);
  const [options, setOptions] = useState(false);
  // The composer keeps its option popover, so it also owns closing it on Escape or outside clicks.
  useEffect(() => {
    if (!options) return;
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || optionsPopoverRef.current?.contains(target) || target.closest('.composer-option')) return;
      setOptions(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOptions(false); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [options]);
          return <div className="composer-area">
          {!atBottom && !!messageCount && <button className="scroll-bottom" title="回到底部" onClick={onScrollToBottom}>
            <ArrowDown size={18}/>
          </button>}
          {branch ? <>
            <div className="composer">
              <div className="composer-resize" role="separator" aria-label="调整输入框高度" aria-orientation="horizontal" aria-valuemin={47} aria-valuemax={Math.max(47, Math.min(420, window.innerHeight * 0.45))} aria-valuenow={height} tabIndex={0} title="上下拖动调整输入框高度，也可使用方向键" onPointerDown={e => { if (e.button !== 0) return; e.preventDefault(); e.currentTarget.focus(); composerDrag.current = { y: e.clientY, height: textareaRef.current?.getBoundingClientRect().height || height }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { const drag = composerDrag.current; if (drag) onHeightChange(drag.height + drag.y - e.clientY); }} onPointerUp={e => { composerDrag.current = null; if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }} onPointerCancel={() => { composerDrag.current = null; }} onLostPointerCapture={() => { composerDrag.current = null; }} onKeyDown={e => { if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); onHeightChange((textareaRef.current?.getBoundingClientRect().height || height) + (e.key === 'ArrowUp' ? 24 : -24)); } else if (e.key === 'Home') { e.preventDefault(); onHeightChange(47); } else if (e.key === 'End') { e.preventDefault(); onHeightChange(420); } }}>
                <span/>
              </div>
              <div className="draft-attachments">
                {branch.draftAttachments.map(a => <div key={a.id} className="draft-attachment">
                  {a.mime.startsWith('image/') ? <DraftImage attachment={a}/> : <span className="attachment-chip" title={a.name}>
                    <Paperclip size={15}/>
                    {a.name}
                  </span>}
                  <button className="icon-button" title="移除附件" onClick={() => onRemoveAttachment(a)}>
                    <X size={12}/>
                  </button>
                </div>)}
              </div>
              <textarea aria-label="消息输入" style={{ height: height }} ref={textareaRef} rows={2} placeholder={model ? '发送消息（Ctrl+I 聚焦），或从回答中开启一个新分支…' : '先在设置中连接模型（Ctrl+I 聚焦输入）…'} value={branch.draft} onChange={e => onDraftChange(e.target.value)} onCompositionStart={() => composing.current = true} onCompositionEnd={() => composing.current = false} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !composing.current) { e.preventDefault(); onSend(); } }} onPaste={e => { const files = [...e.clipboardData.files]; if (files.length) { e.preventDefault(); onAttach(files); } }}/>
              <div className="composer-bottom">
                <button className="icon-button" type="button" aria-label="添加图片或附件" title="添加图片或附件" onClick={() => fileRef.current?.click()}>
                  <ImagePlus size={20}/>
                </button>
                <input hidden ref={fileRef} type="file" multiple onChange={e => { onAttach([...e.target.files || []]); e.target.value = ''; }}/>
                <div className="composer-meta">
                  <div className="model-selector">
                    <select aria-label="聊天模型" title={model ? modelLabel(model, connections) : '选择模型'} value={branch.config.modelId} disabled={busy} onChange={e => { const m = models.find(x => x.id === e.target.value); onUpdateConfig({ modelId: e.target.value, effort: m?.efforts.includes(branch.config.effort) ? branch.config.effort : m?.efforts[0] || 'auto', budget: Math.min(branch.config.budget, Math.max(1024, (m?.maxOutput || 8192) - 1)), search: branch.config.search === 'off' ? 'off' : 'auto' }); }}>
                      <option value="">选择模型</option>
                      {models.map(m => <option key={m.id} value={m.id}>
                        {modelLabel(m, connections)}
                      </option>)}
                    </select>
                  </div>
                  <div className="reasoning-selector">
                    {model?.reasoning === 'budget' ? <select aria-label="思考等级" title="思考预算（token）" value={branch.config.budget} disabled={busy} onChange={e => onUpdateConfig({ budget: Number(e.target.value) })}>
                      {!([1024,2048,4096,8192].includes(branch.config.budget)) && <option value={branch.config.budget}>
                        {branch.config.budget}
                      </option>}
                      {[1024,2048,4096,8192].map(budget => <option key={budget} value={budget} disabled={budget >= model.maxOutput}>
                        {budget}
                      </option>)}
                    </select> : <select aria-label="思考等级" title={model?.reasoning === 'effort' ? '选择当前模型的思考等级' : '当前模型未配置思考等级能力'} value={model?.reasoning === 'effort' ? branch.config.effort : 'auto'} disabled={busy || model?.reasoning !== 'effort'} onChange={e => onUpdateConfig({ effort: e.target.value })}>
                      <option value="auto">
                        {model?.reasoning === 'effort' ? 'auto' : '不支持'}
                      </option>
                      {model?.reasoning === 'effort' && model.efforts.filter(Boolean).map(level => <option key={level} value={level}>
                        {level}
                      </option>)}
                    </select>}
                  </div>
                  <div className="popover-anchor">
                    <button className="composer-option" onClick={() => setOptions(!options)}>
                      <SettingsIcon size={14}/>会话选项{networkingEnabled && <span className="mini-dot"/>}
                    </button>
                    {options && <div className="popover config-popover" ref={optionsPopoverRef}>
                      <div className="config-popover-heading">
                        <h3>当前分支设置</h3>
                        <button className="icon-button" aria-label="关闭会话选项" title="关闭会话选项" onClick={() => setOptions(false)}>
                          <X size={16}/>
                        </button>
                      </div>
                      <div className="sampling-row">
                        <label className="sampling-field">温度<input aria-label="温度" type="number" min="0" max="2" step="0.1" defaultValue={branch.config.temperature ?? 1} disabled={busy || !samplingSupported} title={samplingHelp} onBlur={e => { const raw = e.currentTarget.value.trim() ? Number(e.currentTarget.value) : 1, value = Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 1; e.currentTarget.value = String(value); onUpdateConfig({ temperature: value }); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
                        </label>
                        <label className="sampling-field">top_p<input aria-label="top_p" type="number" min="0" max="1" step="0.05" defaultValue={branch.config.topP ?? 1} disabled={busy || !samplingSupported} title={samplingHelp} onBlur={e => { const raw = e.currentTarget.value.trim() ? Number(e.currentTarget.value) : 1, value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 1; e.currentTarget.value = String(value); onUpdateConfig({ topP: value }); }} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}/>
                        </label>
                      </div>
                      <p className="muted sampling-note">
                        {samplingSupported ? '采样设置仅影响当前分支后续回答。' : samplingHelp}
                      </p>
                      <label className="field inline-config-field">联网搜索<select value={branch.config.search} disabled={busy} onChange={e => onUpdateConfig({ search: e.target.value as Branch['config']['search'] })}>
                          <option value="auto">自动联网（默认）</option>
                          <option value="off">关闭</option>
                          <option value="native" disabled={!model?.nativeSearch || connections.find(c => c.id === model.connectionId)?.protocol === 'chat'}>模型原生</option>
                          <option value="exa" disabled={!model?.tools || !hasExaKey}>Exa</option>
                          <option value="ollama" disabled={!model?.tools || !ollamaSearchConfigured}>Ollama Cloud</option>
                          <option value="tavily" disabled={!model?.tools}>Tavily</option>
                          <option value="firecrawl" disabled={!model?.tools}>Firecrawl</option>
                          <option value="anysearch" disabled={!model?.tools}>AnySearch</option>
                        </select>
                      </label>
                      <label className="field inline-config-field">读取网页<select aria-label="读取网页" value={webFetchMode} disabled={busy} onChange={e => onUpdateConfig({ webFetch: e.target.value as Branch['config']['webFetch'] })}>
                          <option value="auto">自动（默认）</option>
                          <option value="exa" disabled={!hasExaKey}>Exa</option>
                          <option value="ollama" disabled={!ollamaSearchConfigured}>Ollama Cloud</option>
                          <option value="tavily">Tavily</option>
                          <option value="firecrawl">Firecrawl</option>
                          <option value="anysearch">AnySearch</option>
                          <option value="local">本地</option>
                          <option value="off">关闭</option>
                        </select>
                      </label>
                      <label className="field">系统提示词 / 角色预设<select aria-label="系统提示词预设" value={promptPresets.find(p => p.content === branch.config.system)?.id || ''} disabled={busy} onChange={e => { const preset = promptPresets.find(p => p.id === e.target.value); if (preset) onUpdateConfig({ system: preset.content }); }}>
                          <option value="">自定义提示词</option>
                          {promptPresets.map(p => <option key={p.id} value={p.id}>
                            {p.name}
                          </option>)}
                        </select>
                      </label>
                      <label className="field">系统提示词<textarea aria-label="系统提示词" value={branch.config.system} disabled={busy} onChange={e => onUpdateConfig({ system: e.target.value })} rows={4}/>
                      </label>
                      <button disabled={busy || userTurnCount < 3} onClick={() => { setOptions(false); onCompress(); }}>
                        <BookOpen size={14}/>压缩较早历史</button>
                      <p className="muted">保留最近至少两轮，并继续保留到上下文窗口 10% 或 50k token（取较小值）。创意写作摘要还会保留设定与风格。推理展示取决于服务返回内容。</p>
                      {!!backgroundUsage?.length && <details className="background-usage">
                        <summary>标题与压缩用量</summary>
                        {backgroundUsage!.map((u,i) => <p key={i}>
                          {u.kind === "title" ? "标题" : "压缩"} · {models.find(m => m.id === u.modelId)?.name || "历史模型"}
                          <br/>
                          {u.usage.input} 输入 / {u.usage.output} 输出 token</p>)}
                      </details>}
                    </div>}
                  </div>
                </div>
                <button className={`search-toggle ${networkingEnabled ? 'enabled' : ''} ${networkUnavailable ? 'unavailable' : ''}`} aria-label="联网" aria-pressed={networkingEnabled} disabled={busy} title={networkUnavailable ? '自动联网搜索未配置，并且当前模型不支持工具调用；请配置搜索服务或启用模型工具调用。' : !networkingEnabled ? '点击同时启用联网搜索和读取网页' : branch.config.search === 'off' ? '读取网页已启用；点击关闭联网搜索和读取网页' : effectiveSearch === 'native' ? '原生搜索已启用；联网搜索和读取网页可在会话选项中分别配置，点击全部关闭' : effectiveSearch === 'exa' ? 'Exa 搜索已启用；联网搜索和读取网页可在会话选项中分别配置，点击全部关闭' : effectiveSearch === 'ollama' ? 'Ollama Cloud Web Search 已启用；联网搜索和读取网页可在会话选项中分别配置，点击全部关闭' : effectiveSearch === 'tavily' ? 'Tavily 搜索已启用；联网搜索和读取网页可在会话选项中分别配置，点击全部关闭' : effectiveSearch === 'firecrawl' ? 'Firecrawl 搜索已启用；联网搜索和读取网页可在会话选项中分别配置，点击全部关闭' : effectiveSearch === 'anysearch' ? 'AnySearch 搜索已启用；联网搜索和读取网页可在会话选项中分别配置，点击全部关闭' : '联网搜索和读取网页已启用；点击全部关闭'} onClick={() => onUpdateConfig(networkingEnabled ? { search: 'off', webFetch: 'off' } : { search: 'auto', webFetch: 'auto' })}>
                  <span className={'network-icon ' + (!networkingEnabled ? 'off' : '')}>
                    <Globe2 size={14}/>
                  </span>
                </button>
                {busy ? <button className="send-button stop" title="停止生成" onClick={onStop}>
                  <Square size={15} fill="currentColor"/>
                </button> : <button className="send-button" title="发送消息" disabled={pending || !model || (!branch.draft.trim() && !branch.draftAttachments.length)} onClick={onSend}>
                  <ArrowUp size={20}/>
                </button>}
              </div>
            </div>
          </> : <div className="empty-composer">
            <span>准备好开始了？</span>
            <button onClick={onNewChat}>
              <Plus size={16}/>新建对话</button>
          </div>}
        </div>
        }
