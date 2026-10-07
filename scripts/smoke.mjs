import { _electron as electron } from 'playwright';
import { createServer as createViteServer } from 'vite';
import electronPath from 'electron';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = mkdtempSync(join(tmpdir(), 'deepchan-smoke-'));
const calls = []; let lastAuthorization = '';
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.method === 'GET') { lastAuthorization = req.headers.authorization || '';  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url.startsWith('/v1beta/models') ? { models: [{ name: 'models/fixture-model', supportedGenerationMethods: ['generateContent'] }] } : { data: [{ id: 'fixture-model' }] })); return; }
  const data = JSON.parse(body); calls.push({ path: req.url, data });
  const title = (data.instructions || data.system || data.systemInstruction?.parts?.[0]?.text || data.messages?.[0]?.content || '').includes('生成简短标题');
  const compression = (data.instructions || data.system || data.systemInstruction?.parts?.[0]?.text || data.messages?.[0]?.content || '').includes('压缩为');
  const text = title ? '桌面聊天客户端设计' : compression ? '目标：实现 Linux 聊天客户端。保留分支上下文，使用 Electron。' : `这是本地模拟 API 的回答 ${calls.filter(c => !JSON.stringify(c.data).includes('生成简短标题')).length}。\n\n## 实现思路\n\n先完成三栏布局，再连接模型。每个分支只发送自己的上下文。\n\n- **Electron** 提供桌面窗口\n- SQLite 保存对话与分支\n\n\`\`\`ts\nconst branch = createBranch(answer);\n\`\`\``;
  if (title) await new Promise(r => setTimeout(r, 250));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (req.url === '/v1/chat/completions') {
    send({ choices: [{ delta: { reasoning_content: title || compression ? '' : '先检查需求，再选择实施步骤。' } }] });
    await new Promise(r => setTimeout(r, 30));
    for (const part of text.match(/.{1,22}|\n/g)) { send({ choices: [{ delta: { content: part } }] }); await new Promise(r => setTimeout(r, 2)); }
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 30 } } });
  } else if (req.url === '/v1/responses') {
    send({ type: 'response.reasoning_summary_text.delta', delta: '推理摘要来自模拟服务。' });
    send({ type: 'response.web_search_call.in_progress', item_id: 'search-1' });
    send({ type: 'response.web_search_call.completed', item_id: 'search-1' });
    send({ type: 'response.output_text.delta', delta: text });
    send({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', title: 'Electron documentation', url: 'https://www.electronjs.org/docs' }] }] }], usage: { input_tokens: 120, output_tokens: 60, input_tokens_details: { cached_tokens: 30 } } } });
  } else if (req.url.startsWith('/v1beta/models/')) {
    send({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'Gemini 模拟思考摘要。', thought: true }] } }] });
    send({ candidates: [{ index: 0, content: { role: 'model', parts: [{ text, thoughtSignature: 'fixture-signature' }] }, finishReason: 'STOP', ...(data.tools?.some(t => t.googleSearch) ? { groundingMetadata: { webSearchQueries: ['Electron docs'], groundingChunks: [{ web: { title: 'Electron', uri: 'https://www.electronjs.org/docs' } }] } } : {}) }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 60, thoughtsTokenCount: 12, cachedContentTokenCount: 30 } });
  } else {
    send({ type: 'message_start', message: { usage: { input_tokens: 80, cache_read_input_tokens: 30, cache_creation_input_tokens: 10 } } });
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    send({ type: 'message_delta', usage: { output_tokens: 60 } }); send({ type: 'message_stop' });
  }
  res.end();
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const env = { ...process.env, DEEPCHAN_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.DEEPCHAN_DEV_URL;
let vite; if (process.argv.includes('--dev')) { vite = await createViteServer(); await vite.listen(); env.DEEPCHAN_DEV_URL = 'http://127.0.0.1:5173'; }
// IPC predicates are asynchronous; poll in Node and await each result explicitly.
// Playwright's waitForFunction treats a returned Promise as truthy before it resolves.
async function waitFor(page, predicate, arg, { timeout = 10000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('等待桌面应用状态超时');
}
async function assertUsageDetails(page, output = 60) {
  const answer = page.locator('.message.assistant').last();
  const id = await answer.getAttribute('data-id');
  const message = await page.evaluate(async id => (await window.deepchan.load()).conversations.flatMap(c => c.messages).find(m => m.id === id), id);
  assert.equal(message.usage.input, 120); assert.equal(message.usage.output, output); assert.equal(message.usage.cachedInput, 30);
  assert.ok(message.usage.elapsedMs > 0); assert.ok(message.usage.firstTokenMs >= 0 && message.usage.firstTokenMs <= message.usage.elapsedMs);
  const modelMeta = answer.locator('.answer-model-meta');
  assert.match(await modelMeta.innerText(), /^.+·\d{2}:\d{2}$/);
  await modelMeta.hover();
  const modelTooltip = page.locator('.answer-model-popover'); await modelTooltip.waitFor();
  assert.match(await modelTooltip.innerText(), /模拟 .+ \| 本地模拟 .+•\d{4}-\d{2}-\d{2}·\d{2}:\d{2}/);
  await page.mouse.move(5, 5); await modelTooltip.waitFor({ state: 'hidden' });
  const trigger = answer.getByRole('button', { name: '查看 token 用量与速度' });
  const tooltip = page.getByRole('tooltip');
  await trigger.hover(); await tooltip.waitFor();
  assert.deepEqual(await tooltip.locator('dt').allTextContents(), ['输入：','输入（缓存）：','输出：','速度：','首字耗时：']);
  const values = await tooltip.locator('dd').allTextContents();
  assert.deepEqual(values.slice(0, 3), ['120 token','30 token',`${output} token`]);
  assert.equal(values[3], `${(output / (message.usage.elapsedMs / 1000)).toFixed(1)} tps`);
  assert.equal(values[4], `${(message.usage.firstTokenMs / 1000).toFixed(2)} s`);
  const box = await tooltip.boundingBox();
  assert.ok(await page.evaluate(box => box.x >= 0 && box.y >= 0 && box.x + box.width <= innerWidth && box.y + box.height <= innerHeight, box), 'tooltip fits inside window');
  await page.mouse.move(5, 5); await tooltip.waitFor({ state: 'hidden' });
  await trigger.click(); await page.mouse.move(5, 5); await page.waitForTimeout(200); await tooltip.waitFor();
  await page.screenshot({ path: join(directory, `usage-${output}.png`) });
  await page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
  await trigger.click(); await tooltip.waitFor(); await page.getByLabel('消息输入').click(); await tooltip.waitFor({ state: 'hidden' });
  await trigger.focus(); await tooltip.waitFor(); await page.keyboard.press('Escape'); await tooltip.waitFor({ state: 'hidden' });
}
let desktop;
const logs = [];
async function launch() {
  console.log('stage: launch');
  desktop = await electron.launch({ executablePath: electronPath, args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const page = await desktop.firstWindow(); page.on('pageerror', e => logs.push(e.message));
  await page.locator('.window-controls').waitFor(); return page;
}
try {
  let page = await launch();
  const windowControls = page.getByRole('toolbar', { name: '窗口控件' });
  assert.equal(await windowControls.getByRole('button').count(), 3);
  const chatControlBounds = await windowControls.boundingBox();
  const viewportWidth = await page.evaluate(() => innerWidth);
  assert.equal(chatControlBounds.y, 0);
  assert.ok(Math.abs(chatControlBounds.x + chatControlBounds.width - viewportWidth) < 1);
  await windowControls.getByRole('button', { name: '最大化窗口' }).click();
  await waitFor(page, async () => window.deepchan.isWindowMaximized());
  await windowControls.getByRole('button', { name: '还原窗口' }).click();
  await waitFor(page, async () => !(await window.deepchan.isWindowMaximized()));
  assert.equal(await page.locator('.window-titlebar').count(), 0);
  assert.equal(await page.locator('.chat-header').evaluate(el => el.getBoundingClientRect().top), 0);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()[1]), 720);
  console.log('stage: connection presets');
  await page.getByRole('button', { name: /^设置/ }).click();
  const settingsControls = page.getByRole('toolbar', { name: '窗口控件' });
  assert.equal(await settingsControls.count(), 1);
  const settingsControlBounds = await settingsControls.boundingBox();
  const settingsViewportWidth = await page.evaluate(() => innerWidth);
  assert.equal(settingsControlBounds.y, 0);
  assert.ok(Math.abs(settingsControlBounds.x + settingsControlBounds.width - settingsViewportWidth) < 1);
  assert.equal(await page.locator('.preset-row button').first().innerText(), 'DeepSeek·anthropic');
  for (const theme of ['light', 'dark', 'system']) {
    assert.equal(await page.evaluate(theme => { document.documentElement.dataset.theme = theme; return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); }, theme), '#3c64fe');
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('.preset-row').getByRole('button', { name: 'DeepSeek·anthropic', exact: true }).click();
  assert.equal(await page.getByLabel('连接名称', { exact: true }).inputValue(), 'DeepSeek·anthropic');
  assert.equal(await page.getByLabel(/^接口协议/).inputValue(), 'anthropic');
  assert.equal(await page.getByLabel(/^Base URL/).inputValue(), 'https://api.deepseek.com/anthropic');
  assert.equal(await page.getByLabel('展示名称', { exact: true }).inputValue(), 'deepseek-flash');
  assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'deepseek-flash');
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '256000');
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  for (const name of ['图片输入', '工具调用', '原生搜索']) assert.equal(await page.getByLabel(name, { exact: true }).isChecked(), true);
  await page.locator('.preset-row').getByRole('button', { name: '自定义兼容服务', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('重命名的兼容服务');
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '65536');
  await page.getByLabel('模型 ID', { exact: true }).fill('custom-fixture');
  await page.locator('.preset-row').getByRole('button', { name: 'OpenAI · Responses', exact: true }).click();
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '65536');
  await page.getByLabel('模型 ID', { exact: true }).fill('responses-fixture');
  await page.locator('.preset-row').getByRole('button', { name: 'Gemini', exact: true }).click();
  assert.equal(await page.getByLabel(/^接口协议/).inputValue(), 'gemini');
  assert.equal(await page.getByLabel(/^Base URL/).inputValue(), 'https://generativelanguage.googleapis.com/v1beta');
  await page.getByLabel(/^Base URL/).fill(baseUrl.replace('/v1', '/v1beta'));
  await page.getByRole('button', { name: '测试连接 / 获取模型', exact: true }).click();
  await page.getByLabel(/^添加服务端模型/).selectOption('fixture-model');
  assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'fixture-model');
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '65536');
  await page.locator('.settings-nav').getByRole('button', { name: '系统提示词库' }).click();
  await page.getByRole('button', { name: '添加角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).last().fill('测试研究助手');
  await page.getByLabel('角色系统提示词', { exact: true }).last().fill('你是测试研究助手，优先使用证据回答。');
  const roleId = await page.getByLabel(/^新对话默认角色/).locator('option').last().getAttribute('value');
  await page.getByLabel(/^新对话默认角色/).selectOption(roleId);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.settings-page').waitFor({ state: 'hidden' });
  const toastLayout = await page.locator('.toast').evaluate(el => { const r = el.getBoundingClientRect(); return { xOffset: (r.left + r.right) / 2 - window.innerWidth / 2, yOffset: (r.top + r.bottom) / 2 - window.innerHeight / 2 }; });
  assert.ok(Math.abs(toastLayout.xOffset) < 1); assert.ok(Math.abs(toastLayout.yOffset) < 1);
  await page.screenshot({ path: join(directory, 'center-toast.png') });
  const presets = await page.evaluate(() => window.deepchan.load());
  assert.equal(presets.settings.models.find(m => m.model === 'deepseek-flash').nativeSearch, true);
  // Verify that the connection's defaults survive save/reopen and renaming.
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '联网搜索' }).click();
  assert.equal(await page.getByRole('heading', { name: 'Firecrawl', exact: true }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'AnySearch', exact: true }).count(), 1);
  assert.equal(await page.getByLabel('API Key（可选）').count(), 3);
  await page.locator('.settings-nav').getByRole('button', { name: '连接与模型' }).click();
  await page.locator('.connection-tabs').getByRole('button', { name: '重命名的兼容服务', exact: true }).click();
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  assert.deepEqual(await page.getByLabel(/^思考参数/).evaluateAll(els => els.map(el => el.value)), ['effort', 'effort']);
  await page.getByTitle('返回聊天', { exact: true }).click();
  await page.evaluate(async baseUrl => {
    const state = await window.deepchan.load();
    const connections = ['chat','responses','anthropic','gemini'].map(protocol => ({ id: crypto.randomUUID(), name: '本地模拟 ' + protocol, protocol, baseUrl: protocol === 'gemini' ? baseUrl.replace('/v1', '/v1beta') : baseUrl, apiKey: 'fixture-secret', headers: { 'x-fixture-secret': 'header-secret' }, timeout: 30, proxy: '' }));
    state.settings.connections = connections;
    state.settings.firecrawlKey = 'firecrawl-fixture-secret';
    state.settings.anysearchKey = 'anysearch-fixture-secret';
    state.settings.models = connections.map(c => ({ id: crypto.randomUUID(), connectionId: c.id, name: '模拟 ' + c.protocol, model: 'fixture', contextWindow: 128000, maxOutput: 4096, vision: true, tools: true, nativeSearch: c.protocol !== 'chat', reasoning: ['chat', 'gemini'].includes(c.protocol) ? 'effort' : 'none', efforts: ['low','medium','high'], temperature: false }));
    state.settings.defaultModel = state.settings.models[0].id;
    state.settings.titleModel = state.settings.models[0].id;
    await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
  }, baseUrl);
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  const input = page.getByRole('textbox', { name: '消息输入' });
  await page.getByRole('combobox', { name: '思考等级' }).selectOption('high');
  const toolbar = page.locator('.composer-bottom');
  assert.equal(await toolbar.getByRole('combobox', { name: '聊天模型' }).count(), 1);
  const modelSelector = toolbar.getByRole('combobox', { name: '聊天模型' });
  assert.deepEqual(await modelSelector.locator('option').allTextContents(), ['选择模型', '模拟 chat | 本地模拟 chat', '模拟 responses | 本地模拟 responses', '模拟 anthropic | 本地模拟 anthropic', '模拟 gemini | 本地模拟 gemini']);
  assert.equal(await modelSelector.getAttribute('title'), '模拟 chat | 本地模拟 chat');
  assert.equal(await page.locator('.header-title small').innerText(), '模拟 chat | 本地模拟 chat');
  assert.equal(await page.locator('.header-title small').getAttribute('title'), '模拟 chat | 本地模拟 chat');
  assert.equal(await toolbar.getByRole('combobox', { name: '思考等级' }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '会话选项' }).count(), 1);
  await toolbar.getByRole('button', { name: '会话选项' }).click();
  assert.equal(await page.getByLabel('系统提示词', { exact: true }).inputValue(), '你是测试研究助手，优先使用证据回答。');
  const searchMode = page.locator('.inline-config-field').first().locator('select');
  assert.deepEqual(await searchMode.locator('option').allTextContents(), ['自动联网（默认）', '关闭', '模型原生搜索', 'Exa 搜索', 'Ollama Cloud Web Search', 'Tavily 搜索', 'Firecrawl 搜索', 'AnySearch 搜索']);
  assert.equal(await searchMode.locator('option[value="tavily"]').isDisabled(), false);
  const webReading = page.getByRole('combobox', { name: '读取网页' });
  assert.deepEqual(await webReading.locator('option').allTextContents(), ['自动（默认）', 'Exa 读取网页', 'Ollama Cloud 读取网页', 'Tavily 读取网页', 'Firecrawl 读取网页', 'AnySearch 读取网页', '本地读取网页', '关闭']);
  assert.equal(await webReading.locator('option[value="tavily"]').isDisabled(), false);
  assert.equal(await webReading.inputValue(), 'auto');
  assert.deepEqual(await page.locator('.inline-config-field').evaluateAll(fields => fields.map(field => getComputedStyle(field).display)), ['grid', 'grid']);
  await webReading.selectOption('local');
  await waitFor(page, async () => {
    const state = await window.deepchan.load(); const conversation = state.conversations.find(c => c.id === state.selectedId);
    return conversation.branches.find(b => b.id === conversation.activeBranchId).config.webFetch === 'local';
  });
  await page.locator('.message-scroll').click({ position: { x: 12, y: 12 } });
  await page.locator('.config-popover').waitFor({ state: 'hidden' });
  await toolbar.getByRole('button', { name: '会话选项' }).click();
  await page.getByRole('combobox', { name: '系统提示词预设', exact: true }).selectOption('coding');
  await page.getByLabel('系统提示词', { exact: true }).fill('当前分支定制提示词。');
  await page.getByRole('button', { name: '关闭会话选项', exact: true }).click();
  await page.locator('.config-popover').waitFor({ state: 'hidden' });
  const networkToggle = toolbar.getByRole('button', { name: '联网', exact: true });
  assert.equal(await networkToggle.getAttribute('aria-pressed'), 'true');
  await networkToggle.click();
  await waitFor(page, async () => {
    const state = await window.deepchan.load(); const conversation = state.conversations.find(c => c.id === state.selectedId);
    const config = conversation.branches.find(b => b.id === conversation.activeBranchId).config;
    return config.search === 'off' && config.webFetch === 'off';
  });
  assert.equal(await networkToggle.getAttribute('aria-pressed'), 'false');
  await networkToggle.click();
  await waitFor(page, async () => {
    const state = await window.deepchan.load(); const conversation = state.conversations.find(c => c.id === state.selectedId);
    const config = conversation.branches.find(b => b.id === conversation.activeBranchId).config;
    return config.search === 'auto' && config.webFetch === 'auto';
  });
  assert.equal(await networkToggle.getAttribute('aria-pressed'), 'true');
  const layout = await toolbar.evaluate(el => { const text = document.querySelector('textarea[aria-label="消息输入"]').getBoundingClientRect(); const send = el.querySelector('.send-button').getBoundingClientRect(); return { textBottom: text.bottom, controlTop: el.getBoundingClientRect().top, sendLeft: send.left, controls: [...el.querySelectorAll('select')].map(s => s.getBoundingClientRect().right) }; });
  assert.ok(layout.controlTop >= layout.textBottom); assert.ok(layout.controls.every(right => right < layout.sendLeft));
  assert.equal(await page.getByText('AI 的回答可能有误，请核实重要信息。', { exact: true }).count(), 0);
  const header = await page.locator('.chat-header').evaluate(el => {
    const title = el.querySelector('.header-title > span').getBoundingClientRect();
    const model = el.querySelector('.header-title small').getBoundingClientRect();
    return { height: el.getBoundingClientRect().height, titleCenter: (title.top + title.bottom) / 2, modelCenter: (model.top + model.bottom) / 2 };
  });
  assert.equal(header.height, 48); assert.ok(Math.abs(header.titleCenter - header.modelCenter) < 2);
  const grip = page.getByRole('separator', { name: '调整输入框高度' });
  const initialHeight = (await input.boundingBox()).height, gripBox = await grip.boundingBox();
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await waitFor(page, () => document.querySelector('.composer-resize').hasPointerCapture(1));
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2 - 100, { steps: 5 }); await page.mouse.up();
  await waitFor(page, height => document.querySelector('textarea[aria-label="消息输入"]').getBoundingClientRect().height >= height + 95, initialHeight);
  await grip.focus(); await page.keyboard.press('End');
  assert.ok((await input.boundingBox()).height <= Math.min(420, page.viewportSize()?.height * 0.45 || 420) + 1);
  await page.keyboard.press('Home'); await waitFor(page, () => document.querySelector('textarea[aria-label="消息输入"]').getBoundingClientRect().height === 47);
  const composerBox = await page.locator('.composer').boundingBox();
  assert.ok(await page.evaluate(bottom => window.innerHeight - bottom < 12, composerBox.y + composerBox.height));
  await input.fill('如何设计 Linux 聊天客户端？'); await page.getByTitle('发送消息', { exact: true }).click();
  await page.locator('.message.assistant').getByText('实现思路', { exact: true }).waitFor();
  assert.equal(calls.find(c => c.path === '/v1/chat/completions').data.reasoning_effort, 'high');
  assert.equal(await page.locator('.message.assistant .answer-model-meta').first().getAttribute('aria-label'), '查看模型信息：模拟 chat');
  const uploadButton = page.getByRole('button', { name: '添加图片或附件', exact: true });
  assert.equal((await uploadButton.innerText()).trim(), '');
  assert.equal(await page.locator('.composer-bottom input[type=file]').count(), 1);
  const chatMenu = page.locator('.conversation-item').first();
  await chatMenu.getByTitle('会话操作').click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  const renameDialog = page.getByRole('dialog', { name: '重命名对话' });
  await renameDialog.getByLabel('对话标题').fill('重命名交互检查');
  await renameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await renameDialog.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.conversation-item').first().locator('.conversation-select').innerText(), '重命名交互检查');
  await page.locator('.conversation-item').first().getByTitle('会话操作').click();
  await page.locator('.conversation-popover').waitFor();
  await page.locator('.sidebar-label').click();
  await page.locator('.conversation-popover').waitFor({ state: 'hidden' });
  await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
  await waitFor(page, async () => (await window.deepchan.load()).conversations[0].titleState === 'done');
  await assertUsageDetails(page);
  await page.evaluate(async () => {
    const original = await window.deepchan.load(); const id = original.selectedId;
    const promise = window.deepchan.title(id);
    await new Promise(r => setTimeout(r, 50));
    const next = await window.deepchan.load(); const c = next.conversations.find(c => c.id === id); c.title = '用户手动标题'; c.manualTitle = true; await window.deepchan.save(next);
    await promise; window.dispatchEvent(new Event('deepchan-reload'));
    if ((await window.deepchan.load()).conversations.find(c => c.id === id).title !== '用户手动标题') throw new Error('后台标题覆盖了手动标题');
  });
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '系统提示词库' }).click();
  await page.getByLabel('角色系统提示词', { exact: true }).last().fill('角色库更新后的提示词。');
  await page.getByRole('button', { name: '添加角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).last().fill('临时角色');
  await page.getByLabel('角色系统提示词', { exact: true }).last().fill('仅用于测试删除。');
  await page.getByTitle('删除角色：临时角色', { exact: true }).click();
  await page.screenshot({ path: join(directory, 'prompt-library.png') });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.settings-page').waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(async () => { const s = await window.deepchan.load(); return s.conversations.find(c => c.id === s.selectedId).branches[0].config.system; }), '当前分支定制提示词。');
  await page.getByTitle('从此回答创建分支', { exact: true }).first().click();
  await page.locator('.branch-pill').click();
  const branchRows = page.locator('.branch-option');
  await branchRows.last().getByTitle('重命名分支').click();
  const branchRenameDialog = page.getByRole('dialog', { name: '重命名分支' });
  await branchRenameDialog.waitFor({ state: 'visible' });
  await branchRenameDialog.getByLabel('分支名称').fill('Electron 方案');
  await branchRenameDialog.getByRole('button', { name: '保存', exact: true }).click();
  await waitFor(page, async name => { const s = await window.deepchan.load(); return s.conversations.find(c => c.id === s.selectedId).branches.some(b => b.name === name); }, 'Electron 方案');
  await page.locator('.branch-popover').waitFor({ state: 'hidden' });
  await input.fill('只讨论 Electron 的实现'); await page.getByTitle('发送消息', { exact: true }).click();
  await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
  let saved = await page.evaluate(() => window.deepchan.load());
  assert.equal(saved.conversations[0].branches.length, 2);
  assert.equal(saved.settings.connections[0].apiKey, '••••••••');
  assert.equal(saved.settings.connections[0].headers['x-fixture-secret'], '••••••••');
  const c = saved.conversations[0], firstAnswer = c.messages.find(m => m.role === 'assistant');
  await page.evaluate(async ({ cid, bid }) => { const s = await window.deepchan.load(); s.conversations.find(c => c.id === cid).activeBranchId = bid; await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); }, { cid: c.id, bid: c.branches[0].id });
  await page.getByTitle('从此回答创建分支', { exact: true }).first().click();
  await input.fill('只讨论另一个方向'); await page.getByTitle('发送消息', { exact: true }).click();
  await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
  const lastChat = calls.filter(c => c.path === '/v1/chat/completions' && !JSON.stringify(c.data).includes('生成简短标题')).at(-1);
  assert.ok(!JSON.stringify(lastChat.data).includes('只讨论 Electron 的实现'));
  assert.ok(JSON.stringify(lastChat.data).includes('只讨论另一个方向'));
  await page.getByTitle('重新生成并保留旧回答', { exact: true }).last().click();
  await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
  saved = await page.evaluate(() => window.deepchan.load());
  assert.equal(saved.conversations[0].branches.length, 4);
  assert.equal(saved.conversations[0].messages.filter(m => m.parentId === firstAnswer.parentId && m.role === 'assistant').length, 1);
  // Edit an assistant without another model request, then keep chatting on its new path.
  const count = calls.length;
  await page.locator('.message.assistant').last().getByTitle('编辑为新版本').click();
  await page.locator('.edit-box textarea').fill('手动修改的回答，保留原版本。');
  await page.getByRole('button', { name: '保存新版本' }).click();
  assert.equal(calls.length, count);
  for (let i = 0; i < 2; i++) { await input.fill(`补充问题 ${i}`); await page.getByTitle('发送消息', { exact: true }).click(); await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' }); }
  await page.getByRole('button', { name: '会话选项' }).click(); await page.getByRole('button', { name: '压缩较早历史' }).click();
  await waitFor(page, async () => (await window.deepchan.load()).conversations[0].branches.some(b => b.summary));
  await page.screenshot({ path: join(directory, 'desktop.png') });
  for (const protocol of ['responses','anthropic','gemini']) {
    console.log('stage: protocol', protocol);
    const expectedCount = await page.evaluate(async () => (await window.deepchan.load()).conversations.length + 1);
    await page.getByRole('button', { name: /新建对话/ }).first().click();
    await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, expectedCount);
    const modelId = await page.evaluate(async protocol => (await window.deepchan.load()).settings.models.find(m => m.name === '模拟 ' + protocol).id, protocol);
    await page.getByRole('combobox', { name: '聊天模型' }).selectOption(modelId);
    if (protocol === 'gemini') {
      await page.getByRole('combobox', { name: '思考等级' }).selectOption('high');
      await page.evaluate(async () => { const s = await window.deepchan.load(); s.settings.titleModel = ''; await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); });
    }
    if (protocol === 'responses' || protocol === 'gemini') { await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: await page.screenshot({ type: 'png' }) }); await page.locator('.draft-attachments img').waitFor(); }
    await input.fill(`测试 ${protocol} 协议`); await page.getByTitle('发送消息', { exact: true }).click();
    await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.message.assistant .message-content').waitFor();
    await waitFor(page, async protocol => { const s = await window.deepchan.load(); return s.conversations.some(c => c.messages.some(m => m.role === 'user' && m.text === `测试 ${protocol} 协议`) && c.messages.some(m => m.role === 'assistant' && m.status === 'complete') && c.titleState === 'done'); }, protocol, { timeout: 10000 });
    if (protocol === 'gemini') {
      for (let i = 0; i < 2; i++) { await input.fill(`Gemini 后续问题 ${i}`); await page.getByTitle('发送消息', { exact: true }).click(); await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' }); }
      await page.getByRole('button', { name: '会话选项' }).click();
      await page.screenshot({ path: join(directory, 'gemini-options.png') });
      await page.getByRole('button', { name: '压缩较早历史' }).click();
      await waitFor(page, async () => { const s = await window.deepchan.load(); return s.conversations.find(c => c.id === s.selectedId).branches.some(b => b.summary); });
    }
    assert.equal(await page.locator('.header-title small').innerText(), `模拟 ${protocol} | 本地模拟 ${protocol}`);
    assert.equal(await page.locator('.message.assistant .answer-model-meta').last().getAttribute('aria-label'), `查看模型信息：模拟 ${protocol}`);
    await assertUsageDetails(page, protocol === 'gemini' ? 72 : 60);
    console.log('stage: protocol complete', protocol);
  }
  saved = await page.evaluate(() => window.deepchan.load());
  assert.equal(saved.conversations.length, 4);
  assert.equal(logs.length, 0, logs.join('\n'));
  assert.ok(saved.conversations.every(c => c.titleState === 'done'), '关闭前所有标题已完成');
  const db = readFileSync(join(directory,'chat.sqlite'));
  assert.ok(!db.includes(Buffer.from('fixture-secret'))); assert.ok(!db.includes(Buffer.from('header-secret')));
  const messageCount = saved.conversations.reduce((n,c) => n+c.messages.length,0);
  await desktop.close(); desktop = null;
  page = await launch();
  saved = await page.evaluate(() => window.deepchan.load());
  await assertUsageDetails(page, 72);
  const legacyFixture = await page.evaluate(async () => {
    const s = await window.deepchan.load(), selectedId = s.selectedId;
    const c = structuredClone(s.conversations.find(c => c.id === selectedId));
    c.id = crypto.randomUUID(); c.title = '旧消息统计测试';
    for (const m of c.messages) if (m.usage) m.usage = { input: m.usage.input, output: m.usage.output };
    s.conversations.unshift(c); s.selectedId = c.id;
    await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); return { id: c.id, selectedId };
  });
  await page.locator('.header-title > span').getByText('旧消息统计测试', { exact: true }).waitFor();
  const legacyTrigger = page.locator('.message.assistant').last().getByRole('button', { name: '查看 token 用量与速度' });
  await legacyTrigger.click();
  await waitFor(page, () => [...document.querySelectorAll('.usage-details dd')].filter(el => el.textContent === '--').length === 3);
  assert.deepEqual((await page.getByRole('tooltip').locator('dd').allTextContents()).slice(3), ['--','--']);
  assert.equal((await page.getByRole('tooltip').locator('dd').allTextContents())[1], '--');
  await page.keyboard.press('Escape');
  await page.evaluate(async fixture => { const s = await window.deepchan.load(); s.conversations = s.conversations.filter(c => c.id !== fixture.id); s.selectedId = fixture.selectedId; await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); }, legacyFixture);
  assert.equal(saved.conversations.reduce((n,c) => n+c.messages.length,0), messageCount);
  assert.equal(saved.settings.connections[0].apiKey, '••••••••');
  assert.equal(saved.settings.connections[0].headers['x-fixture-secret'], '••••••••');
  const credentialsPath = join(directory, 'credentials.json');
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  assert.equal(credentials.secrets[saved.settings.connections[0].id], 'fixture-secret');
  assert.equal(credentials.secrets.firecrawl, 'firecrawl-fixture-secret');
  assert.equal(credentials.secrets.anysearch, 'anysearch-fixture-secret');
  assert.equal(saved.settings.firecrawlKey, '••••••••'); assert.equal(saved.settings.anysearchKey, '••••••••');
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
  await page.evaluate(async () => { const s = await window.deepchan.load(); await window.deepchan.test(s.settings.connections[0]); });
  assert.equal(lastAuthorization, 'Bearer fixture-secret');
  const nativeRequest = calls.find(c => c.path === '/v1/responses');
  assert.ok(nativeRequest.data.tools.some(t => t.type === 'web_search'), '默认启用原生搜索');
  assert.ok(saved.conversations.every(c => c.titleState === 'done'), '完成的标题应在重启后恢复');
  assert.equal(saved.conversations.find(c => c.branches.length > 1).branches.length, 5);
  const geminiRequest = calls.find(c => c.path.startsWith('/v1beta/models/') && c.data.tools);
  assert.equal(geminiRequest.data.generationConfig.thinkingConfig.thinkingLevel, 'HIGH');
  assert.ok(geminiRequest.data.tools.some(t => t.googleSearch));
  assert.ok(geminiRequest.data.contents.some(c => c.parts.some(p => p.inlineData)));
  assert.ok(saved.settings.promptPresets.some(p => p.name === '测试研究助手' && p.content === '角色库更新后的提示词。'), '编辑后的角色库应在重启后恢复');
  assert.ok(!saved.settings.promptPresets.some(p => p.name === '临时角色'));
  const geminiCalls = calls.filter(c => c.path.startsWith('/v1beta/models/'));
  assert.ok(geminiCalls.some(c => c.data.systemInstruction.parts[0].text.includes('生成简短标题')), 'Gemini 应支持自动标题');
  assert.ok(geminiCalls.some(c => c.data.systemInstruction.parts[0].text.includes('压缩为')), 'Gemini 应支持历史压缩');
  assert.ok(geminiCalls.some(c => c.data.contents.some(m => m.role === 'model' && m.parts.some(p => p.thoughtSignature === 'fixture-signature'))), 'Gemini 多轮请求应保留思考签名');
  const branched = saved.conversations.find(c => c.branches.length > 1);
  assert.equal(branched.branches[0].config.system, '当前分支定制提示词。');
  console.log('stage: validation complete');
  console.log(`PASS: Electron desktop, 4 protocols including native Gemini, prompt preset library, auto title, branch isolation, regeneration, manual edits, compression, connection presets, compact header, resizable composer, bottom toolbar, reasoning levels, default search, local credentials, answer dates, hover/click usage metrics and restart recovery. Screenshot: ${join(directory,'desktop.png')}`);
} finally {
  if (desktop) { await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {}); await desktop.close().catch(() => {}); } server.close(); if (vite) await vite.close();
  // Keep the temporary fixture and screenshot for inspection, never mix with user data.
}
