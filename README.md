# Yobi

> 当前项目仍处于早期开发阶段，整体产品形态、交互细节和能力边界都还在持续迭代中。

Yobi 是一个基于 Electron 的桌面 AI 陪伴应用。它不只是一个聊天窗口，而是一套持续运行的桌面 AI 陪伴系统：本地控制台、多消息通道、长期记忆、主动行为、桌宠、语音、定时任务、Skills 与工具系统都由同一套主进程协调。

Yobi 的核心定位是：**一个带桌面形态、长期记忆和主动行为能力的多通道桌面 AI 陪伴系统**。

## 项目亮点

与传统的 AI 陪伴产品相比，Yobi 的目标不只是提供“更像人的聊天”，而是把陪伴做成一个真正可持续运行的桌面 AI 陪伴系统。

- **桌面原生陪伴，而不只是应用内聊天**：Yobi 可以常驻桌面，以 Live2D 桌宠、本地控制台和后台运行的方式持续陪伴，而不是把关系局限在一个聊天窗口里。
- **实时语音更接近自然交流**：Yobi 支持实时语音对话，回复过程中可以随时打断，配合 `ptt / free` 两种模式和桌宠按住说话，让交流更像真实对话而不是一问一答。
- **一个角色，多入口连续存在**：同一套记忆、状态和人格可以在本地控制台、Telegram、QQ、飞书之间延续，避免传统产品里“换个入口就像换了一个人”的割裂感。
- **情感系统和记忆系统一起工作**：Yobi 不只是保存聊天记录，还会持续维护情绪、关系变化、用户画像和长期记忆，让它不只是“记得你说过什么”，也会随着互动慢慢发生变化。
- **主动性更强，也更可控**：它不仅会在合适的时候主动发起对话，还支持沉默阈值、夜间静默、外部推送目标、定时任务和素材同步，让主动行为更像“有判断的陪伴”，而不是机械提醒。
- **陪伴与执行能力融合**：除了聊天，Yobi 还可以接浏览器、文件、系统、搜索、MCP、Skills 等能力，在安全开关和审批机制下真正帮你完成事。
- **本地优先、可扩展、可审计**：数据目录、模型、工具权限、Skill 资源、运行参数都在本地可见可配，更适合希望长期拥有、持续调教这个陪伴体的用户。


## 功能概览

### 对话与通道

- **本地控制台聊天**：支持流式回复、历史回放、工具调用日志、审批面板和麦克风输入。
- **Telegram 通道**：支持文本 / 图片输入，机器人可发送文本、图片与语音。
- **QQ 通道**：支持 QQ 机器人 C2C 私聊接入，文本 / 图片入站；回消息受平台被动回复窗口限制。
- **飞书通道**：支持飞书机器人私聊（长连接事件模式），文本 / 图片入站，并支持流式文本回推。

### 陪伴形态

- **Live2D 桌宠**：独立桌宠窗口、置顶、情绪 / 思考状态联动。
- **全局按住说话**：可录制全局快捷键，用于桌宠 PTT。
- **实时语音模式**：支持启动实时语音会话，并区分 `ptt / free` 两种模式。
- **后台保活**：可启用防休眠，让内核运转、主动行为和调度器持续可用。

### AI 系统与记忆

- **Provider + 模型路由**：内置 OpenAI、Anthropic、OpenRouter，也支持任意 OpenAI-compatible Provider。
- **三套路由**：聊天、事实提取、反思可分别指定模型。
- **长期记忆系统**：包含 `SOUL / RELATIONSHIP / STATE / PROFILE / FACTS / EPISODES`。
- **Memory 页面**：可编辑 `SOUL / RELATIONSHIP`，查看快照，手动触发内核 Tick / 每日任务，以及重置局部记忆。
- **混合检索**：默认启用本地 embedding + BM25；向量模型未就绪时会自动回退到词法检索。
- **后台反思**：内核会维护事实提取、画像更新、反思与任务队列。

### 主动行为与外部素材

- **主动聊天**：支持冷启动延迟、冷却时间、沉默阈值和夜间静默时段。
- **推送目标**：主动消息可仅本地展示，也可推送到 Telegram / 飞书。
- **Bilibili 素材同步**：当前“浏览同步”实现聚焦 B 站，可扫码登录或手动填 Cookie，支持立即同步、定时自动同步与少量自动关注新 UP。

### 工具、技能与扩展

- **内置工具开关**：浏览器工具、系统工具、文件工具、Exa 搜索都可单独启停。
- **工具安全控制**：系统命令支持白名单 / 阻止规则 / 高风险审批；文件工具支持读写分级与路径白名单。
- **定时任务**：支持一次性任务和 Cron；动作可为提醒，或定时执行 Agent 任务。
- **Skills**：可导入包含 `SKILL.md` 的目录到本地技能库，并在控制台会话中按需激活。
- **MCP**：支持自定义 MCP Server 的 JSON 导入 / 导出与启停管理。
- **说明**：Exa 搜索是内置工具，不需要在 MCP 页面额外添加 Exa Server。

### 运行状态与可观测性

- **仪表盘**：集中展示 Telegram / QQ / 飞书连接状态、主动聊天、语义记忆、后台 Worker、桌宠与权限状态。
- **Token 统计**：按今日 / 7 天 / 30 天聚合，区分聊天与后台任务来源；优先使用 provider usage，缺失时回退估算。
- **系统权限管理**：在应用内查看并引导授权辅助功能、麦克风和屏幕录制权限。

## 页面导航

当前侧边栏包含以下页面：

- `仪表盘`：系统状态、权限、Token 统计、后台运行情况
- `聊天`：本地控制台会话、历史、工具日志、审批
- `定时任务`：提醒 / Agent 任务的创建、编辑、暂停、立即执行、运行记录
- `Skills`：本地技能的导入、启停、预览、删除
- `Provider`：Provider 管理与模型路由配置
- `记忆`：SOUL / RELATIONSHIP / STATE / PROFILE / FACTS / EPISODES 快照与维护
- `MCP`：自定义 MCP Server 的 JSON 管理
- `设置`：通道、语音、桌宠、主动行为、Bilibili、记忆参数、工具权限

## 代码结构

```text
src/
├── main/       # Electron 主进程：运行系统、通道、工具、记忆、调度、桌宠、IPC
├── renderer/   # React 界面：仪表盘、聊天、设置、Memory、MCP、Skills 等页面
├── shared/     # 主进程 / 渲染进程共享类型与配置 schema
└── preload/    # contextBridge 暴露给前端的安全 IPC API
```

如果你要继续读代码，优先看这些入口：

- `src/main/index.ts`：Electron 启动与窗口生命周期
- `src/main/app-runtime.ts`：应用级运行系统的组装与启动顺序
- `src/main/runtime/`：运行状态、生命周期、通道与数据协调器
- `src/main/kernel/`：持续运转内核、事件队列、任务处理
- `src/renderer/App.tsx`：页面装载与整体 UI 框架

## 快速启动

```bash
npm install
npm run dev
```

首次启动后，应用会在本机创建 `~/.yobi/` 作为数据目录。

## 推荐配置顺序

### 1) 先配置 Provider 与模型路由

在 `Provider` 页面至少完成以下配置：

- 至少 1 个可用 Provider（API Key）
- `chat` 路由模型
- `factExtraction` 路由模型
- `reflection` 路由模型

> 模型名为手动输入，兼容 OpenAI-compatible 服务。

### 2) 再选择语音方案（可选）

设置页支持：

- **ASR**：`none` / `sensevoice-local` / `alibaba`
- **TTS**：`edge` / `alibaba`

说明：

- 本地 SenseVoice 首次使用时可在设置页直接下载 `SenseVoice-Small INT8` 模型。
- 默认语义记忆 embedding 也会在后台尝试准备本地 GGUF；未就绪时系统自动回退为 BM25-only。
- 修改语音 provider 或凭证后，配置会自动保存，运行时会自动切换引擎。

### 3) 按需开启消息通道

- **Telegram**：填写 `Bot Token`、`Chat ID`
- **QQ**：填写 `App ID`、`AppSecret`
- **飞书**：填写 `App ID`、`App Secret`

不配置任何外部通道也可以正常使用本地控制台。

### 4) 按需启用桌宠

仓库不包含完整 Live2D 模型；需要在设置页自行导入模型目录。

- 在 `设置 -> 后台与桌宠` 点击 `导入模型`
- 目录内至少包含一个 `*.model3.json`
- 导入后模型会复制到 `~/.yobi/models/`，并自动写入配置

构建时会自动执行 `npm run prebuild:live2d-core`，下载 `live2dcubismcore.min.js` 到 `resources/`。

### 5) 按需打开工具、MCP、Skills 与调度器

- 在 `设置 -> 工具` 里启用浏览器 / 系统 / 文件 / Exa 搜索
- 在 `MCP` 页面导入自定义 MCP Server JSON
- 在 `Skills` 页面导入包含 `SKILL.md` 的目录
- 在 `定时任务` 页面创建提醒或 Agent 任务

## macOS 常见问题

### 应用打开后提示“移到垃圾桶”

如果下载的 `.app` 还没签名公证，macOS 可能提示“已损坏 / 应移到垃圾桶”。

1. 先把应用移动到 `/Applications`
2. 执行：

```bash
xattr -dr com.apple.quarantine /Applications/Yobi.app
```

3. 回到 Finder 里右键应用，选择“打开”

### 权限提示

如果你要使用以下能力，通常需要额外授权：

- **辅助功能**：全局按住说话、部分系统控制能力
- **麦克风**：语音输入 / 实时语音
- **屏幕录制**：截图与部分桌面能力

这些权限可以直接在 `仪表盘` 页面里查看并引导授权。

## 数据目录

运行后会在本机创建：

```text
~/.yobi/
├── config.json
├── soul.md
├── relationship.json
├── state.json
├── runtime-context.json
├── scheduled-tasks.json
├── scheduled-task-runs.jsonl
├── memory/
│   ├── facts.json
│   ├── facts-archive.json
│   ├── fact-embeddings.json
│   ├── facts.sqlite
│   ├── profile.json
│   ├── episodes/
│   ├── reflection-queue.json
│   ├── reflection-log.json
│   ├── pending-tasks.jsonl
│   └── dead-letter.jsonl
├── sessions/main/
│   ├── buffer.jsonl
│   ├── unprocessed.jsonl
│   └── archive/
├── browse/bilibili/
│   ├── feed.json
│   ├── hotlist.json
│   ├── watched.json
│   └── state.json
├── token-stats/
│   └── state.json
├── models/
│   ├── embedding/
│   ├── whisper/
│   ├── sensevoice/
│   └── vad/
├── browser-profile/
├── skills/
├── skills-registry.json
└── logs/
```

按功能启用后，还可能出现：

```text
~/.yobi/
└── tool-media/   # 浏览器 / 系统截图等工具产物
```

## 开发命令

```bash
npm run dev
npm run preview
npm run typecheck
npm run test
npm run build
npm run dist:mac
npm run dist:win
```

## License

`AGPL-3.0-only`
