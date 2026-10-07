# DeepChan-chat

Linux 桌面 LLM 聊天客户端。Electron + React + TypeScript，默认浅色主题，聊天数据保存在本机。

## 本地运行

要求 **Node.js 24 或更高版本**、npm，以及能运行 Electron 的 Linux 桌面环境。

```bash
npm install
npm run dev
```

`npm run dev` 启动 Vite 和 Electron。前端支持热更新，修改 `electron/` 中的主进程或 preload 后需要重启。关闭 Electron 窗口或在终端按 Ctrl+C，会关闭开发服务。当前无需打包。

Electron 44 首次使用时可能下载桌面运行时。如果网络需要代理，可使用：

```bash
ELECTRON_GET_USE_PROXY=1 npm run dev
```

Electron 的 Chromium 沙箱需要 Linux 正常配置用户命名空间。请以普通用户运行，不要使用 root 或关闭沙箱。极简系统可能还需要 GTK、NSS、GBM、音频等 Electron 系统库。

## 开始聊天

1. 打开左下角设置，添加 OpenAI Responses、OpenAI Chat Completions、Anthropic、DeepSeek（Anthropic Messages）、Gemini、Ollama、Ollama Cloud 或自定义兼容连接。
2. 填写 Base URL 和 API Key。地址可以包含 `/v1` 或 `/v1beta`，不要包含 `/responses`、`/messages` 等端点。
3. 测试连接获取模型列表，或手动添加供应商提供的准确模型 ID。
4. 根据模型文档填写上下文窗口、最大输出、图片、视频、音频、PDF、工具、原生搜索及思考能力。
5. 选择默认聊天模型。标题模型和压缩模型可以独立选择，也可以继承聊天模型。
6. 保存设置，新建对话。

“+ DeepSeek”预设使用 `https://api.deepseek.com/anthropic` 和 Anthropic Messages 协议，创建后连接名为“DeepSeek”，自动添加 `deepseek-flash`，上下文窗口为 1,000,000 token、最大输出为 256,000 token，启用图片输入、工具调用和原生搜索，思考参数默认选择“思考等级（effort）”。填写你自己的 API Key 后保存即可。自定义兼容服务新增模型时，思考参数默认选择“思考等级（effort）”，仍可按服务能力修改；GPT 和 DeepSeek 模型包含 `max` 等级。

Ollama 预设指向本地服务 `http://localhost:11434/v1`。Ollama Cloud 使用 OpenAI Chat 兼容协议和 `https://ollama.com/`，自动添加 `gemma4:31b`（上下文与最大输出均为 256,000 token），并启用图片输入、工具调用和视频输入。该模型的思考能力未知，因此默认选择“思考等级（effort）”，等级为 `minimal, low, medium, high`。Ollama Cloud Web Search 可使用其连接 API Key，或在“联网搜索”中单独填写 Ollama API Key。

手动添加和从服务端列表添加模型时，默认选择“思考等级（effort）”，未知模型默认支持 `minimal, low, medium, high`；GPT 和 DeepSeek 保留 `max` 等已知等级。上下文窗口默认为 1,000,000 token，最大输出为 65,536 token，可按实际模型能力修改；DeepSeek 预设模型保留专门配置的最大输出 256,000 token。

部分 Chat Completions 兼容服务只接受 `max_tokens`，或不支持 `stream_options`。可在模型配置中调整最大输出参数、关闭流式用量请求。

标题和历史压缩也会发起 API 请求，使用其各自配置的供应商并产生用量。界面显示的回答 token 用量来自服务返回；上下文预算估算系统提示词、历史、附件和工具结果，不从窗口中预留最大输出 token。最大输出仍作为生成上限发送给服务。

AI 回答不显示头像和前置模型标签；操作按钮右侧显示“模型名称·HH:mm”，悬停、键盘聚焦或点击可查看“模型名称 | 连接名称•YYYY-MM-DD·HH:mm”。悬停、键盘聚焦或点击回答下方的 token 信息可查看输入、缓存命中输入、输出、速度和首字耗时；点击可保持展开，再次点击、按 Esc 或点击外部可关闭。输入总量包含缓存读取和缓存写入，其中“输入（缓存）”只统计缓存命中读取量。速度为各轮输出 token 总量除以生成总耗时，包含思考、网络和搜索工具调用，不含请求前的历史压缩；首字耗时从生成请求开始计至第一段回答正文返回。Gemini 输出包含服务报告的思考 token。指标随消息保存，旧消息的计时、未返回的缓存统计显示“未提供”；多轮工具请求中任一轮未提供缓存统计时，也显示“未提供”。

## Gemini 原生协议

在“模型服务”点击“＋ Gemini”，默认地址为 `https://generativelanguage.googleapis.com/v1beta`，协议为 Gemini GenerateContent。填写 Gemini API Key 后，可以获取模型列表或手动填写模型 ID，支持 `gemini-…` 和 `models/gemini-…` 两种形式。应用通过 `x-goog-api-key` 认证，并使用 `streamGenerateContent?alt=sse` 流式接口。

Gemini 模型设置支持图片、视频、音频、PDF、Google Search 原生搜索及 Exa、Ollama Cloud、Tavily、Firecrawl、AnySearch 工具搜索。新增 Gemini 模型默认勾选图片、视频、音频、PDF、工具调用和原生搜索，仍可按实际模型修改。Qwen 模型新增时默认勾选图片、视频、工具调用和原生搜索。新增模型默认上下文窗口为 1,000,000 token、最大输出为 65,536 token，思考参数默认选择思考等级：Gemini 3 及以上可按模型支持范围配置思考等级（minimal、low、medium、high），Gemini 2.5 使用思考预算。思考摘要和签名由服务返回；后续对话保留签名，手动编辑回答后只发送编辑后的正文。标题和历史压缩也可选择 Gemini 模型。

## 系统提示词库 / 角色预设

设置页面的“系统提示词库”提供通用助手、编程助手、写作助手、翻译助手，并支持新增、编辑和删除角色、选择新对话的默认角色。完成修改后点击“保存设置”。提示词库保存在本地数据库中，并包含在结构化备份里。

在聊天输入框的“会话选项”中，通过“系统提示词 / 角色预设”选择角色。选择后会复制提示词到当前分支，下面的文本框可继续编辑。已有会话和其他分支不随库中的编辑或删除而改变；新分支继承创建时的提示词。升级旧数据时补充初始角色库，保留已有分支提示词。

## 已实现

- 三栏聊天界面，侧栏独立滚动、调整宽度、折叠；右侧问答大纲定位。
- 会话搜索、重命名、删除、归档与取消归档；已归档会话可在侧栏的归档视图中恢复。支持浅色、深色和跟随系统主题。
- 四种 API 协议适配、流式正文和可展示推理、停止生成、错误及部分回答保留。
- 图片选择、粘贴与“上传附件”文件选择，拖放支持图片和文件；每条消息最多 6 个附件、每个文件最多 10 MB。图片会去除元数据并缩至最长边 2048 像素。
- Markdown、表格、代码语法高亮、复制消息及代码。
- 用户提问和模型回答编辑、旧版本保留、重新生成及版本切换。
- 从已完成回答创建分支，嵌套分支、分支命名、删除及上下文隔离。
- 分支独立模型、系统提示词、搜索、思考等级、温度和 `top_p` 配置，输入草稿恢复。
- 首次有效回答后后台生成标题，手动改名优先。
- Responses/Anthropic/Gemini 原生搜索、Exa/Ollama Cloud Web Search/Tavily/Firecrawl/AnySearch 工具检索，以及 `web_fetch` 网页正文抓取与来源展示。
- 自动/手动历史摘要、最近两轮保留、原始记录保留和摘要路径校验。
- SQLite 本地保存、附件单独存放、异常中断恢复。
- 模型连接 API Key、Exa/Ollama/Tavily/Firecrawl/AnySearch 搜索密钥及自定义请求头默认保存在数据目录，重启自动读取；也可选择仅当前运行或系统加密保存。
- 结构化备份恢复及 Markdown 导出，默认不包含密钥与自定义请求头。
- 每个连接支持显式 HTTP/HTTPS 代理。

创建分支只改变本地路径，不调用模型，也不在左侧新增会话。编辑历史生成新路径，其他分支继续使用原版本。手动编辑助手回答时保留原工具证据供查看，但不重新发送旧签名或工具调用结构。

同一个会话一次只运行一个聊天或压缩任务。任务中可以切换查看其他分支，输出始终写入发起任务的分支。

## 搜索与思考

浮动提示显示在窗口正中间。聊天模型下拉框和顶栏以“模型名称 | 连接名称”显示。AI 回答的操作按钮右侧显示模型名称和回答时间，悬停、聚焦或点击可查看完整模型及连接名称、日期时间。GPT 和 DeepSeek 新增模型的思考等级包含 max。

聊天顶栏以单行显示标题、模型和分支。输入框贴近底部，不显示回答免责声明；拖动输入框顶部的短横条可调整高度，聚焦横条后也可用上下方向键调整，Home 恢复最小高度，End 展开至最大高度。高度调整在当前运行期间保留，并限制在窗口高度的 45% 以内（最多 420px）。

输入框下方的底部工具栏包含模型选择、思考等级、会话选项和联网开关，位于发送按钮左侧。温度（0–2）和 `top_p`（0–1）也在“会话选项”中设置，按当前分支保存，默认值均为 1；当前模型或协议的思考模式不接受采样参数时，控件会禁用。新对话默认启用自动联网，在“会话选项”中可选择搜索模式：

- **自动联网（默认）**：优先使用模型原生搜索，其次按 Exa、Ollama Cloud、Firecrawl、AnySearch、Tavily 的顺序使用已配置 Key 的服务；没有已配置搜索 Key 时使用 Firecrawl 免 Key 搜索。
- **关闭**：不启用工具搜索。
- **模型原生搜索**：Responses 使用 `web_search`，Anthropic 使用 `web_search_20250305`，Gemini 使用 `googleSearch`。要求服务端支持这些工具；Chat Completions 不支持统一原生搜索。
- **Exa**：在设置中填写独立密钥，由支持工具调用的模型触发检索，客户端向 Exa 请求结果。每次回答最多三轮工具调用，每轮最多三个查询。
- **Ollama Cloud Web Search**：在设置中填写 Ollama API Key，或复用 Ollama Cloud 连接的密钥；搜索请求发送到 `https://ollama.com/api/web_search`。
- **Tavily**：可在设置中填写 Tavily API Key；未填写时发送 `X-Tavily-Access-Mode: keyless`，使用 basic 搜索深度。
- **Firecrawl**：API Key 可选；无 Key 时使用官方限额内的搜索，有 Key 时可提高限额。搜索可返回 Markdown 正文。
- **AnySearch**：API Key 可选；无 Key 时使用匿名额度，有 Key 时可提高限额。
- **读取网页**：与联网搜索独立设置。自动模式先尝试已配置密钥的 Exa、Ollama Cloud、Tavily、Firecrawl、AnySearch，再尝试支持免 Key 的 Firecrawl、AnySearch、Tavily；都失败时回退到本地读取网页。也可以指定服务、本地读取网页或关闭。Tavily、Firecrawl、AnySearch 均可免 Key 读取网页；Ollama Cloud 可复用连接 API Key。
- **本地读取网页**：使用 Electron Chromium 网络栈的 `net.fetch`，遵循系统 / 浏览器代理设置；请求优先声明 `text/markdown`，HTML 会用 Defuddle 转为 Markdown。只允许公网 HTTP(S)，最多跟随 5 次重定向；响应上限 2 MB，送给模型的正文最多 20,000 字符。
- **联网按钮**：同时启用或关闭联网搜索和读取网页；两项仍可在会话选项中分别调整。

读取网页和外部服务搜索都要求模型支持工具调用。Tavily、Firecrawl 和 AnySearch 的读取网页 API 支持免 Key 调用，匿名额度可能受限。Gemini 原生 Google Search 与 `web_fetch` 同时使用需要 Gemini 3 或更新的模型；较早的 Gemini 模型需选择外部搜索模式，才能同时使用 `web_fetch`。

思考等级按模型配置的 `effort` 枚举发送；Anthropic 和 Gemini 还可设置 token 预算。推理区仅展示服务返回的摘要或文本，不推测内部思考。供应商协议会继续变化，自定义兼容服务需要按其文档配置能力。

## 数据路径与安全

默认保存在 Electron `userData` 下的 `data/`，常见路径为：

```text
~/.config/DeepChan-chat/data/chat.sqlite
~/.config/DeepChan-chat/data/attachments/
~/.config/DeepChan-chat/data/credentials.json
```

实际路径受 Linux 的 XDG 配置及 Electron 行为影响。可以指定隔离的数据目录：

```bash
DEEPCHAN_DATA_DIR=/tmp/deepchan-local npm run dev
```

使用自定义目录时，Electron 的浏览器配置也保存在该目录的 `profile/` 中。SQLite、附件和凭据文件设置为仅当前用户读写。默认的 `credentials.json` 以明文保存 API Key、搜索服务 Key 和自定义请求头，权限为 `0600`，适合随数据目录在本机恢复。设置中仍可改用仅当前运行，或在系统安全存储可用时加密保存到 SQLite。聊天正文没有加密。日志及错误会尽量脱敏认证信息。

渲染进程启用隔离和沙箱，密钥仅在输入时经过设置页，加载后的密钥显示占位符；网络、文件、数据库操作通过受限 IPC 交给主进程。远程 Markdown 图片不会自动加载，外链通过系统浏览器打开。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run test:desktop
```

无显示器的 Linux 环境可运行：

```bash
xvfb-run -a npm run test:desktop
```

桌面回归测试使用临时目录、本地模拟 API 和模拟密钥，不访问真实供应商、不产生 API 费用。覆盖四种协议和系统提示词库、自动标题、分支上下文隔离、回答版本、手动编辑、压缩、凭据文件权限、密钥重启恢复及默认联网行为。

当前验证使用模拟服务；真实供应商以及 Exa 的在线兼容性需要使用自己的账户验证。实际是否支持搜索、推理摘要、参数及模型列表取决于服务。

## 当前边界

- 不含安装包、账号、云同步、任意插件或命令执行、本地模型部署。
- 暂未实现 SOCKS 代理、系统代理自动探测、完整分支树可视化和全文搜索。
- 按模型能力原生发送图片、视频、音频和 PDF；模型不支持的文件类型尝试由 `@firecrawl/anydoc` 在本地转成 Markdown，支持 Word、PowerPoint、Excel、OpenDocument、RTF、EPUB、CSV 和 PDF，纯文本直接输入。转换默认不上传文件；扫描版 PDF 需要 OCR，视频和音频不支持转换，不支持或无法提取内容的格式会提示失败。
- 不自动重发已经接收内容的流式请求；明确重试会产生新请求。

完整产品要求见 [需求文档](docs/product-requirements.md)。
