import { useEffect, useState } from "react";
import type { AppConfig } from "@shared/types";
import { Button } from "@renderer/components/ui/button";
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

const DEFAULT_PTT_HOTKEY = "Alt+Space";
const MODIFIER_KEY_NAMES = new Set(["alt", "control", "ctrl", "shift", "meta", "os"]);

function normalizeModifierToken(token: string): "Ctrl" | "Alt" | "Shift" | "Meta" | null {
  const lower = token.trim().toLowerCase();
  if (!lower) {
    return null;
  }

  if (["ctrl", "control", "ctl"].includes(lower)) {
    return "Ctrl";
  }

  if (["alt", "option", "opt"].includes(lower)) {
    return "Alt";
  }

  if (lower === "shift") {
    return "Shift";
  }

  if (["meta", "cmd", "command", "super", "win", "windows"].includes(lower)) {
    return "Meta";
  }

  return null;
}

function normalizePrimaryKeyToken(token: string): string {
  const normalized = token.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  if (normalized === "space" || normalized === "spacebar" || normalized === "空格") {
    return "Space";
  }

  if (normalized === "enter" || normalized === "return" || normalized === "回车") {
    return "Enter";
  }

  if (normalized === "tab") {
    return "Tab";
  }

  if (normalized === "esc" || normalized === "escape") {
    return "Esc";
  }

  if (normalized === "backspace") {
    return "Backspace";
  }

  if (/^[a-z]$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  if (/^[0-9]$/.test(normalized)) {
    return normalized;
  }

  if (/^f([1-9]|1[0-2])$/.test(normalized)) {
    return normalized.toUpperCase();
  }

  return token.trim().toUpperCase();
}

function normalizeHotkeyString(raw: string): string {
  const tokens = raw
    .split("+")
    .map((token) => token.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    return "";
  }

  const modifiers = {
    Ctrl: false,
    Alt: false,
    Shift: false,
    Meta: false
  };
  let keyToken = "";

  for (const token of tokens) {
    const modifier = normalizeModifierToken(token);
    if (modifier) {
      modifiers[modifier] = true;
      continue;
    }

    if (!keyToken) {
      keyToken = normalizePrimaryKeyToken(token);
    }
  }

  if (!keyToken) {
    return "";
  }

  const normalizedParts: string[] = [];
  if (modifiers.Ctrl) {
    normalizedParts.push("Ctrl");
  }
  if (modifiers.Alt) {
    normalizedParts.push("Alt");
  }
  if (modifiers.Shift) {
    normalizedParts.push("Shift");
  }
  if (modifiers.Meta) {
    normalizedParts.push("Meta");
  }
  normalizedParts.push(keyToken);
  return normalizedParts.join("+");
}

function keyFromKeyboardEvent(event: KeyboardEvent): string {
  const code = event.code;

  if (code === "Space") {
    return "Space";
  }
  if (code === "Enter" || code === "NumpadEnter") {
    return "Enter";
  }
  if (code === "Tab") {
    return "Tab";
  }
  if (code === "Escape") {
    return "Esc";
  }
  if (code === "Backspace") {
    return "Backspace";
  }

  if (/^Key[A-Z]$/.test(code)) {
    return code.slice(3);
  }

  if (/^Digit[0-9]$/.test(code)) {
    return code.slice(5);
  }

  if (/^F([1-9]|1[0-2])$/.test(code)) {
    return code;
  }

  const normalized = event.key.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length === 1 && /[a-z0-9]/i.test(normalized)) {
    return normalized.toUpperCase();
  }

  if (["Space", "Enter", "Tab", "Esc", "Backspace"].includes(normalized)) {
    return normalized;
  }

  return "";
}

function hotkeyFromKeyboardEvent(
  event: KeyboardEvent
): {
  hotkey: string | null;
  error: string | null;
} {
  const keyToken = keyFromKeyboardEvent(event);
  if (!keyToken) {
    return {
      hotkey: null,
      error: null
    };
  }

  if (MODIFIER_KEY_NAMES.has(keyToken.toLowerCase())) {
    return {
      hotkey: null,
      error: null
    };
  }

  const modifiers: string[] = [];
  if (event.ctrlKey) {
    modifiers.push("Ctrl");
  }
  if (event.altKey) {
    modifiers.push("Alt");
  }
  if (event.shiftKey) {
    modifiers.push("Shift");
  }
  if (event.metaKey) {
    modifiers.push("Meta");
  }

  if (modifiers.length === 0) {
    return {
      hotkey: null,
      error: "快捷键至少需要一个修饰键（Ctrl/Option/Shift/Command）。"
    };
  }

  return {
    hotkey: normalizeHotkeyString([...modifiers, keyToken].join("+")),
    error: null
  };
}

function formatHotkeyText(raw: string, isMac: boolean): string {
  const normalized = normalizeHotkeyString(raw) || DEFAULT_PTT_HOTKEY;
  const parts = normalized.split("+");
  const mapped = parts.map((part) => {
    if (part === "Ctrl") {
      return isMac ? "Control" : "Ctrl";
    }
    if (part === "Alt") {
      return isMac ? "Option" : "Alt";
    }
    if (part === "Shift") {
      return "Shift";
    }
    if (part === "Meta") {
      return isMac ? "Command" : "Meta";
    }
    if (part === "Esc") {
      return "Esc";
    }
    if (part === "Space") {
      return "Space";
    }
    return part;
  });

  return mapped.join("+");
}

function formatHotkeySymbol(raw: string, isMac: boolean): string {
  const normalized = normalizeHotkeyString(raw) || DEFAULT_PTT_HOTKEY;
  const parts = normalized.split("+");
  if (!isMac) {
    return parts.join("+");
  }

  const mapped = parts.map((part) => {
    if (part === "Ctrl") {
      return "⌃";
    }
    if (part === "Alt") {
      return "⌥";
    }
    if (part === "Shift") {
      return "⇧";
    }
    if (part === "Meta") {
      return "⌘";
    }
    if (part === "Space") {
      return "Space";
    }
    return part;
  });

  return mapped.join(" ");
}

export function SettingsPage({
  config,
  setConfig
}: {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}) {
  const observationalProviderOptions = config.providers.map((provider) => ({
    id: provider.id,
    label: provider.enabled ? provider.label : `${provider.label}（已停用）`
  }));
  const isMac =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  const [importingModel, setImportingModel] = useState(false);
  const [modelImportNotice, setModelImportNotice] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);
  const [isRecordingPttHotkey, setIsRecordingPttHotkey] = useState(false);
  const [pttHotkeyNotice, setPttHotkeyNotice] = useState("");

  useEffect(() => {
    if (!isRecordingPttHotkey) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (event.key === "Escape") {
        setIsRecordingPttHotkey(false);
        setPttHotkeyNotice("已取消快捷键录制。");
        return;
      }

      const captured = hotkeyFromKeyboardEvent(event);
      if (captured.error) {
        setPttHotkeyNotice(captured.error);
        return;
      }

      if (!captured.hotkey) {
        return;
      }

      const normalized = normalizeHotkeyString(captured.hotkey) || DEFAULT_PTT_HOTKEY;
      setConfig({
        ...config,
        ptt: {
          ...config.ptt,
          hotkey: normalized
        }
      });
      setPttHotkeyNotice(`已设置为 ${formatHotkeyText(normalized, isMac)}。`);
      setIsRecordingPttHotkey(false);
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [config, isMac, isRecordingPttHotkey, setConfig]);

  const importModelDirectory = async (): Promise<void> => {
    if (importingModel) {
      return;
    }

    setImportingModel(true);
    setModelImportNotice(null);
    try {
      const result = await window.companion.importPetModelFromDialog();
      if (result.canceled || !result.modelDir) {
        return;
      }

      const nextConfig: AppConfig = {
        ...config,
        pet: {
          ...config.pet,
          enabled: true,
          modelDir: result.modelDir
        }
      };
      const saved = await window.companion.saveConfig(nextConfig);
      setConfig(saved);
      setModelImportNotice({
        type: "success",
        message: "模型导入成功，桌宠已自动切换到新模型。"
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "模型导入失败，请稍后重试。";
      setModelImportNotice({
        type: "error",
        message
      });
    } finally {
      setImportingModel(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Telegram 通道</CardTitle>
          <CardDescription>填入 Bot Token 和目标 Chat ID，保存后自动重连。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>主动消息不再推送到 Telegram</Label>
            <Switch
              checked={config.proactive.localOnly}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  proactive: {
                    ...config.proactive,
                    localOnly: checked
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
            <Label>Live2D 模型</Label>
            <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
              <div className="min-w-0 pr-3">
                <p className="truncate text-sm">
                  {config.pet.modelDir || "未导入模型"}
                </p>
                <p className="text-xs text-muted-foreground">
                  模型会导入到 ~/.yobi/models 并自动写入配置
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void importModelDirectory()}
                disabled={importingModel}
              >
                {importingModel ? "导入中..." : "导入模型"}
              </Button>
            </div>
            {modelImportNotice ? (
              <p
                className={`text-xs ${
                  modelImportNotice.type === "success" ? "text-emerald-700" : "text-rose-700"
                }`}
              >
                {modelImportNotice.message}
              </p>
            ) : null}
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

          <div className="rounded-md border border-border/70 bg-white/70 px-3 py-3">
            <div className="flex items-center justify-between">
              <Label>桌宠按住说话（全局）</Label>
              <Switch
                checked={config.ptt.enabled}
                onChange={(checked) =>
                  setConfig({
                    ...config,
                    ptt: {
                      ...config.ptt,
                      enabled: checked
                    }
                  })
                }
              />
            </div>
            <div className="mt-3 space-y-1.5">
              <Label>按住说话快捷键</Label>
              <div className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-background px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {formatHotkeySymbol(config.ptt.hotkey, isMac)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatHotkeyText(config.ptt.hotkey, isMac)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    variant={isRecordingPttHotkey ? "default" : "outline"}
                    onClick={() => {
                      if (isRecordingPttHotkey) {
                        setIsRecordingPttHotkey(false);
                        setPttHotkeyNotice("已取消快捷键录制。");
                        return;
                      }

                      setPttHotkeyNotice(
                        isMac
                          ? "请按下快捷键组合，例如 Option+Space。按 Esc 取消。"
                          : "请按下快捷键组合，例如 Alt+Space。按 Esc 取消。"
                      );
                      setIsRecordingPttHotkey(true);
                    }}
                  >
                    {isRecordingPttHotkey ? "等待按键..." : "点击录制快捷键"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => {
                      const normalized = DEFAULT_PTT_HOTKEY;
                      setConfig({
                        ...config,
                        ptt: {
                          ...config.ptt,
                          hotkey: normalized
                        }
                      });
                      setPttHotkeyNotice(`已恢复默认：${formatHotkeyText(normalized, isMac)}。`);
                      setIsRecordingPttHotkey(false);
                    }}
                  >
                    恢复默认
                  </Button>
                </div>
              </div>
              {pttHotkeyNotice ? (
                <p className="text-xs text-muted-foreground">{pttHotkeyNotice}</p>
              ) : null}
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>实时语音模式</Label>
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>阿里百炼语音</CardTitle>
          <CardDescription>
            开启且填写 API Key 后，语音识别和语音合成都会走阿里 WebSocket。未满足条件时回退到 Edge TTS。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用阿里语音（STT + TTS）</Label>
            <Switch
              checked={config.alibabaVoice.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  alibabaVoice: {
                    ...config.alibabaVoice,
                    enabled: checked
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>DashScope API Key</Label>
            <Input
              type="password"
              value={config.alibabaVoice.apiKey}
              placeholder="sk-xxxx"
              onChange={(event) =>
                setConfig({
                  ...config,
                  alibabaVoice: {
                    ...config.alibabaVoice,
                    apiKey: event.target.value
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>区域</Label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              value={config.alibabaVoice.region}
              onChange={(event) =>
                setConfig({
                  ...config,
                  alibabaVoice: {
                    ...config.alibabaVoice,
                    region: event.target.value === "intl" ? "intl" : "cn"
                  }
                })
              }
            >
              <option value="cn">中国内地（dashscope.aliyuncs.com）</option>
              <option value="intl">国际站（dashscope-intl.aliyuncs.com）</option>
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>ASR 模型</Label>
              <Input
                value={config.alibabaVoice.asrModel}
                placeholder="fun-asr-realtime"
                onChange={(event) =>
                  setConfig({
                    ...config,
                    alibabaVoice: {
                      ...config.alibabaVoice,
                      asrModel: event.target.value
                    }
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>TTS 模型</Label>
              <Input
                value={config.alibabaVoice.ttsModel}
                placeholder="cosyvoice-v3-flash"
                onChange={(event) =>
                  setConfig({
                    ...config,
                    alibabaVoice: {
                      ...config.alibabaVoice,
                      ttsModel: event.target.value
                    }
                  })
                }
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>TTS 音色</Label>
            <Input
              value={config.alibabaVoice.ttsVoice}
              placeholder="longxiaochun_v3"
              onChange={(event) =>
                setConfig({
                  ...config,
                  alibabaVoice: {
                    ...config.alibabaVoice,
                    ttsVoice: event.target.value
                  }
                })
              }
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Edge TTS 设置</CardTitle>
          <CardDescription>
            仅在阿里语音未启用时生效；语速、音高等参数只作用于 Edge TTS。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>Edge Voice 名称</Label>
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

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Edge 语速</Label>
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
              <Label>Edge 音高</Label>
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
              <Label>Edge 合成超时（毫秒）</Label>
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
              <Label>Edge 失败重试次数</Label>
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
          <CardTitle>主动聊天参数</CardTitle>
          <CardDescription>
            关闭时只被动回复；开启后按冷却与沉默规则触发主动消息。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用主动聊天</Label>
            <Switch
              checked={config.proactive.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  proactive: {
                    ...config.proactive,
                    enabled: checked
                  }
                })
              }
            />
          </div>

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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>记忆策略</CardTitle>
          <CardDescription>Recent Messages + Working Memory + 可选 Observational Memory。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1.5">
            <Label>最近消息条数（不开 Observational Memory 时）</Label>
            <Input
              value={String(config.memory.recentMessages)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    recentMessages:
                      Number.isFinite(Number(event.target.value))
                        ? Math.max(10, Math.min(200, Number(event.target.value)))
                        : config.memory.recentMessages
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用 Observational Memory</Label>
            <Switch
              checked={config.memory.observational.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    observational: {
                      ...config.memory.observational,
                      enabled: checked
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>Observational Memory Provider</Label>
            <Select
              value={config.memory.observational.providerId}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    observational: {
                      ...config.memory.observational,
                      providerId: event.target.value
                    }
                  }
                })
              }
            >
              <option value="">请选择 Provider</option>
              {observationalProviderOptions.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.label}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>Observational Memory 模型</Label>
            <Input
              value={config.memory.observational.model}
              placeholder="例如: gemini-2.5-flash"
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    observational: {
                      ...config.memory.observational,
                      model: event.target.value
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
          <CardTitle>OpenClaw</CardTitle>
          <CardDescription>桌面操控工具，默认关闭，启用后走审批。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>启用 OpenClaw</Label>
            <Switch
              checked={config.openclaw.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  openclaw: {
                    ...config.openclaw,
                    enabled: checked
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <Label>所有操作需要审批</Label>
            <Switch
              checked={config.openclaw.approvalRequired}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  openclaw: {
                    ...config.openclaw,
                    approvalRequired: checked
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>Gateway URL</Label>
            <Input
              value={config.openclaw.gatewayUrl}
              onChange={(event) =>
                setConfig({
                  ...config,
                  openclaw: {
                    ...config.openclaw,
                    gatewayUrl: event.target.value
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
