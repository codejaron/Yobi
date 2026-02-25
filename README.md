# Yobi

桌面 AI 陪伴应用（Electron + Telegram + 屏幕感知 + Live2D 桌宠）。

## 主要功能

- 本地控制台聊天（支持流式回复）
- Telegram 双向消息（文本、图片输入；文本、语音输出）
- 屏幕感知（活动窗口 + 截图摘要）
- 主动聊天（切换/沉默/回归触发）
- 长期记忆（自动提炼 + 手动管理）
- 提醒系统（创建、查看、取消）
- Live2D 桌宠（情绪/说话/思考动作联动）
- 可选工具能力：浏览器工具、系统工具、文件工具（带开关与审批）

## 快速启动

```bash
npm install
npm run dev
```

## 必须配置

### 1) Provider 和模型路由（必配）

在界面「Provider 与模型路由」中配置：

- 至少 1 个可用 Provider（API Key）
- 聊天 / 感知 / 记忆模型

> 模型名是手动输入，兼容 OpenAI-compatible 服务。

### 2) Telegram（可选）

在「设置 -> Telegram 通道」填写：

- `Bot Token`
- `Chat ID`

不填也能用（本地控制台可正常聊天）。

### 3) Live2D 桌宠（可选）

由于授权原因，仓库不包含完整模型。用户 `clone` 后需自行下载模型并配置目录。

- 在「设置 -> 后台与桌宠」填写 `Live2D 模型目录`
- 目录里至少要有一个 `*.model3.json`

容错行为：

- 路径为空/不存在：桌宠关闭，不影响主程序
- 找不到 `model3.json`：桌宠走 fallback，不会崩
- 动作不完整：自动兜底匹配，不会因缺动作直接报错

## 常用命令

- `/help`
- `/eyes` / `/eyes on` / `/eyes off`
- `/reminders`
- `/cancel <提醒ID前缀>`

## 数据目录

运行后会在本机创建：

```text
~/.yobi/
├── config.json
├── characters/default.json
├── sessions/main/history.jsonl
├── sessions/main/memory.json
├── sessions/main/context.json
├── sessions/main/reminders.json
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
