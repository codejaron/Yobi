export interface ProactiveCandidateMaterial {
  publishedAt?: string;
}

export interface ProactiveCandidateTopic {
  id: string;
  source: string;
  text: string;
  createdAt: string;
  material?: ProactiveCandidateMaterial;
}

export interface CandidatePoolInput<T extends ProactiveCandidateTopic = ProactiveCandidateTopic> {
  topics: T[];
  allowEventShare: boolean;
  eventFreshWindowMs: number;
}

export interface CandidatePoolResult<T extends ProactiveCandidateTopic = ProactiveCandidateTopic> {
  candidates: T[];
  eventCandidates: T[];
}

function nowMs(): number {
  return Date.now();
}

function publishedAtMs(topic: ProactiveCandidateTopic): number {
  const materialPublished = topic.material?.publishedAt;
  if (typeof materialPublished === "string" && materialPublished.trim()) {
    const parsed = new Date(materialPublished).getTime();
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const created = new Date(topic.createdAt).getTime();
  if (Number.isFinite(created) && created > 0) {
    return created;
  }
  return 0;
}

export function isFreshEventTopic(topic: ProactiveCandidateTopic, eventFreshWindowMs: number): boolean {
  if (topic.source !== "browse:event") {
    return false;
  }

  const published = publishedAtMs(topic);
  if (!published) {
    return false;
  }

  return nowMs() - published <= eventFreshWindowMs;
}

export function buildCandidatePool<T extends ProactiveCandidateTopic>(
  input: CandidatePoolInput<T>
): CandidatePoolResult<T> {
  const freshTopics = input.topics.filter((topic) => {
    if (topic.source !== "browse:event") {
      return true;
    }
    return isFreshEventTopic(topic, input.eventFreshWindowMs);
  });

  const candidates = freshTopics.filter((topic) => {
    if (topic.source !== "browse:event") {
      return true;
    }
    return input.allowEventShare;
  });

  const eventCandidates = candidates.filter((topic) => topic.source === "browse:event");

  return {
    candidates,
    eventCandidates
  };
}
