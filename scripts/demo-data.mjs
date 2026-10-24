// 渲染进程里的模拟数据种子：配合隔离的 SEEKIE_DATA_DIR 使用，
// 不碰真实数据、不发任何网络请求。截图脚本和演示视频脚本共用同一套会话。
export async function seedDemoData() {
  const state = await window.seekie.load();
  const now = Date.now(), day = 86_400_000;
  // 侧栏按作息日分组（早上 6 点换日）：用"分组日中午"排时间，截图里才能稳定出现昨天、更早等分组。
  const scheduledNoon = daysAgo => { const shifted = new Date(now - 6 * 3600e3); shifted.setDate(shifted.getDate() - daysAgo); shifted.setHours(12, 0, 0, 0); return shifted.getTime() + 6 * 3600e3; };
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
    reasoning: '先把两边拆成几块来看：运行时从哪来、安装包多大、内存占多少，最后再谈调试和分发。\n\nTauri 复用系统自带的 WebView，体积小，但 WebView 版本跟着发行版走，同一个问题在 Ubuntu 和 Fedora 上表现可能不一样；Electron 自带 Chromium，代价是包大，但一份二进制放到哪都一样。\n\n用户问的是取舍，不是要一个结论，所以两种适用条件都要给出来，不能只推荐一个。',
    reasoningMs: 2100,
    segments: [
      { type: 'reasoning', text: '先把两边拆成几块来看：运行时从哪来、安装包多大、内存占多少，最后再谈调试和分发。\n\nTauri 复用系统自带的 WebView，体积小，但 WebView 版本跟着发行版走，同一个问题在 Ubuntu 和 Fedora 上表现可能不一样；Electron 自带 Chromium，代价是包大，但一份二进制放到哪都一样。\n\n用户问的是取舍，不是要一个结论，所以两种适用条件都要给出来，不能只推荐一个。', ms: 2100 },
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
  // 副分支真实由 fork() 从主线分出，父分支必须指向主线：截图要能展示分支菜单按父子
  // 关系缩进的树形，两个都写 null 会让它退化成两行平铺。
  const sideBranch = { id: uuid(), name: '只看内存占用', leafId: answer.id, originId: answer.id, parentBranchId: mainBranch.id, config, draft: '', draftAttachments: [], scrollTop: 0, updated: now - 90_000 };
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
  const weeklyBranch = { id: uuid(), name: '主线', leafId: weeklyAnswer.id, originId: null, parentBranchId: null, config, draft: '', draftAttachments: [], scrollTop: 0, updated: scheduledNoon(1) };
  const weekly = { id: uuid(), title: '把调研整理成周报', manualTitle: true, titleState: 'done', created: scheduledNoon(1), updated: scheduledNoon(1), activeBranchId: weeklyBranch.id, branches: [weeklyBranch], messages: [weeklyQuestion, weeklyAnswer] };

  const others = ['整理 Electron 主进程的启动流程', '把这段 SQL 改写成窗口函数', '周报：本周进展与下周计划', '给鲸鱼娘写一段角色设定'].map((title, index) => {
    const branchId = uuid(), at = scheduledNoon([2, 3, 4, 40][index]);
    return { id: uuid(), title, manualTitle: true, titleState: 'done', created: at, updated: at, activeBranchId: branchId, branches: [{ id: branchId, name: '主线', leafId: null, originId: null, parentBranchId: null, config, draft: '', draftAttachments: [], scrollTop: 0, updated: at }], messages: [] };
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
}
