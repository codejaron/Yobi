import { useState } from "react";
import { LoaderCircle, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { AppConfig, ProviderConfig } from "@shared/types";
import {
  applyProviderKindDefaults,
  getProviderKindLabel,
  supportsModelDiscovery,
  type ProviderKind,
  type ProviderModelListResult
} from "@shared/provider-catalog";
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

const PROVIDER_KIND_OPTIONS: ProviderKind[] = [
  "openai",
  "anthropic",
  "openrouter",
  "deepseek",
  "qwen",
  "moonshot",
  "zhipu",
  "minimax",
  "custom-openai"
];

type ProviderModelResultsState = Record<string, ProviderModelListResult | undefined>;
type ProviderModelLoadingState = Record<string, boolean | undefined>;
type ProviderModelToggleState = Record<string, boolean | undefined>;

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

function replaceProvider(
  config: AppConfig,
  providerId: string,
  nextProvider: ProviderConfig
): AppConfig {
  return {
    ...config,
    providers: config.providers.map((provider) => (provider.id === providerId ? nextProvider : provider))
  };
}

function createProviderId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `provider-${crypto.randomUUID()}`;
  }
  return `provider-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function createDefaultProvider(id: string): ProviderConfig {
  return applyProviderKindDefaults({
    id,
    label: "Custom Provider",
    kind: "custom-openai",
    apiMode: "chat",
    apiKey: "",
    baseUrl: "https://api.openai.com/v1",
    enabled: true
  }) as ProviderConfig;
}

export function ProvidersPage({
  config,
  setConfig
}: {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}) {
  const [providerModelResults, setProviderModelResults] = useState<ProviderModelResultsState>({});
  const [providerModelLoading, setProviderModelLoading] = useState<ProviderModelLoadingState>({});
  const [showAllModelOptions, setShowAllModelOptions] = useState<ProviderModelToggleState>({});

  const clearProviderModels = (providerId: string): void => {
    setProviderModelResults((current) => {
      if (!current[providerId]) {
        return current;
      }
      const next = {
        ...current
      };
      delete next[providerId];
      return next;
    });
  };

  const addProvider = (): void => {
    const id = createProviderId();
    setConfig({
      ...config,
      providers: [...config.providers, createDefaultProvider(id)]
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
    clearProviderModels(providerId);
    setConfig({
      ...config,
      providers,
      modelRouting: {
        chat: normalizeRoute(config.modelRouting.chat),
        factExtraction: normalizeRoute(config.modelRouting.factExtraction),
        reflection: normalizeRoute(config.modelRouting.reflection),
        cognition: normalizeRoute(config.modelRouting.cognition)
      }
    });
  };

  const handleProviderFieldChange = (
    providerId: string,
    patch: Partial<ProviderConfig>,
    options?: {
      clearModels?: boolean;
    }
  ): void => {
    if (options?.clearModels) {
      clearProviderModels(providerId);
    }
    setConfig(updateProvider(config, providerId, patch));
  };

  const handleProviderKindChange = (provider: ProviderConfig, nextKind: ProviderKind): void => {
    clearProviderModels(provider.id);
    setShowAllModelOptions((current) => ({
      ...current,
      [provider.id]: false
    }));
    const nextProvider = applyProviderKindDefaults({
      ...provider,
      kind: nextKind,
      label: getProviderKindLabel(nextKind),
      apiMode: "chat"
    }) as ProviderConfig;
    setConfig(replaceProvider(config, provider.id, nextProvider));
  };

  const refreshProviderModels = async (provider: ProviderConfig): Promise<void> => {
    setProviderModelLoading((current) => ({
      ...current,
      [provider.id]: true
    }));

    try {
      const result = await window.companion.listProviderModels({
        provider
      });
      setProviderModelResults((current) => ({
        ...current,
        [provider.id]: result
      }));
    } catch (error) {
      setProviderModelResults((current) => ({
        ...current,
        [provider.id]: {
          items: [],
          allItems: [],
          source: "remote",
          fetchedAt: new Date().toISOString(),
          error: {
            code: "provider_error",
            message: "模型列表拉取失败，请稍后重试或手动填写模型名",
            details: error instanceof Error ? error.message : String(error),
            status: null
          }
        }
      }));
    } finally {
      setProviderModelLoading((current) => ({
        ...current,
        [provider.id]: false
      }));
    }
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
              内置 OpenAI / Anthropic / OpenRouter，以及 DeepSeek、Qwen、Moonshot、Zhipu、MiniMax。
            </CardDescription>
          </div>
          <Button variant="outline" onClick={addProvider}>
            <Plus className="mr-2 h-4 w-4" />
            添加 Provider
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.providers.map((provider) => {
            const modelResult = providerModelResults[provider.id];
            const modelCandidates =
              showAllModelOptions[provider.id] === true ? modelResult?.allItems ?? [] : modelResult?.items ?? [];
            const canRefreshModels = supportsModelDiscovery(provider.kind);

            return (
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
                        handleProviderFieldChange(provider.id, { label: event.target.value })
                      }
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label>类型</Label>
                    <Select
                      value={provider.kind}
                      onChange={(event) =>
                        handleProviderKindChange(provider, event.target.value as ProviderKind)
                      }
                    >
                      {PROVIDER_KIND_OPTIONS.map((kind) => (
                        <option value={kind} key={kind}>
                          {getProviderKindLabel(kind)}
                        </option>
                      ))}
                    </Select>
                  </div>

                  {provider.kind === "openai" || provider.kind === "custom-openai" ? (
                    <div className="space-y-1.5">
                      <Label>接口模式</Label>
                      <Select
                        value={provider.apiMode}
                        onChange={(event) =>
                          handleProviderFieldChange(provider.id, {
                            apiMode: event.target.value as ProviderConfig["apiMode"]
                          })
                        }
                      >
                        <option value="chat">Chat Completions</option>
                        <option value="responses">Responses API</option>
                      </Select>
                    </div>
                  ) : null}

                  {provider.kind === "qwen" ? (
                    <div className="space-y-1.5">
                      <Label>区域</Label>
                      <Select
                        value={provider.qwenRegion ?? "cn"}
                        onChange={(event) =>
                          handleProviderFieldChange(
                            provider.id,
                            {
                              qwenRegion: event.target.value as NonNullable<ProviderConfig["qwenRegion"]>
                            },
                            {
                              clearModels: true
                            }
                          )
                        }
                      >
                        <option value="cn">中国站</option>
                        <option value="intl">国际站</option>
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
                        handleProviderFieldChange(
                          provider.id,
                          {
                            apiKey: event.target.value
                          },
                          {
                            clearModels: true
                          }
                        )
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
                          handleProviderFieldChange(
                            provider.id,
                            {
                              baseUrl: event.target.value
                            },
                            {
                              clearModels: true
                            }
                          )
                        }
                      />
                    </div>
                  ) : null}
                </div>

                {canRefreshModels ? (
                  <div className="mt-4 rounded-lg border border-border/70 bg-card/70 p-3">
                    <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                      <div className="space-y-1">
                        <div className="text-sm font-medium">模型列表</div>
                        <div className="text-xs text-muted-foreground">
                          只从远端返回结果生成候选；拉取失败时仍可手动填写模型名。
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-3">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => void refreshProviderModels(provider)}
                          disabled={providerModelLoading[provider.id] === true}
                        >
                          {providerModelLoading[provider.id] === true ? (
                            <LoaderCircle className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <RefreshCw className="mr-2 h-4 w-4" />
                          )}
                          刷新模型
                        </Button>
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Switch
                            checked={showAllModelOptions[provider.id] === true}
                            onChange={(checked) =>
                              setShowAllModelOptions((current) => ({
                                ...current,
                                [provider.id]: checked
                              }))
                            }
                          />
                          显示全部返回项
                        </label>
                      </div>
                    </div>

                    {modelResult ? (
                      <div className="mt-3 space-y-2 text-xs">
                        <div className="text-muted-foreground">
                          当前显示 {modelCandidates.length} 个候选，远端共返回 {modelResult.allItems.length} 个。
                        </div>
                        {modelCandidates.length > 0 ? (
                          <div className="flex flex-wrap gap-2">
                            {modelCandidates.slice(0, 12).map((item) => (
                              <span
                                key={`${provider.id}-${item.value}`}
                                className="rounded-full border border-border/70 bg-card px-2 py-1"
                              >
                                {item.label}
                              </span>
                            ))}
                            {modelCandidates.length > 12 ? (
                              <span className="rounded-full border border-border/70 bg-card px-2 py-1 text-muted-foreground">
                                +{modelCandidates.length - 12}
                              </span>
                            ) : null}
                          </div>
                        ) : null}
                        {modelResult.error ? (
                          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2 text-destructive">
                            <div>{modelResult.error.message}</div>
                            {modelResult.error.details ? (
                              <details className="mt-1 text-[11px]">
                                <summary>技术详情</summary>
                                <div className="mt-1 break-all text-foreground/80">
                                  {modelResult.error.details}
                                </div>
                              </details>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm">
                    <Switch
                      checked={provider.enabled}
                      onChange={(checked) =>
                        handleProviderFieldChange(provider.id, { enabled: checked })
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
            );
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>模型路由</CardTitle>
          <CardDescription>chat / factExtraction / reflection / cognition。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {(
            [
              ["chat", "Chat"],
              ["factExtraction", "Fact Extraction"],
              ["reflection", "Reflection"],
              ["cognition", "Cognition"]
            ] as const
          ).map(([routeKey, label]) => {
            const route = config.modelRouting[routeKey];
            const routeProvider = config.providers.find((provider) => provider.id === route.providerId);
            const routeProviderExists = Boolean(routeProvider);
            const routeProviderModels = routeProvider ? providerModelResults[routeProvider.id]?.items ?? [] : [];
            const datalistId = `provider-models-${routeKey}`;

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
                    list={routeProviderModels.length > 0 ? datalistId : undefined}
                    value={route.model}
                    placeholder={
                      routeProviderModels.length > 0 ? "可直接选择或继续手填" : "手动填写模型名"
                    }
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
                  {routeProviderModels.length > 0 ? (
                    <datalist id={datalistId}>
                      {routeProviderModels.map((item) => (
                        <option value={item.value} key={`${routeKey}-${item.value}`}>
                          {item.label}
                        </option>
                      ))}
                    </datalist>
                  ) : null}
                  <p className="text-xs text-muted-foreground">
                    {routeProviderModels.length > 0
                      ? `已加载 ${routeProviderModels.length} 个候选，也可以继续手动填写。`
                      : "当前没有候选模型；可回到对应 Provider 卡片刷新，或直接手动填写。"}
                  </p>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
