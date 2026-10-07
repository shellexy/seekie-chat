// 生成 docs/screenshots/ 下的界面截图。
// 用隔离的临时数据目录和模拟连接，不碰真实数据、不发起任何网络请求。
// 重新生成：node scripts/screenshots.mjs
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';
import { _electron as playwrightElectron } from 'playwright';

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
await page.evaluate(async () => {
  const state = await window.seekie.load();
  const now = Date.now(), day = 86_400_000;
  const uuid = () => crypto.randomUUID();
  const deepseek = { id: uuid(), name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', apiKey: 'sk-demo-key', headers: {}, timeout: 120, proxy: '' };
  const openai = { id: uuid(), name: 'OpenAI', protocol: 'responses', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo-key', headers: {}, timeout: 120, proxy: '', responsesForGpt: true };
  const flash = { id: uuid(), connectionId: deepseek.id, name: 'DeepSeek-Flash', model: 'deepseek-flash', contextWindow: 1_048_576, maxOutput: 393_216, vision: true, tools: true, nativeSearch: true, videoInput: false, audioInput: false, pdfInput: false, reasoning: 'effort', efforts: ['none', 'low', 'high', 'max'], defaultEffort: 'high', temperature: true };
  const gpt = { id: uuid(), connectionId: openai.id, name: 'GPT-6', model: 'gpt-6-astra', contextWindow: 400_000, maxOutput: 128_000, vision: true, tools: true, nativeSearch: true, videoInput: false, audioInput: false, pdfInput: false, reasoning: 'effort', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], temperature: false };
  const config = { modelId: flash.id, system: state.settings.promptPresets.find(p => p.id === 'general').content, search: 'auto', webFetch: 'auto', effort: 'high', budget: 4096, temperature: 1, topP: 1 };

  const question = { id: uuid(), parentId: null, role: 'user', text: '对比一下 Tauri 和 Electron，重点说说打包体积和内存占用。', reasoning: '', attachments: [], tools: [], sources: [], status: 'complete', created: now - 5 * 60_000 };
  const toolSearch = { id: uuid(), name: 'web_search', input: '{\n  "type": "search",\n  "query": "Tauri Electron 安装包体积 内存占用 对比"\n}', output: '搜索完成，来源见回答引用', status: 'done', started: now - 4.9 * 60_000, elapsed: 1450 };
  const toolFetch = { id: uuid(), name: 'web_fetch', input: '{"url":"https://example.com/desktop-runtimes"}', output: '读取完成', status: 'done', started: now - 4.8 * 60_000, elapsed: 620 };
  const answer = {
    id: uuid(), parentId: question.id, role: 'assistant',
    text: '两者的差别主要在运行时：\n\n- **Tauri** 用系统自带的 WebView，安装包通常 3–10 MB；内存占用随系统 WebView 变化，各发行版表现不一致。\n- **Electron** 自带 Chromium 与 Node.js，安装包 80 MB 起；换来的是一致的行为和完整的调试链路。\n\n目标发行版可控、体积优先，Tauri 更合适；要覆盖多种桌面环境、少踩"在我机器上能用"的坑，Electron 省心得多。',
    reasoning: '先把两边拆成运行时、打包体积和调试链路三块比较，再按发行版覆盖范围给结论。',
    reasoningMs: 2100,
    segments: [
      { type: 'reasoning', text: '先把两边拆成运行时、打包体积和调试链路三块比较，再按发行版覆盖范围给结论。', ms: 2100 },
      { type: 'tool', toolId: toolSearch.id },
      { type: 'tool', toolId: toolFetch.id },
      { type: 'text', text: '两者的差别主要在运行时：\n\n- **Tauri** 用系统自带的 WebView，安装包通常 3–10 MB；内存占用随系统 WebView 变化，各发行版表现不一致。\n- **Electron** 自带 Chromium 与 Node.js，安装包 80 MB 起；换来的是一致的行为和完整的调试链路。\n\n目标发行版可控、体积优先，Tauri 更合适；要覆盖多种桌面环境、少踩"在我机器上能用"的坑，Electron 省心得多。' }
    ],
    attachments: [], tools: [toolSearch, toolFetch],
    sources: [
      { title: 'Tauri vs Electron: 桌面应用框架对比', url: 'https://example.com/tauri-vs-electron' },
      { title: 'Choosing a desktop runtime', url: 'https://example.com/desktop-runtimes' },
      { title: '打包体积与启动速度实测', url: 'https://example.com/bundle-benchmark' }
    ],
    status: 'complete', created: now - 4 * 60_000,
    modelId: flash.id, modelName: flash.name, connectionName: deepseek.name, config,
    usage: { input: 1820, output: 460, cachedInput: 900, elapsedMs: 8200, generationMs: 6100, firstTokenMs: 900, firstOutputMs: 700 }
  };
  const followUp = { id: uuid(), parentId: answer.id, role: 'user', text: '那内存占用具体差多少？', reasoning: '', attachments: [], tools: [], sources: [], status: 'complete', created: now - 2 * 60_000 };
  const finalAnswer = {
    id: uuid(), parentId: followUp.id, role: 'assistant',
    text: '空载时 Electron 大约 120–180 MB，Tauri 在 Linux 上通常 40–80 MB，但两者都会随页面复杂度上升而收敛。\n\n差距主要来自 Chromium 的常驻进程模型，而不是业务代码本身。',
    reasoning: '', reasoningMs: 0,
    segments: [{ type: 'text', text: '空载时 Electron 大约 120–180 MB，Tauri 在 Linux 上通常 40–80 MB，但两者都会随页面复杂度上升而收敛。\n\n差距主要来自 Chromium 的常驻进程模型，而不是业务代码本身。' }],
    attachments: [], tools: [], sources: [], status: 'complete', created: now - 60_000,
    modelId: flash.id, modelName: flash.name, connectionName: deepseek.name, config,
    usage: { input: 2400, output: 180, cachedInput: 1900, elapsedMs: 4300, generationMs: 3900, firstTokenMs: 620, firstOutputMs: 620 }
  };

  const mainBranch = { id: uuid(), name: '主线', leafId: finalAnswer.id, originId: null, parentBranchId: null, config, draft: '', draftAttachments: [], scrollTop: 0, updated: now };
  const sideBranch = { id: uuid(), name: '只看内存占用', leafId: answer.id, originId: answer.id, parentBranchId: null, config, draft: '', draftAttachments: [], scrollTop: 0, updated: now - 90_000 };
  const main = { id: uuid(), title: '对比 Tauri 与 Electron 的取舍', manualTitle: true, titleState: 'done', created: now - day, updated: now, activeBranchId: mainBranch.id, branches: [mainBranch, sideBranch], messages: [question, answer, followUp, finalAnswer] };
  // 多段正文的回答：正文被推理与工具调用隔开，编辑时每段各自一个输入框。
  const weeklyQuestion = { id: uuid(), parentId: null, role: 'user', text: '把刚才的调研整理成一段能贴进周报的话。', reasoning: '', attachments: [], tools: [], sources: [], status: 'complete', created: now - 3 * 60_000 };
  const confirmSize = { id: uuid(), name: 'web_search', input: '{\n  "type": "search",\n  "query": "Electron 打包体积 实测"\n}', output: '搜索完成，来源见回答引用', status: 'done', started: now - 2.9 * 60_000, elapsed: 1180 };
  const confirmPage = { id: uuid(), name: 'web_fetch', input: '{"url":"https://example.com/bundle-size"}', output: '读取完成', status: 'done', started: now - 2.7 * 60_000, elapsed: 540 };
  const bodyOne = '本周完成了桌面端两个候选框架的对比验证。';
  const bodyTwo = '结论：短期内继续用 Electron。安装包更大，但行为一致、调试链路完整，团队不需要为不同发行版分别验证。';
  const bodyThree = '下一步：先做一次打包体积的实测，再决定要不要评估 Tauri。';
  const weeklyAnswer = {
    id: uuid(), parentId: weeklyQuestion.id, role: 'assistant',
    text: `${bodyOne}\n\n${bodyTwo}\n\n${bodyThree}`,
    reasoning: '周报要的是结论和依据，不是过程。', reasoningMs: 1800,
    segments: [
      { type: 'text', text: bodyOne },
      { type: 'reasoning', text: '周报要的是结论和依据，不是过程；结论放前面。', ms: 900 },
      { type: 'tool', toolId: confirmSize.id },
      { type: 'text', text: bodyTwo },
      { type: 'reasoning', text: '体积差距得补一个实测，不能只凭印象。', ms: 900 },
      { type: 'tool', toolId: confirmPage.id },
      { type: 'text', text: bodyThree }
    ],
    attachments: [], tools: [confirmSize, confirmPage], sources: [], status: 'complete', created: now - 2 * 60_000,
    modelId: flash.id, modelName: flash.name, connectionName: deepseek.name, config,
    usage: { input: 2600, output: 320, cachedInput: 2100, elapsedMs: 5400, generationMs: 4700, firstTokenMs: 700, firstOutputMs: 650 }
  };
  const weeklyBranch = { id: uuid(), name: '主线', leafId: weeklyAnswer.id, originId: null, parentBranchId: null, config, draft: '', draftAttachments: [], scrollTop: 0, updated: now - 2 * 60_000 };
  const weekly = { id: uuid(), title: '把调研整理成周报', manualTitle: true, titleState: 'done', created: now - 3 * 60_000, updated: now - 2 * 60_000, activeBranchId: weeklyBranch.id, branches: [weeklyBranch], messages: [weeklyQuestion, weeklyAnswer] };

  const others = ['整理 Electron 主进程的启动流程', '把这段 SQL 改写成窗口函数', '周报：本周进展与下周计划', '给鲸鱼娘写一段角色设定'].map((title, index) => {
    const branchId = uuid();
    return { id: uuid(), title, manualTitle: true, titleState: 'done', created: now - (index + 2) * day, updated: now - (index + 2) * day, activeBranchId: branchId, branches: [{ id: branchId, name: '主线', leafId: null, originId: null, parentBranchId: null, config, draft: '', draftAttachments: [], scrollTop: 0, updated: now - (index + 2) * day }], messages: [] };
  });

  state.settings.connections = [deepseek, openai];
  state.settings.models = [flash, gpt];
  state.settings.defaultModel = flash.id; state.settings.titleModel = ''; state.settings.compressionModel = '';
  state.settings.favoriteModels = [flash.id]; state.settings.recentModels = [flash.id];
  state.settings.exaKey = 'exa-demo'; state.settings.tavilyKey = 'tavily-demo';
  state.conversations = [main, weekly, ...others];
  state.selectedId = main.id;
  await window.seekie.save(state);
  window.dispatchEvent(new Event('seekie-reload'));
});
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
