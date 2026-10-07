import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

// Shared behaviour for the small hover/click popovers: a short hover delay, click to pin, viewport
// aware positioning above or below the trigger, and closing on outside pointer, Escape, resize or
// scroll. Extracted so every popover cannot drift in behaviour from the others.
export default function usePopover<T extends HTMLElement = HTMLButtonElement, P extends HTMLElement = HTMLDivElement>() {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<T>(null), panel = useRef<P>(null);
  const pinned = useRef(false), closeTimer = useRef<ReturnType<typeof setTimeout>>(undefined), id = useId();
  const show = () => { clearTimeout(closeTimer.current); setOpen(true); };
  const close = () => { clearTimeout(closeTimer.current); pinned.current = false; setOpen(false); };
  const leave = () => { clearTimeout(closeTimer.current); closeTimer.current = setTimeout(() => { if (!pinned.current) setOpen(false); }, 150); };
  const toggle = () => { if (pinned.current) close(); else { pinned.current = true; show(); } };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !panel.current) return;
    const anchor = trigger.current.getBoundingClientRect(), box = panel.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - box.width - 8));
    const top = anchor.top - box.height - 8 >= 8 ? anchor.top - box.height - 8 : Math.min(anchor.bottom + 8, window.innerHeight - box.height - 8);
    setPosition(current => current.left === left && current.top === Math.max(8, top) ? current : { left, top: Math.max(8, top) });
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
  return { open, id, position, trigger, panel, show, leave, close, toggle };
}
