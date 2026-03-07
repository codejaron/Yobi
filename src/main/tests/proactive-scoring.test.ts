import test from "node:test";
import assert from "node:assert/strict";
import { applyRealtimeEmotionHeuristics, selectBestProactiveTopic } from "../kernel/engine.js";
import type { AppConfig, EmotionalState, InterestProfile, TopicPoolItem } from "@shared/types";

const baseEmotional: EmotionalState = {
  mood: 0,
  energy: 0.6,
  connection: 0.5,
  curiosity: 0.5,
  confidence: 0.5,
  irritation: 0.1
};

const emotionSignalConfig: AppConfig["kernel"]["emotionSignals"] = {
  enabled: true,
  deltaScale: 0.4,
  moodPositiveStep: 0.12,
  moodNegativeStep: 0.08,
  energyEngagementScale: 0.1,
  curiosityBoost: 0.15,
  confidenceGain: 0.02,
  confidenceDropOnFriction: 0.1,
  irritationBoostOnFriction: 0.12,
  minPositiveEngagement: 0.6,
  minPositiveTrustDelta: 0.03,
  windowMaxAbsDelta: 0.2,
  stalenessFullEffectMinutes: 30,
  stalenessMaxAgeHours: 24,
  stalenessMinScale: 0.15
};

test("applyRealtimeEmotionHeuristics: 负向文本会拉低 mood 和 energy", () => {
  const next = applyRealtimeEmotionHeuristics(baseEmotional, "今天加班好累啊", emotionSignalConfig);
  assert.ok(next.mood < baseEmotional.mood);
  assert.ok(next.energy < baseEmotional.energy);
});

test("applyRealtimeEmotionHeuristics: 好奇类文本会提升 curiosity", () => {
  const next = applyRealtimeEmotionHeuristics(baseEmotional, "我有点好奇为什么会这样", emotionSignalConfig);
  assert.ok(next.curiosity > baseEmotional.curiosity);
});

test("selectBestProactiveTopic: 会优先挑选兴趣重叠的话题", () => {
  const now = new Date().toISOString();
  const topics: TopicPoolItem[] = [
    {
      id: "a",
      text: "一个普通日常碎碎念",
      source: "manual",
      createdAt: now,
      expiresAt: null,
      used: false
    },
    {
      id: "b",
      text: "原神新活动和角色卡池讨论",
      source: "bilibili",
      createdAt: now,
      expiresAt: null,
      used: false,
      material: {
        bvid: "BV1",
        title: "原神新活动",
        up: "测试UP",
        tags: ["原神", "游戏"],
        topComments: [],
        url: "https://example.com"
      }
    }
  ];
  const profile: InterestProfile = {
    games: ["原神"],
    creators: [],
    domains: [],
    dislikes: [],
    keywords: [],
    updatedAt: now
  };

  const picked = selectBestProactiveTopic(topics, profile, 0.8);
  assert.equal(picked?.id, "b");
});
