import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WINDOW_SIZE, MIN_VISIBLE_EDGE, MINIMUM_WINDOW_SIZE, normalizeWindowLayout, restoreWindow, type Display } from '../electron/window_state';
import type { WindowLayout } from '../src/types';

const display = (x: number, y: number, width: number, height: number): Display => ({ workArea: { x, y, width, height } });
const SCREEN = [display(0, 0, 1920, 1080)];
const layout = (over: Partial<WindowLayout>): WindowLayout => ({ x: 120, y: 80, width: 1180, height: 760, maximized: false, outline: true, ...over });

test('没有存档时用默认尺寸，位置留给系统摆放', () => {
  assert.deepEqual(restoreWindow(undefined, SCREEN), { width: DEFAULT_WINDOW_SIZE.width, height: DEFAULT_WINDOW_SIZE.height, maximized: false });
  // 只存了尺寸没存位置时同理：不猜坐标，免得窗口压到不该压的地方。
  assert.deepEqual(restoreWindow(layout({ x: undefined, y: undefined }), SCREEN), { width: 1180, height: 760, maximized: false });
});

test('存档里的尺寸和位置原样恢复', () => {
  assert.deepEqual(restoreWindow(layout({}), SCREEN), { x: 120, y: 80, width: 1180, height: 760, maximized: false });
});

test('最大化这件事只带一个开关，还原尺寸照样记着', () => {
  const restored = restoreWindow(layout({ maximized: true }), SCREEN);
  assert.equal(restored.maximized, true, '下次要按最大化打开');
  assert.deepEqual({ x: restored.x, y: restored.y, width: restored.width, height: restored.height }, { x: 120, y: 80, width: 1180, height: 760 }, '否则点还原会跳到一个谁也没设过的尺寸');
});

test('窗口比屏幕还大时收进屏幕，上限按工作区算', () => {
  const restored = restoreWindow(layout({ x: 0, y: 0, width: 4000, height: 3000 }), SCREEN);
  assert.deepEqual({ width: restored.width, height: restored.height }, { width: 1920, height: 1080 });
  // 顶部有面板时上限是工作区高度而不是整块屏幕；位置只要还看得见就一动不动，用户摆哪儿算哪儿。
  const withPanel = restoreWindow(layout({ x: 0, y: 0, width: 1000, height: 3000 }), [display(0, 30, 1920, 1050)]);
  assert.deepEqual({ x: withPanel.x, y: withPanel.y, height: withPanel.height }, { x: 0, y: 0, height: 1050 });
});

test('再小的屏幕也保证最小尺寸，宁可超出', () => {
  const restored = restoreWindow(layout({ width: 10, height: 10 }), [display(0, 0, 600, 400)]);
  assert.deepEqual({ width: restored.width, height: restored.height }, { width: MINIMUM_WINDOW_SIZE.width, height: MINIMUM_WINDOW_SIZE.height });
});

test('原来那块屏幕拔掉后，窗口被拉回最近的一块屏幕', () => {
  // 存档是在副屏上写的（x 超出主屏），现在只剩一块屏。
  const restored = restoreWindow(layout({ x: 2000, y: 100, width: 1000, height: 600 }), SCREEN);
  assert.deepEqual({ x: restored.x, y: restored.y, width: restored.width, height: restored.height }, { x: 920, y: 100, width: 1000, height: 600 });
  // 整个窗口在屏幕外（负坐标）也一样拉回来。
  const offLeft = restoreWindow(layout({ x: -2000, y: -900, width: 1000, height: 600 }), SCREEN);
  assert.deepEqual({ x: offLeft.x, y: offLeft.y }, { x: 0, y: 0 });
});

test('窗口还搭着某块屏幕时，位置一动不动', () => {
  const two = [display(0, 0, 1440, 900), display(1440, 0, 1440, 900)];
  // 跨在两块屏幕中间：横向与第一块屏重叠 100 px，与第二块重叠更多，谁都不该动它。
  const straddling = restoreWindow(layout({ x: 1340, y: 0, width: 1000, height: 600 }), two);
  assert.deepEqual({ x: straddling.x, y: straddling.y }, { x: 1340, y: 0 });
  // 只露出 MIN_VISIBLE_EDGE 这条边算「看得见」；少一像素就按够不着处理。
  const edge = restoreWindow(layout({ x: 1440 - MIN_VISIBLE_EDGE, y: 0, width: 1000, height: 600 }), [display(0, 0, 1440, 900)]);
  assert.equal(edge.x, 1440 - MIN_VISIBLE_EDGE, '刚好露出这么多时不该搬动窗口');
  const past = restoreWindow(layout({ x: 1440 - MIN_VISIBLE_EDGE + 1, y: 0, width: 1000, height: 600 }), [display(0, 0, 1440, 900)]);
  assert.equal(past.x, 1440 - 1000, '再多缩一像素就该整个拉回来');
});

test('拿不到显示器信息时原样交回，让系统自己摆', () => {
  // 无头环境里的工作区是假的，照它搬反而会把窗口推到看不见的地方。
  assert.deepEqual(restoreWindow(layout({ x: 2000, y: 100, width: 1000, height: 600 }), []), { x: 2000, y: 100, width: 1000, height: 600, maximized: false });
});

test('存档只认有限的数：旧字段、手改过的值一律丢掉', () => {
  assert.deepEqual(normalizeWindowLayout({ x: '10', y: Number.NaN, width: Number.POSITIVE_INFINITY, height: 700.4, maximized: 'yes', outline: 1, legacy: true }), { height: 700, maximized: false, outline: true });
  for (const junk of [undefined, null, 0, 'x', [], [1]]) assert.deepEqual(normalizeWindowLayout(junk), { maximized: false, outline: true }, `${String(junk)} 都该退到默认值`);
});

test('大纲栏缺省按打开处理，只有明确写了关闭才算关闭', () => {
  assert.equal(normalizeWindowLayout({}).outline, true);
  assert.equal(normalizeWindowLayout({ outline: false }).outline, false);
  assert.equal(normalizeWindowLayout({ outline: true }).outline, true);
});
