export interface MemoryRuntimeConfig {
  recentMessages: number;
  context: {
    memoryFloorTokens: number;
    maxPromptTokens: number;
  };
  embedding: {
    modelId: string;
    similarityThreshold: number;
  };
}

export interface KernelEmotionSignalsConfig {
  enabled: boolean;
  deltaScale: number;
  energyEngagementScale: number;
  connectionTrustScale: number;
  ruminationThreshold: number;
  ruminationMaxStages: number;
  windowMaxAbsDelta: number;
  stalenessFullEffectMinutes: number;
  stalenessMaxAgeHours: number;
  stalenessMinScale: number;
}

export interface KernelRuntimeConfig {
  tick: {
    activeIntervalMs: number;
    warmIntervalMs: number;
    idleIntervalMs: number;
    quietIntervalMs: number;
  };
  buffer: {
    maxMessages: number;
    lowWatermark: number;
  };
  queue: {
    maxConcurrent: number;
    retryLimit: number;
  };
  relationship: {
    upgradeWindowDays: number;
    downgradeWindowDays: number;
  };
  personality: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
  };
  emotionSignals: KernelEmotionSignalsConfig;
  sessionReentryGapHours: number;
  dailyTaskHour: number;
}

export const MEMORY_RUNTIME_DEFAULTS: MemoryRuntimeConfig = {
  recentMessages: 60,
  context: {
    memoryFloorTokens: 1200,
    maxPromptTokens: 24_000
  },
  embedding: {
    modelId: "embeddinggemma-300m-qat-Q8_0.gguf",
    similarityThreshold: 0.55
  }
};

export const KERNEL_RUNTIME_DEFAULTS: KernelRuntimeConfig = {
  tick: {
    activeIntervalMs: 5000,
    warmIntervalMs: 30_000,
    idleIntervalMs: 3 * 60_000,
    quietIntervalMs: 10 * 60_000
  },
  buffer: {
    maxMessages: 120,
    lowWatermark: 80
  },
  queue: {
    maxConcurrent: 1,
    retryLimit: 2
  },
  relationship: {
    upgradeWindowDays: 3,
    downgradeWindowDays: 7
  },
  personality: {
    openness: 0.5,
    conscientiousness: 0.5,
    extraversion: 0.5,
    agreeableness: 0.5,
    neuroticism: 0.5
  },
  emotionSignals: {
    enabled: true,
    deltaScale: 0.4,
    energyEngagementScale: 0.1,
    connectionTrustScale: 0.5,
    ruminationThreshold: 0.7,
    ruminationMaxStages: 4,
    windowMaxAbsDelta: 0.2,
    stalenessFullEffectMinutes: 30,
    stalenessMaxAgeHours: 24,
    stalenessMinScale: 0.15
  },
  sessionReentryGapHours: 6,
  dailyTaskHour: 3
};
