import test from "node:test";
import assert from "node:assert/strict";
import { selectBestProactiveTopic } from "../kernel/engine.js";
import type { InterestProfile, TopicPoolItem } from "@shared/types";

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
