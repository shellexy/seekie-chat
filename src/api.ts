import { initialState } from './domain';
import type { Bridge } from './types';
// Browser mode is a layout preview. API requests and secrets are desktop-only.
let preview = initialState();
export const api: Bridge = window.deepchan || {
  async load() { return preview; }, async save(state) { preview = state; return structuredClone(state); },
  async run() { throw new Error('浏览器仅用于界面预览，请通过 npm run dev 打开 Electron 桌面客户端发送消息'); },
  async cancel() {}, async compress() { throw new Error('历史压缩需要 Electron 桌面客户端'); },
  async title() { throw new Error('自动标题需要 Electron 桌面客户端'); },
  async test() { throw new Error('测试连接需要 Electron 桌面客户端'); }, async exportData() { throw new Error('请在桌面客户端导出'); }, async importData() { throw new Error('请在桌面客户端导入'); },
  async openExternal(url) { window.open(url, '_blank', 'noopener,noreferrer'); },
  async minimizeWindow() {}, async toggleMaximizeWindow() { return false; }, async isWindowMaximized() { return false; }, async closeWindow() {}, onWindowState() { return () => {}; },
  onEvent() { return () => {}; }
};
