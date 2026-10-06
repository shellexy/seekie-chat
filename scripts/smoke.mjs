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
  if (req.method === 'GET') { lastAuthorization = req.headers.authorization || '';  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
  const data = JSON.parse(body); calls.push({ path: req.url, data });
  const title = (data.instructions || data.system || data.messages?.[0]?.content || '').includes('生成简短标题');
  const compression = (data.instructions || data.system || data.messages?.[0]?.content || '').includes('压缩为');
  const text = title ? '桌面聊天客户端设计' : compression ? '目标：实现 Linux 聊天客户端。保留分支上下文，使用 Electron。' : `这是本地模拟 API 的回答 ${calls.filter(c => !JSON.stringify(c.data).includes('生成简短标题')).length}。\n\n## 实现思路\n\n先完成三栏布局，再连接模型。每个分支只发送自己的上下文。\n\n- **Electron** 提供桌面窗口\n- SQLite 保存对话与分支\n\n\`\`\`ts\nconst branch = createBranch(answer);\n\`\`\``;
  if (title) await new Promise(r => setTimeout(r, 250));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  if (req.url === '/v1/chat/completions') {
    send({ choices: [{ delta: { reasoning_content: title || compression ? '' : '先检查需求，再选择实施步骤。' } }] });
    for (const part of text.match(/.{1,22}|\n/g)) { send({ choices: [{ delta: { content: part } }] }); await new Promise(r => setTimeout(r, 2)); }
    send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 60 } });
  } else if (req.url === '/v1/responses') {
    send({ type: 'response.reasoning_summary_text.delta', delta: '推理摘要来自模拟服务。' });
    send({ type: 'response.web_search_call.in_progress', item_id: 'search-1' });
    send({ type: 'response.web_search_call.completed', item_id: 'search-1' });
    send({ type: 'response.output_text.delta', delta: text });
    send({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', title: 'Electron documentation', url: 'https://www.electronjs.org/docs' }] }] }], usage: { input_tokens: 120, output_tokens: 60 } } });
  } else {
    send({ type: 'message_start', message: { usage: { input_tokens: 120 } } });
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
let desktop;
const logs = [];
async function launch() {
  console.log('stage: launch');
  desktop = await electron.launch({ executablePath: electronPath, args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const page = await desktop.firstWindow(); page.on('pageerror', e => logs.push(e.message));
  await page.getByText('DeepChan-chat', { exact: true }).waitFor(); return page;
}
try {
  let page = await launch();
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()[1]), 720);
  console.log('stage: connection presets');
  await page.locator('.settings-entry').click();
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
  await page.getByLabel('模型 ID', { exact: true }).fill('custom-fixture');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.settings-page').waitFor({ state: 'hidden' });
  const presets = await page.evaluate(() => window.deepchan.load());
  assert.equal(presets.settings.models.find(m => m.model === 'deepseek-flash').nativeSearch, true);
  // Verify that the connection's defaults survive save/reopen and renaming.
  await page.locator('.settings-entry').click();
  await page.locator('.connection-tabs').getByRole('button', { name: '重命名的兼容服务', exact: true }).click();
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  assert.deepEqual(await page.getByLabel(/^思考参数/).evaluateAll(els => els.map(el => el.value)), ['effort', 'effort']);
  await page.getByTitle('返回聊天', { exact: true }).click();
  await page.evaluate(async baseUrl => {
    const state = await window.deepchan.load();
    const connections = ['chat','responses','anthropic'].map(protocol => ({ id: crypto.randomUUID(), name: '本地模拟 ' + protocol, protocol, baseUrl, apiKey: 'fixture-secret', headers: { 'x-fixture-secret': 'header-secret' }, timeout: 30, proxy: '' }));
    state.settings.connections = connections;
    state.settings.models = connections.map(c => ({ id: crypto.randomUUID(), connectionId: c.id, name: '模拟 ' + c.protocol, model: 'fixture', contextWindow: 128000, maxOutput: 4096, vision: true, tools: true, nativeSearch: c.protocol !== 'chat', reasoning: c.protocol === 'chat' ? 'effort' : 'none', efforts: ['low','medium','high'], temperature: false }));
    state.settings.defaultModel = state.settings.models[0].id;
    state.settings.titleModel = state.settings.models[0].id;
    await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
  }, baseUrl);
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  const input = page.getByRole('textbox', { name: '消息输入' });
  await page.getByRole('combobox', { name: '思考等级' }).selectOption('high');
  const toolbar = page.locator('.composer-bottom');
  assert.equal(await toolbar.getByRole('combobox', { name: '聊天模型' }).count(), 1);
  assert.equal(await toolbar.getByRole('combobox', { name: '思考等级' }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '会话选项' }).count(), 1);
  await toolbar.getByRole('button', { name: '会话选项' }).click();
  await page.getByRole('button', { name: '关闭会话选项', exact: true }).click();
  await page.locator('.config-popover').waitFor({ state: 'hidden' });
  assert.equal(await toolbar.getByRole('button', { name: '联网搜索' }).getAttribute('aria-pressed'), 'true');
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
  await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
  await waitFor(page, async () => (await window.deepchan.load()).conversations[0].titleState === 'done');
  await page.evaluate(async () => {
    const original = await window.deepchan.load(); const id = original.selectedId;
    const promise = window.deepchan.title(id);
    await new Promise(r => setTimeout(r, 50));
    const next = await window.deepchan.load(); const c = next.conversations.find(c => c.id === id); c.title = '用户手动标题'; c.manualTitle = true; await window.deepchan.save(next);
    await promise; window.dispatchEvent(new Event('deepchan-reload'));
    if ((await window.deepchan.load()).conversations.find(c => c.id === id).title !== '用户手动标题') throw new Error('后台标题覆盖了手动标题');
  });
  await page.getByTitle('从此回答创建分支', { exact: true }).first().click();
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
  for (const protocol of ['responses','anthropic']) {
    console.log('stage: protocol', protocol);
    const expectedCount = await page.evaluate(async () => (await window.deepchan.load()).conversations.length + 1);
    await page.getByRole('button', { name: /新建对话/ }).first().click();
    await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, expectedCount);
    const modelId = await page.evaluate(async protocol => (await window.deepchan.load()).settings.models.find(m => m.name === '模拟 ' + protocol).id, protocol);
    await page.getByRole('combobox', { name: '聊天模型' }).selectOption(modelId);
    if (protocol === 'responses') { await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: await page.screenshot({ type: 'png' }) }); await page.locator('.draft-attachments img').waitFor(); }
    await input.fill(`测试 ${protocol} 协议`); await page.getByTitle('发送消息', { exact: true }).click();
    await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.message.assistant .message-content').waitFor();
    await waitFor(page, async protocol => { const s = await window.deepchan.load(); return s.conversations.some(c => c.messages.some(m => m.role === 'user' && m.text === `测试 ${protocol} 协议`) && c.messages.some(m => m.role === 'assistant' && m.status === 'complete') && c.titleState === 'done'); }, protocol, { timeout: 10000 });
    console.log('stage: protocol complete', protocol);
  }
  saved = await page.evaluate(() => window.deepchan.load());
  assert.equal(saved.conversations.length, 3);
  assert.equal(logs.length, 0, logs.join('\n'));
  assert.ok(saved.conversations.every(c => c.titleState === 'done'), '关闭前所有标题已完成');
  const db = readFileSync(join(directory,'chat.sqlite'));
  assert.ok(!db.includes(Buffer.from('fixture-secret'))); assert.ok(!db.includes(Buffer.from('header-secret')));
  const messageCount = saved.conversations.reduce((n,c) => n+c.messages.length,0);
  await desktop.close(); desktop = null;
  page = await launch();
  saved = await page.evaluate(() => window.deepchan.load());
  assert.equal(saved.conversations.reduce((n,c) => n+c.messages.length,0), messageCount);
  assert.equal(saved.settings.connections[0].apiKey, '••••••••');
  assert.equal(saved.settings.connections[0].headers['x-fixture-secret'], '••••••••');
  const credentialsPath = join(directory, 'credentials.json');
  const credentials = JSON.parse(readFileSync(credentialsPath, 'utf8'));
  assert.equal(credentials.secrets[saved.settings.connections[0].id], 'fixture-secret');
  assert.equal(statSync(credentialsPath).mode & 0o777, 0o600);
  await page.evaluate(async () => { const s = await window.deepchan.load(); await window.deepchan.test(s.settings.connections[0]); });
  assert.equal(lastAuthorization, 'Bearer fixture-secret');
  const nativeRequest = calls.find(c => c.path === '/v1/responses');
  assert.ok(nativeRequest.data.tools.some(t => t.type === 'web_search'), '默认启用原生搜索');
  assert.ok(saved.conversations.every(c => c.titleState === 'done'), '完成的标题应在重启后恢复');
  assert.equal(saved.conversations.find(c => c.branches.length > 1).branches.length, 5);
  console.log('stage: validation complete');
  console.log(`PASS: Electron desktop, 3 protocols, auto title, branch isolation, regeneration, manual edits, compression, connection presets, compact header, resizable composer, bottom toolbar, reasoning levels, default search, local credentials and restart recovery. Screenshot: ${join(directory,'desktop.png')}`);
} finally {
  if (desktop) { await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {}); await desktop.close().catch(() => {}); } server.close(); if (vite) await vite.close();
  // Keep the temporary fixture and screenshot for inspection, never mix with user data.
}
