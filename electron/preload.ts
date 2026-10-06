import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, Bridge } from '../src/types';
const bridge: Bridge = {
  load: () => ipcRenderer.invoke('load'), save: state => ipcRenderer.invoke('save', state),
  run: request => ipcRenderer.invoke('run', request), cancel: id => ipcRenderer.invoke('cancel', id),
  compress: (id, branch) => ipcRenderer.invoke('compress', id, branch), test: c => ipcRenderer.invoke('test', c), title: id => ipcRenderer.invoke('title', id),
  exportData: (format, id) => ipcRenderer.invoke('export', format, id), importData: () => ipcRenderer.invoke('import'),
  openExternal: url => ipcRenderer.invoke('external', url),
  onEvent: callback => { const listener = (_: unknown, event: AppEvent) => callback(event); ipcRenderer.on('event', listener); return () => ipcRenderer.removeListener('event', listener); }
};
contextBridge.exposeInMainWorld('deepchan', bridge);
