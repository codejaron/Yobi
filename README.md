# Yobi

桌面 AI 陪伴伴侣（Electron + Telegram + 屏幕感知）。

## 已实现能力

- Telegram 双向对话（`grammy`）
- 三层记忆（工作记忆 + 长期记忆 + 永久历史 JSONL）
- 屏幕感知两层策略（`active-win` 标题检测 + `node-screenshots` + `sharp`）
- 主动聊天决策（状态切换 / 沉默 / 回归）
- 三层感知控制（全局开关 + `/eyes on/off` + 锁屏/空闲自动暂停）
- 语音消息标记（`[voice]...[/voice]`，`edge-tts-universal` + 自动重试）
- 提醒标记（`[reminder]{...}[/reminder]`，支持 `/reminders` 与 `/cancel`）
- Telegram 图片输入（`message:photo` 多模态理解）
- 后台保活（macOS `caffeinate -i`）
- 桌宠透明窗口（Live2D 尝试加载 + fallback）
- 多 Provider + 多模型路由（聊天 / 感知 / 记忆）
- Electron 配置面板（Provider、角色、记忆、历史、参数）

## 目录

- `src/main`: 主进程 + 核心逻辑
- `src/renderer`: 配置面板 UI（React + Tailwind + shadcn-style components）
- `src/preload`: IPC 桥接
- `src/shared`: 共享类型

## 启动

```bash
npm install
npm run dev
```

## 数据目录

应用运行后会在本机创建：

```text
~/.yobi/
├── config.json
├── characters/default.json
├── sessions/main/history.jsonl
├── sessions/main/memory.json
├── sessions/main/context.json
└── sessions/main/reminders.json
```

## 说明

- 未配置 Telegram token/chatId 时，Bot 不会连接。
- 模型名采用手动输入，便于兼容 OpenAI-compatible 服务（DeepSeek、Moonshot、智谱、Ollama、LM Studio 等）。
- Edge TTS 使用微软在线语音服务（无需额外 API Key），网络波动时会自动重试。
