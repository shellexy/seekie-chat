import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { messageDate } from './UsageDetails';

export default function AnswerModelDetails({ modelName, fullLabel, timestamp }: { modelName: string; fullLabel: string; timestamp: number }) {
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
    setPosition({
      left: Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8)),
      top: Math.max(8, anchor.top - box.height - 8 >= 8 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8))
    });
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

  return <>
    <button ref={trigger} className="answer-model-meta" aria-label={`查看模型信息：${modelName}`} aria-expanded={open} aria-describedby={open ? id : undefined}
      onPointerEnter={show} onPointerLeave={leave} onFocus={show} onBlur={leave}
      onClick={() => { if (pinned.current) close(); else { pinned.current = true; show(); } }}>
      {modelName}·{messageDate(timestamp).slice(-5)}
    </button>
    {open && createPortal(<div ref={panel} id={id} className="answer-model-popover" role="tooltip" style={position} onPointerEnter={show} onPointerLeave={leave}>
      {fullLabel}•{messageDate(timestamp)}
    </div>, document.body)}
  </>;
}
