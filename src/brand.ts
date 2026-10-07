// 图标只有一份：build/icon.png 既是 Electron 的窗口图标，也是侧栏品牌标记和新建对话页的图标，
// 由脚本按同一张源文件导出各尺寸。放进 build/ 而不是 src/ 是因为它同时属于打包资源。
import iconUrl from '../build/icon.png';
export const brandIcon = iconUrl;