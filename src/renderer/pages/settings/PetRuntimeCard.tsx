import type { AppConfig } from "@shared/types";
import type { PetExpressionOption } from "@shared/ipc";
import { Button } from "@renderer/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Label } from "@renderer/components/ui/label";
import { Select } from "@renderer/components/ui/select";
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
  expressionOptions: PetExpressionOption[];
  applyingExpression: boolean;
  onSelectExpression: (expressionId: string) => void;
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
  expressionOptions,
  applyingExpression,
  onSelectExpression,
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
        <CardDescription>后台保活和桌宠窗口配置。</CardDescription>
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

        {expressionOptions.length > 0 ? (
          <div className="space-y-1.5">
            <Label>换装 / Expression</Label>
            <Select
              value={config.pet.expressionId}
              disabled={applyingExpression}
              onChange={(event) => onSelectExpression(event.target.value)}
            >
              <option value="">默认 / 无换装</option>
              {expressionOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-muted-foreground">
              选择后会立即应用到桌宠，并自动保存为当前模型的默认换装。
            </p>
          </div>
        ) : null}

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
      </CardContent>
    </Card>
  );
}
