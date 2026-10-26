# AGENTS.md

给在这个仓库里干活的编码 agent 看：命令、结构、约定、容易踩的坑。
产品行为看 [README](README.md)，需求看 [docs/product-requirements.md](docs/product-requirements.md)，这里不重复。

## 命令

| 命令 | 做什么 | 什么时候跑 |
| --- | --- | --- |
| `npm run check` | 类型检查 + 单元测试（`node:test`） | 改完必跑 |
| `npm run test:desktop` | 构建后用 Playwright 起真实 Electron 跑桌面回归 | 改了 UI / 交互 / IPC 必跑 |
| `npm run test:dev` | 起 Vite 开发服务，验证开发页与设置页能加载 | 改了入口或构建配置 |
| `npm run build` | 类型检查 + 前端打包 + 主进程打包 | 提交前 |
| `npm run dist:deb` | 打 Linux deb 到 `release/` | 发布前 |
| `npm run dist:appimage` | 打 Linux AppImage 到 `release/` | 发布前 |
| `npm run dist:win` | 打 Windows NSIS 安装包；在 Linux 上交叉构建需要 wine | 发布前 |
| `npm run dist:mac` | 打 macOS dmg；必须在 macOS 上运行 | 发布前 |
| `npm run record` | 用 ffmpeg 录一段 1440×900 的界面演示到 `release/seekie-chat-demo.mp4`；无显示器时套 `xvfb-run -a -s "-screen 0 1440x900x24"` | 需要更新演示视频时 |

- 类型检查通过**不代表**改对了：`check` 里还有一百多个单测，`test:desktop` 覆盖真实窗口。
- `test:desktop` 与 `test:dev` 都要能创建窗口。有显示器就直接跑；纯 SSH / CI 才需要 `xvfb-run -a`。
- 冒烟一次约 2–3 分钟，别在循环里反复跑。
- 想隔离数据目录：`SEEKIE_DATA_DIR=/tmp/seekie-local npm run dev`。

## 结构

- `electron/` 主进程：网络、密钥、SQLite、工具执行、任务生命周期。
- `src/domain.ts` 两端共用的纯逻辑。新能力优先做成这里的纯函数 + 单测。
- `src/App.tsx` 只做状态与编排；UI 拆在 `Composer` / `MessageRow` / `Sidebar` / `OutlinePanel` / `Settings`，浮层行为在 `usePopover`。
- `tests/` 单测；`scripts/smoke.mjs` 是桌面回归。
- `docs/screenshots/` 是 README 与 `docs/screenshots.md` 用的界面图，由 `node scripts/screenshots.mjs` 用模拟数据重新生成（不含真实数据）；改了 UI 记得重跑。
- `build/` 图标素材；`dist/`、`dist-electron/`、`release/` 都是生成物，不要手改。

## 风格

- 2 空格缩进，单引号，中文注释。
- 注释写**为什么**，不写**是什么**。现有代码里大量注释解释取舍，跟着这个习惯走。
- 大文件里允许并排的长行 JSX，跟着现有写法，不要为了"更整洁"重排。

## 提交信息

```
标题一行

- 先讲为什么，再讲怎么做
- 写清楚取舍：放弃了什么、为什么
- 交代验证方式
- README 与需求文档同步。
```

标题与正文之间**必须有空行**，否则 `git log --oneline` 会把整段挤成一行。

## 坑

- 样式都在 `src/styles.css`。它里面有多层覆盖块，**后面的规则赢**。改之前先看文件尾部，别照着前面的值算（对话页顶栏实际是 32px，前面写的是 48px）。
- 密钥在离开主进程前被替换成 `••••••••`。渲染层的草稿和磁盘上的值不是一回事，`store.resolveSecrets` 负责还原。
- 设置页是"草稿 + 自动保存"：`dirty` / `version` 两个 ref 管有没有未写盘的改动；导入备份必须置 `skipSave`，否则页面里的旧草稿会覆盖刚恢复的数据。
- `scripts/smoke.mjs` 是单个约 1500 行的文件，所有断言在同一个作用域里。别用 `layout` / `tools` / `state` / `input` 这类常见名——撞名会直接语法错误、整个冒烟跑不起来。加新断言用带前缀的名字（如 `aboutLayout`）。
- 侧栏是**虚拟列表**：只有视口内（上下各多渲染 8 行）的会话在 DOM 里。断言别去数 `.conversation-item` 节点，按 `data-id` 滚动收集；`.conversation-group` 里还混着吸顶用的覆盖层，检查分组顺序要限定在 `.conversation-rows .conversation-group`。行距是运行时量出来的，改侧栏样式后不必调常量，但**别把行高写死**。
- 侧栏列表空白处的右键菜单复用会话菜单那套状态与定位，只把 id 换成 `Sidebar.tsx` 导出的 `LIST_MENU` 伪 id（`menuConversation` 查不到就是它）。加新菜单项时记得那个三元分支；行上的右键靠 `closest('.conversation-item')` 让位，别改成 `stopPropagation`——`.conversation-more` 的按钮也在行里。
- 侧栏多选：勾选集合是渲染层的临时状态（不进 `AppState`、不进备份，切换归档视图时清空）。批量归档走 `selectionChanges` + `saveFields`，批量删除仍走整份保存。**多选时右键菜单作用于勾选项**，文案必须带条数（`删除选中的 3 个对话`）——「删除」在单条与批量两种作用域下长得一样是最容易误操作的地方；右键落在未勾选的行上时先把它变成唯一选中（资源管理器的惯例），菜单随之退化成单条语义。多选菜单因此比单条菜单宽（`.selection-menu`），别把这条放宽规则挪到共用的 `.conversation-popover` 上。复选框必须是 `.conversation-item` 的直接子元素——`input` 嵌在 `button` 里不合法；它按会话图标那 15px + 8px 间距对齐，所以标题不会左右跳，改这一列的样式要连着看虚拟列表量出来的行高。
- 删除会话的「短期撤销」整个放在主进程里，别在渲染层做快照：`handle('save')` 收到 `undoIds` 时只把那些会话 `store.hold()` 起来 + 15 秒计时，`closeGrace()` 里补的那一次保存才真删行、删附件文件、删请求记录。`Store.save` 写盘前会把 held 里的会话并进副本，所以宽限期内的**任何**一次保存（流式落盘也算）都不会把它们清掉。撤销提示是 12 秒，比窗口短 3 秒——改一个必须改另一个。`import` 与 `before-quit` 都要先 `closeGrace(false)`，否则已删的会话会跟着导入的状态或下次启动复活（被强杀时留一份比误删一份好）。`undo-delete` 只改内存再 `emit(true)`，不保存。**普通保存不能关掉宽限期**——`closeGrace` 只在「新的可撤销删除」和「导入 / 退出」时调用；放在 `save` 开头会让「12 秒可撤销」在下一次流式落盘时悄悄失效。
- 窗口布局（尺寸、是否最大化、大纲栏开合）不走 `AppState`：它存在数据库单独的 `window_layout` 一行里，由主进程读写，渲染层只借 `window-layout` / `window-outline` 两个通道拿大纲栏那一项。别把它塞进 `Settings`——那样备份导出会把本机窗口尺寸带到另一台机器上，恢复备份还会顺手改掉你的窗口，而布局本身也不必跟着每次广播跑一遍。
- 改「选择 / 切换分支 / 改名 / 归档」这类标量状态时，把字段加进 `src/domain.ts` 的 `applyStateChanges` 白名单并走 `saveFields`，别退回整份保存——那会把整个会话树搬两遍。删除类操作反过来：它要连带清理附件与请求记录，仍然走整份保存。
- 冒烟脚本中途会关掉应用再重启。**重启前抓的 locator 会失效**，之后必须从 `page` 重新取，不能复用之前的 `const`。
- `.chat-header` 与 `.settings-header` 的高度要彼此对齐，也和窗口控件对齐；改一个记得看另外两个。
- AppImage 的压缩用 **zstd**，别改回 xz。xz 能把包压到约 99 MB（zstd 约 123 MB），但 squashfs 的 xz 解压慢，而 AppImage 是按需解压：启动要等一大截才出窗口，出窗口后正文还要再等。gzip 与 zstd 体积都在 123 MB 上下、启动明显更快，取 zstd（同体积下压缩率略好）。想省体积就去压应用本身（见 `dependencies` 那条），别在压缩算法上抠。
- `package.json` 的 `dependencies` 只放**运行时真加载**的包（目前只有 `undici` 与 `@firecrawl/anydoc`）。electron-builder 会把 `dependencies` 整包复制进 asar，而渲染层用的库已经被 Vite 打进 `dist/`、`defuddle`/`linkedom` 已被 esbuild 内联进 `main.cjs`——把它们留在 `dependencies` 就是白带几十 MB。往 `scripts/build-electron.mjs` 的 `external` 里加包之前，先确认它同时在 `dependencies` 里。
- `MessageRow` 用自定义 `propsEqual`（消息本身靠 `sameMessage` 逐字段比较），`Markdown` 用默认浅比较、只认 `text`。**新增 `Message` 字段或给消息行加 prop 时，必须同时加进 `sameMessage` / `propsEqual`**，否则那一行不会更新——表现是界面停在旧内容而不是报错，很难联想到 memo。
- 若冒烟偶发失败在**悬停 / 浮层**类断言上，先重跑一次：本机 GPU 进程会反复崩，渲染节流会让这类断言抖动。
- 发版时三处要一起改：`package.json` 的 `version`、README 顶部的版本徽章（静态徽章不会自动更新）、README 里出现版本号的路径示例。
- 推 `v*` 标签会触发 `.github/workflows/release.yml` 在 Linux/Windows/macOS 三个 runner 上打包并发布到 Releases；标签号必须与 `package.json` 的 `version` 一致，否则构建先失败。不想发版时用 workflow_dispatch 手动跑，只产 Actions Artifacts。

## 别做

- 别为了"看起来更整洁"重排大段 JSX、拆文件或改格式——diff 会淹没真正的改动。
- 别把功能说明写进这份文件，那是 README 的活。
- 别在没跑 `npm run check` 和 `npm run test:desktop` 的情况下提交 UI 改动。
