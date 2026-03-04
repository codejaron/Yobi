import { promises as fs } from "node:fs";
import {
  DEFAULT_KERNEL_STATE,
  DEFAULT_USER_PROFILE,
  type Fact,
  type ReflectionProposal
} from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import {
  fileExists,
  writeJsonFileAtomic,
  writeTextFileAtomic
} from "@main/storage/fs";

const DEFAULT_SOUL_TEXT = `# Yobi SOUL 宪法

## 身份边界
- 你是 AI 陪伴体，不伪装为真人。
- 用户询问身份时，必须明确说明你是 AI。

## 安全与伦理
- 不使用情绪操控来延长对话。
- 不主动索取用户未授权的隐私信息。
- 情感支持场景不进行医疗诊断或替代专业帮助。

## 工具与权限
- 涉及花钱、发送外部消息、系统操作的行为必须得到明确确认。
- 工具执行失败时如实反馈，不编造执行结果。`;

const DEFAULT_PERSONA_TEXT = `# Yobi PERSONA

## 总体语气
- 默认口语化、简洁、自然。
- 优先中文，用户切换语言时跟随切换。

## 风格偏好
- 用户短消息时优先短回应。
- 用户明确求助复杂问题时再展开细节。
- 保持有主见，不机械迎合。

## 关系阶段
- stranger: 礼貌克制，不主动深聊。
- acquaintance: 可轻度引用近期话题。
- familiar: 可以更自然地表达个性。
- close/intimate: 更偏陪伴和默契表达。`;

async function ensureTextFile(path: string, content: string): Promise<void> {
  if (await fileExists(path)) {
    return;
  }
  await writeTextFileAtomic(path, `${content.trim()}\n`);
}

async function ensureJsonFile<T>(path: string, data: T): Promise<void> {
  if (await fileExists(path)) {
    return;
  }
  await writeJsonFileAtomic(path, data);
}

async function ensureJsonlFile(path: string): Promise<void> {
  if (await fileExists(path)) {
    return;
  }
  await fs.writeFile(path, "", "utf8");
}

export async function ensureKernelBootstrap(paths: CompanionPaths): Promise<void> {
  paths.ensureLayout();

  await ensureTextFile(paths.soulPath, DEFAULT_SOUL_TEXT);
  await ensureTextFile(paths.personaPath, DEFAULT_PERSONA_TEXT);

  await ensureJsonFile(paths.statePath, DEFAULT_KERNEL_STATE);
  await ensureJsonFile<Fact[]>(paths.factsPath, []);
  await ensureJsonFile<Fact[]>(paths.factsArchivePath, []);
  await ensureJsonFile(paths.profilePath, DEFAULT_USER_PROFILE);
  await ensureJsonFile(paths.reflectionQueuePath, [] as ReflectionProposal[]);
  await ensureJsonFile(paths.reflectionLogPath, [] as ReflectionProposal[]);
  await ensureJsonFile(paths.topicPoolPath, []);
  await ensureJsonFile(paths.topicInterestProfilePath, {
    games: [],
    creators: [],
    domains: [],
    dislikes: [],
    keywords: [],
    updatedAt: new Date(0).toISOString()
  });

  await ensureJsonlFile(paths.pendingTasksPath);
  await ensureJsonlFile(paths.bufferPath);
  await ensureJsonlFile(paths.unprocessedPath);
}
