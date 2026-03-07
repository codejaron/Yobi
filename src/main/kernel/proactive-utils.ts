import type { InterestProfile, TopicPoolItem } from "@shared/types";

function clampRange(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function topicInterestOverlap(topic: TopicPoolItem, profile: InterestProfile): number {
  const haystacks = [
    topic.text,
    topic.source,
    topic.material?.title ?? "",
    topic.material?.up ?? "",
    ...(topic.material?.tags ?? [])
  ]
    .join(" ")
    .toLowerCase();
  const interests = [...profile.games, ...profile.creators, ...profile.domains, ...profile.keywords]
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (interests.length === 0) {
    return 0;
  }
  return interests.some((item) => haystacks.includes(item)) ? 1 : 0;
}

function topicFreshnessScore(topic: TopicPoolItem): number {
  const ageMs = Date.now() - new Date(topic.createdAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs <= 2 * 3600 * 1000) {
    return 1;
  }
  if (ageMs <= 12 * 3600 * 1000) {
    return 0.7;
  }
  if (ageMs <= 24 * 3600 * 1000) {
    return 0.4;
  }
  return 0.2;
}

export function selectBestProactiveTopic(
  topics: TopicPoolItem[],
  profile: InterestProfile,
  curiosity: number
): TopicPoolItem | null {
  if (topics.length === 0) {
    return null;
  }

  return (
    topics
      .map((topic) => ({
        topic,
        score:
          topicFreshnessScore(topic) * 0.5 +
          topicInterestOverlap(topic, profile) * 0.3 +
          clampRange(curiosity, 0, 1) * 0.15 +
          Math.random() * 0.05
      }))
      .sort((left, right) => right.score - left.score)[0]?.topic ?? null
  );
}
