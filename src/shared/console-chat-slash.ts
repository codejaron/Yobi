import type { AppConfig, SkillCatalogItem } from "./types";

export type ConsoleSlashGroup = "commands" | "skills";
export type ConsoleSlashFeedbackTone = "neutral" | "warn";

export interface ConsoleSlashFeedback {
  tone: ConsoleSlashFeedbackTone;
  message: string;
}

interface ConsoleSlashActionBase {
  nextEnabled: boolean;
  feedback: ConsoleSlashFeedback;
}

export type ConsoleSlashCommandAction =
  | (ConsoleSlashActionBase & {
      type: "toggle-proactive";
    })
  | (ConsoleSlashActionBase & {
      type: "toggle-pet";
    })
  | (ConsoleSlashActionBase & {
      type: "toggle-skill";
      skillId: string;
      skillName: string;
    });

export interface ConsoleSlashCommandItem {
  id: string;
  group: ConsoleSlashGroup;
  label: string;
  description: string;
  keywords: string[];
  currentEnabled: boolean;
  action: ConsoleSlashCommandAction;
}

function normalizeSearchValue(value: string): string {
  return value.trim().toLowerCase();
}

function buildSearchText(item: ConsoleSlashCommandItem): string {
  return normalizeSearchValue([item.label, item.description, ...item.keywords].join(" "));
}

function compareSkillItems(left: SkillCatalogItem, right: SkillCatalogItem): number {
  if (left.enabled !== right.enabled) {
    return left.enabled ? -1 : 1;
  }

  return left.name.localeCompare(right.name, "zh-CN");
}

export function isConsoleSlashDraft(draft: string): boolean {
  return draft.trimStart().startsWith("/");
}

export function getConsoleSlashQuery(draft: string): string {
  if (!isConsoleSlashDraft(draft)) {
    return "";
  }

  return draft.trimStart().slice(1).trim();
}

export function buildConsoleSlashCommandItems(input: {
  config: AppConfig;
  skills: SkillCatalogItem[];
}): ConsoleSlashCommandItem[] {
  const { config, skills } = input;
  const proactiveEnabled = config.proactive.enabled;
  const petEnabled = config.pet.enabled;
  const petMissingModel = !config.pet.modelDir.trim();

  const items: ConsoleSlashCommandItem[] = [
    {
      id: "command:proactive",
      group: "commands",
      label: proactiveEnabled ? "关闭主动聊天" : "开启主动聊天",
      description: "切换主动聊天总开关",
      keywords: ["proactive", "主动", "主动聊天", "推送"],
      currentEnabled: proactiveEnabled,
      action: {
        type: "toggle-proactive",
        nextEnabled: !proactiveEnabled,
        feedback: {
          tone: "neutral",
          message: proactiveEnabled ? "已关闭主动聊天" : "已开启主动聊天"
        }
      }
    },
    {
      id: "command:pet",
      group: "commands",
      label: petEnabled ? "关闭桌宠" : "开启桌宠",
      description: "切换桌宠窗口总开关",
      keywords: ["pet", "桌宠", "live2d"],
      currentEnabled: petEnabled,
      action: {
        type: "toggle-pet",
        nextEnabled: !petEnabled,
        feedback:
          !petEnabled && petMissingModel
            ? {
                tone: "warn",
                message: "已开启桌宠，但模型未导入"
              }
            : {
                tone: "neutral",
                message: petEnabled ? "已关闭桌宠" : "已开启桌宠"
              }
      }
    }
  ];

  const skillItems = [...skills]
    .sort(compareSkillItems)
    .map<ConsoleSlashCommandItem>((skill) => ({
      id: `skill:${skill.id}`,
      group: "skills",
      label: skill.name,
      description: skill.enabled ? "停用 skill" : "启用 skill",
      keywords: ["skill", "技能", skill.name, skill.description, ...skill.tags],
      currentEnabled: skill.enabled,
      action: {
        type: "toggle-skill",
        skillId: skill.id,
        skillName: skill.name,
        nextEnabled: !skill.enabled,
        feedback: {
          tone: "neutral",
          message: skill.enabled ? `已停用 skill：${skill.name}` : `已启用 skill：${skill.name}`
        }
      }
    }));

  return [...items, ...skillItems];
}

export function filterConsoleSlashCommandItems(
  items: ConsoleSlashCommandItem[],
  query: string
): ConsoleSlashCommandItem[] {
  const normalized = normalizeSearchValue(query);
  if (!normalized) {
    return items;
  }

  const tokens = normalized.split(/\s+/).filter(Boolean);
  return items.filter((item) => {
    const searchText = buildSearchText(item);
    return tokens.every((token) => searchText.includes(token));
  });
}

export function getNextConsoleSlashIndex(currentIndex: number, delta: number, total: number): number {
  if (total <= 0) {
    return 0;
  }

  const next = (currentIndex + delta) % total;
  return next >= 0 ? next : next + total;
}
