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
    setConfig({
      ...config,
      providers,
      modelRouting: {
        chat:
          config.modelRouting.chat.providerId === providerId
            ? { ...config.modelRouting.chat, providerId: fallback.id }
            : config.modelRouting.chat,
        perception:
          config.modelRouting.perception.providerId === providerId
            ? { ...config.modelRouting.perception, providerId: fallback.id }
            : config.modelRouting.perception,
        memory:
          config.modelRouting.memory.providerId === providerId
            ? { ...config.modelRouting.memory, providerId: fallback.id }
            : config.modelRouting.memory
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
          <CardTitle>模型分配</CardTitle>
          <CardDescription>聊天 / 屏幕感知 / 记忆提取可使用不同模型，节省成本。</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-1.5">
            <Label>聊天 Provider</Label>
            <Select
              value={config.modelRouting.chat.providerId}
              onChange={(event) =>
                setConfig({
                  ...config,
                  modelRouting: {
                    ...config.modelRouting,
                    chat: {
                      ...config.modelRouting.chat,
                      providerId: event.target.value
                    }
                  }
                })
              }
            >
              {providerOptions}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>聊天模型</Label>
            <Input
              value={config.modelRouting.chat.model}
              onChange={(event) =>
                setConfig({
                  ...config,
                  modelRouting: {
                    ...config.modelRouting,
                    chat: {
                      ...config.modelRouting.chat,
                      model: event.target.value
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>屏幕感知 Provider</Label>
            <Select
              value={config.modelRouting.perception.providerId}
              onChange={(event) =>
                setConfig({
                  ...config,
                  modelRouting: {
                    ...config.modelRouting,
                    perception: {
                      ...config.modelRouting.perception,
                      providerId: event.target.value
                    }
                  }
                })
              }
            >
              {providerOptions}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>屏幕感知模型</Label>
            <Input
              value={config.modelRouting.perception.model}
              onChange={(event) =>
                setConfig({
                  ...config,
                  modelRouting: {
                    ...config.modelRouting,
                    perception: {
                      ...config.modelRouting.perception,
                      model: event.target.value
                    }
                  }
                })
              }
            />
          </div>

          <div className="space-y-1.5">
            <Label>记忆总结 Provider</Label>
            <Select
              value={config.modelRouting.memory.providerId}
              onChange={(event) =>
                setConfig({
                  ...config,
                  modelRouting: {
                    ...config.modelRouting,
                    memory: {
                      ...config.modelRouting.memory,
                      providerId: event.target.value
                    }
                  }
                })
              }
            >
              {providerOptions}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>记忆总结模型</Label>
            <Input
              value={config.modelRouting.memory.model}
              onChange={(event) =>
                setConfig({
                  ...config,
                  modelRouting: {
                    ...config.modelRouting,
                    memory: {
                      ...config.modelRouting.memory,
                      model: event.target.value
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
