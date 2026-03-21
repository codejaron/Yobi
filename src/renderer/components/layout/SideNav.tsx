import {
  Bot,
  Brain,
  Clock3,
  Gauge,
  MessageSquare,
  Moon,
  Orbit,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Sparkles,
  Sun,
  Settings2
} from "lucide-react";
import type { ComponentType } from "react";
import type { ThemeMode } from "@shared/types";
import { cn } from "@renderer/lib/utils";
import type { PageId } from "@renderer/types";

const items: Array<{
  id: PageId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: "dashboard", label: "仪表盘", icon: Gauge },
  { id: "console", label: "聊天", icon: MessageSquare },
  { id: "scheduler", label: "定时任务", icon: Clock3 },
  { id: "skills", label: "Skills", icon: Sparkles },
  { id: "providers", label: "Provider", icon: Bot },
  { id: "memory", label: "记忆", icon: Brain },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "cognition", label: "认知", icon: Orbit },
  { id: "settings", label: "设置", icon: Settings2 }
];

export function SideNav({
  active,
  onSelect,
  themeMode,
  onThemeModeChange,
  themeSaving,
  collapsed,
  onToggleCollapsed
}: {
  active: PageId;
  onSelect: (pageId: PageId) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  themeSaving: boolean;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const isDarkModeActive =
    themeMode === "dark" ||
    (themeMode === "system" &&
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"));
  const nextThemeMode: ThemeMode = isDarkModeActive ? "light" : "dark";

  return (
    <aside
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden border-r border-border/70 bg-card/82 backdrop-blur-md",
        collapsed ? "p-2" : "p-3"
      )}
    >
      <div className={cn("mb-4 flex items-center", collapsed ? "justify-center" : "justify-between px-2 py-2")}>
        {collapsed ? null : (
          <div>
            <p className="truncate whitespace-nowrap font-display text-xl">Yobi</p>
            <p className="truncate whitespace-nowrap text-xs text-muted-foreground">桌面 AI 伴侣控制台</p>
          </div>
        )}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="rounded-md border border-border/70 p-1.5 text-foreground/80 transition hover:bg-secondary/70 hover:text-foreground"
          title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}
        >
          {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
        </button>
      </div>

      <nav className={cn("overflow-y-auto", collapsed ? "space-y-2" : "space-y-1 pr-1")}>
        {items.map((item) => {
          const Icon = item.icon;
          const selected = item.id === active;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              title={item.label}
              className={cn(
                "flex w-full items-center rounded-lg px-3 py-2 text-sm transition",
                collapsed ? "h-10 justify-center px-0" : "gap-3",
                selected
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-foreground/80 hover:bg-secondary/70 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              {collapsed ? null : <span className="truncate whitespace-nowrap">{item.label}</span>}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border/70 px-2 pt-4">
        <button
          type="button"
          onClick={() => onThemeModeChange(nextThemeMode)}
          disabled={themeSaving}
          title={isDarkModeActive ? "切换到浅色模式" : "切换到暗黑模式"}
          aria-label={isDarkModeActive ? "切换到浅色模式" : "切换到暗黑模式"}
          className={cn(
            "text-sm transition disabled:cursor-not-allowed disabled:opacity-60",
            collapsed
              ? "flex h-10 w-full items-center justify-center rounded-lg text-foreground/80 hover:bg-secondary/70 hover:text-foreground"
              : "flex w-full items-center gap-2 rounded-lg border border-border/70 px-3 py-2 hover:bg-secondary/70"
          )}
        >
          {isDarkModeActive ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          {collapsed ? null : (
            <span className="truncate whitespace-nowrap">
              {isDarkModeActive ? "切换到浅色" : "切换到暗黑"}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}
