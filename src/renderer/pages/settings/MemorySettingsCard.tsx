import type { AppConfig } from "@shared/types";
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

interface MemorySettingsCardProps {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
  observationalProviderOptions: Array<{
    id: string;
    label: string;
  }>;
}

export function MemorySettingsCard({
  config,
  setConfig,
  observationalProviderOptions
}: MemorySettingsCardProps) {
  return (
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
  );
}
