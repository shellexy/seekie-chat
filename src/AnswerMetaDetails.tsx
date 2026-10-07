import { createPortal } from 'react-dom';
import { messageDateTime } from './domain';
import usePopover from './usePopover';
import type { Usage } from './types';

// One control for everything about a finished answer: which model answered, through which
// connection, when, and what it cost. The popover keeps the usage metrics in the same
// definition list the smoke tests and the docs already describe.
export default function AnswerMetaDetails({ modelName, connectionName, timestamp, usage, effort, rolePresetName }: { modelName: string; connectionName: string; timestamp: number; usage?: Usage; effort?: string; rolePresetName?: string }) {
  const popover = usePopover();
  const count = (value?: number) => value === undefined ? '--' : `${value.toLocaleString()} token`;
  const totalDuration = usage?.elapsedMs === undefined ? '--' : `${(usage!.elapsedMs / 1000).toFixed(2)} s`;
  const speedDuration = usage ? usage.generationMs ?? usage.elapsedMs : undefined;
  // 端对端速度：输出 ÷ 生成耗时，含首 Token 等待与工具往返之外的整段。
  const endToEndSpeed = usage && speedDuration !== undefined && speedDuration > 0 ? `${(usage.output / (speedDuration / 1000)).toFixed(1)} tps` : '--';
  // 生成速度：只扣掉模型第一个输出之前的等待（排队与首 Token），推理的生成时间要留在分母里——
  // usage.output 本来就包含思考 token，把那段也扣掉等于高估速度。老消息没有这个值时退回首字耗时。
  const firstOutput = usage?.firstOutputMs ?? usage?.firstTokenMs;
  const generationDuration = usage && usage.generationMs !== undefined && firstOutput !== undefined ? usage.generationMs - firstOutput : undefined;
  const generationSpeed = usage && generationDuration !== undefined && generationDuration > 0 ? `${(usage.output / (generationDuration / 1000)).toFixed(1)} tps` : '--';
  return <>
    <button ref={popover.trigger} className="answer-meta" aria-label={`查看回答详情：${modelName}`} aria-expanded={popover.open} aria-describedby={popover.open ? popover.id : undefined}
      onPointerEnter={popover.show} onPointerLeave={popover.leave} onFocus={popover.show} onBlur={popover.leave} onClick={popover.toggle}>
      {modelName}·{messageDateTime(timestamp)}{usage && <> · {usage.input.toLocaleString()} 输入 · {usage.output.toLocaleString()} 输出</>}
    </button>
    {popover.open && createPortal(<div ref={popover.panel} id={popover.id} className="usage-details" role="tooltip" style={popover.position} onPointerEnter={popover.show} onPointerLeave={popover.leave}>
      <div className="answer-meta-block">
        <p><strong>{modelName}</strong></p>
        <p>{connectionName}</p>
        {(effort || rolePresetName) && <p>{[effort && `思考等级：${effort}`, rolePresetName && `角色预设：${rolePresetName}`].filter(Boolean).join(' · ')}</p>}
        <p>{messageDateTime(timestamp)}</p>
      </div>
      {usage && <>
        <dl>
          <dt>输入：</dt><dd>{count(usage.input)}</dd>
          <dt>输入（缓存）：</dt><dd>{count(usage.cachedInput)}</dd>
          <dt>输出：</dt><dd>{count(usage.output)}</dd>
          <dt>总耗时：</dt><dd>{totalDuration}</dd>
          <dt>端对端速度：</dt><dd>{endToEndSpeed}</dd>
          <dt>生成速度：</dt><dd>{generationSpeed}</dd>
          <dt>首 Token 生成时间：</dt><dd>{usage.firstOutputMs === undefined ? '--' : `${(usage.firstOutputMs / 1000).toFixed(2)} s`}</dd>
        </dl>
        <p>总耗时含工具等待；生成速度已扣除工具调用及首 Token 等待时间。服务端原生搜索无法单独计时时仍会计入。</p>
      </>}
    </div>, document.body)}
  </>;
}
