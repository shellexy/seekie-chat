// 录制一段界面演示视频：隔离的临时数据目录 + 模拟连接，不碰真实数据、不发网络请求。
// 画面用 ffmpeg 抓 X11 屏幕（1440×900），窗口固定在左上角；无显示器时用：
//   xvfb-run -a -s "-screen 0 1440x900x24" npm run record
// 产物：release/seekie-chat-demo.mp4
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';
import { _electron as playwrightElectron } from 'playwright';
import { seedDemoData } from './demo-data.mjs';

const root = process.cwd(), outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const output = join(outDir, 'seekie-chat-demo.mp4');
const directory = mkdtempSync(join(tmpdir(), 'seekie-record-'));
const env = { ...process.env, SEEKIE_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SEEKIE_DEV_URL;

if (!process.env.DISPLAY) {
  console.error('没有 DISPLAY。无桌面环境时请用：xvfb-run -a -s "-screen 0 1440x900x24" npm run record');
  process.exit(1);
}
if (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0) {
  console.error('需要 ffmpeg（带 x11grab 支持）才能录屏。');
  process.exit(1);
}

const app = await playwrightElectron.launch({ executablePath: electron, args: ['.'], cwd: root, env, timeout: 30000 });
let ffmpeg;
try {
  const page = await app.firstWindow();
  await page.locator('.window-controls').waitFor();
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    win.setBounds({ x: 0, y: 0, width: 1440, height: 900 });
    win.setAlwaysOnTop(true);
  });
  await page.waitForFunction(() => innerHeight === 900, null, { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(300);

  // 复制几段旧会话，让侧栏能滚动，吸顶分组标题才有机会入镜。
  await page.evaluate(seedDemoData);
  await page.locator('.message.assistant').first().waitFor();
  await page.evaluate(async () => {
    const state = await window.seekie.load();
    const template = state.conversations.find(c => c.messages.length) || state.conversations[0];
    const scheduledNoon = daysAgo => { const shifted = new Date(Date.now() - 6 * 3600e3); shifted.setDate(shifted.getDate() - daysAgo); shifted.setHours(12, 0, 0, 0); return shifted.getTime() + 6 * 3600e3; };
    const extras = [
      ['把日志里的报错归类', 5], ['给脚本补上重试', 6], ['研究一下 RAG 的切分策略', 12],
      ['写一份接口变更说明', 20], ['整理发布检查清单', 31], ['对比两种缓存方案', 45],
      ['复盘一次线上故障', 60], ['给新同事的启动指南', 75], ['整理这周的周会记录', 90], ['旧版迁移笔记', 120]
    ];
    for (const [title, daysAgo] of extras) {
      const at = scheduledNoon(daysAgo);
      const branch = { ...structuredClone(template.branches[0]), id: crypto.randomUUID(), name: '主线', parentBranchId: null, originId: null, leafId: null, summary: undefined, updated: at };
      state.conversations.push({ ...structuredClone(template), id: crypto.randomUUID(), title, manualTitle: true, titleState: 'done', archived: false, created: at, updated: at, activeBranchId: branch.id, branches: [branch], messages: [], backgroundUsage: [] });
    }
    await window.seekie.save(state); window.dispatchEvent(new Event('seekie-reload'));
  });
  await page.locator('.message.assistant').first().waitFor();
  await page.waitForTimeout(600);

  // ffmpeg 抓屏：从 (0,0) 开始，与窗口位置严格对齐。
  ffmpeg = spawn('ffmpeg', [
    '-y', '-f', 'x11grab', '-framerate', '30', '-video_size', '1440x900',
    '-i', `${process.env.DISPLAY}+0,0`, '-t', '120',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', output
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  ffmpeg.stderr.on('data', () => {});
  await page.waitForTimeout(700);

  const wait = ms => page.waitForTimeout(ms);
  const chatTop = () => page.evaluate(() => { const el = document.querySelector('.message-scroll'); if (el) el.scrollTop = 0; });

  // 1. 主界面与时间分组
  await chatTop();
  await wait(2600);

  // 2. 侧栏滚动：分组标题吸顶
  await page.evaluate(() => { const el = document.querySelector('.conversation-list'); if (el) el.scrollTo({ top: 520, behavior: 'smooth' }); });
  await wait(1800);
  await page.evaluate(() => { const el = document.querySelector('.conversation-list'); if (el) el.scrollTo({ top: 0, behavior: 'smooth' }); });
  await wait(1200);

  // 3. 分支菜单
  await page.locator('.branch-pill').click();
  await page.locator('.branch-option').first().waitFor();
  await wait(2800);
  await page.keyboard.press('Escape');
  await wait(600);

  // 4. 用量详情
  await page.getByRole('button', { name: /^查看回答详情：/ }).first().click();
  await page.getByRole('tooltip').waitFor();
  await wait(2800);
  await page.keyboard.press('Escape');
  await wait(500);

  // 5. 会话选项
  await page.getByRole('button', { name: /^会话选项/ }).click();
  await page.locator('.config-popover').waitFor();
  await wait(2800);
  await page.keyboard.press('Escape');
  await page.locator('.config-popover').waitFor({ state: 'hidden' });
  await wait(500);

  // 6. 推理摘要展开
  await page.locator('.message.assistant').first().locator('.thinking summary').click();
  await wait(2600);
  await page.locator('.message.assistant').first().locator('.thinking summary').click();
  await wait(500);

  // 7. 设置：模型服务与联网搜索
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '模型服务' }).click();
  await wait(2400);
  await page.locator('.settings-nav').getByRole('button', { name: '联网搜索' }).click();
  await wait(2000);
  await page.getByTitle('返回聊天', { exact: true }).click();
  await page.locator('.settings-page').waitFor({ state: 'hidden' });

  // 8. 深色主题
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await chatTop();
  await wait(2600);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await wait(800);
} finally {
  if (ffmpeg) {
    try {
      ffmpeg.kill('SIGINT');
      await Promise.race([once(ffmpeg, 'exit'), new Promise(resolve => setTimeout(resolve, 5000))]);
      if (ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
    } catch { ffmpeg.kill('SIGKILL'); }
  }
  await app.close().catch(() => {});
  rmSync(directory, { recursive: true, force: true });
}
if (!existsSync(output)) { console.error('录制失败：没有生成视频文件'); process.exit(1); }
console.log('saved', output, `${(statSync(output).size / 1024 / 1024).toFixed(1)} MB`);
