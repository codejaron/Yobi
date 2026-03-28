<div align="center">

<h1>🐾 Yobi</h1>

<p><strong>一个有记忆、有认知、有主动性的桌面 AI 陪伴系统</strong></p>

<p>Desktop AI Companion with Cognition, Long-term Memory &amp; Live2D</p>

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Electron](https://img.shields.io/badge/Electron-37-47848F?logo=electron)](https://www.electronjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript)](https://www.typescriptlang.org/)

<!-- 如果有截图或 GIF 演示，强烈建议放在这里 -->
<!-- ![Yobi Screenshot](docs/screenshot.png) -->

</div>

---

> ⚠️ 项目仍处于早期开发阶段，功能和 API 随时可能变化。

## 这是什么

Yobi 不是又一个 AI 聊天窗口。它是一个**持续运行在桌面上的 AI 陪伴系统**——拥有受认知科学启发的潜意识循环、真正的长期记忆和情感状态，可以通过本地控制台、Telegram、QQ、飞书等多个入口与你交互，并以 Live2D 桌宠的形态常驻桌面。

核心理念：**让 AI 陪伴从"打开聊天框"变成"一直在身边"。**

## 为什么选择 Yobi

**认知引擎，不只是检索** — Yobi 内置了一套受认知科学启发的潜意识系统，独立于对话持续运转。记忆以图谱而非条目的形式存储，概念之间通过语义、时间、因果、情感等关系连接。扩散激活沿着这些关系传播联想，Hebbian 学习让常被一起激活的记忆之间连接越来越强、不再相关的自然衰减。泊松心跳驱动自发思维，情绪状态和预测编码分别让联想带有情绪色彩并偏好新鲜内容。产出的想法经多维评估后决定是否主动表达，表达后通过全局工作空间广播同步所有子系统。用户不活跃时段自动执行记忆巩固——回放、抽象、归档、去重，类似睡眠整理记忆。

**长期记忆** — 六层记忆结构（Soul、Relationship、State、Profile、Facts、Episodes），通过后台反思持续提炼对你的理解，embedding + BM25 混合检索帮助它在大量记忆中更稳定地回忆相关内容。认知引擎的记忆图谱与事实库并行运作，构成多层次的记忆系统。

**情感是实时计算的，不是标签** — 基于以 PAD 为核心扩展的六维情感维度 + Ekman 基本情绪，结合 OCEAN 人格模型、情绪反刍队列、会话亲密度衰减等机制，情感状态随每一次对话实时演化，而非简单地贴"开心/难过"标签。

**关系会成长** — 五阶段关系系统（陌生人 → 相识 → 熟悉 → 亲近 → 亲密），基于互动频率、对话质量、情感连接度综合评估，每天自动判定是否升降级。不同阶段有不同的说话风格和行为边界。

**陪伴模式** — 开启后 Yobi 会感知你当前的前台应用和窗口标题，在合适的时机主动搭话——比如你切到 IDE 写代码时、刷 B 站时、或者深夜还在加班时，它会基于屏幕上下文给出自然的反应，而不是机械提醒。

**主动而不打扰** — 除了陪伴模式的屏幕感知，Yobi 还支持基于沉默阈值、夜间静默、冷启动延迟的主动聊天机制。潜意识循环产生的思维气泡经过多维评估后才会表达，做到"有判断地陪伴"。

**一个角色，多个入口** — 同一套人格、记忆和状态在本地控制台、Telegram、QQ、飞书之间无缝延续，不会"换个入口像换了一个人"。

**桌面原生体验** — Live2D 桌宠常驻桌面、情绪联动；全局快捷键按住说话；实时语音对话支持随时打断，PTT / Free 两种模式可选。

**可扩展的能力系统** — 内置浏览器、文件、系统命令、Exa 搜索等工具，支持 MCP Server 接入和本地 Skills 导入。系统命令和文件能力支持白名单、阻止规则与审批机制。

**本地优先** — 数据存储在 `~/.yobi/`，模型、记忆、配置、日志全部本地可见可控。你的 AI 伙伴完全属于你。

## 功能一览

| 类别 | 功能 |
|------|------|
| **认知引擎** | 记忆图谱 · 扩散激活 · Hebbian 学习 · 侧抑制 · 预测编码 · 情绪调制 · 思维气泡 · 全局工作空间广播 · 记忆巩固 |
| **情感系统** | 六维情感维度 · Ekman 情绪 · OCEAN 人格 · 情绪反刍 · 会话亲密度 · 实时情感信号 |
| **关系系统** | 五阶段关系自动升降级，每阶段独立行为指南 |
| **陪伴模式** | 前台窗口感知 · 屏幕上下文 · 主动搭话 |
| **对话通道** | 本地控制台（流式回复 / 工具日志 / 审批）· Telegram · QQ（C2C）· 飞书（长连接 + 流式回推） |
| **语音** | ASR（本地 SenseVoice / 阿里云）· TTS（Edge / 阿里云）· 实时语音会话（PTT / Free）· VAD · 打断 |
| **桌宠** | Live2D 独立窗口 · 情绪 & 思考状态联动 · 全局快捷键按住说话 |
| **记忆** | Soul / Relationship / State / Profile / Facts / Episodes 六层结构 · 认知图谱 · embedding + BM25 混合检索 |
| **AI 路由** | OpenAI / Anthropic / OpenRouter / DeepSeek / Qwen / Moonshot / Zhipu / MiniMax 及任意 OpenAI-compatible Provider，chat / reflection / cognition 三路由独立配置 |
| **主动行为** | 沉默阈值 · 夜间静默 · 定时任务（一次性 / Cron）· Bilibili 素材同步 |
| **工具 & 扩展** | 内置工具开关 · MCP Server · Skills 本地技能库 · Exa 搜索 |
| **可观测性** | 仪表盘 · Token 统计（今日 / 7天 / 30天） |

## 快速开始

### 环境要求

- Node.js 22
- npm
- macOS / Windows

### 安装 & 运行

```bash
git clone https://github.com/codejaron/Yobi.git
cd Yobi
npm install
npm run dev
```

首次启动后会在 `~/.yobi/` 创建数据目录。

### 首次配置

**第一步：配置 AI Provider**（必须）

进入 `Provider` 页面，至少添加一个 Provider 的 API Key，并为 `chat`、`reflection`、`cognition` 三条路由各指定一个模型。`cognition` 路由用于认知引擎相关任务，推荐使用成本较低的模型。

**第二步：语音方案**（可选）

在设置页选择 ASR（`none` / `sensevoice-local` / `alibaba`）和 TTS（`edge` / `alibaba`）。本地 SenseVoice 模型可在设置页一键下载。

**第三步：消息通道**（可选）

按需配置 Telegram（Bot Token + Chat ID）、QQ（App ID + AppSecret）或飞书（App ID + App Secret）。不配置外部通道也可正常使用本地控制台。

**第四步：桌宠 & 陪伴模式**（可选）

在 `设置 → 后台与桌宠` 导入包含 `*.model3.json` 的 Live2D 模型目录。开启陪伴模式后，Yobi 会感知你的前台应用并在合适时机主动搭话（需要授权辅助功能、麦克风和屏幕录制权限）。

**第五步：工具 & 技能**（可选）

在设置中启用内置工具，在 `MCP` 页面导入自定义 Server，在 `Skills` 页面导入包含 `SKILL.md` 的技能目录。

## macOS 注意事项

如果下载的 `.app` 提示"已损坏 / 应移到垃圾桶"：

```bash
xattr -dr com.apple.quarantine /Applications/Yobi.app
```

然后在 Finder 中右键 → 打开。陪伴模式和语音功能需要额外授权辅助功能、麦克风和屏幕录制权限，可在应用内仪表盘页面引导授权。

## 开发命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 开发模式 |
| `npm run build` | 构建 |
| `npm run preview` | 预览构建产物 |
| `npm run typecheck` | 类型检查 |
| `npm run test` | 运行测试 |
| `npm run dist:mac` | 打包 macOS DMG |
| `npm run dist:win` | 打包 Windows NSIS |

## License

[AGPL-3.0-only](LICENSE)
