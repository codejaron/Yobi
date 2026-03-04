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

interface OpenClawSettingsCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
  clawProviderOptions: Array<{
    id: string;
    label: string;
  }>;
  clawPrimarySelection: {
    followChat: boolean;
    providerId: string;
    modelId: string;
  };
  clawFallbackInput: string;
  openClawWebUi: () => Promise<void>;
  openingOpenClawWebUi: boolean;
  openClawWebUiNotice: {
    type: "success" | "error";
    message: string;
  } | null;
}

export function OpenClawSettingsCard({
  config,
  setConfig,
  clawProviderOptions,
  clawPrimarySelection,
  clawFallbackInput,
  openClawWebUi,
  openingOpenClawWebUi,
  openClawWebUiNotice
}: OpenClawSettingsCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>OpenClaw</CardTitle>
        <CardDescription>Claw 双通道配置（模型、浏览器、心跳、工具权限）。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5">
          <Label>OpenClaw Web UI</Label>
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <div className="pr-3">
              <p className="text-sm">一键在应用内窗口打开 OpenClaw 控制台页面</p>
              <p className="text-xs text-muted-foreground">
                复用 Yobi 当前网关地址、token 和配置文件
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => void openClawWebUi()}
              disabled={openingOpenClawWebUi}
            >
              {openingOpenClawWebUi ? "打开中..." : "打开 Web UI"}
            </Button>
          </div>
          {openClawWebUiNotice ? (
            <p
              className={`text-xs ${
                openClawWebUiNotice.type === "success" ? "text-emerald-700" : "text-rose-700"
              }`}
            >
              {openClawWebUiNotice.message}
            </p>
          ) : null}
        </div>

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

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>跟随 Yobi 聊天模型</Label>
          <Switch
            checked={clawPrimarySelection.followChat}
            onChange={(checked) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  modelPrimary: checked
                    ? ""
                    : `${clawPrimarySelection.providerId}/${clawPrimarySelection.modelId}`.trim()
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>Claw 模型 Provider</Label>
          <Select
            value={clawPrimarySelection.providerId}
            onChange={(event) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  modelPrimary: `${event.target.value}/${clawPrimarySelection.modelId || config.modelRouting.chat.model}`
                }
              })
            }
            disabled={clawPrimarySelection.followChat}
          >
            {clawProviderOptions.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
              </option>
            ))}
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Claw 主模型 ID</Label>
          <Input
            value={clawPrimarySelection.modelId}
            placeholder="例如: gpt-5.2"
            disabled={clawPrimarySelection.followChat}
            onChange={(event) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  modelPrimary: `${clawPrimarySelection.providerId}/${event.target.value.trim()}`
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>备用模型（逗号分隔）</Label>
          <Input
            value={clawFallbackInput}
            placeholder="例如: openai-main/gpt-5.2, anthropic-main/claude-sonnet-4.5"
            onChange={(event) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  modelFallbacks: event.target.value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean)
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>思考模式</Label>
          <Select
            value={config.openclaw.thinkingDefault}
            onChange={(event) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  thinkingDefault: event.target.value as AppConfig["openclaw"]["thinkingDefault"]
                }
              })
            }
          >
            <option value="off">off</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
            <option value="xhigh">xhigh</option>
            <option value="minimal">minimal</option>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>上下文 Tokens</Label>
            <Input
              type="number"
              min={1}
              value={config.openclaw.contextTokens}
              onChange={(event) =>
                setConfig({
                  ...config,
                  openclaw: {
                    ...config.openclaw,
                    contextTokens: Math.max(1, Number(event.target.value) || 1)
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>超时（秒）</Label>
            <Input
              type="number"
              min={30}
              value={config.openclaw.timeoutSeconds}
              onChange={(event) =>
                setConfig({
                  ...config,
                  openclaw: {
                    ...config.openclaw,
                    timeoutSeconds: Math.max(30, Number(event.target.value) || 30)
                  }
                })
              }
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用浏览器工具</Label>
          <Switch
            checked={config.openclaw.browserEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  browserEnabled: checked
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>浏览器模式</Label>
          <Select
            value={config.openclaw.browserProfile}
            onChange={(event) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  browserProfile: event.target.value as AppConfig["openclaw"]["browserProfile"]
                }
              })
            }
          >
            <option value="openclaw">独立（openclaw）</option>
            <option value="chrome">扩展中继（chrome）</option>
          </Select>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>Browser Headless 模式</Label>
          <Switch
            checked={config.openclaw.browserHeadless}
            onChange={(checked) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  browserHeadless: checked
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>浏览器可执行文件路径（可选）</Label>
          <Input
            value={config.openclaw.browserExecutablePath}
            placeholder="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
            onChange={(event) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  browserExecutablePath: event.target.value
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>Heartbeat 间隔</Label>
          <Input
            value={config.openclaw.heartbeatEvery}
            placeholder="30m（设为 0m 禁用）"
            onChange={(event) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  heartbeatEvery: event.target.value
                }
              })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>允许网络搜索（web.search）</Label>
          <Switch
            checked={config.openclaw.toolWebSearchEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  toolWebSearchEnabled: checked
                }
              })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>允许网页抓取（web.fetch）</Label>
          <Switch
            checked={config.openclaw.toolWebFetchEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  toolWebFetchEnabled: checked
                }
              })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>允许命令执行（exec）</Label>
          <Switch
            checked={config.openclaw.toolExecEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  toolExecEnabled: checked
                }
              })
            }
          />
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>允许高权限操作（elevated）</Label>
          <Switch
            checked={config.openclaw.toolElevatedEnabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                openclaw: {
                  ...config.openclaw,
                  toolElevatedEnabled: checked
                }
              })
            }
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>最大并行任务数</Label>
            <Input
              type="number"
              min={1}
              max={32}
              value={config.openclaw.maxConcurrent}
              onChange={(event) =>
                setConfig({
                  ...config,
                  openclaw: {
                    ...config.openclaw,
                    maxConcurrent: Math.min(32, Math.max(1, Number(event.target.value) || 1))
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>沙盒模式</Label>
            <Select
              value={config.openclaw.sandboxMode}
              onChange={(event) =>
                setConfig({
                  ...config,
                  openclaw: {
                    ...config.openclaw,
                    sandboxMode: event.target.value as AppConfig["openclaw"]["sandboxMode"]
                  }
                })
              }
            >
              <option value="off">off</option>
              <option value="non-main">non-main</option>
              <option value="all">all</option>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
