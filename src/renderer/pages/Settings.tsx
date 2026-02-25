import type { AppConfig } from "@shared/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { Select } from "@renderer/components/ui/select";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";

export function SettingsPage({
  config,
  setConfig
}: {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}) {
  const parseList = (raw: string): string[] =>
    raw
      .split(/[\n,]/)
      .map((item) => item.trim())
      .filter(Boolean);

  const toListText = (values: string[]): string => values.join("\n");

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Telegram 通道</CardTitle>
          <CardDescription>填入 Bot Token 和目标 Chat ID，保存后自动重连。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Bot Token</Label>
            <Input
              type="password"
              value={config.telegram.botToken}
              onChange={(event) =>
                setConfig({
                  ...config,
                  telegram: {
                    ...config.telegram,
                    botToken: event.target.value
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>Chat ID</Label>
            <Input
              value={config.telegram.chatId}
              placeholder="例如: 123456789"
              onChange={(event) =>
                setConfig({
                  ...config,
                  telegram: {
                    ...config.telegram,
                    chatId: event.target.value
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>多模态消息</CardTitle>
          <CardDescription>语音/图片输入能力控制。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>允许发语音</Label>
            <Switch
              checked={config.messaging.allowVoiceMessages}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  messaging: {
                    ...config.messaging,
                    allowVoiceMessages: checked
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>允许图片输入理解</Label>
            <Switch
              checked={config.messaging.allowPhotoInput}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  messaging: {
                    ...config.messaging,
                    allowPhotoInput: checked
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>语音参数</CardTitle>
          <CardDescription>用于 [voice] 标记的 Edge TTS 合成。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Voice 名称</Label>
            <Input
              value={config.voice.ttsVoice}
              placeholder="zh-CN-XiaoxiaoNeural"
              onChange={(event) =>
                setConfig({
                  ...config,
                  voice: {
                    ...config.voice,
                    ttsVoice: event.target.value
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>TTS 代理（可选）</Label>
            <Input
              value={config.voice.proxy}
              placeholder="http://127.0.0.1:7890"
              onChange={(event) =>
                setConfig({
                  ...config,
                  voice: {
                    ...config.voice,
                    proxy: event.target.value
                  }
                })
              }
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>语速</Label>
              <Input
                value={config.voice.ttsRate}
                placeholder="+0%"
                onChange={(event) =>
                  setConfig({
                    ...config,
                    voice: {
                      ...config.voice,
                      ttsRate: event.target.value
                    }
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>音高</Label>
              <Input
                value={config.voice.ttsPitch}
                placeholder="+0Hz"
                onChange={(event) =>
                  setConfig({
                    ...config,
                    voice: {
                      ...config.voice,
                      ttsPitch: event.target.value
                    }
                  })
                }
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>合成超时（毫秒）</Label>
              <Input
                value={String(config.voice.requestTimeoutMs)}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    voice: {
                      ...config.voice,
                      requestTimeoutMs:
                        Number.isFinite(Number(event.target.value))
                          ? Math.max(3000, Math.min(30000, Number(event.target.value)))
                          : config.voice.requestTimeoutMs
                    }
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>失败重试次数</Label>
              <Input
                value={String(config.voice.retryCount)}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    voice: {
                      ...config.voice,
                      retryCount:
                        Number.isFinite(Number(event.target.value))
                          ? Math.max(0, Math.min(2, Number(event.target.value)))
                          : config.voice.retryCount
                    }
                  })
                }
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>屏幕感知参数</CardTitle>
          <CardDescription>
            三层控制：全局开关 + /eyes 指令 + 锁屏/空闲自动暂停。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用屏幕感知</Label>
            <Switch
              checked={config.perception.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  perception: {
                    ...config.perception,
                    enabled: checked
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>检测间隔（毫秒）</Label>
            <Input
              value={String(config.perception.pollIntervalMs)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  perception: {
                    ...config.perception,
                    pollIntervalMs: Number(event.target.value) || config.perception.pollIntervalMs
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>截图最大宽度</Label>
            <Input
              value={String(config.perception.screenshotMaxWidth)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  perception: {
                    ...config.perception,
                    screenshotMaxWidth:
                      Number(event.target.value) || config.perception.screenshotMaxWidth
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>截图质量（20-100）</Label>
            <Input
              value={String(config.perception.screenshotQuality)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  perception: {
                    ...config.perception,
                    screenshotQuality:
                      Number(event.target.value) || config.perception.screenshotQuality
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>空闲暂停阈值（秒）</Label>
            <Input
              value={String(config.perception.idlePauseSeconds)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  perception: {
                    ...config.perception,
                    idlePauseSeconds:
                      Number(event.target.value) || config.perception.idlePauseSeconds
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>后台与桌宠</CardTitle>
          <CardDescription>后台保活、桌宠窗口和实时语音配置。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>保持后台运行（防休眠）</Label>
            <Switch
              checked={config.background.keepAwake}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  background: {
                    ...config.background,
                    keepAwake: checked
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用桌宠窗口</Label>
            <Switch
              checked={config.pet.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  pet: {
                    ...config.pet,
                    enabled: checked
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>Live2D 模型目录</Label>
            <Input
              value={config.pet.modelDir}
              onChange={(event) =>
                setConfig({
                  ...config,
                  pet: {
                    ...config.pet,
                    modelDir: event.target.value
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>桌宠窗口置顶</Label>
            <Switch
              checked={config.pet.alwaysOnTop}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  pet: {
                    ...config.pet,
                    alwaysOnTop: checked
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>实时语音模式（实验）</Label>
            <Switch
              checked={config.realtimeVoice.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  realtimeVoice: {
                    ...config.realtimeVoice,
                    enabled: checked
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>Whisper 模式</Label>
            <Select
              value={config.realtimeVoice.whisperMode}
              onChange={(event) =>
                setConfig({
                  ...config,
                  realtimeVoice: {
                    ...config.realtimeVoice,
                    whisperMode: event.target.value as "local" | "api"
                  }
                })
              }
            >
              <option value="api">Whisper API</option>
              <option value="local">whisper.cpp (本地)</option>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>主动聊天参数</CardTitle>
          <CardDescription>事件驱动触发 + 冷却，避免机器人感。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>冷却时间（毫秒）</Label>
            <Input
              value={String(config.proactive.cooldownMs)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  proactive: {
                    ...config.proactive,
                    cooldownMs: Number(event.target.value) || config.proactive.cooldownMs
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>沉默阈值（毫秒）</Label>
            <Input
              value={String(config.proactive.silenceThresholdMs)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  proactive: {
                    ...config.proactive,
                    silenceThresholdMs:
                      Number(event.target.value) || config.proactive.silenceThresholdMs
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>回归检测窗口（毫秒）</Label>
            <Input
              value={String(config.proactive.comebackGraceMs)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  proactive: {
                    ...config.proactive,
                    comebackGraceMs:
                      Number(event.target.value) || config.proactive.comebackGraceMs
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>记忆策略</CardTitle>
          <CardDescription>工作记忆窗口和长期记忆提炼节奏。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>工作记忆窗口（条）</Label>
            <Input
              value={String(config.memory.workingSetSize)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    workingSetSize: Number(event.target.value) || config.memory.workingSetSize
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>每多少轮提炼一次</Label>
            <Input
              value={String(config.memory.summarizeEveryTurns)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    summarizeEveryTurns:
                      Number(event.target.value) || config.memory.summarizeEveryTurns
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>浏览器工具（Beta）</CardTitle>
          <CardDescription>隔离 Chromium + snapshot/ref/act 模式。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用浏览器工具</Label>
            <Switch
              checked={config.tools.browser.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    browser: {
                      ...config.tools.browser,
                      enabled: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>Headless 模式</Label>
            <Switch
              checked={config.tools.browser.headless}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    browser: {
                      ...config.tools.browser,
                      headless: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>阻止私网地址</Label>
            <Switch
              checked={config.tools.browser.blockPrivateNetwork}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    browser: {
                      ...config.tools.browser,
                      blockPrivateNetwork: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>CDP 端口</Label>
            <Input
              value={String(config.tools.browser.cdpPort)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    browser: {
                      ...config.tools.browser,
                      cdpPort: Number(event.target.value) || config.tools.browser.cdpPort
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>域名白名单（每行一个，空=不限制）</Label>
            <Textarea
              rows={3}
              value={toListText(config.tools.browser.allowedDomains)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    browser: {
                      ...config.tools.browser,
                      allowedDomains: parseList(event.target.value)
                    }
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>系统工具（Beta）</CardTitle>
          <CardDescription>Shell 执行 + App 控制，默认走审批。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用系统工具</Label>
            <Switch
              checked={config.tools.system.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    system: {
                      ...config.tools.system,
                      enabled: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>允许执行 shell</Label>
            <Switch
              checked={config.tools.system.execEnabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    system: {
                      ...config.tools.system,
                      execEnabled: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>高风险操作需确认</Label>
            <Switch
              checked={config.tools.system.approvalRequired}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    system: {
                      ...config.tools.system,
                      approvalRequired: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>命令白名单（每行一个，空=不限制）</Label>
            <Textarea
              rows={3}
              value={toListText(config.tools.system.allowedCommands)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    system: {
                      ...config.tools.system,
                      allowedCommands: parseList(event.target.value)
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>命令阻止规则（每行一个）</Label>
            <Textarea
              rows={3}
              value={toListText(config.tools.system.blockedPatterns)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    system: {
                      ...config.tools.system,
                      blockedPatterns: parseList(event.target.value)
                    }
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>文件工具（Beta）</CardTitle>
          <CardDescription>按目录白名单控制读写。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>允许读取文件</Label>
            <Switch
              checked={config.tools.file.readEnabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    file: {
                      ...config.tools.file,
                      readEnabled: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>允许写入文件</Label>
            <Switch
              checked={config.tools.file.writeEnabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    file: {
                      ...config.tools.file,
                      writeEnabled: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>允许访问目录（每行一个，空=不限制）</Label>
            <Textarea
              rows={3}
              value={toListText(config.tools.file.allowedPaths)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    file: {
                      ...config.tools.file,
                      allowedPaths: parseList(event.target.value)
                    }
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
