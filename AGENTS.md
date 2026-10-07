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

- 类型检查通过**不代表**改对了：`check` 里还有一百多个单测，`test:desktop` 覆盖真实窗口。
- `test:desktop` 与 `test:dev` 都要能创建窗口。有显示器就直接跑；纯 SSH / CI 才需要 `xvfb-run -a`。
- 冒烟一次约 2–3 分钟，别在循环里反复跑。
- 想隔离数据目录：`SEEKIE_DATA_DIR=/tmp/seekie-local npm run dev`。

## 结构

- `electron/` 主进程：网络、密钥、SQLite、工具执行、任务生命周期。
- `src/domain.ts` 两端共用的纯逻辑。新能力优先做成这里的纯函数 + 单测。
- `src/App.tsx` 只做状态与编排；UI 拆在 `Composer` / `MessageRow` / `Sidebar` / `OutlinePanel` / `Settings`。
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
- 冒烟脚本中途会关掉应用再重启。**重启前抓的 locator 会失效**，之后必须从 `page` 重新取，不能复用之前的 `const`。
- `.chat-header` 与 `.settings-header` 的高度要彼此对齐，也和窗口控件对齐；改一个记得看另外两个。
- 若冒烟偶发失败在**悬停 / 浮层**类断言上，先重跑一次：本机 GPU 进程会反复崩，渲染节流会让这类断言抖动。

## 别做

- 别为了"看起来更整洁"重排大段 JSX、拆文件或改格式——diff 会淹没真正的改动。
- 别把功能说明写进这份文件，那是 README 的活。
- 别在没跑 `npm run check` 和 `npm run test:desktop` 的情况下提交 UI 改动。
