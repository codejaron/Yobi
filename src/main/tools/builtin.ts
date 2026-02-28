import { z } from "zod";
import type { ReminderService } from "@main/services/reminders";
import type { VoiceProviderRouter } from "@main/services/voice-router";
import type { PetWindowController } from "@main/pet/pet-window";
import type { ToolDefinition } from "./types";

const EMOTIONS = [
  "happy",
  "sad",
  "shy",
  "angry",
  "surprised",
  "excited",
  "calm",
  "idle"
] as const;

export function createBuiltinTools(input: {
  reminderService: ReminderService;
  voiceRouter: VoiceProviderRouter;
  petBridge: PetWindowController;
}): Array<ToolDefinition<any>> {
  const reminderTool: ToolDefinition<{ time: string; text: string }> = {
    name: "reminder",
    source: "builtin",
    description: "创建一个定时提醒",
    parameters: z.object({
      time: z.string().min(1),
      text: z.string().min(1)
    }),
    execute: async ({ time, text }) => {
      const item = await input.reminderService.create({
        at: time,
        text
      });

      if (!item) {
        return {
          success: false,
          error: "提醒时间格式不合法"
        };
      }

      return {
        success: true,
        data: {
          id: item.id,
          at: item.at,
          text: item.text
        }
      };
    }
  };

  const setEmotionTool: ToolDefinition<{ emotion: string }> = {
    name: "setEmotion",
    source: "builtin",
    description: "设置桌宠的情绪表情（happy/sad/shy/angry/surprised/excited/calm/idle）",
    parameters: z.object({
      emotion: z.string().min(1)
    }),
    execute: async ({ emotion }) => {
      const normalized = emotion.trim().toLowerCase();
      const safeEmotion = EMOTIONS.includes(normalized as (typeof EMOTIONS)[number])
        ? normalized
        : "idle";

      input.petBridge.emitEvent({
        type: "emotion",
        value: safeEmotion
      });

      return {
        success: true,
        data: {
          emotion: safeEmotion
        }
      };
    }
  };

  const speakTool: ToolDefinition<{ text: string }> = {
    name: "speak",
    source: "builtin",
    description: "用语音朗读一段话（适合需要语音表达的场景）",
    parameters: z.object({
      text: z.string().min(1)
    }),
    execute: async ({ text }, context) => {
      const config = context.getConfig();
      const audio = await input.voiceRouter.synthesize({
        text,
        edgeConfig: {
          voice: config.voice.ttsVoice,
          rate: config.voice.ttsRate,
          pitch: config.voice.ttsPitch,
          requestTimeoutMs: config.voice.requestTimeoutMs,
          retryCount: config.voice.retryCount
        }
      });

      input.petBridge.emitEvent({
        type: "speech",
        audioBase64: audio.toString("base64"),
        mimeType: "audio/mpeg"
      });

      return {
        success: true,
        data: {
          spoken: true
        }
      };
    }
  };

  return [reminderTool, setEmotionTool, speakTool];
}
