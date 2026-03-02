import {
  Bot,
  Brain,
  Gauge,
  ListChecks,
  MessageSquare,
  MessageCircleHeart,
  Plug,
  Settings2
} from "lucide-react";
import type { ComponentType } from "react";
import { cn } from "@renderer/lib/utils";
import type { PageId } from "@renderer/types";

const items: Array<{
  id: PageId;
  label: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { id: "dashboard", label: "仪表盘", icon: Gauge },
  { id: "topics", label: "话题池", icon: ListChecks },
  { id: "console", label: "聊天", icon: MessageSquare },
  { id: "providers", label: "Provider", icon: Bot },
  { id: "character", label: "角色", icon: MessageCircleHeart },
  { id: "memory", label: "记忆", icon: Brain },
  { id: "mcp", label: "MCP", icon: Plug },
  { id: "settings", label: "设置", icon: Settings2 }
];

export function SideNav({
  active,
  onSelect
}: {
  active: PageId;
  onSelect: (pageId: PageId) => void;
}) {
  return (
    <aside className="glass-panel sticky top-6 h-fit p-3">
      <div className="mb-4 px-2 py-3">
        <p className="font-display text-xl">Yobi</p>
        <p className="text-xs text-muted-foreground">桌面 AI 伴侣控制台</p>
      </div>

      <nav className="space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const selected = item.id === active;

          return (
            <button
              key={item.id}
              type="button"
              onClick={() => onSelect(item.id)}
              className={cn(
                "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition",
                selected
                  ? "bg-primary text-primary-foreground shadow"
                  : "text-foreground/80 hover:bg-secondary/70 hover:text-foreground"
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
