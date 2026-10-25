import { applyStateChanges, initialState } from './domain';
import type { Bridge } from './types';
// Browser mode is a layout preview. API requests and secrets are desktop-only.
let preview = initialState();
let previewOutline = true;
export const api: Bridge = window.seekie || {
  async load() { return preview; }, async save(state) { preview = state; return structuredClone(state); },
  async saveDraft(branchId, draft) { for (const c of preview.conversations) for (const b of c.branches) if (b.id === branchId) { b.draft = draft; return true; } return false; },
  async saveSettings(settings) { preview.settings = settings; return structuredClone(settings); },
  async saveFields(changes) { preview = applyStateChanges(preview, changes); return true; },
  async run() { throw new Error('浏览器仅用于界面预览，请通过 npm run dev 打开 Electron 桌面客户端发送消息'); },
  async cancel() {}, async compress() { throw new Error('历史压缩需要 Electron 桌面客户端'); },
  async title() { throw new Error('自动标题需要 Electron 桌面客户端'); }, async debug() { return []; }, async attachment() { return ''; }, async versions() { return { app: '', chromium: '', electron: '', node: '' }; },
  async test() { throw new Error('测试连接需要 Electron 桌面客户端'); }, async exportData() { throw new Error('请在桌面客户端导出'); }, async importData() { throw new Error('请在桌面客户端导入'); },
  async openExternal(url) { window.open(url, '_blank', 'noopener,noreferrer'); },
  async minimizeWindow() {}, async toggleMaximizeWindow() { return false; }, async isWindowMaximized() { return false; }, async closeWindow() {}, onWindowState() { return () => {}; },
  // 浏览器预览没有窗口可恢复：大纲栏每次都是默认的打开状态，开关只在界面里生效。
  async windowLayout() { return { outline: previewOutline }; }, async setOutlineOpen(open) { previewOutline = open; },
  onEvent() { return () => {}; }
};
