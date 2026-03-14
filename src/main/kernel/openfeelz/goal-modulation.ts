/*
 * Adapted from OpenFeelz (https://github.com/trianglegrrl/openfeelz), MIT License.
 * Source basis: src/model/goal-modulation.ts from OpenFeelz v1.1.1.
 */

import type { OCEANPersonality } from "@shared/types";

export interface PersonalityGoal {
  type: "task_completion" | "exploration" | "social_harmony" | "self_regulation" | "novelty_seeking";
  strength: number;
  threatEmotions: string[];
  achievementEmotions: string[];
}

const GOAL_THRESHOLD = 0.6;

export function inferGoals(personality: OCEANPersonality): PersonalityGoal[] {
  const goals: PersonalityGoal[] = [];

  if (personality.conscientiousness > GOAL_THRESHOLD) {
    goals.push({
      type: "task_completion",
      strength: (personality.conscientiousness - GOAL_THRESHOLD) / (1 - GOAL_THRESHOLD),
      threatEmotions: ["frustrated", "anxious", "confused", "fatigued"],
      achievementEmotions: ["happy", "relieved", "energized", "focused"]
    });
  }

  if (personality.openness > GOAL_THRESHOLD) {
    goals.push({
      type: "exploration",
      strength: (personality.openness - GOAL_THRESHOLD) / (1 - GOAL_THRESHOLD),
      threatEmotions: ["bored", "frustrated"],
      achievementEmotions: ["curious", "excited", "surprised"]
    });
  }

  if (personality.agreeableness > GOAL_THRESHOLD) {
    goals.push({
      type: "social_harmony",
      strength: (personality.agreeableness - GOAL_THRESHOLD) / (1 - GOAL_THRESHOLD),
      threatEmotions: ["angry", "disgusted", "lonely"],
      achievementEmotions: ["connected", "trusting", "happy", "calm"]
    });
  }

  if (personality.conscientiousness > GOAL_THRESHOLD && personality.neuroticism < 0.4) {
    goals.push({
      type: "self_regulation",
      strength: Math.min(
        (personality.conscientiousness - GOAL_THRESHOLD) / (1 - GOAL_THRESHOLD),
        (0.4 - personality.neuroticism) / 0.4
      ),
      threatEmotions: ["angry", "anxious"],
      achievementEmotions: ["calm", "focused", "relieved"]
    });
  }

  if (personality.openness > 0.7 && personality.extraversion > GOAL_THRESHOLD) {
    goals.push({
      type: "novelty_seeking",
      strength: Math.min(
        (personality.openness - 0.7) / 0.3,
        (personality.extraversion - GOAL_THRESHOLD) / (1 - GOAL_THRESHOLD)
      ),
      threatEmotions: ["bored", "fatigued"],
      achievementEmotions: ["excited", "curious", "surprised", "energized"]
    });
  }

  return goals;
}

export function applyGoalModulation(
  goals: PersonalityGoal[],
  emotionLabel: string,
  intensity: number
): number {
  let multiplier = 1;
  const label = emotionLabel.toLowerCase();

  for (const goal of goals) {
    if (goal.threatEmotions.includes(label)) {
      multiplier += goal.strength * 0.3;
      continue;
    }
    if (goal.achievementEmotions.includes(label)) {
      multiplier += goal.strength * 0.2;
    }
  }

  return Math.min(1, Math.max(0, intensity * multiplier));
}
