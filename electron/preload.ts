import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, Bridge } from '../src/types';
const bridge: Bridge = {
  load: () => ipcRenderer.invoke('load'), save: state => ipcRenderer.invoke('save', state),
  saveDraft: (branchId, draft) => ipcRenderer.invoke('draft', branchId, draft), saveSettings: settings => ipcRenderer.invoke('settings', settings), saveFields: changes => ipcRenderer.invoke('fields', changes),
  run: request => ipcRenderer.invoke('run', request), cancel: id => ipcRenderer.invoke('cancel', id),
  compress: (id, branch) => ipcRenderer.invoke('compress', id, branch), test: c => ipcRenderer.invoke('test', c), title: id => ipcRenderer.invoke('title', id), debug: id => ipcRenderer.invoke('debug', id), attachment: id => ipcRenderer.invoke('attachment', id), versions: () => ipcRenderer.invoke('versions'),
  exportData: (format, id) => ipcRenderer.invoke('export', format, id), importData: () => ipcRenderer.invoke('import'),
  openExternal: url => ipcRenderer.invoke('external', url),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),
  isWindowMaximized: () => ipcRenderer.invoke('window-is-maximized'),
  closeWindow: () => ipcRenderer.invoke('window-close'),
  windowLayout: () => ipcRenderer.invoke('window-layout'), setOutlineOpen: open => ipcRenderer.invoke('window-outline', open),
  onWindowState: callback => { const listener = (_: unknown, state: { maximized: boolean }) => callback(!!state.maximized); ipcRenderer.on('window-state', listener); return () => ipcRenderer.removeListener('window-state', listener); },
  onEvent: callback => { const listener = (_: unknown, event: AppEvent) => callback(event); ipcRenderer.on('event', listener); return () => ipcRenderer.removeListener('event', listener); }
};
contextBridge.exposeInMainWorld('seekie', bridge);
