import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Usage } from './types';

export function messageDate(timestamp: number) {
  const date = new Date(timestamp), pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}·${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default function UsageDetails({ usage }: { usage: Usage }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const pinned = useRef(false), closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined), id = useId();
  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const close = () => { clearTimeout(closeTimer.current); pinned.current = false; setOpen(false); };
  const leave = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => { if (!pinned.current) setOpen(false); }, 150); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect(), box = panel.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
    const top = anchor.top - box.height - 8 >= 8 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8);
    setPosition({ left, top: Math.max(8, top) });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const scroll = (event: Event) => { if (!panel.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [open]);
  const count = (value?: number) => value === undefined ? '--' : `${value.toLocaleString()} token`;
  const speedDuration = usage.generationMs ?? usage.elapsedMs;
  const speed = speedDuration !== undefined && speedDuration > 0 ? `${(usage.output / (speedDuration / 1000)).toFixed(1)} tps` : '--';
  return <>
    <button ref={trigger} className="usage" aria-label="查看 token 用量与速度" aria-expanded={open} aria-describedby={open ? id : undefined}
      onPointerEnter={show} onPointerLeave={leave} onFocus={show} onBlur={leave}
      onClick={() => { if (pinned.current) close(); else { pinned.current = true; show(); } }}>
      {usage.input.toLocaleString()} 输入 · {usage.output.toLocaleString()} 输出
    </button>
    {open && createPortal(<div ref={panel} id={id} className="usage-details" role="tooltip" style={position} onPointerEnter={show} onPointerLeave={leave}>
      <dl>
        <dt>输入：</dt><dd>{count(usage.input)}</dd>
        <dt>输入（缓存）：</dt><dd>{count(usage.cachedInput)}</dd>
        <dt>输出：</dt><dd>{count(usage.output)}</dd>
        <dt>速度：</dt><dd>{speed}</dd>
        <dt>首字耗时：</dt><dd>{usage.firstTokenMs === undefined ? '--' : `${(usage.firstTokenMs / 1000).toFixed(2)} s`}</dd>
      </dl>
      <p>缓存为输入中的命中量；速度按输出 ÷ 生成耗时计算，扣除可测量的工具等待时间，并将并发区间合并后再扣除。服务端原生搜索无法单独计时时仍会计入。首字指回答正文。</p>
    </div>, document.body)}
  </>;
}
