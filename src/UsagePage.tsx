import { useMemo, useState } from 'react';
import { buildUsageReport, formatTokens } from './domain';
import type { Conversation, Model } from './types';

// 只从当前保留的会话里算（方案 A）。页面必须把这件事说在明处：它不是账本，删掉的会话不该
// 悄悄消失在「历史花费」里而不解释。
const RANGES = [['7', '近 7 天'], ['30', '近 30 天'], ['all', '全部']] as const;

export default function UsagePage({ conversations, models }: { conversations: Conversation[]; models: Model[] }) {
  const [range, setRange] = useState<'7' | '30' | 'all'>('30');
  const report = useMemo(() => buildUsageReport(conversations, { days: range === 'all' ? undefined : Number(range) }), [conversations, range]);
  const nameOf = (modelId: string, fallback: string) => models.find(model => model.id === modelId)?.name || fallback || '未知模型';
  const days = report.byDay.slice(0, 14);
  const busiest = Math.max(1, ...days.map(day => day.input + day.output));
  return <>
    <h2>用量</h2>
    <div className="settings-card"><h3>总览</h3>
      <label className="field usage-range">时间范围<select value={range} onChange={event => setRange(event.target.value as typeof range)}>{RANGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      {report.answers ? <>
        <div className="usage-summary">
          <div><strong>{report.answers}</strong><span>回答</span></div>
          <div><strong>{formatTokens(report.input)}</strong><span>输入</span></div>
          <div><strong>{formatTokens(report.output)}</strong><span>输出</span></div>
          <div><strong>{report.cachedInput ? formatTokens(report.cachedInput) : '—'}</strong><span>缓存命中</span></div>
        </div>
        <p className="muted">输入按每次请求的上下文计：多轮工具调用每轮都会重发历史，供应商也按每轮收费，所以它通常比对话本身的长度大。缓存命中是输入的子集，不计入上面的输入合计。</p>
      </> : <p className="muted">这个范围内还没有回答记录。</p>}
      {report.background.count > 0 && <p className="muted">另有后台请求 {report.background.count} 次（自动标题、历史压缩）：输入 {formatTokens(report.background.input)} · 输出 {formatTokens(report.background.output)}。</p>}
      {report.estimated > 0 && <p className="muted">其中 {report.estimated} 条为客户端估算值——服务没有上报用量，这些数字是按字符长度估的。</p>}
    </div>
    {report.byModel.length > 0 && <div className="settings-card"><h3>按模型</h3>
      <div className="usage-rows">
        <div className="usage-row usage-head"><span>模型</span><span>回答</span><span>输入</span><span>输出</span><span>缓存</span></div>
        {report.byModel.map(model => <div className="usage-row" key={model.modelId || model.modelName}>
          <span title={model.connectionName || undefined}>{nameOf(model.modelId, model.modelName)}</span>
          <span>{model.answers}</span><span>{formatTokens(model.input)}</span><span>{formatTokens(model.output)}</span><span>{model.cachedInput ? formatTokens(model.cachedInput) : '—'}</span>
        </div>)}
      </div>
    </div>}
    {days.length > 0 && <div className="settings-card"><h3>按天</h3>
      <div className="usage-days">{days.map(day => <div className="usage-day" key={day.day}>
        <span>{day.day.slice(5).replace('-', '/')}</span>
        <i style={{ width: `${Math.max(2, Math.round((day.input + day.output) / busiest * 100))}%` }}/>
        <b>{formatTokens(day.input + day.output)}</b>
      </div>)}</div>
    </div>}
    <p className="muted usage-scope">只统计当前保留的会话与分支；删除会话或分支后，那部分不再计入。要做「一共花过多少」的总账需要另记一张表，目前没有。</p>
  </>;
}
