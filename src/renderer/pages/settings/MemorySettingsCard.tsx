import type { AppConfig, AppStatus } from "@shared/types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle
} from "@renderer/components/ui/card";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
import { Switch } from "@renderer/components/ui/switch";

interface MemorySettingsCardProps {
  config: AppConfig;
  status: AppStatus | null;
  setConfig: (next: AppConfig) => void;
}

function toInt(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export function MemorySettingsCard({
  config,
  status,
  setConfig
}: MemorySettingsCardProps) {
  const showFallbackWarning =
    (status?.embedder.mode === "bm25-only" || status?.embedder.mode === "vector-only") &&
    config.memory.embedding.enabled;

  return (
    <Card>
      <CardHeader>
        <CardTitle>内核与记忆</CardTitle>
        <CardDescription>
          配置 buffer 上限、tick 节拍、fact extraction 预算与关系抗抖动窗口。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {showFallbackWarning ? (
          <div className="rounded-md border border-amber-300/80 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            当前检索处于回退模式；请检查本地 GGUF 模型或词法索引状态是否可用。
          </div>
        ) : null}

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用 Kernel V2</Label>
          <Switch
            checked={config.kernel.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                kernel: {
                  ...config.kernel,
                  enabled: checked
                }
              })
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Buffer 最大消息数</Label>
            <Input
              type="number"
              min={20}
              max={1000}
              value={String(config.kernel.buffer.maxMessages)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    buffer: {
                      ...config.kernel.buffer,
                      maxMessages: toInt(event.target.value, config.kernel.buffer.maxMessages, 20, 1000)
                    }
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Buffer 低水位</Label>
            <Input
              type="number"
              min={10}
              max={999}
              value={String(config.kernel.buffer.lowWatermark)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    buffer: {
                      ...config.kernel.buffer,
                      lowWatermark: toInt(event.target.value, config.kernel.buffer.lowWatermark, 10, 999)
                    }
                  }
                })
              }
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>记忆块保底预算(tokens)</Label>
            <Input
              type="number"
              min={200}
              max={8000}
              value={String(config.memory.context.memoryFloorTokens)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    context: {
                      ...config.memory.context,
                      memoryFloorTokens: toInt(event.target.value, config.memory.context.memoryFloorTokens, 200, 8000)
                    }
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>对话上下文上限(tokens)</Label>
            <Input
              type="number"
              min={4000}
              max={24000}
              value={String(config.memory.context.maxPromptTokens)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    context: {
                      ...config.memory.context,
                      maxPromptTokens: toInt(event.target.value, config.memory.context.maxPromptTokens, 4000, 24000)
                    }
                  }
                })
              }
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>最近消息上限</Label>
            <Input
              type="number"
              min={10}
              max={400}
              value={String(config.memory.recentMessages)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    recentMessages: toInt(event.target.value, config.memory.recentMessages, 10, 400)
                  }
                })
              }
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用本地语义检索</Label>
          <Switch
            checked={config.memory.embedding.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                memory: {
                  ...config.memory,
                  embedding: {
                    ...config.memory.embedding,
                    enabled: checked
                  }
                }
              })
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Embedding 模型标识 / 文件名</Label>
            <Input
              value={config.memory.embedding.modelId}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    embedding: {
                      ...config.memory.embedding,
                      modelId: event.target.value || config.memory.embedding.modelId
                    }
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>语义相似度阈值</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step="0.01"
              value={String(config.memory.embedding.similarityThreshold)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  memory: {
                    ...config.memory,
                    embedding: {
                      ...config.memory.embedding,
                      similarityThreshold: Math.max(
                        0,
                        Math.min(1, Number(event.target.value) || config.memory.embedding.similarityThreshold)
                      )
                    }
                  }
                })
              }
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>活跃 Tick(ms)</Label>
            <Input
              type="number"
              min={1000}
              value={String(config.kernel.tick.activeIntervalMs)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    tick: {
                      ...config.kernel.tick,
                      activeIntervalMs: toInt(
                        event.target.value,
                        config.kernel.tick.activeIntervalMs,
                        1000,
                        600000
                      )
                    }
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>安静 Tick(ms)</Label>
            <Input
              type="number"
              min={1000}
              value={String(config.kernel.tick.quietIntervalMs)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    tick: {
                      ...config.kernel.tick,
                      quietIntervalMs: toInt(
                        event.target.value,
                        config.kernel.tick.quietIntervalMs,
                        1000,
                        600000
                      )
                    }
                  }
                })
              }
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Fact 输入预算(tokens)</Label>
            <Input
              type="number"
              min={256}
              value={String(config.kernel.factExtraction.maxInputTokens)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    factExtraction: {
                      ...config.kernel.factExtraction,
                      maxInputTokens: toInt(
                        event.target.value,
                        config.kernel.factExtraction.maxInputTokens,
                        256,
                        16000
                      )
                    }
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>Fact 输出预算(tokens)</Label>
            <Input
              type="number"
              min={128}
              value={String(config.kernel.factExtraction.maxOutputTokens)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    factExtraction: {
                      ...config.kernel.factExtraction,
                      maxOutputTokens: toInt(
                        event.target.value,
                        config.kernel.factExtraction.maxOutputTokens,
                        128,
                        4000
                      )
                    }
                  }
                })
              }
            />
          </div>
        </div>

        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <Label>启用窗口情绪信号</Label>
          <Switch
            checked={config.kernel.emotionSignals.enabled}
            onChange={(checked) =>
              setConfig({
                ...config,
                kernel: {
                  ...config.kernel,
                  emotionSignals: {
                    ...config.kernel.emotionSignals,
                    enabled: checked
                  }
                }
              })
            }
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>信号全效时间(分钟)</Label>
            <Input
              type="number"
              min={1}
              max={1440}
              value={String(config.kernel.emotionSignals.stalenessFullEffectMinutes)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    emotionSignals: {
                      ...config.kernel.emotionSignals,
                      stalenessFullEffectMinutes: toInt(
                        event.target.value,
                        config.kernel.emotionSignals.stalenessFullEffectMinutes,
                        1,
                        1440
                      )
                    }
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>信号最久生效(小时)</Label>
            <Input
              type="number"
              min={1}
              max={168}
              value={String(config.kernel.emotionSignals.stalenessMaxAgeHours)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    emotionSignals: {
                      ...config.kernel.emotionSignals,
                      stalenessMaxAgeHours: toInt(
                        event.target.value,
                        config.kernel.emotionSignals.stalenessMaxAgeHours,
                        1,
                        168
                      )
                    }
                  }
                })
              }
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>关系升级窗口(天)</Label>
            <Input
              type="number"
              min={1}
              value={String(config.kernel.relationship.upgradeWindowDays)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    relationship: {
                      ...config.kernel.relationship,
                      upgradeWindowDays: toInt(
                        event.target.value,
                        config.kernel.relationship.upgradeWindowDays,
                        1,
                        30
                      )
                    }
                  }
                })
              }
            />
          </div>
          <div className="space-y-1.5">
            <Label>关系降级窗口(天)</Label>
            <Input
              type="number"
              min={1}
              value={String(config.kernel.relationship.downgradeWindowDays)}
              onChange={(event) =>
                setConfig({
                  ...config,
                  kernel: {
                    ...config.kernel,
                    relationship: {
                      ...config.kernel.relationship,
                      downgradeWindowDays: toInt(
                        event.target.value,
                        config.kernel.relationship.downgradeWindowDays,
                        1,
                        90
                      )
                    }
                  }
                })
              }
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>会话恢复阈值（小时）</Label>
          <Input
            type="number"
            min={1}
            max={168}
            value={String(config.kernel.sessionReentryGapHours)}
            onChange={(event) =>
              setConfig({
                ...config,
                kernel: {
                  ...config.kernel,
                  sessionReentryGapHours: toInt(event.target.value, config.kernel.sessionReentryGapHours, 1, 168)
                }
              })
            }
          />
        </div>

        <div className="space-y-1.5">
          <Label>每日任务小时（0-23）</Label>
          <Input
            type="number"
            min={0}
            max={23}
            value={String(config.kernel.dailyTaskHour)}
            onChange={(event) =>
              setConfig({
                ...config,
                kernel: {
                  ...config.kernel,
                  dailyTaskHour: toInt(event.target.value, config.kernel.dailyTaskHour, 0, 23)
                }
              })
            }
          />
        </div>

      </CardContent>
    </Card>
  );
}
