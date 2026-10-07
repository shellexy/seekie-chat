import { Copy, Minus, Square, X } from 'lucide-react';
import { api } from './api';

export default function WindowControls({ maximized, onMaximizedChange, onError }: {
  maximized: boolean; onMaximizedChange: (maximized: boolean) => void; onError?: (error: string) => void;
}) {
  return <div className="window-controls" role="toolbar" aria-label="窗口控件">
    <button className="window-control" type="button" title="最小化窗口" aria-label="最小化窗口" onClick={() => { void api.minimizeWindow().catch(error => onError?.(String(error))); }}><Minus size={15}/></button>
    <button className="window-control" type="button" title={maximized ? '还原窗口' : '最大化窗口'} aria-label={maximized ? '还原窗口' : '最大化窗口'} onClick={() => { void api.toggleMaximizeWindow().then(onMaximizedChange).catch(error => onError?.(String(error))); }}>{maximized ? <Copy size={13}/> : <Square size={13}/>}</button>
    <button className="window-control window-close" type="button" title="关闭窗口" aria-label="关闭窗口" onClick={() => { void api.closeWindow().catch(error => onError?.(String(error))); }}><X size={16}/></button>
  </div>;
}
