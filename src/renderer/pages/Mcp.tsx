import { useState } from "react";
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
import { Textarea } from "@renderer/components/ui/textarea";

type McpServer = AppConfig["tools"]["mcp"]["servers"][number];

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function parseStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.entries(value).reduce<Record<string, string>>((result, [key, item]) => {
    const normalizedKey = key.trim();
    const normalizedValue = typeof item === "string" ? item.trim() : "";
    if (!normalizedKey || !normalizedValue) {
      return result;
    }
    result[normalizedKey] = normalizedValue;
    return result;
  }, {});
}

function normalizeServerId(input: string, fallback: string): string {
  const normalized = input
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return normalized || fallback;
}

function parseServerCandidate(
  candidate: Record<string, unknown>,
  fallbackId: string
): McpServer | null {
  const transportToken =
    typeof candidate.transport === "string"
      ? candidate.transport.trim().toLowerCase()
      : typeof candidate.type === "string"
        ? candidate.type.trim().toLowerCase()
        : "";
  const id = normalizeServerId(
    typeof candidate.id === "string" ? candidate.id : fallbackId,
    fallbackId
  );
  const labelSource =
    typeof candidate.label === "string"
      ? candidate.label
      : typeof candidate.name === "string"
        ? candidate.name
        : id;
  const label = labelSource.trim() || id;
  const enabled =
    typeof candidate.enabled === "boolean"
      ? candidate.enabled
      : typeof candidate.disabled === "boolean"
        ? !candidate.disabled
        : true;
  const command = typeof candidate.command === "string" ? candidate.command.trim() : "";
  const url = typeof candidate.url === "string" ? candidate.url.trim() : "";

  if (command || transportToken === "stdio") {
    if (!command) {
      return null;
    }

    return {
      id,
      label,
      enabled,
      transport: "stdio",
      command,
      args: parseStringArray(candidate.args),
      env: parseStringMap(candidate.env)
    };
  }

  const remoteTransportTokens = new Set([
    "remote",
    "http",
    "https",
    "sse",
    "streamablehttp",
    "streamable-http"
  ]);

  if (url || remoteTransportTokens.has(transportToken)) {
    if (!url) {
      return null;
    }

    return {
      id,
      label,
      enabled,
      transport: "remote",
      url,
      headers: parseStringMap(candidate.headers)
    };
  }

  return null;
}

function parseImportJson(raw: string): McpServer[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const fragment = trimmed
      .replace(/^\{/, "")
      .replace(/\}$/, "")
      .replace(/^,|,$/g, "");
    parsed = JSON.parse(`{${fragment}}`);
  }

  const parseArrayPayload = (items: unknown[]): McpServer[] =>
    items
      .map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return null;
        }

        return parseServerCandidate(item as Record<string, unknown>, `server-${index + 1}`);
      })
      .filter((item): item is McpServer => item !== null);

  if (Array.isArray(parsed)) {
    return parseArrayPayload(parsed);
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("JSON 根节点必须是对象或数组。");
  }

  const root = parsed as Record<string, unknown>;

  if (Array.isArray(root.servers)) {
    return parseArrayPayload(root.servers);
  }

  if (root.mcpServers && typeof root.mcpServers === "object" && !Array.isArray(root.mcpServers)) {
    return Object.entries(root.mcpServers as Record<string, unknown>)
      .map(([key, value]) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return null;
        }
        return parseServerCandidate(value as Record<string, unknown>, key);
      })
      .filter((item): item is McpServer => item !== null);
  }

  const maybeMap = Object.entries(root)
    .map(([key, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }

      return parseServerCandidate(value as Record<string, unknown>, key);
    })
    .filter((item): item is McpServer => item !== null);

  if (maybeMap.length > 0) {
    return maybeMap;
  }

  const single = parseServerCandidate(root, "server-1");
  if (single) {
    return [single];
  }

  return [];
}

function buildExportJson(servers: McpServer[]): string {
  const serverMap: Record<string, Record<string, unknown>> = {};

  for (const [index, server] of servers.entries()) {
    const id = normalizeServerId(server.id, `server-${index + 1}`);

    if (server.transport === "stdio") {
      const payload: Record<string, unknown> = {
        type: "stdio",
        command: server.command
      };

      if (server.args.length > 0) {
        payload.args = [...server.args];
      }

      if (Object.keys(server.env).length > 0) {
        payload.env = { ...server.env };
      }

      if (!server.enabled) {
        payload.disabled = true;
      }

      serverMap[id] = payload;
      continue;
    }

    const payload: Record<string, unknown> = {
      type: "remote",
      url: server.url
    };

    if (Object.keys(server.headers).length > 0) {
      payload.headers = { ...server.headers };
    }

    if (!server.enabled) {
      payload.disabled = true;
    }

    serverMap[id] = payload;
  }

  return JSON.stringify(serverMap, null, 2);
}

export function McpPage({
  config,
  setConfig
}: {
  config: AppConfig;
  setConfig: (next: AppConfig) => void;
}) {
  const [jsonText, setJsonText] = useState("");
  const [notice, setNotice] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const updateMcpServers = (servers: McpServer[]): void => {
    setConfig({
      ...config,
      tools: {
        ...config.tools,
        mcp: {
          ...config.tools.mcp,
          servers
        }
      }
    });
  };

  const appendImportedServers = (imported: McpServer[]): {
    next: McpServer[];
    appended: number;
    updated: number;
    skippedLocked: number;
  } => {
    const next = [...config.tools.mcp.servers];
    let appended = 0;
    let updated = 0;
    let skippedLocked = 0;

    for (const server of imported) {
      if (server.id === "exa") {
        skippedLocked += 1;
        continue;
      }

      const existingIndex = next.findIndex((item) => item.id === server.id);
      if (existingIndex >= 0) {
        next[existingIndex] = server;
        updated += 1;
        continue;
      }

      next.push(server);
      appended += 1;
    }

    return {
      next,
      appended,
      updated,
      skippedLocked
    };
  };

  const setServerEnabled = (serverId: string, enabled: boolean): void => {
    updateMcpServers(
      config.tools.mcp.servers.map((server) => {
        if (server.id !== serverId || server.id === "exa") {
          return server;
        }

        return {
          ...server,
          enabled
        };
      })
    );
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>JSON 导入 / 导出</CardTitle>
          <CardDescription>支持 JSON 导入导出。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                const exported = buildExportJson(config.tools.mcp.servers);
                setJsonText(exported);
                setNotice({
                  type: "success",
                  text: "已生成 JSON。"
                });
              }}
            >
              生成当前 JSON
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={async () => {
                const exported = buildExportJson(config.tools.mcp.servers);
                setJsonText(exported);
                if (typeof navigator !== "undefined" && navigator.clipboard) {
                  try {
                    await navigator.clipboard.writeText(exported);
                    setNotice({
                      type: "success",
                      text: "已复制到剪贴板。"
                    });
                    return;
                  } catch {
                    // ignore
                  }
                }

                setNotice({
                  type: "success",
                  text: "已生成 JSON，请手动复制。"
                });
              }}
            >
              复制当前 JSON
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                try {
                  const imported = parseImportJson(jsonText);
                  if (imported.length === 0) {
                    setNotice({
                      type: "error",
                      text: "未识别到有效 MCP Server。请检查 JSON。"
                    });
                    return;
                  }

                  const merged = appendImportedServers(imported);
                  updateMcpServers(merged.next);
                  setJsonText(buildExportJson(merged.next));
                  setNotice({
                    type: "success",
                    text:
                      merged.skippedLocked > 0
                        ? `导入成功：新增 ${merged.appended} 个，更新 ${merged.updated} 个，忽略内置 Exa ${merged.skippedLocked} 项。`
                        : merged.updated > 0
                          ? `导入成功：新增 ${merged.appended} 个，更新 ${merged.updated} 个。`
                          : `导入成功：新增 ${merged.appended} 个 Server。`
                  });
                } catch (error) {
                  setNotice({
                    type: "error",
                    text: error instanceof Error ? error.message : "JSON 解析失败。"
                  });
                }
              }}
            >
              从 JSON 导入
            </Button>
          </div>

          {notice ? (
            <p className={notice.type === "error" ? "text-xs text-red-500" : "text-xs text-emerald-600"}>
              {notice.text}
            </p>
          ) : null}

          <div className="space-y-1.5">
            <Label>JSON 内容</Label>
            <Textarea
              rows={12}
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              className="font-mono text-xs leading-6"
              placeholder={`{
  "exa": {
    "type": "remote",
    "url": "https://mcp.exa.ai/mcp"
  }
}`}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>MCP Server 列表</CardTitle>
          <CardDescription>每个 Server 可单独开关；内置 Exa 固定锁定。</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {config.tools.mcp.servers.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无 MCP Server。可在上方 JSON 导入。</p>
          ) : (
            config.tools.mcp.servers.map((server, index) => (
              <div
                key={`${server.id}-${index}`}
                className="space-y-3 rounded-md border border-border/70 bg-white/70 p-3"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Server #{index + 1}</p>
                  {server.id === "exa" ? (
                    <span className="text-xs text-muted-foreground">内置锁定</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">
                        {server.enabled ? "已开启" : "已关闭"}
                      </span>
                      <Switch
                        checked={server.enabled}
                        onChange={(checked) => setServerEnabled(server.id, checked)}
                      />
                    </div>
                  )}
                </div>

                <pre className="overflow-auto rounded-md border border-border/70 bg-muted/40 p-3 font-mono text-xs leading-6">
{JSON.stringify(
  server.transport === "remote"
    ? {
        id: server.id,
        label: server.label,
        enabled: server.enabled,
        type: "remote",
        url: server.url,
        headers: server.headers
      }
    : {
        id: server.id,
        label: server.label,
        enabled: server.enabled,
        type: "stdio",
        command: server.command,
        args: server.args,
        env: server.env
      },
  null,
  2
)}
                </pre>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
