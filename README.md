# Yobi

Yobi 是一个运行在桌面端的 AI 陪伴应用，基于 Electron 构建，集成了 Telegram 消息通道、Live2D 桌宠和多种 AI 能力。它不只是一个被动应答的聊天机器人——Yobi 拥有长期记忆，能在后台默默回顾你们的对话，并在合适的时机结合最近聊天语境主动找你聊天。你可以通过 Telegram 随时和它交流，也可以在本地控制台进行更深度的对话；桌面上的 Live2D 桌宠会根据对话内容实时切换情绪和动作，让陪伴有温度也有画面。

## 主要功能

- 本地控制台聊天（支持流式回复）
- Telegram 双向消息（文本、图片输入；文本、语音输出）
- 持续运转内核（tick + 事件优先级 + 异步任务队列）
- 主动聊天（内核驱动，支持夜间静默与会话恢复）
- 三层记忆（buffer / facts / episodes）
- Mind Center（SOUL 可编辑，STATE/PROFILE/FACTS/EPISODES 可视化）
- 回想与反思（日常任务：TTL 清理、Episode 生成、画像语义更新、反思）
- 浏览同步服务（同步兴趣偏好与近期素材）
- MCP 工具能力（支持 stdio / remote Server）
- 定时任务系统（一次性 / Cron 调度，支持提醒与工具执行）
- Live2D 桌宠（情绪/说话/思考动作联动）
- 可选工具能力：浏览器工具、系统工具、文件工具（带开关与审批）

## 回想服务

回想服务是 Yobi 的"反刍"机制。Yobi 会在后台定期回顾你们之间的对话和已有的记忆，做两件事：一是整理记忆——把重复的信息合并，把已经过时的内容更新（比如你换了工作，旧的职业信息会被替换），把新出现的值得记住的事实补充进来；二是从你的视角梳理最近值得跟进的上下文——你提过的还没跟进的事情（即将到来的考试、面试、旅行计划），或者最近对话中流露的情绪变化。等到你沉默了一段时间后，Yobi 会结合这些最近语境，以符合角色性格的方式主动找你聊天——而不是干巴巴地问"你在干嘛"。

## 浏览同步服务

闲逛服务是 Yobi 的"好奇心"机制。当 Yobi 对你足够了解之后，它会像一个会主动帮你刷资讯的朋友，根据你的兴趣和近况去互联网上搜索你可能感兴趣的内容。

搜索方向不是泛泛地搜"科技新闻"，而是根据它对你的了解来规划——如果它记得你最近在学 Rust，可能就会去搜最新的异步运行时进展；如果你提过想去日本旅行，可能会搜当季的旅行攻略。搜索到结果后，Yobi 会从中挑出最有意思的一个点，用一句口语化的话概括，像朋友闲聊时会随口说的那种。如果这轮搜索没找到什么有价值的内容，就安静地跳过，不会硬凑。

这部分同步结果主要用于补充近期事实和兴趣偏好，本身带有时效性；如果这轮没有值得保留的内容，系统会安静地跳过，不会强行生成额外打扰。

## 快速启动

```bash
npm install
npm run dev
```

## macOS 打开后提示“移到垃圾桶”

如果下载的 `.app` 还没签名公证，macOS 可能提示“已损坏/应移到垃圾桶”。

1. 先把应用移动到 `/Applications`
2. 执行：

```bash
xattr -dr com.apple.quarantine /Applications/Yobi.app
```

3. 回到 Finder 里右键应用，选择“打开”

## 必须配置

### 1) Provider 和模型路由（必配）

在界面「Provider 与模型路由」中配置：

- 至少 1 个可用 Provider（API Key）
- 聊天 / 记忆模型

> 模型名是手动输入，兼容 OpenAI-compatible 服务。

### 2) Telegram（可选）

在「设置 -> Telegram 通道」填写：

- `Bot Token`
- `Chat ID`

不填也能用（本地控制台可正常聊天）。

### 3) Live2D 桌宠（可选）

由于授权原因，仓库不包含完整模型。用户 `clone` 后需自行下载模型并配置目录。

构建时会自动下载 `live2dcubismcore.min.js` 到 `resources/`（默认源：`cubism.live2d.com`），无需让终端用户手动下载。

- 在「设置 -> 后台与桌宠」点击 `导入模型`
- 目录里至少要有一个 `*.model3.json`

导入后会自动复制到 `~/.yobi/models/` 并写入配置，不需要手动填路径。

容错行为：

- 路径为空/不存在：桌宠关闭，不影响主程序
- 找不到 `model3.json`：桌宠走 fallback，不会崩
- 动作不完整：自动兜底匹配，不会因缺动作直接报错

### 4) MCP 工具中心（可选）

- 在侧边栏 `MCP` 页面可查看/管理 MCP Server
- 支持 JSON 导入导出（导入为追加/按 id 更新）
- 内置 `exa` Server 默认可用（remote：`https://mcp.exa.ai/mcp`）
- 非内置 Server 支持单独开关

### 主动聊天参数（可选）

在「设置 -> 主动聊天参数」可以配置：

- 主动消息冷却时间、沉默触发阈值
- 夜间静默时段（支持跨天，例如 `23:00-07:00`）
- `主动消息仅本地展示`（开启后仅本地展示；关闭后按最近外部通道 best-effort 推送）

说明：

- Telegram 推送可回落到配置的 `Chat ID`
- QQ 推送受平台被动回复窗口限制，窗口外会自动跳过并记录日志

## 数据目录

运行后会在本机创建：

```text
~/.yobi/
├── config.json
├── soul.md
├── state.json
├── characters/default.json
├── memory/
│   ├── facts.json
│   ├── facts-archive.json
│   ├── profile.json
│   ├── episodes/
│   ├── reflection-queue.json
│   ├── reflection-log.json
│   └── pending-tasks.jsonl
├── sessions/main/
│   ├── buffer.jsonl
│   ├── unprocessed.jsonl
│   └── archive/
├── topics/
│   ├── pool.json
│   └── interest-profile.json
├── scheduled-tasks.json
├── scheduled-task-runs.jsonl
├── runtime-context.json
├── models/
└── logs/
```

按功能启用后还可能出现：

```text
~/.yobi/
├── browser-profile/   # 启用浏览器工具后
└── tool-media/        # 浏览器/系统截图等工具产物
```

## 开发命令

```bash
npm run dev
npm run typecheck
npm run build
```
