# Yobi

桌面 AI 陪伴应用（Electron + Telegram + Live2D 桌宠）。

## 主要功能

- 本地控制台聊天（支持流式回复）
- Telegram 双向消息（文本、图片输入；文本、语音输出）
- 主动聊天（沉默触发 + 话题池驱动）
- 长期记忆（自动提炼 + 手动管理，支持长期记忆条数上限配置）
- 回想服务（后台定时提炼记忆，并生成可跟进话题）
- 闲逛服务（基于用户记忆规划搜索，沉淀时效话题）
- MCP 工具能力（支持 stdio / remote Server，内置 Exa 远程 MCP 搜索）
- 提醒系统（创建、查看、取消）
- Live2D 桌宠（情绪/说话/思考动作联动）
- 可选工具能力：浏览器工具、系统工具、文件工具（带开关与审批）

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

## 常用命令

- `/help`
- `/reminders`
- `/cancel <提醒ID前缀>`

## 数据目录

运行后会在本机创建：

```text
~/.yobi/
├── config.json
├── characters/default.json
├── models/
├── sessions/main/history.jsonl
├── sessions/main/memory.json
├── sessions/main/context.json
├── sessions/main/reminders.json
├── sessions/main/topics.json
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
