import type { AppConfig } from "@shared/types";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Label } from "@renderer/components/ui/label";
import { Switch } from "@renderer/components/ui/switch";
import {
  formatHotkeySymbol,
  formatHotkeyText
} from "./hotkey-utils";

interface PetRuntimeCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
  importModelDirectory: () => Promise<void>;
  importingModel: boolean;
  modelImportNotice: {
    type: "success" | "error";
    message: string;
  } | null;
  isMac: boolean;
  isRecordingPttHotkey: boolean;
  pttHotkeyNotice: string;
  onToggleRecordHotkey: () => void;
  onResetHotkey: () => void;
}

export function PetRuntimeCard({
  config,
  setConfig,
  importModelDirectory,
  importingModel,
  modelImportNotice,
  isMac,
  isRecordingPttHotkey,
  pttHotkeyNotice,
  onToggleRecordHotkey,
  onResetHotkey
}: PetRuntimeCardProps) {
  return (
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
                modelImportNotice.type === "success"
                  ? "text-[hsl(var(--status-success-foreground))]"
                  : "text-[hsl(var(--status-danger-foreground))]"
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
                  onClick={onToggleRecordHotkey}
                >
                  {isRecordingPttHotkey ? "等待按键..." : "点击录制快捷键"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onResetHotkey}
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

        <div className="grid gap-3 rounded-md border border-border/70 bg-white/70 px-3 py-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label>会话模式</Label>
            <select
              className="flex h-10 w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              value={config.realtimeVoice.mode}
              onChange={(event) =>
                setConfig({
                  ...config,
                  realtimeVoice: {
                    ...config.realtimeVoice,
                    mode: event.target.value as AppConfig["realtimeVoice"]["mode"]
                  }
                })
              }
            >
              <option value="ptt">PTT（稳定串行）</option>
              <option value="free">自由对话（全流式）</option>
            </select>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-background px-3 py-2">
            <Label>自动打断</Label>
            <Switch
              checked={config.realtimeVoice.autoInterrupt}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  realtimeVoice: {
                    ...config.realtimeVoice,
                    autoInterrupt: checked
                  }
                })
              }
            />
          </div>

          <div className="flex items-center justify-between rounded-md border border-border/70 bg-background px-3 py-2">
            <Label>AEC</Label>
            <Switch
              checked={config.realtimeVoice.aecEnabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  realtimeVoice: {
                    ...config.realtimeVoice,
                    aecEnabled: checked
                  }
                })
              }
            />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
