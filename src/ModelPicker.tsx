import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Star } from 'lucide-react';
import usePopover from './usePopover';
import { modelLabel } from './domain';
import type { Connection, Model } from './types';

/**
 * The model picker replaces a native <select>: an <option> cannot hold a button, and <optgroup>
 * cannot be interacted with, so favourites and section headings both need a drawn panel.
 *
 * Favourites and recently used models are shortcuts at the top; the full list stays below them so
 * every model is still reachable without a search box. Keyboard handling follows the listbox
 * pattern — arrows and Home/End move between rows, Enter selects, Escape closes — because the
 * native select it replaces provided that for free and losing it would be a regression.
 */
export default function ModelPicker({ model, models, connections, favorites, recent, disabled, onSelect, onToggleFavorite }: {
  model?: Model; models: Model[]; connections: Connection[]; favorites: string[]; recent: string[]; disabled: boolean;
  onSelect: (model: Model) => void; onToggleFavorite: (modelId: string) => void;
}) {
  const popover = usePopover();
  // Rows are looked up by key rather than pushed into an array: a ref callback runs again on every
  // render, and a model listed under two sections would otherwise be visited twice per re-render.
  const nodes = useRef(new Map<string, HTMLButtonElement>());
  // 停用连接上的模型不参与选择。触发按钮仍然显示当前模型的名称——它在分支配置里，没有变；
  // 只是这个模型不再出现在列表中，这本身就是"它所属的连接已停用"的信号。
  const stopped = new Set(connections.filter(c => c.disabled).map(c => c.id));
  const byName = models.filter(m => !stopped.has(m.connectionId)).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true }) || a.id.localeCompare(b.id));
  // A favourited model already has a permanent entry, so the recent section skips it; the full list
  // keeps everything, because that section is what makes every model reachable.
  const starred = byName.filter(m => favorites.includes(m.id));
  const recentlyUsed = byName.filter(m => recent.includes(m.id) && !favorites.includes(m.id));
  const sections = [
    ...(starred.length ? [{ title: '收藏', models: starred }] : []),
    ...(recentlyUsed.length ? [{ title: '最近使用', models: recentlyUsed }] : []),
    { title: '全部模型', models: byName }
  ];
  const rows = sections.flatMap(section => section.models.map(entry => ({ entry, key: section.title + '\u0000' + entry.id })));
  const select = (target: Model) => { onSelect(target); popover.close(); popover.trigger.current?.focus(); };
  // Opening focuses the row that is already in use, so Enter or an arrow key starts from there
  // instead of from the top of the list.
  useEffect(() => { if (popover.open) nodes.current.get(rows[Math.max(0, rows.findIndex(row => row.entry.id === model?.id))]?.key)?.focus(); }, [popover.open]);
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const current = rows.findIndex(row => nodes.current.get(row.key) === document.activeElement);
    const move = (next: number) => { event.preventDefault(); nodes.current.get(rows[(next + rows.length) % rows.length]?.key)?.focus(); };
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) move(current + 1);
    else if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) move(current - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(rows.length - 1);
    // usePopover already closes on Escape; returning focus to the trigger keeps the keyboard path
    // the same as clicking a row.
    else if (event.key === 'Escape') popover.trigger.current?.focus();
  }
  const label = model ? modelLabel(model, connections) : '选择模型';
  // The label fades out at the edge rather than ending in an ellipsis. CSS alone cannot tell an
  // overflowing element from a short one, and a mask on a short label would fade its last characters
  // for no reason, so the component measures the text and only then asks for the mask.
  const labelRef = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const element = labelRef.current;
    if (!element) return;
    const update = () => setClipped(element.scrollWidth > element.clientWidth + 1);
    update();
    // The label changes with the chosen model, with connection names and with the composer width, so
    // the box is watched instead of measuring once on mount.
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [label]);
  return <>
    <button ref={popover.trigger} className={'model-select-trigger' + (clipped ? ' clipped' : '')} aria-label="聊天模型" aria-haspopup="listbox" aria-expanded={popover.open}
      title={model ? label : '选择模型'} disabled={disabled} onClick={popover.toggle}
      onKeyDown={e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); popover.show(); } }}>
      <span ref={labelRef}>{label}</span>
      <ChevronDown size={12}/>
    </button>
    {popover.open && createPortal(<div ref={popover.panel} className="popover model-select-popover" role="listbox" aria-label="聊天模型" style={popover.position} onKeyDown={onKeyDown}>
      {sections.map(section => <div className="model-select-section" key={section.title}>
        <div className="model-select-heading">{section.title}</div>
        {section.models.map(entry => {
          const key = section.title + '\u0000' + entry.id, isFavorite = favorites.includes(entry.id);
          return <div className="model-select-row" key={key}>
            <button className="model-select-label" role="option" aria-selected={entry.id === model?.id} tabIndex={-1} title={modelLabel(entry, connections)}
              ref={element => { if (element) nodes.current.set(key, element); else nodes.current.delete(key); }} onClick={() => select(entry)}>
              <span>{modelLabel(entry, connections)}</span>
              {entry.id === model?.id && <Check size={14}/>}
            </button>
            <button className={'icon-button model-select-star' + (isFavorite ? ' on' : '')} aria-pressed={isFavorite}
              aria-label={`${isFavorite ? '取消收藏' : '收藏'} ${entry.name}`} title={isFavorite ? '取消收藏' : '收藏'}
              onClick={() => onToggleFavorite(entry.id)}>
              <Star size={14} fill={isFavorite ? 'currentColor' : 'none'}/>
            </button>
          </div>;
        })}
      </div>)}
    </div>, document.body)}
  </>;
}