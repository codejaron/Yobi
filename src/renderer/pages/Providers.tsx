import { Plus, Trash2 } from "lucide-react";
import type { AppConfig, ProviderConfig } from "@shared/types";
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

function updateProvider(
  config: AppConfig,
  providerId: string,
  patch: Partial<ProviderConfig>
): AppConfig {
  return {
    ...config,
    providers: config.providers.map((provider) =>
      provider.id === providerId
        ? {
            ...provider,
            ...patch
          }
        : provider
    )
  };
}

function createProviderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `provider-${crypto.randomUUID()}`;
  }
  return `provider-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

export function ProvidersPage({
  config,
  setConfig
}: {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}) {
  const addProvider = (): void => {
    const id = createProviderId();
    setConfig({
      ...config,
      providers: [
        ...config.providers,
        {
          id,
          label: "Custom Provider",
          kind: "custom-openai",
          apiMode: "chat",
          apiKey: "",
          baseUrl: "https://api.openai.com/v1",
          enabled: true
        }
      ]
    });
  };

  const removeProvider = (providerId: string): void => {
    const providers = config.providers.filter((provider) => provider.id !== providerId);
    if (providers.length === 0) {
      return;
    }

    const fallback = providers[0];
    const normalizeRoute = (route: { providerId: string; model: string }) => {
      if (route.providerId !== providerId) {
        return route;
      }
      return {
        ...route,
        providerId: fallback.id
      };
    };
    setConfig({
      ...config,
      providers,
      modelRouting: {
        chat: normalizeRoute(config.modelRouting.chat),
        factExtraction: normalizeRoute(config.modelRouting.factExtraction),
        reflection: normalizeRoute(config.modelRouting.reflection)
      }
    });
  };

  const providerOptions = config.providers.map((provider) => (
    <option value={provider.id} key={provider.id}>
      {provider.label}
    </option>
  ));

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle>Provider 管理</CardTitle>
            <CardDescription>
              内置 OpenAI / Anthropic / OpenRouter，也支持任意 OpenAI 兼容服务。
            </CardDescription>
          </div>
          <Button variant="outline" onClick={addProvider}>
            <Plus className="mr-2 h-4 w-4" />
            添加 Provider
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.providers.map((provider) => (
            <div
              key={provider.id}
              className="rounded-xl border border-border/80 bg-white/75 p-4 shadow-sm"
            >
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>名称</Label>
                  <Input
                    value={provider.label}
                    onChange={(event) =>
                      setConfig(updateProvider(config, provider.id, { label: event.target.value }))
                    }
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>类型</Label>
                  <Select
                    value={provider.kind}
                    onChange={(event) =>
                      setConfig(
                        updateProvider(config, provider.id, {
                          kind: event.target.value as ProviderConfig["kind"]
                        })
                      )
                    }
                  >
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="openrouter">OpenRouter</option>
                    <option value="custom-openai">Custom OpenAI Compatible</option>
                  </Select>
                </div>

                {provider.kind === "openai" || provider.kind === "custom-openai" ? (
                  <div className="space-y-1.5">
                    <Label>接口模式</Label>
                    <Select
                      value={provider.apiMode}
                      onChange={(event) =>
                        setConfig(
                          updateProvider(config, provider.id, {
                            apiMode: event.target.value as ProviderConfig["apiMode"]
                          })
                        )
                      }
                    >
                      <option value="chat">Chat Completions</option>
                      <option value="responses">Responses API</option>
                    </Select>
                  </div>
                ) : null}

                <div className="space-y-1.5 md:col-span-2">
                  <Label>API Key</Label>
                  <Input
                    type="password"
                    value={provider.apiKey}
                    placeholder="sk-..."
                    onChange={(event) =>
                      setConfig(updateProvider(config, provider.id, { apiKey: event.target.value }))
                    }
                  />
                </div>

                {provider.kind === "custom-openai" ? (
                  <div className="space-y-1.5 md:col-span-2">
                    <Label>Base URL</Label>
                    <Input
                      value={provider.baseUrl ?? ""}
                      placeholder="https://api.example.com/v1"
                      onChange={(event) =>
                        setConfig(updateProvider(config, provider.id, { baseUrl: event.target.value }))
                      }
                    />
                  </div>
                ) : null}
              </div>

              <div className="mt-4 flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={provider.enabled}
                    onChange={(checked) =>
                      setConfig(updateProvider(config, provider.id, { enabled: checked }))
                    }
                  />
                  <span>{provider.enabled ? "启用" : "停用"}</span>
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProvider(provider.id)}
                  disabled={config.providers.length <= 1}
                >
                  <Trash2 className="mr-1 h-4 w-4" />
                  删除
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型路由</CardTitle>
          <CardDescription>chat / factExtraction / reflection。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(
            [
              ["chat", "Chat"],
              ["factExtraction", "Fact Extraction"],
              ["reflection", "Reflection"]
            ] as const
          ).map(([routeKey, label]) => {
            const route = config.modelRouting[routeKey];
            const routeProviderExists = config.providers.some(
              (provider) => provider.id === route.providerId
            );
            return (
              <div key={routeKey} className="grid gap-3 rounded-lg border border-border/70 p-3 md:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>{label} Provider</Label>
                  <Select
                    value={route.providerId}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        modelRouting: {
                          ...config.modelRouting,
                          [routeKey]: {
                            ...route,
                            providerId: event.target.value
                          }
                        }
                      })
                    }
                  >
                    {!routeProviderExists ? (
                      <option value={route.providerId}>
                        缺失 Provider（{route.providerId}）
                      </option>
                    ) : null}
                    {providerOptions}
                  </Select>
                  {!routeProviderExists ? (
                    <p className="text-xs text-destructive">
                      当前路由引用了不存在的 provider，请重新选择后再保存。
                    </p>
                  ) : null}
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label>{label} Model</Label>
                  <Input
                    value={route.model}
                    onChange={(event) =>
                      setConfig({
                        ...config,
                        modelRouting: {
                          ...config.modelRouting,
                          [routeKey]: {
                            ...route,
                            model: event.target.value
                          }
                        }
                      })
                    }
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
