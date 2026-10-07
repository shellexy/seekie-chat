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
  const speed = usage && speedDuration !== undefined && speedDuration > 0 ? `${(usage.output / (speedDuration / 1000)).toFixed(1)} tps` : '--';
  return <>
    <button ref={popover.trigger} className="answer-meta" aria-label={`查看回答详情：${modelName}`} aria-expanded={popover.open} aria-describedby={popover.open ? popover.id : undefined}
      onPointerEnter={popover.show} onPointerLeave={popover.leave} onFocus={popover.show} onBlur={popover.leave} onClick={popover.toggle}>
      {modelName}·{messageDateTime(timestamp)}{usage && <> · {usage.input.toLocaleString()} 输入 · {usage.output.toLocaleString()} 输出</>}
    </button>
    {popover.open && createPortal(<div ref={popover.panel} id={popover.id} className="usage-details" role="tooltip" style={popover.position} onPointerEnter={popover.show} onPointerLeave={popover.leave}>
      <div className="answer-meta-block">
        <p><strong>{modelName}</strong></p>
        <p>{connectionName}</p>
        {effort && <p>思考等级：{effort}</p>}
        {rolePresetName && <p>角色预设：{rolePresetName}</p>}
        <p>{messageDateTime(timestamp)}</p>
      </div>
      {usage && <>
        <dl>
          <dt>输入：</dt><dd>{count(usage.input)}</dd>
          <dt>输入（缓存）：</dt><dd>{count(usage.cachedInput)}</dd>
          <dt>输出：</dt><dd>{count(usage.output)}</dd>
          <dt>总耗时：</dt><dd>{totalDuration}</dd>
          <dt>速度：</dt><dd>{speed}</dd>
          <dt>首字耗时：</dt><dd>{usage.firstTokenMs === undefined ? '--' : `${(usage.firstTokenMs / 1000).toFixed(2)} s`}</dd>
        </dl>
        <p>总耗时包含整个生成请求及工具等待；缓存为输入中的命中量。速度按输出 ÷ 生成耗时计算，扣除可测量的工具等待时间，并将并发区间合并后再扣除。服务端原生搜索无法单独计时时仍会计入。首字指回答正文。</p>
      </>}
    </div>, document.body)}
  </>;
}
