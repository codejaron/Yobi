import { useEffect, useState } from "react";
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

function toFloat(raw: string, fallback: number, min: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

export function MemorySettingsCard({
  config,
  status,
  setConfig
}: MemorySettingsCardProps) {
  const semanticEnabled = config.memory.embedding.enabled;
  const showFallbackWarning = semanticEnabled && status?.embedder.mode === "bm25-only";
  const [recentMessagesDraft, setRecentMessagesDraft] = useState(() => String(config.memory.recentMessages));
  const [cognitionBatchRoundsDraft, setCognitionBatchRoundsDraft] = useState(() =>
    String(config.memory.cognitionBatchRounds)
  );
  const [similarityThresholdDraft, setSimilarityThresholdDraft] = useState(() =>
    String(config.memory.embedding.similarityThreshold)
  );

  useEffect(() => {
    setRecentMessagesDraft(String(config.memory.recentMessages));
  }, [config.memory.recentMessages]);

  useEffect(() => {
    setCognitionBatchRoundsDraft(String(config.memory.cognitionBatchRounds));
  }, [config.memory.cognitionBatchRounds]);

  useEffect(() => {
    setSimilarityThresholdDraft(String(config.memory.embedding.similarityThreshold));
  }, [config.memory.embedding.similarityThreshold]);

  const commitRecentMessages = () => {
    const nextValue = toInt(recentMessagesDraft, config.memory.recentMessages, 10, 400);
    setRecentMessagesDraft(String(nextValue));
    if (nextValue === config.memory.recentMessages) {
      return;
    }
    setConfig({
      ...config,
      memory: {
        ...config.memory,
        recentMessages: nextValue
      }
    });
  };

  const commitSimilarityThreshold = () => {
    const nextValue = toFloat(similarityThresholdDraft, config.memory.embedding.similarityThreshold, 0, 1);
    setSimilarityThresholdDraft(String(nextValue));
    if (nextValue === config.memory.embedding.similarityThreshold) {
      return;
    }
    setConfig({
      ...config,
      memory: {
        ...config.memory,
        embedding: {
          ...config.memory.embedding,
          similarityThreshold: nextValue
        }
      }
    });
  };

  const commitCognitionBatchRounds = () => {
    const nextValue = toInt(cognitionBatchRoundsDraft, config.memory.cognitionBatchRounds, 1, 50);
    setCognitionBatchRoundsDraft(String(nextValue));
    if (nextValue === config.memory.cognitionBatchRounds) {
      return;
    }
    setConfig({
      ...config,
      memory: {
        ...config.memory,
        cognitionBatchRounds: nextValue
      }
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>内核与记忆</CardTitle>
        <CardDescription>常用参数已固定到运行时；这里只保留少量高级调参。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between rounded-md border border-border/70 bg-white/70 px-3 py-2">
          <div className="space-y-1">
            <Label>启用本地语义检索</Label>
            <p className="text-xs text-muted-foreground">开启后会尝试使用本地 embedding；若缺默认 GGUF，会自动后台下载。</p>
          </div>
          <Switch
            checked={semanticEnabled}
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
        {showFallbackWarning ? (
          <div className="status-surface status-surface--warn rounded-md px-3 py-2 text-sm">
            当前检索处于回退模式；请检查本地 GGUF 模型或词法索引状态是否可用。
          </div>
        ) : null}
        <details className="rounded-md border border-border/70 bg-white/70 px-3 py-3">
          <summary className="cursor-pointer list-none text-sm font-medium">高级参数</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>最近消息上限</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={recentMessagesDraft}
                onChange={(event) => setRecentMessagesDraft(event.target.value)}
                onBlur={commitRecentMessages}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">如果 token 预算允许，最多从 recent buffer 里取这么多条消息参与组装。</p>
            </div>
            <div className="space-y-1.5">
              <Label>认知图批量更新轮次</Label>
              <Input
                type="text"
                inputMode="numeric"
                value={cognitionBatchRoundsDraft}
                onChange={(event) => setCognitionBatchRoundsDraft(event.target.value)}
                onBlur={commitCognitionBatchRounds}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">轮次越多，消耗 token 越少，但认知系统更新越慢；轮次越少，认知系统更新越快，但更容易引入噪声。</p>
            </div>
            <div className="space-y-1.5">
              <Label>语义相似度阈值</Label>
              <Input
                type="text"
                inputMode="decimal"
                value={similarityThresholdDraft}
                onChange={(event) => setSimilarityThresholdDraft(event.target.value)}
                onBlur={commitSimilarityThreshold}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
              <p className="text-xs text-muted-foreground">默认值为 0.55，越高越严格，越低越容易召回边缘相关记忆。</p>
            </div>
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
