import type { WindowLayout } from '../src/types';

// 没有存档时的窗口尺寸，以及窗口控件允许的最小值——和 BrowserWindow 的 minWidth / minHeight 同源，
// 两处不一致的话，恢复出来的窗口会比用户能拖到的最小值还小。
export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 720 };
export const MINIMUM_WINDOW_SIZE = { width: 800, height: 560 };
// 恢复出来的窗口至少要和某块屏幕重叠这么多像素，否则当作「够不着」。拔掉一台显示器后，存下来的
// 坐标可能落在一片不存在的区域里，窗口整个跑出去的话连顶栏都摸不到，只能改配置目录才能救回来。
export const MIN_VISIBLE_EDGE = 80;

export interface WorkArea { x: number; y: number; width: number; height: number }
export interface Display { workArea: WorkArea }
/** 直接摊给 BrowserWindow 构造参数用的那一组值；x / y 缺失时交给系统居中摆放。 */
export interface RestoredWindow { x?: number; y?: number; width: number; height: number; maximized: boolean }

const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
// 窗口坐标必须是整数，交给 Electron 取整的话不同平台会给出不同结果。
const integer = (value: number) => Math.round(value);
// high 可能小于 low（屏幕比窗口的最小尺寸还窄），这时就停在 low：宁可窗口超出屏幕，也不要建一个
// 比 minWidth 还窄的窗口，那会让 Electron 立刻又把它撑回去。
const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));

/**
 * 存档可能来自旧版本、也可能被手改过，所以只认有限的数：其余一律丢掉，让它落回默认值，
 * 而不是拿着 NaN 去建窗口。大纲栏缺省按打开处理，和界面初始值一致，老存档不会凭空少一栏。
 */
export function normalizeWindowLayout(raw: unknown): WindowLayout {
  const value = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const x = finite(value.x), y = finite(value.y), width = finite(value.width), height = finite(value.height);
  return {
    ...(x !== undefined ? { x: integer(x) } : {}),
    ...(y !== undefined ? { y: integer(y) } : {}),
    ...(width !== undefined ? { width: integer(width) } : {}),
    ...(height !== undefined ? { height: integer(height) } : {}),
    maximized: value.maximized === true,
    outline: value.outline !== false
  };
}

/** 左上角落在这块屏幕的工作区里的程度：横向和纵向都要露出足够多，露一条边不算看得见。 */
function reachable(area: WorkArea, x: number, y: number, width: number, height: number) {
  return Math.min(area.x + area.width, x + width) - Math.max(area.x, x) >= MIN_VISIBLE_EDGE
    && Math.min(area.y + area.height, y + height) - Math.max(area.y, y) >= MIN_VISIBLE_EDGE;
}

/** 从一点到一块工作区的最短距离，用来挑「离原来最近的那块屏幕」。 */
function gap(area: WorkArea, x: number, y: number) {
  return Math.hypot(Math.max(area.x - x, 0, x - (area.x + area.width)), Math.max(area.y - y, 0, y - (area.y + area.height)));
}

/**
 * 把存档换算成建窗口用的参数。两条不能少的兜底：尺寸不超过屏幕（否则底部输入框永远够不着），
 * 位置必须落在某块还接得上的屏幕上（否则窗口出现在虚空里）。没有显示器信息时原样交回，
 * 让 Electron 自己摆放——无头环境下工作区是假的，照它搬反而会把窗口推到看不见的地方。
 */
export function restoreWindow(layout: WindowLayout | undefined, displays: Display[]): RestoredWindow {
  const areas = displays.map(display => display?.workArea).filter(area => !!area && area.width > 0 && area.height > 0);
  const maximized = layout?.maximized === true;
  const widest = areas.length ? Math.max(...areas.map(area => area.width)) : Number.MAX_SAFE_INTEGER;
  const tallest = areas.length ? Math.max(...areas.map(area => area.height)) : Number.MAX_SAFE_INTEGER;
  const width = integer(clamp(layout?.width ?? DEFAULT_WINDOW_SIZE.width, MINIMUM_WINDOW_SIZE.width, widest));
  const height = integer(clamp(layout?.height ?? DEFAULT_WINDOW_SIZE.height, MINIMUM_WINDOW_SIZE.height, tallest));
  const x0 = layout?.x, y0 = layout?.y;
  if (x0 === undefined || y0 === undefined) return { width, height, maximized };
  let x = integer(x0), y = integer(y0);
  if (!areas.length) return { x, y, width, height, maximized };
  if (!areas.some(area => reachable(area, x, y, width, height))) {
    const nearest = areas.reduce((best, area) => gap(area, x, y) < gap(best, x, y) ? area : best, areas[0]);
    x = integer(clamp(x, nearest.x, nearest.x + nearest.width - width));
    y = integer(clamp(y, nearest.y, nearest.y + nearest.height - height));
  }
  return { x, y, width, height, maximized };
}
