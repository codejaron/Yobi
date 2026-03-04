import type { BufferMessage, UserProfile } from "@shared/types";
import { DEFAULT_USER_PROFILE } from "@shared/types";
import { CompanionPaths } from "@main/storage/paths";
import { readJsonFile, writeJsonFileAtomic } from "@main/storage/fs";

export class ProfileStore {
  private loaded = false;
  private profile: UserProfile = {
    ...DEFAULT_USER_PROFILE
  };

  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const raw = await readJsonFile<UserProfile>(this.paths.profilePath, DEFAULT_USER_PROFILE);
    this.profile = normalizeProfile(raw);
    this.loaded = true;
  }

  getProfile(): UserProfile {
    return deepCloneProfile(this.profile);
  }

  async updateFromStatSignals(messages: BufferMessage[]): Promise<UserProfile> {
    await this.init();
    if (messages.length === 0) {
      return this.getProfile();
    }

    const userMessages = messages.filter((message) => message.role === "user");
    if (userMessages.length === 0) {
      return this.getProfile();
    }

    const lengths = userMessages.map((message) => message.text.trim().length).filter((length) => length > 0);
    const avgLength = lengths.length > 0 ? lengths.reduce((sum, value) => sum + value, 0) / lengths.length : 0;
    if (avgLength <= 20) {
      this.profile.communication.avg_message_length = "short";
    } else if (avgLength >= 100) {
      this.profile.communication.avg_message_length = "long";
    } else {
      this.profile.communication.avg_message_length = "medium";
    }

    const emojiCount = userMessages.reduce((sum, message) => sum + countEmoji(message.text), 0);
    const perMessageEmoji = emojiCount / Math.max(1, userMessages.length);
    if (perMessageEmoji === 0) {
      this.profile.communication.emoji_usage = "none";
    } else if (perMessageEmoji < 1.2) {
      this.profile.communication.emoji_usage = "occasional";
    } else {
      this.profile.communication.emoji_usage = "frequent";
    }

    const hourCounts = new Array<number>(24).fill(0);
    for (const message of userMessages) {
      const hour = new Date(message.ts).getHours();
      if (Number.isFinite(hour) && hour >= 0 && hour <= 23) {
        hourCounts[hour] += 1;
      }
    }
    const peakHour = hourCounts.reduce(
      (best, current, index) => (current > best.count ? { hour: index, count: current } : best),
      { hour: 0, count: 0 }
    );
    const activeStart = peakHour.hour;
    const activeEnd = (peakHour.hour + 3) % 24;
    this.profile.patterns.active_hours = `通常 ${pad2(activeStart)}:00-${pad2(activeEnd)}:00 活跃`;
    if (activeStart >= 21 || activeStart <= 2) {
      this.profile.identity.typical_schedule = "夜猫子";
    } else if (activeStart >= 5 && activeStart <= 9) {
      this.profile.identity.typical_schedule = "早起型";
    } else {
      this.profile.identity.typical_schedule = "不规律";
    }

    this.profile.updated_at = new Date().toISOString();
    await this.persist();
    return this.getProfile();
  }

  async applySemanticPatch(mutator: (draft: UserProfile) => void): Promise<UserProfile> {
    await this.init();
    const draft = this.getProfile();
    mutator(draft);
    this.profile = normalizeProfile(draft);
    this.profile.updated_at = new Date().toISOString();
    await this.persist();
    return this.getProfile();
  }

  private async persist(): Promise<void> {
    await writeJsonFileAtomic(this.paths.profilePath, this.profile);
  }
}

function deepCloneProfile(profile: UserProfile): UserProfile {
  return {
    identity: {
      ...profile.identity
    },
    communication: {
      ...profile.communication,
      catchphrases: [...profile.communication.catchphrases],
      tone_words: [...profile.communication.tone_words]
    },
    patterns: {
      ...profile.patterns,
      topic_preferences: [...profile.patterns.topic_preferences]
    },
    interaction_notes: {
      ...profile.interaction_notes,
      what_works: [...profile.interaction_notes.what_works],
      what_fails: [...profile.interaction_notes.what_fails],
      sensitive_topics: [...profile.interaction_notes.sensitive_topics],
      trust_areas: {
        ...profile.interaction_notes.trust_areas
      }
    },
    pending_confirmations: profile.pending_confirmations.map((item) => ({ ...item })),
    updated_at: profile.updated_at
  };
}

function normalizeProfile(raw: UserProfile): UserProfile {
  const fallback = deepCloneProfile(DEFAULT_USER_PROFILE);
  const profile = raw && typeof raw === "object" ? raw : fallback;
  return {
    identity: {
      timezone: typeof profile.identity?.timezone === "string" ? profile.identity.timezone : null,
      typical_schedule:
        typeof profile.identity?.typical_schedule === "string" ? profile.identity.typical_schedule : null,
      language_preference:
        typeof profile.identity?.language_preference === "string"
          ? profile.identity.language_preference
          : fallback.identity.language_preference
    },
    communication: {
      avg_message_length:
        profile.communication?.avg_message_length === "short" ||
        profile.communication?.avg_message_length === "medium" ||
        profile.communication?.avg_message_length === "long"
          ? profile.communication.avg_message_length
          : fallback.communication.avg_message_length,
      emoji_usage:
        profile.communication?.emoji_usage === "none" ||
        profile.communication?.emoji_usage === "occasional" ||
        profile.communication?.emoji_usage === "frequent"
          ? profile.communication.emoji_usage
          : fallback.communication.emoji_usage,
      humor_receptivity: clamp(profile.communication?.humor_receptivity, fallback.communication.humor_receptivity),
      advice_receptivity: clamp(
        profile.communication?.advice_receptivity,
        fallback.communication.advice_receptivity
      ),
      emotional_openness: clamp(
        profile.communication?.emotional_openness,
        fallback.communication.emotional_openness
      ),
      preferred_comfort_style:
        typeof profile.communication?.preferred_comfort_style === "string"
          ? profile.communication.preferred_comfort_style
          : null,
      catchphrases: normalizeStringList(profile.communication?.catchphrases),
      tone_words: normalizeStringList(profile.communication?.tone_words)
    },
    patterns: {
      active_hours: typeof profile.patterns?.active_hours === "string" ? profile.patterns.active_hours : null,
      chat_frequency:
        typeof profile.patterns?.chat_frequency === "string" ? profile.patterns.chat_frequency : null,
      topic_preferences: normalizeStringList(profile.patterns?.topic_preferences),
      session_style: typeof profile.patterns?.session_style === "string" ? profile.patterns.session_style : null,
      response_to_proactive:
        typeof profile.patterns?.response_to_proactive === "string"
          ? profile.patterns.response_to_proactive
          : null
    },
    interaction_notes: {
      what_works: normalizeStringList(profile.interaction_notes?.what_works),
      what_fails: normalizeStringList(profile.interaction_notes?.what_fails),
      sensitive_topics: normalizeStringList(profile.interaction_notes?.sensitive_topics),
      trust_areas: {
        tech: clamp(profile.interaction_notes?.trust_areas?.tech, 0.5),
        life_advice: clamp(profile.interaction_notes?.trust_areas?.life_advice, 0.5),
        emotional_support: clamp(profile.interaction_notes?.trust_areas?.emotional_support, 0.5),
        entertainment: clamp(profile.interaction_notes?.trust_areas?.entertainment, 0.5)
      }
    },
    pending_confirmations: Array.isArray(profile.pending_confirmations)
      ? profile.pending_confirmations
          .map((item) => {
            if (!item || typeof item !== "object") {
              return null;
            }
            const row = item as Record<string, unknown>;
            const id = typeof row.id === "string" ? row.id : "";
            const field = typeof row.field === "string" ? row.field : "";
            const value = typeof row.value === "string" ? row.value : "";
            if (!id || !field || !value) {
              return null;
            }
            return {
              id,
              field,
              value,
              needs_confirmation: Boolean(row.needs_confirmation),
              confirmed: Boolean(row.confirmed),
              created_at:
                typeof row.created_at === "string" ? row.created_at : new Date().toISOString()
            };
          })
          .filter((item): item is UserProfile["pending_confirmations"][number] => item !== null)
      : [],
    updated_at:
      typeof profile.updated_at === "string" && Number.isFinite(new Date(profile.updated_at).getTime())
        ? new Date(profile.updated_at).toISOString()
        : new Date().toISOString()
  };
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const text = item.trim();
    if (!text) {
      continue;
    }
    output.push(text);
    if (output.length >= 50) {
      break;
    }
  }
  return output;
}

function countEmoji(text: string): number {
  return [...text].filter((char) => /\p{Extended_Pictographic}/u.test(char)).length;
}

function clamp(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
