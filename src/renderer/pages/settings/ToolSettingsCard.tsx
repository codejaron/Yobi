import type { AppConfig } from "@shared/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { Switch } from "@renderer/components/ui/switch";
import { Textarea } from "@renderer/components/ui/textarea";

interface ToolSettingsCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}

function parseList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function toListText(values: string[]): string {
  return values.join("\n");
}

function toPort(raw: string, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1000, Math.min(65535, Math.floor(parsed)));
}

export function ToolSettingsCard({ config, setConfig }: ToolSettingsCardProps) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Exa 搜索</CardTitle>
          <CardDescription>
            启用后会提供 `web_search` 和 `code_search` 两个搜索工具。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
            <div>
              <Label>启用 Exa 搜索</Label>
              <p className="text-xs text-muted-foreground">网页/新闻/资料搜索与代码上下文检索都会一起启用。</p>
            </div>
            <Switch
              checked={config.tools.exa.enabled}
              onChange={(checked) =>
                setConfig({
                  ...config,
                  tools: {
                    ...config.tools,
                    exa: {
                      ...config.tools.exa,
                      enabled: checked
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
          <CardTitle>浏览器工具</CardTitle>
          <CardDescription>隔离浏览器控制能力，支持页面快照、截图和交互。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>CDP 端口</Label>
              <Input
                type="number"
                min={1000}
                max={65535}
                value={String(config.tools.browser.cdpPort)}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    tools: {
                      ...config.tools,
                      browser: {
                        ...config.tools.browser,
                        cdpPort: toPort(event.target.value, config.tools.browser.cdpPort)
                      }
                    }
                  })
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label>允许域名（每行一个，空=不限制）</Label>
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
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>系统工具</CardTitle>
          <CardDescription>受控执行 shell、系统通知和桌面应用操作。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <Label>允许执行 Shell</Label>
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
          <CardTitle>文件工具</CardTitle>
          <CardDescription>受控文件读写；默认只开放读取。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
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
            <Label>允许路径（每行一个，空=不限制）</Label>
            <Textarea
              rows={4}
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
