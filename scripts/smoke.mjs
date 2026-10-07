import { _electron as electron } from 'playwright';
import { createServer as createViteServer } from 'vite';
import electronPath from 'electron';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const directory = mkdtempSync(join(tmpdir(), 'deepchan-smoke-'));
const calls = []; let lastAuthorization = '';
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  if (req.method === 'GET') { lastAuthorization = req.headers.authorization || '';  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.url.startsWith('/v1beta/models') ? { models: [{ name: 'models/fixture-model', supportedGenerationMethods: ['generateContent'] }] } : { data: [
      { id: 'fixture-model' },
      // A service that describes its models, in the shape DeepSeek documents.
      { id: 'gpt-4o', name: 'GPT-4o', context_window: 128_000, max_output_tokens: 16_384, input_modalities: ['text', 'image'], output_modalities: ['text'], effort: { supported_levels: ['low', 'medium', 'high'], default_level: 'high' } },
      { id: 'deepseek-flash' }
    ] })); return; }
  const data = JSON.parse(body); calls.push({ path: req.url, data });
  const title = (data.instructions || data.system || data.systemInstruction?.parts?.[0]?.text || data.messages?.[0]?.content || '').includes('生成简短标题');
  const compression = (data.instructions || data.system || data.systemInstruction?.parts?.[0]?.text || data.messages?.[0]?.content || '').includes('压缩为');
  const text = title ? '桌面聊天客户端设计' : compression ? '目标：实现 Linux 聊天客户端。保留分支上下文，使用 Electron。' : `这是本地模拟 API 的回答 ${calls.filter(c => !JSON.stringify(c.data).includes('生成简短标题')).length}。\n\n## 实现思路\n\n先完成三栏布局，再连接模型。每个分支只发送自己的上下文。\n\n- **Electron** 提供桌面窗口\n- SQLite 保存对话与分支\n\n\`\`\`ts\nconst branch = createBranch(answer);\n\`\`\``;
  if (title) await new Promise(r => setTimeout(r, 250));
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  // Responses 协议的服务（DeepSeek 就是这样）每帧先写一行 event: 再写 data:，解析器要能跳过
  // 前者，所以这一支按真实格式发。
  const sendEvent = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  if (req.url === '/v1/chat/completions') {
    // 模型可以先请求工具再给正文；工具调用是模型的第一个输出。用本地 datetime，不需要网络。
    const wantsToolFirst = JSON.stringify(data.messages).includes('先问时间') && !JSON.stringify(data.messages).includes('"role":"tool"');
    if (wantsToolFirst) {
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'clock-1', type: 'function', function: { name: 'datetime', arguments: '{}' } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      // 工具优先那个场景第二轮不出推理：否则推理会先于正文落下计时，看不出工具调用算不算输出。
      const toolScenario = JSON.stringify(data.messages).includes('先问时间');
      if (!toolScenario) send({ choices: [{ delta: { reasoning_content: title || compression ? '' : '先检查需求，再选择实施步骤。' } }] });
      await new Promise(r => setTimeout(r, 30));
      const pieces = text.match(/.{1,22}|\n/g);
      for (const [index, part] of pieces.entries()) {
        send({ choices: [{ delta: { content: part } }] });
        // Pause after the first piece so the 80ms broadcast happens while the answer is still running:
        // that is what makes the incremental patch observable in the smoke.
        await new Promise(r => setTimeout(r, index === 0 && !title && !compression ? 200 : 2));
      }
      send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 120, completion_tokens: 60, prompt_tokens_details: { cached_tokens: 30 } } });
    }
  } else if (req.url === '/v1/responses') {
    // 两种思维链事件名都要覆盖：OpenAI 发 reasoning_summary_text.delta（摘要），DeepSeek 的
    // Responses 接口发 reasoning_text.delta（思维链原文）。
    sendEvent({ type: 'response.reasoning_summary_text.delta', delta: '推理摘要来自模拟服务。' });
    sendEvent({ type: 'response.reasoning_text.delta', delta: '思维链原文。' });
    sendEvent({ type: 'response.web_search_call.in_progress', item_id: 'search-1' });
    sendEvent({ type: 'response.web_search_call.completed', item_id: 'search-1' });
    sendEvent({ type: 'response.output_text.delta', delta: text });
    sendEvent({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [{ type: 'url_citation', title: 'Electron documentation', url: 'https://www.electronjs.org/docs' }] }] }], usage: { input_tokens: 120, output_tokens: 60, input_tokens_details: { cached_tokens: 30 } } } });
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
// The model selector is a drawn listbox rather than a native select, so choosing a model means
// opening it and clicking a row. The option reads "name | connection", so match on the model name
// only; .first() because a favourited model is listed in more than one section.
async function pickModel(page, name) {
  await page.getByRole('button', { name: '聊天模型' }).first().click();
  await page.locator('.model-select-popover').waitFor();
  await page.locator('.model-select-popover').getByRole('option', { name }).first().click();
  await page.locator('.model-select-popover').waitFor({ state: 'hidden' });
}
async function lengthenActiveHistory(page) {
  return await page.evaluate(async () => {
    const state = await window.deepchan.load();
    const conversation = state.conversations.find(c => c.id === state.selectedId);
    const branch = conversation.branches.find(b => b.id === conversation.activeBranchId);
    const messages = new Map(conversation.messages.map(message => [message.id, message]));
    const originalLeaf = branch.leafId;
    const path = []; let id = branch.leafId;
    while (id) { const message = messages.get(id); path.unshift(message); id = message.parentId; }
    const longText = role => `${role === 'user' ? '用户设定：' : '助手整理：'}${'角色名、世界规则、关系与当前剧情。'.repeat(1600)}`;
    const model = state.settings.models.find(m => m.id === branch.config.modelId);
    const protocol = state.settings.connections.find(c => c.id === model?.connectionId)?.protocol;
    for (const message of path) message.text = longText(message.role);
    let userTurns = path.filter(message => message.role === 'user').length;
    const additionalTurns = Math.max(2, 4 - userTurns);
    for (let turn = 0; turn < additionalTurns; turn++) {
      const user = { id: crypto.randomUUID(), parentId: branch.leafId, role: 'user', text: longText('user'), reasoning: '', attachments: [], tools: [], sources: [], status: 'complete', created: Date.now() };
      const answer = { id: crypto.randomUUID(), parentId: user.id, role: 'assistant', text: longText('assistant'), reasoning: '', attachments: [], tools: [], sources: [], status: 'complete', modelId: branch.config.modelId, usage: { input: 120, output: protocol === 'gemini' ? 72 : 60, cachedInput: 30, elapsedMs: 1000, firstTokenMs: 100 }, created: Date.now() };
      conversation.messages.push(user, answer); branch.leafId = answer.id; userTurns++;
    }
    await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
    const persisted = await window.deepchan.load(), persistedConversation = persisted.conversations.find(c => c.id === state.selectedId), persistedBranch = persistedConversation.branches.find(b => b.id === branch.id);
    const persistedMessages = new Map(persistedConversation.messages.map(message => [message.id, message])); let persistedTurns = 0, persistedId = persistedBranch.leafId;
    while (persistedId) { const message = persistedMessages.get(persistedId); if (message.role === 'user') persistedTurns++; persistedId = message.parentId; }
    return { selectedId: state.selectedId, conversationId: conversation.id, branchId: branch.id, originalLeaf, userTurns, persistedTurns, leafId: branch.leafId, persistedLeaf: persistedBranch.leafId };
  });
}
async function assertUsageDetails(page, output = 60) {
  const answer = page.locator('.message.assistant').last();
  const id = await answer.getAttribute('data-id');
  const message = await page.evaluate(async id => (await window.deepchan.load()).conversations.flatMap(c => c.messages).find(m => m.id === id), id);
  assert.equal(message.usage.input, 120); assert.equal(message.usage.output, output); assert.equal(message.usage.cachedInput, 30);
  assert.ok(message.usage.elapsedMs > 0); assert.ok(message.usage.firstTokenMs >= 0 && message.usage.firstTokenMs <= message.usage.elapsedMs);
  // Model, connection, time and usage now share one control and one popover.
  const trigger = answer.getByRole('button', { name: /^查看回答详情：/ });
  assert.match(await trigger.innerText(), /^.+·\d{4}-\d{2}-\d{2} \d{2}:\d{2} · [\d,]+ 输入 · [\d,]+ 输出$/);
  const tooltip = page.getByRole('tooltip');
  // 期望值先算好：悬浮层会被任何一次滚动关掉，读的时候不能夹在中间做耗时的 IPC。
  const expected = await page.evaluate(async id => {
    const s = await window.deepchan.load(), m = s.conversations.flatMap(c => c.messages).find(x => x.id === id);
    const model = s.settings.models.find(x => x.id === m?.modelId);
    return {
      effort: model?.reasoning === 'effort' ? (m?.config?.effort || '') : '',
      role: s.settings.promptPresets.find(p => p.content === m?.config?.system)?.name || ''
    };
  }, id);
  // The popover opens on a short hover delay; retry once in case the pointer entered mid-render.
  await trigger.hover();
  try { await tooltip.waitFor({ timeout: 2000 }); } catch { await trigger.hover(); await tooltip.waitFor(); }
  // 一次读齐：两次读取之间弹层可能被滚动关掉。
  // innerText 而非 textContent：后者把相邻的 p 直接拼在一起、不留换行。
  const meta = await tooltip.evaluate(el => ({ block: el.querySelector('.answer-meta-block')?.innerText || '', lines: [...el.querySelectorAll('.answer-meta-block p')].map(p => p.innerText || '') }));
  const metaBlock = meta.block;
  assert.match(metaBlock, /模拟 .+\s+本地模拟 .+[\s\S]*\d{4}-\d{2}-\d{2} \d{2}:\d{2}/, '详情块应有模型名、连接名与时间');
  // 连接名之后补上这条回答自己的思考等级与角色预设名。两项都按这条回答记下的东西算：思考
  // 等级只有按等级配置的模型才有，角色预设名按提示词内容匹配，都认不出就不显示。
  if (expected.effort) { assert.match(metaBlock, new RegExp(`思考等级：${expected.effort}`), '详情块应显示这条回答用的思考等级'); assert.ok(metaBlock.indexOf('思考等级') > metaBlock.indexOf('本地模拟'), '思考等级应排在连接名之后'); }
  else assert.doesNotMatch(metaBlock, /思考等级：/, '不用思考等级的模型不应显示思考等级');
  if (expected.role) { assert.match(metaBlock, new RegExp(`角色预设：${expected.role}`), '详情块应显示这条回答用的角色预设名'); assert.ok(metaBlock.indexOf('角色预设') > metaBlock.indexOf('思考等级') || !expected.effort, '角色预设名应排在思考等级之后'); }
  else assert.doesNotMatch(metaBlock, /角色预设：/, '自定义提示词不应显示角色预设名');
  if (expected.effort && expected.role) {
    // 思考等级与角色预设名排在同一行。
    assert.equal(meta.lines.filter(line => line.includes('思考等级') && line.includes('角色预设')).length, 1, `思考等级与角色预设名应在同一行，实际分行：${JSON.stringify(meta.lines)}`);
  }
  assert.deepEqual(await tooltip.locator('dt').allTextContents(), ['输入：','输入（缓存）：','输出：','总耗时：','速度：','生成速度：','首个输出：','首字耗时：']);
  const values = await tooltip.locator('dd').allTextContents();
  assert.deepEqual(values.slice(0, 3), ['120 token','30 token',`${output} token`]);
  assert.equal(values[3], `${(message.usage.elapsedMs / 1000).toFixed(2)} s`);
  assert.equal(values[4], `${(output / ((message.usage.generationMs ?? message.usage.elapsedMs) / 1000)).toFixed(1)} tps`);
  // 生成速度：生成耗时再减去首字耗时。
  // 生成速度扣掉的是模型第一个输出之前的等待；推理也算输出，所以不能扣首字耗时。
  const generationMs = message.usage.generationMs ?? message.usage.elapsedMs;
  const firstOutput = message.usage.firstOutputMs ?? message.usage.firstTokenMs;
  const generationOnly = generationMs - firstOutput;
  assert.equal(values[5], generationOnly > 0 ? `${(output / (generationOnly / 1000)).toFixed(1)} tps` : '--', '生成速度应扣除首个输出之前的等待');
  assert.equal(values[6], `${(firstOutput / 1000).toFixed(2)} s`, '首个输出应是模型开始出 token 的时刻');
  assert.equal(values[7], `${(message.usage.firstTokenMs / 1000).toFixed(2)} s`);
  // 模型先思考时，"首个输出"应早于"正文首字"——两者不是一回事，生成速度用的是前者。
  if (message.reasoning) assert.ok(message.usage.firstOutputMs < message.usage.firstTokenMs, `首个输出应早于正文首字，实际 ${message.usage.firstOutputMs} vs ${message.usage.firstTokenMs}`);
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
// 删除角色、重置预设角色等操作会先弹确认框；测试要能分别验证"确认"与"取消"两条路。
let acceptDialogs = true;
async function launch() {
  console.log('stage: launch');
  desktop = await electron.launch({ executablePath: electronPath, args: ['.'], cwd: process.cwd(), env, timeout: 30000 });
  const page = await desktop.firstWindow(); page.on('pageerror', e => logs.push(e.message));
  // 只有角色相关的确认框接受，其余（删除连接、删除分支、删除会话）保持 Playwright 原先的
  // 默认拒绝，免得把测试没打算执行的破坏性操作放行。
  page.on('dialog', dialog => { if (acceptDialogs && /角色/.test(dialog.message())) void dialog.accept(); else void dialog.dismiss(); });
  await page.locator('.window-controls').waitFor(); return page;
}
try {
  let page = await launch();
  // Records the wire while answers stream: the main process must send patches (one message) rather
  // than a full state, and the revisions must increase.
  await page.evaluate(() => { window.__patches = []; window.deepchan.onEvent(event => { if (event.patch) window.__patches.push({ revision: event.patch.message.streamRevision, length: event.patch.message.text.length }); }); });
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
  const titleRows = await page.evaluate(() => ({ sidebar: document.querySelector('.sidebar-top')?.getBoundingClientRect().height, chat: document.querySelector('.chat-header')?.getBoundingClientRect().height, controls: document.querySelector('.window-controls')?.getBoundingClientRect().height }));
  assert.equal(titleRows.sidebar, titleRows.controls, '对话列表顶栏与窗口控件等高');
  assert.equal(titleRows.chat, titleRows.controls, '聊天顶栏与窗口控件等高');
  // 侧栏顶栏按设计不显示图标（.brand-mark 未渲染），新建对话页才用线稿图标。
  assert.equal(await page.locator('.brand-mark').count(), 0, '侧栏顶栏不显示图标');
  const welcome = page.locator('.welcome-icon');
  if (await welcome.count()) {
    assert.match(await welcome.evaluate(el => el.style.getPropertyValue('--welcome-mask')), /welcome-icon-[^)]*\.png/, '线稿应是 Vite 打包后的哈希资源');
    assert.equal(await welcome.evaluate(el => el.getBoundingClientRect().width), 128);
    // 线稿的颜色必须与所在背景分得开：白底转透明后只剩线条，配色一旦选成和底色接近就会
    // 整个消失。accent 是主题无关的品牌蓝，两种主题下都要达到图形元素的 3:1。
    const contrast = (a, b) => {
      const lum = color => { const [r, g, bl] = color.match(/[\d.]+/g).map(Number); const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl); };
      const l1 = lum(a), l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const previousTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    for (const theme of ['light', 'dark']) {
      const colors = await page.evaluate(async t => {
        document.documentElement.dataset.theme = t;
        const el = document.querySelector('.welcome-icon');
        return { ink: getComputedStyle(el).backgroundColor, bg: getComputedStyle(document.body).backgroundColor };
      }, theme);
      const ratio = contrast(colors.ink, colors.bg);
      assert.ok(ratio >= 3, `${theme} 主题下线稿与背景的对比度不应低于 3:1，实际 ${ratio.toFixed(2)}:1（墨色 ${colors.ink} 背景 ${colors.bg}）`);
    }
    await page.evaluate(t => { document.documentElement.dataset.theme = t; }, previousTheme);
  }
  assert.equal(await page.locator('.local-note').count(), 0, '隐藏侧栏底部本地保存提示');
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()[1]), 720);
  console.log('stage: connection presets');
  await page.getByRole('button', { name: /^设置/ }).click();
  const settingsControls = page.getByRole('toolbar', { name: '窗口控件' });
  assert.equal(await settingsControls.count(), 1);
  const settingsControlBounds = await settingsControls.boundingBox();
  const settingsViewportWidth = await page.evaluate(() => innerWidth);
  assert.equal(settingsControlBounds.y, 0);
  assert.ok(Math.abs(settingsControlBounds.x + settingsControlBounds.width - settingsViewportWidth) < 1);
  // “DeepSeek” 排在最前且使用 OpenAI 兼容协议；只有 Anthropic 预设才带原生搜索。
  assert.equal(await page.locator('.preset-row button').first().innerText(), 'DeepSeek');
  assert.deepEqual(await page.locator('.preset-row button').allTextContents(), ['DeepSeek', 'DeepSeek · Anthropic', 'OpenAI', 'OpenRouter', 'Anthropic', 'Gemini', 'Ollama', 'Ollama Cloud', '自定义兼容服务']);
  for (const theme of ['light', 'dark', 'system']) {
    assert.equal(await page.evaluate(theme => { document.documentElement.dataset.theme = theme; return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(); }, theme), '#3c64fe');
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.locator('.preset-row').getByRole('button', { name: 'DeepSeek', exact: true }).click();
  assert.equal(await page.getByLabel('连接名称', { exact: true }).inputValue(), 'DeepSeek');
  // 禁用开关：可逆、无确认，停用后标签变淡带点，模型不再出现在选择器里。
  const deepseekTab = page.locator('.connection-tabs button', { hasText: 'DeepSeek' });
  assert.equal(await page.getByRole('button', { name: '禁用连接' }).count(), 1, '删除按钮右侧应有禁用开关');
  await page.getByRole('button', { name: '禁用连接' }).click();
  assert.equal(await page.locator('.connection-tabs button.stopped', { hasText: 'DeepSeek' }).count(), 1, '停用的连接标签应变淡并带点');
  assert.equal(await deepseekTab.getAttribute('title'), 'DeepSeek（已禁用）');
  assert.equal(await page.locator('.stopped-dot').count(), 1);
  assert.equal(await page.getByRole('button', { name: '启用连接' }).count(), 1, '停用后按钮应变为启用');
  await page.getByRole('button', { name: '启用连接' }).click();
  assert.equal(await page.locator('.connection-tabs button.stopped').count(), 0, '重新启用后不应再有停用标记');
  assert.equal(await page.getByLabel('连接名称', { exact: true }).evaluate(el => getComputedStyle(el.parentElement).display), 'grid', '连接名称与输入框并排');
  assert.equal(await page.getByLabel(/^接口协议/).evaluate(el => getComputedStyle(el.parentElement).display), 'grid', '接口协议标签与选项并排');
  assert.equal(await page.getByLabel(/^接口协议/).inputValue(), 'chat', 'DeepSeek 预设默认走 OpenAI 兼容协议');
  assert.equal(await page.getByLabel(/^Base URL/).inputValue(), 'https://api.deepseek.com/');
  assert.equal(await page.getByLabel('展示名称', { exact: true }).inputValue(), 'deepseek-flash');
  assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'deepseek-flash');
  // 与服务端 /models 报告的值一致：1048576 / 393216（384K）。
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1048576');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '393216');
  // Ollama 的 gemma4 只认思考等级：改用思考预算会导致完全不思考，也看不到思考摘要。
  await page.locator('.preset-row').getByRole('button', { name: 'Ollama Cloud', exact: true }).click();
  const gemmaCard = page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: 'gemma4:31b' }) }).last();
  assert.equal(await gemmaCard.getByLabel('展示名称', { exact: true }).inputValue(), 'gemma4:31b');
  // 包裹式 label 会把 select 的选项文本也算进可访问名，所以只能用正则前缀匹配。
  assert.equal(await gemmaCard.getByLabel(/^思考参数/).inputValue(), 'effort', 'gemma4 必须使用思考等级，改成思考预算就不思考了');
  await page.locator('.preset-row').getByRole('button', { name: 'DeepSeek', exact: true }).click();
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  for (const name of ['图片输入', '工具调用']) assert.equal(await page.getByLabel(name, { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('原生搜索', { exact: true }).isChecked(), false, 'OpenAI 兼容协议不提供服务端原生搜索');
  // Anthropic 预设保留，仍带原生搜索。
  await page.locator('.preset-row').getByRole('button', { name: 'DeepSeek · Anthropic', exact: true }).click();
  assert.equal(await page.getByLabel(/^接口协议/).inputValue(), 'anthropic');
  assert.equal(await page.getByLabel(/^Base URL/).inputValue(), 'https://api.deepseek.com/anthropic');
  assert.equal(await page.getByLabel('原生搜索', { exact: true }).isChecked(), true, 'Anthropic 协议提供服务端原生搜索');
  await page.locator('.preset-row').getByRole('button', { name: 'DeepSeek', exact: true }).click();
  await page.locator('.preset-row').getByRole('button', { name: '自定义兼容服务', exact: true }).click();
  await page.getByLabel('连接名称', { exact: true }).fill('重命名的兼容服务');
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '65536');
  await page.getByLabel('模型 ID', { exact: true }).fill('custom-fixture');
  // “GPT 模型自动使用 Responses 协议”只在 OpenAI 兼容协议下出现。
  await page.locator('.preset-row').getByRole('button', { name: 'OpenAI', exact: true }).click();
  assert.equal(await page.getByLabel(/^接口协议/).inputValue(), 'responses', 'OpenAI 预设默认走 Responses 协议');
  assert.equal(await page.getByLabel('GPT 模型自动使用 Responses 协议').count(), 0, 'Responses 协议下不显示该选项');
  await page.locator('.preset-row').getByRole('button', { name: '自定义兼容服务', exact: true }).click();
  assert.equal(await page.getByLabel(/^接口协议/).inputValue(), 'chat');
  const gptOption = page.getByLabel('GPT 模型自动使用 Responses 协议');
  assert.equal(await gptOption.count(), 1, 'OpenAI 兼容协议下应显示该选项');
  assert.equal(await gptOption.isChecked(), true, '默认开启');
  await gptOption.uncheck();
  assert.equal(await gptOption.isChecked(), false, '可以关掉');
  await gptOption.check();
  await page.locator('.preset-row').getByRole('button', { name: 'OpenAI', exact: true }).click();
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '65536');
  await page.getByLabel('模型 ID', { exact: true }).fill('responses-fixture');
  await page.getByLabel(/^Base URL/).fill(baseUrl);
  // The fetched list opens in an in-app dialog; models are ticked and added from there.
  // `fetched` means a model-list request was just started: it opens the dialog itself, so waiting for
  // it is both correct and race-free (clicking the reopen button could meet the arriving backdrop).
  const addServerModel = async (id, { fetched = false } = {}) => {
    const dialog = page.getByRole('dialog', { name: '添加服务端模型' });
    if (fetched) await dialog.waitFor({ state: 'visible' });
    else { await page.getByRole('button', { name: '从服务端列表添加模型…' }).click(); await dialog.waitFor({ state: 'visible' }); }
    await page.getByLabel(`选择模型 ${id}`).check();
    await page.getByRole('button', { name: /^添加所选/ }).click();
    await dialog.waitFor({ state: 'hidden' });
  };
  await page.getByRole('button', { name: '测试连接 / 获取模型', exact: true }).click();
  await page.getByRole('dialog', { name: '添加服务端模型' }).waitFor();
  await page.screenshot({ path: join(directory, 'model-picker.png') });
  // The dialog shows what the service described, and the description becomes the new model's defaults.
  const describedRow = page.locator('.model-picker-row', { hasText: 'GPT-4o' });
  const describedFacts = await describedRow.innerText();
  for (const fact of ['上下文 128,000', '输出上限 16,384', '输入 text / image', '输出 text', '思考 low / medium / high（默认 high）']) assert.ok(describedFacts.includes(fact), `对话框应显示「${fact}」，实际：${describedFacts}`);
  assert.match(await page.locator('.model-picker-row', { hasText: 'fixture-model' }).innerText(), /服务端未提供更多信息/);
  // 列表上方的搜索框：按展示名与 ID 都能过滤，并显示匹配数。
  const modelSearch = page.getByLabel('搜索模型', { exact: true });
  assert.equal(await modelSearch.count(), 1, '模型列表上方应有搜索框');
  const allRows = await page.locator('.model-picker-row').count();
  await modelSearch.fill('gpt');
  const gptRows = await page.locator('.model-picker-row').count();
  assert.ok(gptRows > 0 && gptRows < allRows, `搜索应缩小结果范围：${gptRows} / ${allRows}`);
  assert.equal(await page.locator('.model-picker-row', { hasText: 'GPT-4o' }).count(), 1, '按 ID 或展示名都应命中');
  assert.equal(await page.locator('.model-picker-row', { hasText: 'fixture-model' }).count(), 0, '不匹配的模型应被过滤掉');
  assert.match(await page.locator('.model-picker-search').innerText(), new RegExp(`显示 ${gptRows} / ${allRows} 个`), '应显示匹配数');
  await modelSearch.fill('zzz-不存在');
  assert.equal(await page.locator('.model-picker-row').count(), 0);
  assert.match(await page.locator('.model-picker-list').innerText(), /没有匹配的模型/);
  await modelSearch.fill('');
  assert.equal(await page.locator('.model-picker-row').count(), allRows, '清空搜索后应恢复全部');
  // Model cards are ordered by name, so they are addressed by title rather than by position.
  const cardFor = title => page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: title }) }).last();
  for (const [index, id] of ['gpt-4o', 'deepseek-flash'].entries()) {
    await addServerModel(id, { fetched: index === 0 });
    const added = cardFor(id === 'gpt-4o' ? 'GPT-4o' : id);
    assert.equal(await added.getByLabel('图片输入', { exact: true }).isChecked(), true, `${id} should default image input on`);
    assert.equal(await added.getByLabel('工具调用', { exact: true }).isChecked(), true, `${id} should default tool calls on`);
    if (id !== 'gpt-4o') continue;
    assert.equal(await added.getByLabel('模型 ID', { exact: true }).inputValue(), 'gpt-4o');
    assert.equal(await added.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '128000', '服务端给出的上下文窗口应作为默认值');
    assert.equal(await added.getByLabel('最大输出（token）', { exact: true }).inputValue(), '16384', '服务端给出的输出上限应作为默认值');
    assert.equal(await added.getByLabel('支持的等级（逗号分隔）', { exact: true }).inputValue(), 'low,medium,high');
    assert.match(await added.innerText(), /切换到此模型时默认使用 high/, '服务端的 default_level 应被记住并用于该模型的默认档位');
  }
  await addServerModel('fixture-model');
  // 已经添加过的行仍要显示服务端给出的信息，只是前面多一个"已添加"，否则同一行看不出模型多大。
  await page.getByRole('button', { name: '测试连接 / 获取模型', exact: true }).click();
  await page.getByRole('dialog', { name: '添加服务端模型' }).waitFor();
  const usedRow = page.locator('.model-picker-row.used', { hasText: 'GPT-4o' });
  const usedFacts = await usedRow.innerText();
  for (const fact of ['已添加', '上下文 128,000', '输出上限 16,384', '输入 text / image', '思考 low / medium / high（默认 high）']) assert.ok(usedFacts.includes(fact), `已添加的行仍应显示「${fact}」，实际：${usedFacts}`);
  // 淡化但不能淡到读不出来：按计算样式算出的对比度不得低于 2（0.55 时只有 1.74）。
  const usedContrast = await usedRow.evaluate(el => { const o = parseFloat(getComputedStyle(el).opacity); const [r, g, b] = getComputedStyle(el.querySelector('.model-picker-facts')).color.match(/[\d.]+/g).slice(0, 3).map(Number); const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }; const bg = [246, 247, 245]; const eff = [r, g, b].map((v, i) => v * o + bg[i] * (1 - o)); const [hi, lo] = [lum(eff), lum(bg)].sort((a, b) => b - a); return +((hi + 0.05) / (lo + 0.05)).toFixed(2); });
  assert.ok(usedContrast >= 2, `已添加行的模型信息对比度不应低于 2，实际 ${usedContrast}`);
  await page.getByRole('button', { name: '关闭添加模型' }).click();
  await page.getByRole('dialog', { name: '添加服务端模型' }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.settings-card').last().getByLabel('图片输入', { exact: true }).isChecked(), false, 'unknown models should keep image input unchecked');
  await page.locator('.preset-row').getByRole('button', { name: 'Gemini', exact: true }).click();
  assert.equal(await page.getByLabel(/^接口协议/).inputValue(), 'gemini');
  assert.equal(await page.getByLabel(/^Base URL/).inputValue(), 'https://generativelanguage.googleapis.com/v1beta');
  await page.getByLabel(/^Base URL/).fill(baseUrl.replace('/v1', '/v1beta'));
  await page.getByRole('button', { name: '测试连接 / 获取模型', exact: true }).click();
  await addServerModel('fixture-model', { fetched: true });
  assert.equal(await page.getByLabel('模型 ID', { exact: true }).inputValue(), 'fixture-model');
  assert.equal(await page.getByLabel(/^思考参数/).inputValue(), 'effort');
  assert.equal(await page.getByLabel('上下文窗口（token）', { exact: true }).inputValue(), '1000000');
  assert.equal(await page.getByLabel('最大输出（token）', { exact: true }).inputValue(), '65536');
  await page.locator('.settings-nav').getByRole('button', { name: '系统提示词库' }).click();
  await page.getByRole('button', { name: '添加角色', exact: true }).click();
  // 新角色排在已有角色卡片之前，所以它的字段是第一个而不是最后一个。
  assert.equal(await page.locator('.settings-card h3').first().innerText(), '新角色', '新角色应排在已有角色卡片前面');
  await page.getByLabel('角色名称', { exact: true }).first().fill('测试研究助手');
  assert.equal(await page.getByLabel('角色名称', { exact: true }).first().evaluate(el => getComputedStyle(el.parentElement).display), 'grid', '角色名称与单行文本框并排');
  await page.getByLabel('角色系统提示词', { exact: true }).first().fill('你是测试研究助手，优先使用证据回答。');
  const roleId = await page.getByLabel(/^新对话默认角色/).locator('option', { hasText: '测试研究助手' }).getAttribute('value');
  assert.ok(roleId, '新角色应出现在"新对话默认角色"下拉里');
  await page.getByLabel(/^新对话默认角色/).selectOption(roleId);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.settings-page').waitFor({ state: 'hidden' });
  const toastLayout = await page.locator('.toast').evaluate(el => { const r = el.getBoundingClientRect(); return { xOffset: (r.left + r.right) / 2 - window.innerWidth / 2, yOffset: (r.top + r.bottom) / 2 - window.innerHeight / 2 }; });
  assert.ok(Math.abs(toastLayout.xOffset) < 1); assert.ok(Math.abs(toastLayout.yOffset) < 1);
  await page.screenshot({ path: join(directory, 'center-toast.png') });
  const presets = await page.evaluate(() => window.deepchan.load());
  // 两个 DeepSeek 预设各留下一个 deepseek-flash：兼容协议的不带原生搜索，Anthropic 的带。
  const flashModels = presets.settings.models.filter(m => m.model === 'deepseek-flash');
  assert.deepEqual([...new Set(flashModels.map(m => m.nativeSearch))].sort(), [false, true], 'OpenAI 兼容预设不带原生搜索，Anthropic 预设带');
  // Verify that the connection's defaults survive save/reopen and renaming.
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '联网搜索' }).click();
  assert.equal(await page.getByRole('heading', { name: 'Firecrawl', exact: true }).count(), 1);
  assert.equal(await page.getByRole('heading', { name: 'AnySearch', exact: true }).count(), 1);
  assert.equal(await page.getByLabel('API Key（可选）').count(), 4, 'Tavily / Firecrawl / AnySearch / DeepSeek 四家的密钥都可留空');
  // Search preferences are global defaults; they only change the fallback order of the auto mode.
  assert.deepEqual(await page.getByLabel('新对话的搜索模式').locator('option').allTextContents(), ['自动联网（默认）', '模型原生', 'Exa', 'Ollama Cloud', 'Tavily', 'Firecrawl', 'AnySearch', 'DeepSeek 搜索', '关闭']);
  assert.equal(await page.getByLabel('新对话的搜索模式').inputValue(), 'auto');
  assert.equal(await page.getByRole('checkbox', { name: '自动模式下优先使用模型原生搜索' }).isChecked(), true, '默认原生搜索优先');
  // The external head and the default webpage reader are separate preferences; both land in settings.
  const preferredExternal = page.getByLabel('自动模式下优先使用的外部搜索');
  assert.deepEqual(await preferredExternal.locator('option').allTextContents(), ['默认顺序（内置）', 'Exa（需 API Key）', 'Ollama Cloud（需 API Key）', 'Tavily', 'Firecrawl', 'AnySearch', 'DeepSeek 搜索（按次计费）']);
  assert.equal(await preferredExternal.inputValue(), 'auto');
  await page.getByRole('checkbox', { name: '自动模式下优先使用模型原生搜索' }).uncheck();
  await preferredExternal.selectOption('tavily');
  await page.getByLabel('新对话的默认读取网页方法').selectOption('last');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await page.locator('.settings-page').waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(async () => { const s = await window.deepchan.load(); return [s.settings.defaultSearch, s.settings.preferNativeSearch, s.settings.preferredExternalSearch, s.settings.defaultWebFetch]; }), ['auto', false, 'tavily', 'last']);
  // "上次使用" has nothing recorded yet, so a new chat still starts on the automatic reader.
  const readerBefore = await page.evaluate(async () => { const s = await window.deepchan.load(); return { count: s.conversations.length, selected: s.selectedId }; });
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, readerBefore.count + 1);
  const probeChat = await page.evaluate(async () => (await window.deepchan.load()).selectedId);
  const inheritedFetch = await page.evaluate(async () => { const s = await window.deepchan.load(), c = s.conversations.find(item => item.id === s.selectedId); return c.branches.find(b => b.id === c.activeBranchId).config.webFetch; });
  assert.equal(inheritedFetch, 'auto', '“上次使用”在没有记录时应回落到自动读取网页');
  // Drop the probe chat again and put the preferences back, so later stages see the state they expect.
  await page.evaluate(async before => {
    const s = await window.deepchan.load();
    s.conversations = s.conversations.filter(c => c.id !== before.probe);
    s.selectedId = before.selected;
    s.settings.defaultSearch = 'auto'; s.settings.preferNativeSearch = true; s.settings.preferredExternalSearch = 'auto'; s.settings.defaultWebFetch = 'auto';
    await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload'));
  }, { probe: probeChat, ...readerBefore });
  await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, readerBefore.count);
  // Saving closes the settings page, so open it again for the steps that follow.
  await page.getByRole('button', { name: /^设置/ }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '模型服务' }).click();
  await page.locator('.settings-nav').getByRole('button', { name: '模型服务' }).click();
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
    state.settings.deepseekKey = 'deepseek-fixture-secret';
    state.settings.models = connections.map(c => ({ id: crypto.randomUUID(), connectionId: c.id, name: '模拟 ' + c.protocol, model: 'fixture', contextWindow: 128000, maxOutput: 65_536, vision: true, tools: true, nativeSearch: c.protocol !== 'chat', reasoning: ['chat', 'gemini'].includes(c.protocol) ? 'effort' : 'none', efforts: ['low','medium','high'], temperature: false }));
    state.settings.defaultModel = state.settings.models[0].id;
    state.settings.titleModel = state.settings.models[0].id;
    await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
  }, baseUrl);
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  const input = page.getByRole('textbox', { name: '消息输入' });
  await page.getByRole('combobox', { name: '思考等级' }).selectOption('high');
  const toolbar = page.locator('.composer-bottom');
  assert.equal(await toolbar.getByRole('button', { name: '聊天模型' }).count(), 1);
  const modelSelector = toolbar.getByRole('button', { name: '聊天模型' });
  assert.equal(await modelSelector.getAttribute('title'), '模拟 chat | 本地模拟 chat');
  // The drawn list keeps the native select's alphabetical order, and the full list stays complete.
  await modelSelector.click();
  await page.locator('.model-select-popover').waitFor();
  assert.equal(await page.locator('.model-select-popover').getByRole('option').count(), 4, '每个模型都应出现在完整列表里');
  assert.deepEqual(await page.locator('.model-select-popover [role="option"]').allTextContents(), ['模拟 anthropic | 本地模拟 anthropic', '模拟 chat | 本地模拟 chat', '模拟 gemini | 本地模拟 gemini', '模拟 responses | 本地模拟 responses']);
  assert.deepEqual(await page.locator('.model-select-heading').allTextContents(), ['全部模型'], '还没有收藏时只显示完整列表');
  // Starring a model adds a 收藏 section above the list and takes the model out of 最近使用.
  await page.locator('.model-select-popover').getByRole('button', { name: '收藏 模拟 chat' }).first().click();
  assert.deepEqual(await page.locator('.model-select-heading').allTextContents(), ['收藏', '全部模型']);
  // A favourited model is starred in both places it is listed: the shortcut section above and the
  // complete list below, which stays complete on purpose.
  assert.equal(await page.locator('.model-select-star.on').count(), 2);
  assert.deepEqual(await page.locator('.model-select-section').first().locator('[role="option"]').allTextContents(), ['模拟 chat | 本地模拟 chat']);
  assert.equal(await page.locator('.model-select-popover [role="option"]').count(), 5, '收藏区 1 条加上完整列表 4 条');
  // The star button owns the right edge of its row, so the column has to line up across rows, but
  // the glyph itself must sit centred inside that button and carry no button background: it was
  // previously flush right (flex-end plus left padding) and floated on a grey box.
  const pickerStyle = await page.locator('.model-select-popover').evaluate(el => {
    const panel = el.getBoundingClientRect(), cs = getComputedStyle(el);
    const stars = [...el.querySelectorAll('.model-select-star')];
    const contentRight = panel.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
    return {
      columnGaps: [...new Set(stars.map(s => Math.round((contentRight - s.getBoundingClientRect().right) * 10) / 10))],
      centred: stars.every(s => { const b = s.getBoundingClientRect(), i = s.querySelector('svg').getBoundingClientRect(); return Math.abs((i.left - b.left) - (b.right - i.right)) <= 0.5; }),
      backgrounds: [...new Set(stars.map(s => getComputedStyle(s).backgroundColor))],
      justify: getComputedStyle(stars[0]).justifyContent, starWidth: getComputedStyle(stars[0]).width
    };
  });
  assert.deepEqual(pickerStyle.columnGaps, [0], '星标按钮应贴住行内容右边缘，且所有行对齐成同一列');
  assert.equal(pickerStyle.centred, true, '星形应在按钮内水平居中');
  assert.deepEqual(pickerStyle.backgrounds, ['rgba(0, 0, 0, 0)'], '星标不应有按钮底色');
  assert.equal(pickerStyle.justify, 'center', '.popover button 的 justify-content 会压过裸类名，星标规则必须挂在面板作用域下');
  assert.equal(pickerStyle.starWidth, '26px', '星标点击区宽度不应被 padding 挤掉');
  await page.locator('.model-select-popover').getByRole('button', { name: '取消收藏 模拟 chat' }).first().click();
  assert.deepEqual(await page.locator('.model-select-heading').allTextContents(), ['全部模型']);
  assert.equal(await page.evaluate(async () => (await window.deepchan.load()).settings.favoriteModels.length), 0, '取消收藏应写回设置');
  await page.keyboard.press('Escape');
  await page.locator('.model-select-popover').waitFor({ state: 'hidden' });
  // Style regressions. Everything above only reads text and roles, so a class name that drifts away
  // from its rule, or a rule that loses a specificity fight, passes the whole suite while the panel
  // renders with the global button styles. Both happened here once already; these assertions are
  // what makes the next one loud.
  // Playwright leaves the pointer sitting on the button after clicking it, so sampling straight away
  // measures the hover background rather than the idle one. Move the pointer away first.
  // The global button rule transitions the background over 150ms, so both the idle and the open
  // colour have to settle before they are compared — sampling mid-transition reads a partial alpha.
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  const triggerStyle = await modelSelector.evaluate(el => {
    const label = el.querySelector('span'), cs = getComputedStyle(el);
    return { border: cs.borderTopWidth, radius: cs.borderTopLeftRadius, background: cs.backgroundColor, color: cs.color, whiteSpace: getComputedStyle(label).whiteSpace, clipped: el.classList.contains('clipped') };
  });
  assert.equal(triggerStyle.border, '0px', '模型选择按钮不应有边框');
  assert.equal(triggerStyle.radius, '8px', '模型选择按钮应与"会话选项"一样有圆角');
  assert.equal(triggerStyle.background, 'rgba(0, 0, 0, 0)', '未激活时模型选择按钮应无底色');
  assert.equal(triggerStyle.whiteSpace, 'nowrap', '模型名称应单行显示');
  assert.equal(triggerStyle.clipped, false, '名称未超出时不该加淡出遮罩');
  // While the list is up the button itself turns into the open-state cue, so it must not look idle.
  // The colour is compared against --accent-bg rather than a literal, so this also holds in dark mode.
  await modelSelector.click();
  await page.locator('.model-select-popover').waitFor();
  await page.waitForTimeout(250);
  const openStyle = await modelSelector.evaluate(el => {
    const probe = document.createElement('div');
    probe.style.background = getComputedStyle(document.documentElement).getPropertyValue('--accent-bg').trim();
    document.body.appendChild(probe);
    const accentBg = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { background: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color, accentBg, expanded: el.getAttribute('aria-expanded') };
  });
  assert.equal(openStyle.expanded, 'true', '浮层打开时按钮应标记为展开');
  assert.equal(openStyle.background, openStyle.accentBg, '浮层打开时按钮底色应为 --accent-bg');
  assert.equal(openStyle.color, triggerStyle.color, '按下时不应改变模型名称的字色');
  await page.keyboard.press('Escape');
  await page.locator('.model-select-popover').waitFor({ state: 'hidden' });
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  assert.equal(await modelSelector.evaluate(el => getComputedStyle(el).backgroundColor), 'rgba(0, 0, 0, 0)', '关闭后按钮应恢复无底色');
  // Force the overflow branch: the fixture names are short, so shrink the label box until it clips.
  await toolbar.evaluate(el => { el.style.maxWidth = '96px'; });
  await page.locator('.model-select-trigger.clipped').waitFor();
  const clippedStyle = await modelSelector.evaluate(el => {
    const label = el.querySelector('span'), ls = getComputedStyle(label);
    return { mask: ls.maskImage || ls.webkitMaskImage, overflow: ls.textOverflow, scrollable: label.scrollWidth > label.clientWidth };
  });
  assert.ok(clippedStyle.scrollable, '收窄后名称文本确实应超出可视宽度');
  assert.match(clippedStyle.mask, /linear-gradient/, '超长名称应淡出截断，而不是省略号');
  assert.equal(clippedStyle.overflow, 'clip', '淡出截断时不应再显示省略号');
  assert.equal(await modelSelector.evaluate(el => el.querySelector('span').getClientRects().length), 1, '名称应始终只有一行');
  await toolbar.evaluate(el => { el.style.maxWidth = ''; });
  await page.locator('.model-select-trigger.clipped').waitFor({ state: 'detached' }).catch(() => {});
  await page.locator('.header-title small.model-label').innerText();
  assert.equal(await page.locator('.header-title small.model-label').getAttribute('title'), '模拟 chat | 本地模拟 chat');
  // 顶栏在模型名后带上当前分支用的角色预设名。
  const roleLabel = page.locator('.header-title small.role-preset');
  assert.equal(await roleLabel.count(), 1, '顶栏应显示角色预设名');
  assert.equal((await roleLabel.innerText()).replace(/^·/, ''), await page.evaluate(async () => { const s = await window.deepchan.load(), c = s.conversations.find(x => x.id === s.selectedId), b = c.branches.find(x => x.id === c.activeBranchId); return s.settings.promptPresets.find(p => p.content === b.config.system)?.name || ''; }), '显示的应是与分支提示词匹配的那个预设名');
  assert.equal((await roleLabel.innerText()).trim(), (await roleLabel.innerText()).trim().replace(/^·\s*/, ''), '角色预设名前不应有间隔点');
  assert.equal(await toolbar.getByRole('combobox', { name: '思考等级' }).count(), 1);
  // 折叠状态的当前值保持弱化层级，展开后的选项列表提到正文色；只断言计算样式里的颜色，
  // 因为原生下拉弹层在无头环境里画不出来。
  const effortColors = await page.locator('.reasoning-selector select').first().evaluate(el => ({
    closed: getComputedStyle(el).color, open: getComputedStyle(el.querySelector('option')).color, background: getComputedStyle(el.querySelector('option')).backgroundColor,
    muted: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(), text: getComputedStyle(document.documentElement).getPropertyValue('--text').trim(), panel: getComputedStyle(document.documentElement).getPropertyValue('--panel').trim()
  }));
  const rgbOf = hex => `rgb(${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;
  assert.equal(effortColors.closed, rgbOf(effortColors.muted), '思考等级框当前值仍为 --muted');
  assert.equal(effortColors.open, rgbOf(effortColors.text), '下拉列表文字为 --text');
  assert.equal(effortColors.background, rgbOf(effortColors.panel), '下拉列表底色与正文成对');
  assert.equal(await toolbar.getByRole('button', { name: '会话选项' }).count(), 1);
  await toolbar.getByRole('button', { name: '会话选项' }).click();
  assert.equal(await page.getByLabel('系统提示词', { exact: true }).inputValue(), '你是测试研究助手，优先使用证据回答。');
  const searchMode = page.locator('.inline-config-field').first().locator('select');
  // 关闭 is offered last, after every concrete way of searching.
  assert.deepEqual(await searchMode.locator('option').allTextContents(), ['自动联网（默认）', '模型原生', 'Exa', 'Ollama Cloud', 'Tavily', 'Firecrawl', 'AnySearch', 'DeepSeek 搜索（按次计费）', '关闭']);
  assert.equal(await searchMode.locator('option[value="tavily"]').isDisabled(), false);
  const webReading = page.getByRole('combobox', { name: '读取网页' });
  assert.deepEqual(await webReading.locator('option').allTextContents(), ['自动（默认）', 'Exa', 'Ollama Cloud', 'Tavily', 'Firecrawl', 'AnySearch', 'DeepSeek Fetch（按次计费）', '本地读取', '关闭']);
  assert.equal(await webReading.locator('option[value="tavily"]').isDisabled(), false);
  // 本次运行配置了 DeepSeek 密钥，按次计费的两项应可选用并在文案里标明计费方式。
  assert.equal(await searchMode.locator('option[value="deepseek"]').isDisabled(), false, '配了密钥后应能显式选择 DeepSeek 搜索');
  assert.equal(await webReading.locator('option[value="deepseek"]').isDisabled(), false, '配了密钥后应能显式选择 DeepSeek Fetch');
  assert.match(await searchMode.locator('option[value="deepseek"]').innerText(), /按次计费/, '按次计费的服务必须在选项里标明');
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
  assert.equal(await networkToggle.innerText(), '', '联网按钮仅显示地球状态图标');
  assert.equal(await networkToggle.locator('.network-icon.off').count(), 0);
  await networkToggle.click();
  await waitFor(page, async () => {
    const state = await window.deepchan.load(); const conversation = state.conversations.find(c => c.id === state.selectedId);
    const config = conversation.branches.find(b => b.id === conversation.activeBranchId).config;
    return config.search === 'off' && config.webFetch === 'off';
  });
  assert.equal(await networkToggle.getAttribute('aria-pressed'), 'false');
  assert.equal(await networkToggle.locator('.network-icon.off').count(), 1, '关闭联网时显示斜线状态');
  await networkToggle.click();
  await waitFor(page, async () => {
    const state = await window.deepchan.load(); const conversation = state.conversations.find(c => c.id === state.selectedId);
    const config = conversation.branches.find(b => b.id === conversation.activeBranchId).config;
    return config.search === 'auto' && config.webFetch === 'auto';
  });
  assert.equal(await networkToggle.getAttribute('aria-pressed'), 'true');
  assert.equal(await networkToggle.locator('.network-icon.off').count(), 0);
  const layout = await toolbar.evaluate(el => { const text = document.querySelector('textarea[aria-label="消息输入"]').getBoundingClientRect(); const send = el.querySelector('.send-button').getBoundingClientRect(); return { textBottom: text.bottom, controlTop: el.getBoundingClientRect().top, sendLeft: send.left, controls: [...el.querySelectorAll('select')].map(s => s.getBoundingClientRect().right) }; });
  assert.ok(layout.controlTop >= layout.textBottom); assert.ok(layout.controls.every(right => right < layout.sendLeft));
  assert.equal(await page.getByText('AI 的回答可能有误，请核实重要信息。', { exact: true }).count(), 0);
  const header = await page.locator('.chat-header').evaluate(el => {
    const title = el.querySelector('.header-title > span').getBoundingClientRect();
    const model = el.querySelector('.header-title small').getBoundingClientRect();
    return { height: el.getBoundingClientRect().height, titleCenter: (title.top + title.bottom) / 2, modelCenter: (model.top + model.bottom) / 2 };
  });
  assert.equal(header.height, 32); assert.ok(Math.abs(header.titleCenter - header.modelCenter) < 2);
  const grip = page.getByRole('separator', { name: '调整输入框高度' });
  const initialHeight = (await input.boundingBox()).height;
  async function dragComposerResize() {
    const gripBox = await grip.boundingBox(), centerX = gripBox.x + gripBox.width / 2, centerY = gripBox.y + gripBox.height / 2;
    await page.mouse.move(centerX, centerY); await page.mouse.down();
    await waitFor(page, () => document.querySelector('.composer-resize').hasPointerCapture(1));
    // Chromium coalesces moves that land in one frame, and a coalesced batch followed by pointerup
    // loses the intermediate positions; let each step settle so the drag reflects real pointer input.
    for (let step = 1; step <= 5; step++) { await page.mouse.move(centerX, centerY - step * 20); await page.waitForTimeout(30); }
    await page.mouse.up(); await page.waitForTimeout(250);
    return await input.evaluate(el => el.getBoundingClientRect().height);
  }
  let resizedHeight = await dragComposerResize();
  if (resizedHeight < initialHeight + 95) resizedHeight = await dragComposerResize();
  assert.ok(resizedHeight >= initialHeight + 95, `输入框拖动高度未生效：${initialHeight} -> ${resizedHeight}`);
  await grip.focus(); await page.keyboard.press('End');
  assert.ok((await input.boundingBox()).height <= Math.min(420, page.viewportSize()?.height * 0.45 || 420) + 1);
  await page.keyboard.press('Home'); await waitFor(page, () => document.querySelector('textarea[aria-label="消息输入"]').getBoundingClientRect().height === 47);
  const composerBox = await page.locator('.composer').boundingBox();
  assert.ok(await page.evaluate(bottom => window.innerHeight - bottom < 12, composerBox.y + composerBox.height));
  await input.fill('如何设计 Linux 聊天客户端？'); await page.getByTitle('发送消息', { exact: true }).click();
  await page.locator('.message.assistant').getByText('实现思路', { exact: true }).waitFor();
  assert.equal(calls.find(c => c.path === '/v1/chat/completions').data.reasoning_effort, 'high');
  assert.match(await input.getAttribute('placeholder'), /Ctrl\+I/);
  await page.keyboard.press('Control+f');
  const chatSearch = page.getByRole('searchbox', { name: '搜索当前分支' }); await chatSearch.waitFor();
  await chatSearch.fill('实现思路');
  await page.getByRole('button', { name: /AI · 正文/ }).first().waitFor();
  await page.keyboard.press('Control+i');
  await page.locator('.chat-search-popover').waitFor({ state: 'hidden' });
  assert.equal(await input.evaluate(el => document.activeElement === el), true, 'Ctrl+I 聚焦消息输入框');
  assert.equal(await page.locator('.message.assistant .answer-meta').first().getAttribute('aria-label'), '查看回答详情：模拟 chat');
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
  const streamPatches = await page.evaluate(() => window.__patches || []);
  assert.ok(streamPatches.length >= 1, `流式期间必须收到增量补丁（收到 ${streamPatches.length}）`);
  assert.ok(streamPatches.every((patch, index) => patch.length > 0 && (index === 0 || patch.revision > streamPatches[index - 1].revision)), '补丁必须携带正文且修订号单调递增');
  await waitFor(page, async () => (await window.deepchan.load()).conversations[0].titleState === 'done');
  await assertUsageDetails(page);
  // 模型先请求工具再给正文：工具调用是模型的第一个输出，计时要算它。
  await input.fill('先问时间'); await page.getByTitle('发送消息', { exact: true }).click();
  await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
  const toolFirst = await page.evaluate(async () => {
    const s = await window.deepchan.load(), c = s.conversations.find(x => x.id === s.selectedId);
    const answer = c.messages.filter(m => m.role === 'assistant').at(-1);
    return { hasTool: !!answer.tools.length, firstOutputMs: answer.usage?.firstOutputMs, firstTokenMs: answer.usage?.firstTokenMs, generationMs: answer.usage?.generationMs, output: answer.usage?.output };
  });
  assert.equal(toolFirst.hasTool, true, '模型应先请求了 datetime 工具');
  assert.ok(toolFirst.firstOutputMs < toolFirst.firstTokenMs, `工具调用先于正文时，首个输出应早于首字，实际 ${toolFirst.firstOutputMs} vs ${toolFirst.firstTokenMs}`);
  assert.ok(toolFirst.generationMs - toolFirst.firstOutputMs > 0, '扣掉首个输出后仍应剩下生成时间');
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
  // 按角色名定位卡片，不依赖它在列表里的位置——新角色现在排在最前。
  await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '测试研究助手' }) }).getByLabel('角色系统提示词', { exact: true }).fill('角色库更新后的提示词。');
  await page.getByRole('button', { name: '添加角色', exact: true }).click();
  await page.getByLabel('角色名称', { exact: true }).first().fill('临时角色');
  await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '临时角色' }) }).getByLabel('角色系统提示词', { exact: true }).fill('仅用于测试删除。');
  // 删除角色与重置预设角色都要先确认。
  acceptDialogs = false;
  await page.getByTitle('删除角色：临时角色', { exact: true }).click();
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '临时角色' }) }).count(), 1, '取消确认时不应删除角色');
  acceptDialogs = true;
  await page.getByTitle('删除角色：临时角色', { exact: true }).click();
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '临时角色' }) }).count(), 0, '确认后角色应被删除');
  // “重置预设角色”把程序自带的角色恢复成默认，并补回被删掉的；用户自己的角色不动。
  await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '通用助手' }) }).getByLabel('角色系统提示词', { exact: true }).fill('被我改过的内置提示词。');
  await page.getByTitle('删除角色：通用助手', { exact: true }).click();
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '通用助手' }) }).count(), 0, '通用助手应已被删除');
  acceptDialogs = false;
  await page.getByRole('button', { name: '重置预设角色', exact: true }).click();
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '通用助手' }) }).count(), 0, '取消确认时不应重置预设角色');
  acceptDialogs = true;
  await page.getByRole('button', { name: '重置预设角色', exact: true }).click();
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '通用助手' }) }).count(), 1, '重置后通用助手应被补回');
  // 新增的内置角色不随升级自动补进旧库，重置时才补上。
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '鲸鱼娘' }) }).count(), 1, '重置后应补上新增的内置角色');
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '测试研究助手' }) }).count(), 1, '用户添加的角色不应受影响');
  assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '测试研究助手' }) }).getByLabel('角色系统提示词', { exact: true }).inputValue(), '角色库更新后的提示词。', '用户角色连改过的提示词都不应被重置');
    assert.equal(await page.locator('.settings-card').filter({ has: page.locator('h3', { hasText: '通用助手' }) }).getByLabel('角色系统提示词', { exact: true }).inputValue(), '你是一位严谨、友善的助手。使用用户的语言回答。', '内置角色应恢复默认提示词');
  // 角色库里已经有"通用助手"时，下拉里不能再出现第二个同名的内置兜底项。
  const roleOptions = await page.getByLabel(/^新对话默认角色/).locator('option').allTextContents();
  assert.equal(roleOptions.filter(text => text.includes('通用助手')).length, 1, `下拉里应只有一个"通用助手"，实际：${roleOptions.join(' / ')}`);
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
  await page.locator('.edit-box textarea').last().fill('手动修改的回答，保留原版本。');
  await page.getByRole('button', { name: '保存新版本' }).click();
  assert.equal(calls.length, count);
  for (let i = 0; i < 2; i++) { await input.fill(`补充问题 ${i}`); await page.getByTitle('发送消息', { exact: true }).click(); await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' }); }
  const compressionFixture = await lengthenActiveHistory(page); assert.ok(compressionFixture.userTurns >= 4); assert.equal(compressionFixture.persistedTurns, compressionFixture.userTurns);
  await page.getByRole('button', { name: '会话选项' }).click();
  // A toast may still be on screen from an earlier step, so only a *new* one counts as the error.
  const toastBeforeCompression = await page.evaluate(() => document.querySelector('.toast')?.textContent || '');
  await page.getByRole('button', { name: '压缩较早历史' }).click();
  await waitFor(page, async before => {
    const state = await window.deepchan.load(), summary = state.conversations[0].branches.some(b => b.summary);
    const toast = document.querySelector('.toast')?.textContent || '';
    return summary ? 'summary' : toast && toast !== before ? `error: ${toast}` : false;
  }, toastBeforeCompression);
  const chatStateAfterCompression = await page.evaluate(async () => ({ summaries: (await window.deepchan.load()).conversations[0].branches.filter(b => b.summary).length, toast: document.querySelector('.toast')?.textContent }));
  assert.ok(chatStateAfterCompression.summaries, chatStateAfterCompression.toast || 'no summary was persisted');
  const chatCompression = calls.filter(c => c.path === '/v1/chat/completions' && c.data.messages?.[0]?.content.includes('如果内容涉及创意写作')).at(-1);
  assert.equal(chatCompression.data.max_completion_tokens, 50_000);
  for (const heading of ['## 世界观规则', '## 最近风格样本', '最近 1～2 段风格样本可保留原文']) assert.ok(chatCompression.data.messages[0].content.includes(heading), `compression prompt should contain ${heading}`);
  await page.screenshot({ path: join(directory, 'desktop.png') });
  for (const protocol of ['responses','anthropic','gemini']) {
    console.log('stage: protocol', protocol);
    const expectedCount = await page.evaluate(async () => (await window.deepchan.load()).conversations.length + 1);
    await page.getByRole('button', { name: /新建对话/ }).first().click();
    await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, expectedCount);
    const modelId = await page.evaluate(async protocol => (await window.deepchan.load()).settings.models.find(m => m.name === '模拟 ' + protocol).id, protocol);
    await pickModel(page, `模拟 ${protocol}`);
    // Switching a model records it straight away, before any answer exists.
    assert.equal(await page.evaluate(async id => (await window.deepchan.load()).settings.recentModels.includes(id), modelId), true, `切换到 ${protocol} 就应记入最近使用`);
    if (protocol === 'gemini') {
      await page.getByRole('combobox', { name: '思考等级' }).selectOption('high');
      await page.evaluate(async () => { const s = await window.deepchan.load(); s.settings.titleModel = ''; await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); });
    }
    if (protocol === 'responses' || protocol === 'gemini') { await page.locator('input[type=file]').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: await page.screenshot({ type: 'png' }) }); await page.locator('.draft-attachments img').waitFor(); }
    await input.fill(`测试 ${protocol} 协议`); await page.getByTitle('发送消息', { exact: true }).click();
    await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' });
    await page.locator('.message.assistant .message-content').waitFor();
    // 各协议的思考摘要都应出现在回答的推理卡片里。
    const summary = page.locator('.message.assistant').last().locator('.thinking');
    if (protocol === 'responses') {
      assert.equal(await summary.count(), 1, 'Responses 协议应显示思考摘要卡片');
      assert.match(await summary.textContent(), /推理摘要来自模拟服务。/, '思考摘要内容应来自 response.reasoning_summary_text.delta');
      assert.match(await summary.textContent(), /思维链原文。/, 'DeepSeek 的 response.reasoning_text.delta 也应被读成思考内容');
      // store 省略时 OpenAI 默认存服务端并且不把思考内容交回来，摘要就无从显示。
      const responsesCall = calls.filter(c => c.path === '/v1/responses').at(-1);
      assert.equal(responsesCall.data.store, false, 'Responses 请求应显式关闭 store，否则思考摘要拿不到');
      assert.equal(responsesCall.data.include, undefined, '不必请求用不到的 encrypted_content');
    }
    await waitFor(page, async protocol => { const s = await window.deepchan.load(); return s.conversations.some(c => c.messages.some(m => m.role === 'user' && m.text === `测试 ${protocol} 协议`) && c.messages.some(m => m.role === 'assistant' && m.status === 'complete') && c.titleState === 'done'); }, protocol, { timeout: 10000 });
    if (protocol === 'gemini') {
      for (let i = 0; i < 2; i++) { await input.fill(`Gemini 后续问题 ${i}`); await page.getByTitle('发送消息', { exact: true }).click(); await page.getByTitle('停止生成', { exact: true }).waitFor({ state: 'hidden' }); }
    }
    await page.getByRole('button', { name: '会话选项' }).click();
    if (protocol === 'gemini') await page.screenshot({ path: join(directory, 'gemini-options.png') });
    const compressionFixture = await lengthenActiveHistory(page); assert.ok(compressionFixture.userTurns >= 4); assert.equal(compressionFixture.persistedTurns, compressionFixture.userTurns);
    await page.getByRole('button', { name: '压缩较早历史' }).click();
    await waitFor(page, async () => { const s = await window.deepchan.load(); return s.conversations.find(c => c.id === s.selectedId).branches.some(b => b.summary); });
    const compressionCall = calls.filter(c => {
      const prompt = c.data.instructions || c.data.system || c.data.systemInstruction?.parts?.[0]?.text || '';
      return prompt.includes('如果内容涉及创意写作') && (protocol === 'gemini' ? c.path.startsWith('/v1beta/models/') : c.path === (protocol === 'responses' ? '/v1/responses' : '/v1/messages'));
    }).at(-1);
    assert.ok(compressionCall, `${protocol} 应发送创意写作压缩提示词`);
    const outputLimit = protocol === 'gemini' ? compressionCall.data.generationConfig.maxOutputTokens : compressionCall.data[protocol === 'responses' ? 'max_output_tokens' : 'max_tokens'];
    assert.equal(outputLimit, 50_000, `${protocol} 压缩输出上限应为50k token`);
    await page.evaluate(async fixture => {
      const state = await window.deepchan.load(), conversation = state.conversations.find(c => c.id === fixture.conversationId), branch = conversation.branches.find(b => b.id === fixture.branchId);
      branch.leafId = fixture.originalLeaf; await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
    }, compressionFixture);
    await waitFor(page, async id => { const s = await window.deepchan.load(), c = s.conversations.find(x => x.id === s.selectedId), b = c.branches.find(x => x.id === c.activeBranchId); return b.leafId === id; }, compressionFixture.originalLeaf);
    await waitFor(page, async id => [...document.querySelectorAll('.message.assistant')].at(-1)?.getAttribute('data-id') === id, compressionFixture.originalLeaf);
    assert.equal(await page.locator('.header-title small.model-label').innerText(), `模拟 ${protocol} | 本地模拟 ${protocol}`);
    assert.equal(await page.locator('.message.assistant .answer-meta').last().getAttribute('aria-label'), `查看回答详情：模拟 ${protocol}`);
    await assertUsageDetails(page, protocol === 'gemini' ? 72 : 60);
    // The in-app debug view must expose the outgoing request without ever exposing credentials.
    await page.locator('.message.assistant').last().getByRole('button', { name: '查看请求详情' }).click();
    const debugWindow = page.locator('.attachment-viewer-window');
    await debugWindow.waitFor();
    const debugText = await debugWindow.innerText();
    assert.match(debugText, /第 1 次请求/);
    assert.match(debugText, /请求头/); assert.match(debugText, /请求体/);
    // 调试时还要看得到上游返回了什么，而不只是我们发出去的。
    assert.match(debugText, /响应内容/, '请求详情应显示上游返回的内容');
    assert.ok(debugText.includes('这是本地模拟 API 的回答'), `响应内容应含上游原文，实际：${debugText.slice(0, 400)}`);
    assert.ok(debugText.includes('••••••••'), '请求详情应显示掩码后的密钥');
    // Header names may contain "secret"; what must never appear is the credential value itself.
    assert.ok(!debugText.includes('Bearer fixture-secret'), '请求详情不得泄露 API Key 的值');
    assert.ok(!debugText.includes('"header-secret"'), '请求详情不得泄露自定义请求头的值');
    await page.screenshot({ path: join(directory, `debug-${protocol}.png`) });
    await page.keyboard.press('Escape');
    await debugWindow.waitFor({ state: 'hidden' });
    console.log('stage: protocol complete', protocol);
  }
  // 图片附件的处理：长边缩到 1280、压成 WebP；小于 50KB 的与动图原样保留。
  const buildGif = (frames, padding = 0) => {
    const parts = [Buffer.from('GIF89a', 'latin1'), Buffer.from([0x10, 0, 0x10, 0, 0, 0, 0])];
    if (padding) {
      parts.push(Buffer.from([0x21, 0xff]));                 // Application Extension
      let left = padding;
      while (left > 0) { const n = Math.min(255, left); parts.push(Buffer.from([n]), Buffer.alloc(n, 0x41)); left -= n; }
      parts.push(Buffer.from([0x00]));
    }
    const frame = () => Buffer.concat([Buffer.from([0x2c, 0, 0, 0, 0, 0x10, 0, 0x10, 0, 0]), Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00])]);
    for (let i = 0; i < frames; i++) parts.push(frame());
    parts.push(Buffer.from([0x3b]));
    return Buffer.concat(parts);
  };
  const draftImage = async () => await page.locator('.draft-attachments img').first().evaluate(el => {
    const src = el.getAttribute('src') || '', comma = src.indexOf(',');
    return { mime: /^data:([^;,]+)/.exec(src)?.[1] || '', bytes: comma < 0 ? 0 : Math.floor((src.length - comma - 1) * 3 / 4), width: el.naturalWidth, height: el.naturalHeight };
  });
  const upload = async (name, mimeType, buffer) => {
    await page.locator('input[type=file]').setInputFiles({ name, mimeType, buffer });
    await page.locator(`.draft-attachments img[alt="${name}"]`).waitFor();
  };
  // 一张长边超过 1280 的图：压成 WebP，尺寸缩到 1280 以内。
  const bigPng = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1400; canvas.height = 140;
    const ctx = canvas.getContext('2d'), image = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) { image.data[i] = Math.random() * 256; image.data[i + 1] = Math.random() * 256; image.data[i + 2] = Math.random() * 256; image.data[i + 3] = 255; }
    ctx.putImageData(image, 0, 0);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  }), 'base64');
  assert.ok(bigPng.length > 50 * 1024, `测试用图必须大于 50KB 才走压缩路径，实际 ${bigPng.length}`);
  await upload('big.png', 'image/png', bigPng);
  const big = await draftImage();
  assert.equal(big.mime, 'image/webp', '大图应压成 WebP');
  assert.ok(big.bytes < bigPng.length, `压缩后应更小：${big.bytes} vs ${bigPng.length}`);
  assert.ok(Math.max(big.width, big.height) <= 1280, `长边应不超过 1280，实际 ${big.width}×${big.height}`);
  await page.getByTitle('移除附件', { exact: true }).first().click();
  // 小图不压：原样保留，mime 也不变。
  const smallPng = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 8;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4488cc'; ctx.fillRect(0, 0, 12, 8);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    return await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(String(fr.result).split(',')[1]); fr.readAsDataURL(blob); });
  }), 'base64');
  assert.ok(smallPng.length < 50 * 1024, '小图必须小于 50KB 才走原样路径');
  await upload('small.png', 'image/png', smallPng);
  assert.equal((await draftImage()).mime, 'image/png', '小于 50KB 的图不压缩');
  await page.getByTitle('移除附件', { exact: true }).first().click();
  // 动图原样保留：DeepSeek、Qwen3+ 只读第一帧，转成静态图就白转了。
  await upload('motion.gif', 'image/gif', buildGif(2, 60 * 1024));
  assert.equal((await draftImage()).mime, 'image/gif', '动图应原样保留');
  await page.getByTitle('移除附件', { exact: true }).first().click();
  // 静态 GIF 没有帧的问题，照常压成 WebP。
  await upload('still.gif', 'image/gif', buildGif(1, 60 * 1024));
  assert.equal((await draftImage()).mime, 'image/webp', '静态 GIF 应压成 WebP');
  await page.getByTitle('移除附件', { exact: true }).first().click();
  // The finished answer promoted its model to the front, and a new chat now starts from it.
  const resume = await page.evaluate(async () => (await window.deepchan.load()).selectedId);
  const geminiModel = await page.evaluate(async () => (await window.deepchan.load()).settings.models.find(m => m.name === '模拟 gemini').id);
  assert.equal(await page.evaluate(async () => (await window.deepchan.load()).settings.recentModels[0]), geminiModel, '回答跑完后应把它的模型置顶');
  const chatCount = await page.evaluate(async () => (await window.deepchan.load()).conversations.length);
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, chatCount + 1);
  const throwaway = [await page.evaluate(async () => (await window.deepchan.load()).selectedId)];
  const activeModel = async () => await page.evaluate(async () => { const s = await window.deepchan.load(), c = s.conversations.find(item => item.id === s.selectedId); return c.branches.find(b => b.id === c.activeBranchId).config.modelId; });
  assert.equal(await activeModel(), geminiModel, '新对话应接着最近使用过的模型');
  // Turning the preference off sends new chats back to the configured default model.
  await page.evaluate(async () => { const s = await window.deepchan.load(); s.settings.useRecentModel = false; await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); });
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, chatCount + 2);
  throwaway.push(await page.evaluate(async () => (await window.deepchan.load()).selectedId));
  assert.equal(await activeModel(), await page.evaluate(async () => (await window.deepchan.load()).settings.defaultModel), '关闭开关后新对话回到默认聊天模型');
  // 停用默认模型所属的连接之后，新对话不能静默地开在它上面，而且它要从模型选择器里消失。
  const stopped = await page.evaluate(async () => {
    const s = await window.deepchan.load();
    const model = s.settings.models.find(m => m.id === s.settings.defaultModel);
    const connection = s.settings.connections.find(c => c.id === model.connectionId);
    s.settings.connections.forEach(c => { if (c.id === connection.id) c.disabled = true; });
    await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload'));
    return { modelId: model.id, connectionId: connection.id, label: `${model.name} | ${connection.name}` };
  });
  const beforeNewChat = await page.evaluate(async () => (await window.deepchan.load()).selectedId);
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, chatCount + 3);
  // 会话数够了不代表选中项已经切过去：选中还停在旧会话上时读到的仍是旧模型，会偶发失败。
  await waitFor(page, async previous => (await window.deepchan.load()).selectedId !== previous, beforeNewChat);
  throwaway.push(await page.evaluate(async () => (await window.deepchan.load()).selectedId));
  assert.notEqual(await activeModel(), stopped.modelId, '停用连接后新对话不应继续开在它的模型上');
  await page.getByRole('button', { name: '聊天模型' }).first().click();
  await page.locator('.model-select-popover').waitFor();
  assert.equal(await page.locator('.model-select-popover').getByRole('option', { name: stopped.label }).count(), 0, `停用连接的模型不应出现在选择器中：${stopped.label}`);
  await page.keyboard.press('Escape');
  await page.locator('.model-select-popover').waitFor({ state: 'hidden' });
  await page.evaluate(async connectionId => { const s = await window.deepchan.load(); s.settings.connections.forEach(c => { if (c.id === connectionId) c.disabled = false; }); await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); }, stopped.connectionId);
  // 连接勾选"gpt 自动使用 Responses"后，gpt-数字* 的模型要改走 Responses 协议。
  const gptSwitch = await page.evaluate(async () => {
    const s = await window.deepchan.load();
    const chat = s.settings.connections.find(c => c.protocol === 'chat');
    const model = { id: 'gpt-fixture', connectionId: chat.id, name: 'gpt-fixture', model: 'gpt-4o', contextWindow: 128000, maxOutput: 4096, vision: false, tools: false, nativeSearch: false, reasoning: 'none', efforts: [], temperature: false };
    s.settings.models.push(model);
    chat.responsesForGpt = true;
    await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload'));
    return { modelId: model.id, connectionId: chat.id };
  });
  await page.getByRole('button', { name: /新建对话/ }).first().click();
  await waitFor(page, async expected => (await window.deepchan.load()).conversations.length === expected, chatCount + 4);
  throwaway.push(await page.evaluate(async () => (await window.deepchan.load()).selectedId));
  await page.evaluate(async modelId => { const s = await window.deepchan.load(), c = s.conversations.find(x => x.id === s.selectedId), b = c.branches.find(x => x.id === c.activeBranchId); b.config.modelId = modelId; await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); }, gptSwitch.modelId);
  await waitFor(page, async id => { const s = await window.deepchan.load(), c = s.conversations.find(x => x.id === s.selectedId), b = c.branches.find(x => x.id === c.activeBranchId); return b.config.modelId === id; }, gptSwitch.modelId);
  const callsBeforeGpt = calls.length;
  await input.fill('gpt 走哪条协议？'); await page.getByTitle('发送消息', { exact: true }).click();
  // 调用记录留在 Node 侧的模拟服务器里，页面里读不到，所以在这里轮询。
  for (let i = 0; i < 80 && !calls.slice(callsBeforeGpt).some(c => c.path === '/v1/responses'); i++) await new Promise(resolve => setTimeout(resolve, 250));
  assert.ok(calls.slice(callsBeforeGpt).some(c => c.path === '/v1/responses' && c.data.model === 'gpt-4o'), 'gpt 模型应改走 Responses 协议');
  assert.ok(!calls.slice(callsBeforeGpt).some(c => c.path === '/v1/chat/completions'), '该次请求不应再走 Chat Completions');
  await page.evaluate(async fixture => { const s = await window.deepchan.load(); s.settings.connections.forEach(c => { if (c.id === fixture.connectionId) c.responsesForGpt = false; }); s.settings.models = s.settings.models.filter(m => m.id !== fixture.modelId); await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); }, gptSwitch);
  // Leave the app on the conversation the following stages expect, and drop the two throwaway chats
  // so the final conversation count still means "no extra conversation leaked".
  await page.evaluate(async payload => { const s = await window.deepchan.load(); s.conversations = s.conversations.filter(c => !payload.drop.includes(c.id)); s.selectedId = payload.keep; s.settings.useRecentModel = true; await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); }, { keep: resume, drop: throwaway });
  await waitFor(page, async id => { const s = await window.deepchan.load(); return s.selectedId === id && s.conversations.length === 4; }, resume);
  // Right click menus, and the timestamp shown on user messages.
  await page.locator('.conversation-item').first().click({ button: 'right' });
  const listMenu = page.locator('.conversation-popover');
  await listMenu.waitFor();
  const listMenuText = await listMenu.innerText();
  assert.match(listMenuText, /重命名/); assert.match(listMenuText, /删除会话/);
  await page.keyboard.press('Escape'); await listMenu.waitFor({ state: 'hidden' });
  await page.locator('.message.assistant').last().click({ button: 'right' });
  const messageMenu = page.locator('.message-context-menu');
  await messageMenu.waitFor();
  const messageMenuText = await messageMenu.innerText();
  assert.match(messageMenuText, /复制正文（Markdown）/); assert.match(messageMenuText, /重新生成并保留旧回答/); assert.match(messageMenuText, /查看请求详情/);
  await page.screenshot({ path: join(directory, 'message-context-menu.png') });
  await page.keyboard.press('Escape'); await messageMenu.waitFor({ state: 'hidden' });
  assert.match(await page.locator('.message.user .message-time').last().innerText(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  console.log('stage: context menus');
  saved = await page.evaluate(() => window.deepchan.load());
  assert.equal(saved.conversations.length, 4);
  assert.equal(logs.length, 0, logs.join('\n'));
  assert.ok(saved.conversations.every(c => c.titleState === 'done'), '关闭前所有标题已完成');
  // With WAL enabled the newest writes live beside the database, so both files are searched.
  const db = Buffer.concat([readFileSync(join(directory,'chat.sqlite')), existsSync(join(directory,'chat.sqlite-wal')) ? readFileSync(join(directory,'chat.sqlite-wal')) : Buffer.alloc(0)]);
  // Header names are kept on purpose so the debug view can show what was sent; credential values
  // must never reach the file, whether through the state JSON, the normalised tables or the
  // persisted request records.
  assert.ok(!db.includes(Buffer.from('Bearer fixture-secret')), '数据库不得包含 API Key 的值');
  assert.ok(!db.includes(Buffer.from('"header-secret"')), '数据库不得包含自定义请求头的值');
  const messageCount = saved.conversations.reduce((n,c) => n+c.messages.length,0);
  await desktop.close(); desktop = null;
  page = await launch();
  saved = await page.evaluate(() => window.deepchan.load());
  await assertUsageDetails(page, 72);
  // Attachment bytes no longer travel with the state, so after a restart the picture can only come
  // from the on-demand fetch; a broken lazy path shows up here as an image without its payload.
  const restoredImage = page.locator('.message img').first();
  await restoredImage.waitFor();
  assert.match(await restoredImage.getAttribute('src') || '', /^data:image\//, '重启后图片必须仍能通过按需加载显示');
  const storedAttachment = saved.conversations.flatMap(c => c.messages).flatMap(m => m.attachments).find(a => a.mime.startsWith('image/'));
  assert.ok(storedAttachment, '测试数据里应当有图片附件');
  assert.equal(storedAttachment.data, '', '广播出去的状态不应再携带附件载荷');
  // Request records are persisted with the conversation, so they survive a restart too.
  await page.locator('.message.assistant').last().getByRole('button', { name: '查看请求详情' }).click();
  const restoredDebug = page.locator('.attachment-viewer-window');
  await restoredDebug.waitFor();
  const restoredText = await restoredDebug.innerText();
  assert.match(restoredText, /第 1 次请求/, '重启后仍应能查看请求记录');
  assert.match(restoredText, /请求体/);
  assert.ok(!restoredText.includes('Bearer fixture-secret'), '重启后的请求记录同样不得泄露密钥');
  await page.keyboard.press('Escape');
  await restoredDebug.waitFor({ state: 'hidden' });
  console.log('stage: request log persisted');
  const legacyFixture = await page.evaluate(async () => {
    const s = await window.deepchan.load(), selectedId = s.selectedId;
    const c = structuredClone(s.conversations.find(c => c.id === selectedId));
    c.id = crypto.randomUUID(); c.title = '旧消息统计测试';
    for (const m of c.messages) if (m.usage) m.usage = { input: m.usage.input, output: m.usage.output };
    s.conversations.unshift(c); s.selectedId = c.id;
    await window.deepchan.save(s); window.dispatchEvent(new Event('deepchan-reload')); return { id: c.id, selectedId };
  });
  await page.locator('.header-title > span').getByText('旧消息统计测试', { exact: true }).waitFor();
  const legacyTrigger = page.locator('.message.assistant').last().getByRole('button', { name: /^查看回答详情：/ });
  await legacyTrigger.click();
  await waitFor(page, () => [...document.querySelectorAll('.usage-details dd')].filter(el => el.textContent === '--').length === 6);
  assert.deepEqual((await page.getByRole('tooltip').locator('dd').allTextContents()).slice(3), ['--','--','--','--','--']);
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
  assert.equal(credentials.secrets.deepseek, 'deepseek-fixture-secret', 'DeepSeek 搜索密钥应写入凭据文件');
  assert.equal(saved.settings.firecrawlKey, '••••••••'); assert.equal(saved.settings.anysearchKey, '••••••••'); assert.equal(saved.settings.deepseekKey, '••••••••', 'DeepSeek 密钥离开主进程前必须被掩码');
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
  const geminiCompression = geminiCalls.find(c => c.data.systemInstruction?.parts?.[0]?.text.includes('如果内容涉及创意写作'));
  assert.ok(geminiCompression, 'Gemini 应使用完整的创意写作压缩提示词');
  assert.equal(geminiCompression.data.generationConfig.maxOutputTokens, 50_000);
  assert.ok(geminiCalls.some(c => c.data.contents.some(m => m.role === 'model' && m.parts.some(p => p.thoughtSignature === 'fixture-signature'))), 'Gemini 多轮请求应保留思考签名');
  const branched = saved.conversations.find(c => c.branches.length > 1);
  assert.equal(branched.branches[0].config.system, '当前分支定制提示词。');
  console.log('stage: attachment viewer');
  const imageData = `data:image/png;base64,${(await page.screenshot({ type: 'png' })).toString('base64')}`;
  await page.evaluate(async imageData => {
    const state = await window.deepchan.load(), conversation = state.conversations.find(c => c.id === state.selectedId), branch = conversation.branches.find(b => b.id === conversation.activeBranchId);
    const message = { id: crypto.randomUUID(), parentId: branch.leafId, role: 'user', text: '查看附件预览', reasoning: '', attachments: [
      { id: crypto.randomUUID(), name: 'preview.png', mime: 'image/png', size: 1, data: imageData },
      { id: crypto.randomUUID(), name: 'notes.txt', mime: 'text/plain', size: 1, data: 'data:text/plain;base64,', markdown: '# 附件预览内容\n\n' + '这是附件正文。\n\n'.repeat(30) + '### 深层标题\n\n已在应用内打开。' },
      { id: crypto.randomUUID(), name: 'plain.txt', mime: 'text/plain', size: 1, data: 'data:text/plain;base64,', markdown: '这份文档没有标题。\n\n正文应占满查看区域。' },
      { id: crypto.randomUUID(), name: 'clip.mp4', mime: 'video/mp4', size: 1, data: 'data:video/mp4;base64,' }
    ], tools: [], sources: [
      { url: 'https://example.com/one', title: '第一条来源' },
      { url: 'https://example.com/two', title: '第二条来源' },
      { url: 'https://example.com/three', title: '第三条来源' }
    ], status: 'complete', created: Date.now() };
    conversation.messages.push(message); branch.leafId = message.id;
    await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
  }, imageData);
  const imageTrigger = page.getByRole('button', { name: '查看图片：preview.png' }); await imageTrigger.waitFor();
  // 来源默认收成一行，点一下才展开：一次搜索能带回十几条，全部铺开会把回答区撑得很长。
  const sourcesBox = page.locator('.message').last().locator('.sources');
  const lastSourcesOpen = want => page.waitForFunction(wanted => { const list = document.querySelectorAll('.sources'); return list[list.length - 1]?.hasAttribute('open') === wanted; }, want);
  assert.equal(await sourcesBox.locator('summary').count(), 1, '来源应是一个可展开的折叠块');
  assert.equal(await sourcesBox.evaluate(el => el.hasAttribute('open')), false, '来源默认收起');
  assert.equal(await sourcesBox.locator('.sources-list button').count(), 3, '展开后应有三条来源');
  const collapsedHeight = await sourcesBox.evaluate(el => el.getBoundingClientRect().height);
  await sourcesBox.locator('summary').click();
  await lastSourcesOpen(true);
  const expandedHeight = await sourcesBox.evaluate(el => el.getBoundingClientRect().height);
  assert.ok(expandedHeight > collapsedHeight, `展开后应更高：${collapsedHeight} -> ${expandedHeight}`);
  await sourcesBox.locator('summary').click();
  await lastSourcesOpen(false);
  await imageTrigger.click();
  const imageDialog = page.getByRole('dialog', { name: '查看附件：preview.png' }); await imageDialog.waitFor();
  assert.equal(await imageDialog.locator('.attachment-viewer-zoom span').innerText(), '100%');
  await imageDialog.getByRole('button', { name: '向左旋转' }).click();
  assert.match(await imageDialog.locator('.attachment-viewer-image').getAttribute('style'), /rotate\(270deg\)/);
  await imageDialog.getByRole('button', { name: '向右旋转' }).click();
  await imageDialog.getByRole('button', { name: '水平翻转' }).click();
  assert.match(await imageDialog.locator('.attachment-viewer-image').getAttribute('style'), /scale\(-1, 1\)/);
  await imageDialog.getByRole('button', { name: '垂直翻转' }).click();
  assert.match(await imageDialog.locator('.attachment-viewer-image').getAttribute('style'), /scale\(-1, -1\)/);
  await imageDialog.getByRole('button', { name: '水平翻转' }).click(); await imageDialog.getByRole('button', { name: '垂直翻转' }).click();
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: async items => { window.__clipboardImageTypes = items[0].types; } } });
    window.__savedImageName = '';
    HTMLAnchorElement.prototype.click = function() { window.__savedImageName = this.download; };
  });
  await imageDialog.getByRole('button', { name: '复制图片' }).click();
  await waitFor(page, () => window.__clipboardImageTypes?.includes('image/webp'));
  await imageDialog.getByRole('button', { name: '保存图片' }).click();
  await waitFor(page, () => window.__savedImageName === 'preview.webp');
  const viewport = imageDialog.locator('.image-viewer-content'); await viewport.hover(); await page.mouse.wheel(0, -300);
  await page.waitForFunction(() => Number(document.querySelector('.attachment-viewer-zoom span')?.textContent?.replace('%', '')) > 100);
  const viewportBounds = await viewport.boundingBox();
  const beforeDrag = await imageDialog.locator('.attachment-viewer-image').getAttribute('style');
  await page.mouse.move(viewportBounds.x + viewportBounds.width / 2, viewportBounds.y + viewportBounds.height / 2); await page.mouse.down();
  await page.mouse.move(viewportBounds.x + viewportBounds.width / 2 + 40, viewportBounds.y + viewportBounds.height / 2 + 30); await page.mouse.up();
  const afterDrag = await imageDialog.locator('.attachment-viewer-image').getAttribute('style');
  assert.notEqual(afterDrag, beforeDrag, '放大后可拖动图片');
  await page.keyboard.press('Escape'); await imageDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查看附件：notes.txt' }).click();
  const fileDialog = page.getByRole('dialog', { name: '查看附件：notes.txt' }); await fileDialog.waitFor();
  await fileDialog.getByRole('heading', { name: '附件预览内容' }).waitFor();
  const markdownOutline = fileDialog.locator('.attachment-viewer-outline');
  const markdownLayout = await fileDialog.evaluate(el => ({ contentLeft: el.querySelector('.attachment-viewer-markdown').getBoundingClientRect().left, outlineRight: el.querySelector('.attachment-viewer-outline').getBoundingClientRect().right }));
  assert.ok(markdownLayout.outlineRight <= markdownLayout.contentLeft + 1, 'Markdown 大纲应位于内容左侧');
  assert.deepEqual(await markdownOutline.locator('button').allTextContents(), ['附件预览内容', '深层标题']);
  await markdownOutline.getByRole('button', { name: '深层标题' }).click();
  assert.equal(await markdownOutline.getByRole('button', { name: '深层标题' }).getAttribute('class'), 'active');
  await fileDialog.getByRole('button', { name: '关闭附件预览' }).click(); await fileDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查看附件：plain.txt' }).click();
  const plainDialog = page.getByRole('dialog', { name: '查看附件：plain.txt' }); await plainDialog.waitFor();
  const plainLayout = await plainDialog.evaluate(el => ({ layout: el.querySelector('.attachment-viewer-markdown-layout').getBoundingClientRect(), content: el.querySelector('.attachment-viewer-markdown').getBoundingClientRect(), outlineCount: el.querySelectorAll('.attachment-viewer-outline').length }));
  assert.equal(plainLayout.outlineCount, 0, '无标题的 Markdown 文档应隐藏大纲');
  assert.equal(plainLayout.content.left, plainLayout.layout.left, '无标题时正文应从查看区域左侧开始');
  assert.equal(plainLayout.content.width, plainLayout.layout.width, '无标题时正文应占满查看区域');
  await plainDialog.getByRole('button', { name: '关闭附件预览' }).click(); await plainDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查看附件：clip.mp4' }).click();
  const videoDialog = page.getByRole('dialog', { name: '查看附件：clip.mp4' }); await videoDialog.waitFor();
  const videoSizing = await videoDialog.locator('video').evaluate(video => ({ objectFit: getComputedStyle(video).objectFit, width: video.getBoundingClientRect().width, height: video.getBoundingClientRect().height, parentWidth: video.parentElement.getBoundingClientRect().width, parentHeight: video.parentElement.getBoundingClientRect().height }));
  assert.equal(videoSizing.objectFit, 'contain'); assert.equal(videoSizing.width, videoSizing.parentWidth); assert.equal(videoSizing.height, videoSizing.parentHeight);
  await videoDialog.getByRole('button', { name: '关闭附件预览' }).click(); await videoDialog.waitFor({ state: 'hidden' });
  const versionFixture = await page.evaluate(async () => {
    const state = await window.deepchan.load(), conversation = state.conversations.find(c => c.id === state.selectedId), parentBranch = conversation.branches.find(b => b.id === conversation.activeBranchId);
    const user = { id: crypto.randomUUID(), parentId: parentBranch.leafId, role: 'user', text: '切换失败回答版本', reasoning: '', attachments: [], tools: [], sources: [], status: 'complete', created: Date.now() };
    const failed = { id: crypto.randomUUID(), parentId: user.id, role: 'assistant', text: '', reasoning: '', attachments: [], tools: [], sources: [], status: 'error', error: '模拟生成失败', modelId: parentBranch.config.modelId, created: Date.now() };
    const toolId = crypto.randomUUID();
    const complete = { id: crypto.randomUUID(), parentId: user.id, role: 'assistant', text: '第一段正文。最后一段正文。', reasoning: '第一次思考。第二次思考。', attachments: [], tools: [{ id: toolId, name: 'web_fetch', input: '{"url":"https://example.com/one"}', output: '读取完成', status: 'done', started: Date.now(), elapsed: 120 }], sources: [], status: 'complete', modelId: parentBranch.config.modelId, segments: [{ type: 'text', text: '第一段正文。' }, { type: 'reasoning', text: '第一次思考。' }, { type: 'tool', toolId }, { type: 'text', text: '最后一段正文。' }, { type: 'reasoning', text: '第二次思考。' }], created: Date.now() };
    conversation.messages.push(user, failed, complete);
    const makeBranch = (message, name) => ({ ...structuredClone(parentBranch), id: crypto.randomUUID(), name, parentBranchId: parentBranch.id, originId: message.id, leafId: message.id, summary: undefined, draft: '', draftAttachments: [], scrollTop: 0, updated: Date.now() });
    const failedBranch = makeBranch(failed, '失败回答分支'), completeBranch = makeBranch(complete, '成功回答分支');
    conversation.branches.push(failedBranch, completeBranch); conversation.activeBranchId = completeBranch.id;
    await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
    return { conversationId: conversation.id, userId: user.id, failedId: failed.id, completeId: complete.id, failedBranchId: failedBranch.id, completeBranchId: completeBranch.id };
  });
  const completeVersion = page.locator(`.message.assistant[data-id="${versionFixture.completeId}"]`); await completeVersion.waitFor();
  assert.deepEqual(await completeVersion.locator('.message-content, .thinking, .tool-card').evaluateAll(elements => elements.map(element => element.classList.contains('message-content') ? 'text' : element.classList.contains('thinking') ? 'reasoning' : 'tool')), ['text', 'reasoning', 'tool', 'text', 'reasoning']);
  const previousVersion = completeVersion.getByTitle('上一个版本'); assert.equal(await previousVersion.isDisabled(), false);
  await previousVersion.click();
  await waitFor(page, async ({ conversationId, branchId }) => { const state = await window.deepchan.load(); return state.conversations.find(c => c.id === conversationId).activeBranchId === branchId; }, { conversationId: versionFixture.conversationId, branchId: versionFixture.failedBranchId });
  const failedVersion = page.locator(`.message.assistant[data-id="${versionFixture.failedId}"]`); await failedVersion.waitFor();
  assert.equal(await failedVersion.getByTitle('下一个版本').isDisabled(), false, '失败回答之后仍可切换到下一个版本');
  await failedVersion.getByTitle('下一个版本').click();
  await waitFor(page, async ({ conversationId, branchId }) => { const state = await window.deepchan.load(); return state.conversations.find(c => c.id === conversationId).activeBranchId === branchId; }, { conversationId: versionFixture.conversationId, branchId: versionFixture.completeBranchId });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedAnswer = text; } } }));
  // The answer has two body blocks (a tool call and reasoning sit between them); copying takes both.
  await completeVersion.getByTitle('复制正文').click(); await waitFor(page, () => (window.__copiedAnswer || '').replace(/\s+/g, '') === '第一段正文。最后一段正文。');
  // Copy flavours: Markdown stays the toolbar behaviour, plain text drops the markers, rich text
  // also fills text/html. The stub only exposes writeText, so the plain fallback is observable.
  await completeVersion.getByTitle('复制正文').click({ button: 'right' });
  const copyMenu = page.locator('.message-context-menu'); await copyMenu.waitFor();
  const copyItems = await copyMenu.innerText();
  assert.match(copyItems, /复制正文（Markdown）/); assert.match(copyItems, /复制正文（纯文本）/); assert.match(copyItems, /复制正文（富文本）/);
  assert.doesNotMatch(copyItems, /复制选中/, '未选中文字时不应出现选区复制');
  await copyMenu.getByRole('menuitem', { name: '复制正文（纯文本）' }).click();
  await waitFor(page, () => (window.__copiedAnswer || '').replace(/\s+/g, '') === '第一段正文。最后一段正文。');
  // With a selection the menu offers the selection first, in both flavours.
  await completeVersion.locator('.message-content').first().evaluate(node => {
    const range = document.createRange(); range.selectNodeContents(node);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  });
  await completeVersion.getByTitle('复制正文').click({ button: 'right' });
  const selectionMenu = page.locator('.message-context-menu'); await selectionMenu.waitFor();
  assert.match(await selectionMenu.innerText(), /复制选中（纯文本）/);
  await page.screenshot({ path: join(directory, 'copy-menu-selection.png') });
  await selectionMenu.getByRole('menuitem', { name: '复制选中（纯文本）' }).click();
  await waitFor(page, () => (window.__copiedAnswer || '').includes('正文'));
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await completeVersion.getByTitle('编辑为新版本').click();
  const answerEditor = page.locator('.edit-box textarea');
  await page.locator('.edit-box .edit-bodies').waitFor();
  assert.deepEqual(await answerEditor.evaluateAll(nodes => nodes.map(node => node.value)), ['第一段正文。', '最后一段正文。'], '编辑应载入每一个正文段');
  assert.deepEqual(await answerEditor.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label'))), ['第 1 段正文', '第 2 段正文']);
  await page.screenshot({ path: join(directory, 'answer-editor.png') });
  const editorArea = page.locator('.edit-box .edit-bodies');
  const editLayout = await page.evaluate(() => {
    const scroller = document.querySelector('.message-scroll'), edit = document.querySelector('.edit-box'), actions = edit?.querySelector('.button-row');
    if (!scroller || !edit || !actions) throw new Error('编辑控件布局缺失');
    const scrollRect = scroller.getBoundingClientRect(), editRect = edit.getBoundingClientRect(), actionsRect = actions.getBoundingClientRect();
    const network = document.querySelector('.search-toggle'), options = document.querySelector('.composer-option');
    const networkRect = network.getBoundingClientRect(), optionsRect = options.getBoundingClientRect();
    const networkIcon = network.querySelector('svg').getBoundingClientRect(), optionsIcon = options.querySelector('svg').getBoundingClientRect();
    return { editorTop: editRect.top - scrollRect.top, actionsBottom: actionsRect.bottom, scrollBottom: scrollRect.bottom, networkHeight: networkRect.height, optionsHeight: optionsRect.height, networkIconSize: networkIcon.width, optionsIconSize: optionsIcon.width };
  });
  assert.ok(editLayout.editorTop >= 0 && editLayout.editorTop <= 20, '编辑框打开后应滚到视口顶部附近');
  assert.ok(editLayout.actionsBottom <= editLayout.scrollBottom, '取消和保存按钮应留在可视区域内');
  assert.ok(Math.abs(editLayout.networkHeight - editLayout.optionsHeight) < 1, '联网按钮与会话选项按钮应等高');
  assert.ok(Math.abs(editLayout.networkIconSize - editLayout.optionsIconSize) < 1, '联网图标与会话选项图标应等大');
  // The hint and the buttons share a row; shrinking the window to its minimum must not overlap them.
  const previousSize = await desktop.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; const size = window.getSize(); window.setSize(800, size[1]); return size; });
  await page.waitForTimeout(200);
  const footerLayout = await page.evaluate(() => {
    const footer = document.querySelector('.edit-box .edit-footer');
    const hint = footer?.querySelector('small'), actions = footer?.querySelector('.button-row');
    if (!footer || !hint || !actions) throw new Error('编辑区的提示或按钮缺失');
    const hintRect = hint.getBoundingClientRect(), actionsRect = actions.getBoundingClientRect();
    return { windowWidth: innerWidth, sameLine: Math.abs(hintRect.top - actionsRect.top) < 12, hintRight: hintRect.right, hintBottom: hintRect.bottom, actionsLeft: actionsRect.left, actionsTop: actionsRect.top };
  });
  assert.ok(footerLayout.windowWidth <= 820, `窗口应已收窄到最小宽度，实际 ${footerLayout.windowWidth}`);
  assert.ok(footerLayout.sameLine ? footerLayout.hintRight <= footerLayout.actionsLeft + 1 : footerLayout.hintBottom <= footerLayout.actionsTop + 1, `提示与按钮不得重叠：${JSON.stringify(footerLayout)}`);
  await desktop.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]), previousSize);
  await page.waitForTimeout(200);
  const editorHeight = (await editorArea.boundingBox()).height;
  assert.ok(editorHeight >= 300, '回答编辑框仍应有足够高度');
  assert.ok(editorHeight <= (await page.evaluate(() => innerHeight)) - 300, '回答编辑框应保持在视口可用高度内');
  await answerEditor.last().fill('改写后的最后正文。'); await page.getByRole('button', { name: '保存新版本' }).click();
  const editedSegments = await page.evaluate(async ({ conversationId, userId }) => {
    const conversation = (await window.deepchan.load()).conversations.find(c => c.id === conversationId);
    const edited = conversation.messages.find(message => message.edited && message.parentId === userId);
    return { text: edited.text, segments: edited.segments, toolCount: edited.tools.length };
  }, versionFixture);
  assert.equal(editedSegments.text, '第一段正文。\n\n改写后的最后正文。', '编辑后每段正文仍然分开保存');
  assert.deepEqual(editedSegments.segments.map(segment => segment.type === 'tool' ? 'tool' : `${segment.type}:${segment.text}`), ['text:第一段正文。', 'reasoning:第一次思考。', 'tool', 'text:改写后的最后正文。', 'reasoning:第二次思考。']);
  assert.equal(editedSegments.toolCount, 1);

  const thinkingFixture = await page.evaluate(async () => {
    const state = await window.deepchan.load(), conversation = state.conversations.find(c => c.id === state.selectedId), branch = conversation.branches.find(b => b.id === conversation.activeBranchId);
    const user = { id: crypto.randomUUID(), parentId: branch.leafId, role: 'user', text: '检查思考摘要自动收起', reasoning: '', attachments: [], tools: [], sources: [], status: 'complete', created: Date.now() };
    const answer = { id: crypto.randomUUID(), parentId: user.id, role: 'assistant', text: '', reasoning: '正在生成的思考摘要。', attachments: [], tools: [], sources: [], status: 'streaming', modelId: branch.config.modelId, created: Date.now() };
    conversation.messages.push(user, answer); branch.leafId = answer.id;
    await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
    return { conversationId: conversation.id, answerId: answer.id };
  });
  const thinking = page.locator(`.message.assistant[data-id="${thinkingFixture.answerId}"] .thinking`); await thinking.waitFor();
  await waitFor(page, async id => document.querySelector(`.message.assistant[data-id="${id}"] .thinking`)?.open === true, thinkingFixture.answerId);
  await page.evaluate(async ({ conversationId, answerId }) => {
    const state = await window.deepchan.load(), conversation = state.conversations.find(c => c.id === conversationId), answer = conversation.messages.find(m => m.id === answerId);
    answer.status = 'complete'; answer.text = '思考摘要结束后的回答。'; await window.deepchan.save(state); window.dispatchEvent(new Event('deepchan-reload'));
  }, thinkingFixture);
  await waitFor(page, async id => document.querySelector(`.message.assistant[data-id="${id}"] .thinking`)?.open === false, thinkingFixture.answerId);
  await thinking.locator('summary').click(); assert.equal(await thinking.evaluate(el => el.open), true, '回答完成后仍可手动展开思考摘要');
  console.log('stage: validation complete');
  console.log(`PASS: Electron desktop, 4 protocols including native Gemini, prompt preset library, auto title, branch isolation and failed-version switching, regeneration, manual edits, compression, aligned compact title rows, inline connection and role fields, image rotate/flip/copy/save/zoom/pan, Markdown outline and fitted video preview, ordered body/thinking/tool events, last-body copy/edit, tall answer editor, conversation search and Ctrl+F/Ctrl+I, icon-state networking toggle, tool-adjusted generation speed, resizable composer, bottom toolbar, reasoning levels and auto-collapse, default search, local credentials, answer dates, hover/click usage metrics and restart recovery. Screenshot: ${join(directory,'desktop.png')}`);
} finally {
  if (desktop) { await desktop.evaluate(({ app }) => app.exit(0)).catch(() => {}); await desktop.close().catch(() => {}); } server.close(); if (vite) await vite.close();
  // Keep the temporary fixture and screenshot for inspection, never mix with user data.
}
