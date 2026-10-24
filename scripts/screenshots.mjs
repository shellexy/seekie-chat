// 生成 docs/screenshots/ 下的界面截图。
// 用隔离的临时数据目录和模拟连接，不碰真实数据、不发起任何网络请求。
// 重新生成：node scripts/screenshots.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';
import { _electron as playwrightElectron } from 'playwright';
import { seedDemoData } from './demo-data.mjs';

const root = process.cwd();
const outDir = join(root, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });
const directory = mkdtempSync(join(tmpdir(), 'seekie-shots-'));
const env = { ...process.env, SEEKIE_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.SEEKIE_DEV_URL;

const app = await playwrightElectron.launch({ executablePath: electron, args: ['.'], cwd: root, env, timeout: 30000 });
const page = await app.firstWindow();
await page.locator('.window-controls').waitFor();
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
// 等视口真的变成 1440×900 再拍，否则第一张还是默认的 720 高，和图廊里其它图对不齐。
await page.waitForFunction(() => innerHeight === 900, null, { timeout: 5000 }).catch(() => {});
await page.waitForTimeout(300);

const shot = async name => {
  const png = join(directory, `${name}.png`);
  await page.screenshot({ path: png });
  // WebP 比同画质 PNG 小得多，仓库里放截图不该拖慢 clone 和页面加载。
  execFileSync('cwebp', ['-quiet', '-q', '88', png, '-o', join(outDir, `${name}.webp`)]);
  console.log('saved', `${name}.webp`);
};

// 还没配任何模型时的第一屏，趁注入模拟数据之前先拍：这一屏要说明"没有 API Key
// 也能一键添加免费体验模型"，是首次打开的人最需要看到的一句话。
await page.locator('.welcome .text-link').waitFor();
await page.waitForTimeout(300);
await shot('first-run');

// ---- 模拟数据：两个连接、三个模型、几个会话，其中一个是完整回答 ----
await page.evaluate(seedDemoData);
await page.locator('.message.assistant').first().waitFor();
await page.waitForTimeout(500);

// 从对话开头拍，别从问题中间截断。
const chatTop = () => page.evaluate(() => { const el = document.querySelector('.message-scroll'); if (el) el.scrollTop = 0; });
// 展开来源列表，让"联网搜索带回真实来源"看得见。
const openSources = async () => { if (await page.locator('.sources').count()) await page.locator('.sources summary').first().click(); };

await chatTop();
await openSources();
await page.waitForTimeout(250);
await shot('main-window');

// 分支：展开分支菜单，这是这个客户端最不寻常的功能。
await page.locator('.branch-pill').click();
await page.locator('.branch-option').first().waitFor();
await page.waitForTimeout(250);
await shot('branches');
await page.keyboard.press('Escape');

// 推理摘要展开：说明模型的思考过程是可见的，而不是只给一句"思考了 2.1 秒"。
await chatTop();
await page.locator('.message.assistant').first().locator('.thinking summary').click();
await page.waitForTimeout(250);
await shot('reasoning');
await page.locator('.message.assistant').first().locator('.thinking summary').click();
await page.waitForTimeout(200);

// 请求详情：给第一条回答补一条请求记录。真实运行时是主进程写入 requests/<消息 id>.json，
// 这里直接写同一个位置，内容和真实记录同形（头已脱敏、请求体是格式化后的 JSON）。
const answerId = await page.evaluate(async () => {
  const state = await window.seekie.load(), conversation = state.conversations.find(c => c.id === state.selectedId);
  return conversation.messages.find(m => m.role === 'assistant').id;
});
mkdirSync(join(directory, 'requests'), { recursive: true });
writeFileSync(join(directory, 'requests', `${answerId}.json`), JSON.stringify([{
  url: 'https://api.deepseek.com/anthropic/v1/messages',
  method: 'POST',
  headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': '••••••••' },
  body: JSON.stringify({
    model: 'deepseek-flash', max_tokens: 8192, stream: true,
    thinking: { type: 'enabled', budget_tokens: 4096 },
    system: '你是一位严谨、友善的助手。使用用户的语言回答。',
    tools: [
      { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      { name: 'web_fetch', description: '读取公开网页正文并转换为 Markdown。输入应是搜索结果或用户提供的完整网页 URL。', input_schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } }
    ],
    messages: [{ role: 'user', content: '对比一下 Tauri 和 Electron，重点说说打包体积和内存占用。' }]
  }, null, 2),
  response: 'event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-flash","usage":{"input_tokens":1820}}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"先把两边拆成运行时…"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}'
}]), { mode: 0o600 });
await page.getByRole('button', { name: '查看请求详情' }).first().click();
await page.getByRole('dialog', { name: '查看请求详情' }).waitFor();
await page.waitForTimeout(300);
await shot('request-details');
await page.getByRole('button', { name: '关闭请求详情' }).click();
await page.getByRole('dialog', { name: '查看请求详情' }).waitFor({ state: 'hidden' });

// 用量详情：点开回答右侧那串"模型·时间·输入·输出"，浮窗里有完整指标。
const metaTrigger = page.getByRole('button', { name: /^查看回答详情：/ }).first();
await metaTrigger.click();
await page.getByRole('tooltip').waitFor();
await page.waitForTimeout(250);
await shot('answer-meta');
await page.keyboard.press('Escape');

// 回答右键菜单：三种格式的复制、编辑、重新生成、请求详情与建分支都收在这里。
await page.locator('.message.assistant').first().click({ button: 'right' });
await page.locator('.message-context-menu').waitFor();
await page.waitForTimeout(200);
await shot('answer-menu');
await page.keyboard.press('Escape');

// 会话选项：温度/top_p、联网搜索与读取网页、系统提示词/角色预设和压缩入口都收在这个浮窗里，
// 配置按分支各自保存——每个分支可以是完全不同的问法。
await page.getByRole('button', { name: /^会话选项/ }).click();
await page.locator('.config-popover').waitFor();
await page.waitForTimeout(250);
await shot('session-options');
await page.keyboard.press('Escape');
await page.locator('.config-popover').waitFor({ state: 'hidden' });

// 设置 · 模型服务
await page.getByRole('button', { name: /^设置/ }).click();
await page.locator('.settings-nav').getByRole('button', { name: '模型服务' }).click();
await page.waitForTimeout(350);
await shot('settings-models');

// 设置 · 联网搜索：往下滚一点，让各家搜索服务的配置卡露出来。
await page.locator('.settings-nav').getByRole('button', { name: '联网搜索' }).click();
await page.waitForTimeout(350);
await page.evaluate(() => { const el = document.querySelector('.settings-content'); if (el) el.scrollTop = 560; });
await page.waitForTimeout(250);
await shot('search');

// 深色主题：同一屏，换主题即可。
await page.getByTitle('返回聊天', { exact: true }).click();
await page.locator('.settings-page').waitFor({ state: 'hidden' });
await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
await chatTop();
await openSources();
await page.waitForTimeout(300);
await shot('main-window-dark');

// 多段正文编辑：换到那条正文被推理与工具调用隔开的回答，点铅笔。
await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
await page.locator('.conversation-item', { hasText: '把调研整理成周报' }).click();
await page.locator('.message.assistant').last().getByTitle('编辑为新版本').click();
await page.locator('.edit-box').waitFor();
await page.waitForTimeout(300);
await shot('multi-body-edit');
await page.keyboard.press('Escape');

// 新建对话页放在最后：它会多出一个空会话，别让这个空会话进到别的图里。
await page.getByRole('button', { name: /新建对话/ }).first().click();
await page.locator('.starter-grid').waitFor();
await page.waitForTimeout(300);
await shot('welcome');

await app.close();
rmSync(directory, { recursive: true, force: true });
console.log('done →', outDir);
