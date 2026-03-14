import { DEFAULT_EMOTIONAL_STATE, type EmotionalState } from "./types";

export const PET_EMOTION_SLOTS = [
  "mouthForm",
  "mouthOpen",
  "eyeOpenL",
  "eyeOpenR",
  "eyeSmileL",
  "eyeSmileR",
  "eyeForm",
  "eyeBallForm",
  "browLY",
  "browRY",
  "browLAngle",
  "browRAngle",
  "browLForm",
  "browRForm",
  "tere",
  "angleY",
  "angleZ"
] as const;

export const PET_EMOTION_FEATURES = [
  "pleasure",
  "pleasurePositive",
  "pleasureNegative",
  "arousal",
  "dominance",
  "trustSigned",
  "happiness",
  "sadness",
  "anger",
  "surprise",
  "expressionScale"
] as const;

export const PET_EMOTION_IMPULSE_NAMES = [
  "happy",
  "sad",
  "angry",
  "surprised",
  "shy",
  "excited"
] as const;

export type PetEmotionSlot = (typeof PET_EMOTION_SLOTS)[number];
export type PetEmotionFeature = (typeof PET_EMOTION_FEATURES)[number];
export type PetEmotionImpulseName = (typeof PET_EMOTION_IMPULSE_NAMES)[number];

export interface PetEmotionSlotMapping {
  baseValue: number;
  softMin?: number;
  softMax?: number;
  weights: Partial<Record<PetEmotionFeature, number>>;
}

export interface PetEmotionImpulseTemplate {
  intensity: number;
  durationMs: number;
  slots: Partial<Record<PetEmotionSlot, number>>;
}

export interface PetEmotionBlinkConfig {
  intervalMinMs: number;
  intervalMaxMs: number;
  closeMs: number;
  holdMs: number;
  openMs: number;
}

export interface PetEmotionLipSyncConfig {
  releasePerSecond: number;
}

export interface PetEmotionSmoothingConfig {
  followPerSecond: number;
  warmupPerSecond: number;
  warmupMs: number;
}

export interface PetEmotionStateSyncConfig {
  epsilon: number;
  heartbeatMs: number;
}

export interface PetEmotionConfig {
  schemaVersion: number;
  defaultEmotion: EmotionalState;
  stateSync: PetEmotionStateSyncConfig;
  smoothing: PetEmotionSmoothingConfig;
  blink: PetEmotionBlinkConfig;
  lipSync: PetEmotionLipSyncConfig;
  angleLimits: {
    angleY: number;
    angleZ: number;
  };
  aliases: Record<PetEmotionSlot, string[]>;
  mappings: Partial<Record<PetEmotionSlot, PetEmotionSlotMapping>>;
  impulses: Record<PetEmotionImpulseName, PetEmotionImpulseTemplate>;
}

export type PetEmotionConfigOverride = Partial<{
  schemaVersion: number;
  defaultEmotion: Partial<EmotionalState>;
  stateSync: Partial<PetEmotionStateSyncConfig>;
  smoothing: Partial<PetEmotionSmoothingConfig>;
  blink: Partial<PetEmotionBlinkConfig>;
  lipSync: Partial<PetEmotionLipSyncConfig>;
  angleLimits: Partial<PetEmotionConfig["angleLimits"]>;
  aliases: Partial<Record<PetEmotionSlot, string[]>>;
  mappings: Partial<Record<PetEmotionSlot, Partial<PetEmotionSlotMapping>>>;
  impulses: Partial<Record<PetEmotionImpulseName, Partial<PetEmotionImpulseTemplate>>>;
}>;

export interface PetEmotionStateEvent {
  type: "emotion-state";
  emotional: EmotionalState;
}

export interface PetEmotionImpulseEvent {
  type: "emotion-impulse";
  name: PetEmotionImpulseName;
  intensity?: number;
  durationMs?: number;
}

export const LEGACY_PET_EMOTION_TO_IMPULSE: Record<string, PetEmotionImpulseName | null> = {
  happy: "happy",
  sad: "sad",
  angry: "angry",
  surprised: "surprised",
  shy: "shy",
  excited: "excited",
  calm: null,
  idle: null
};

export const DEFAULT_PET_EMOTION_CONFIG: PetEmotionConfig = {
  schemaVersion: 2,
  defaultEmotion: {
    ...DEFAULT_EMOTIONAL_STATE
  },
  stateSync: {
    epsilon: 0.02,
    heartbeatMs: 2000
  },
  smoothing: {
    followPerSecond: 7.2,
    warmupPerSecond: 12,
    warmupMs: 900
  },
  blink: {
    intervalMinMs: 2800,
    intervalMaxMs: 5200,
    closeMs: 90,
    holdMs: 45,
    openMs: 140
  },
  lipSync: {
    releasePerSecond: 9
  },
  angleLimits: {
    angleY: 3,
    angleZ: 5
  },
  aliases: {
    mouthForm: ["PARAM_MOUTH_FORM", "ParamMouthForm", "Param_Mouth_Form", "param_mouth_form", "MouthForm"],
    mouthOpen: ["PARAM_MOUTH_OPEN_Y", "ParamMouthOpenY", "Param_Mouth_Open_Y", "param_mouth_open_y", "MouthOpenY", "MouthOpen"],
    eyeOpenL: ["PARAM_EYE_L_OPEN", "ParamEyeLOpen", "Param_Eye_L_Open", "param_eye_l_open", "EyeLOpen"],
    eyeOpenR: ["PARAM_EYE_R_OPEN", "ParamEyeROpen", "Param_Eye_R_Open", "param_eye_r_open", "EyeROpen"],
    eyeSmileL: ["PARAM_EYE_L_SMILE", "ParamEyeLSmile", "Param_Eye_L_Smile", "param_eye_l_smile", "EyeLSmile"],
    eyeSmileR: ["PARAM_EYE_R_SMILE", "ParamEyeRSmile", "Param_Eye_R_Smile", "param_eye_r_smile", "EyeRSmile"],
    eyeForm: ["PARAM_EYE_FORM", "ParamEyeForm", "Param_Eye_Form", "param_eye_form", "EyeForm"],
    eyeBallForm: ["PARAM_EYE_BALL_FORM", "ParamEyeBallForm", "Param_Eye_Ball_Form", "param_eye_ball_form", "EyeBallForm"],
    browLY: ["PARAM_BROW_L_Y", "ParamBrowLY", "Param_Brow_L_Y", "param_brow_l_y", "BrowLY"],
    browRY: ["PARAM_BROW_R_Y", "ParamBrowRY", "Param_Brow_R_Y", "param_brow_r_y", "BrowRY"],
    browLAngle: ["PARAM_BROW_L_ANGLE", "ParamBrowLAngle", "Param_Brow_L_Angle", "param_brow_l_angle", "BrowLAngle"],
    browRAngle: ["PARAM_BROW_R_ANGLE", "ParamBrowRAngle", "Param_Brow_R_Angle", "param_brow_r_angle", "BrowRAngle"],
    browLForm: ["PARAM_BROW_L_FORM", "ParamBrowLForm", "Param_Brow_L_Form", "param_brow_l_form", "BrowLForm"],
    browRForm: ["PARAM_BROW_R_FORM", "ParamBrowRForm", "Param_Brow_R_Form", "param_brow_r_form", "BrowRForm"],
    tere: ["PARAM_TERE", "ParamTere", "Param_Tere", "param_tere", "Tere"],
    angleY: ["PARAM_ANGLE_Y", "ParamAngleY", "Param_Angle_Y", "param_angle_y", "AngleY"],
    angleZ: ["PARAM_ANGLE_Z", "ParamAngleZ", "Param_Angle_Z", "param_angle_z", "AngleZ"]
  },
  mappings: {
    mouthForm: {
      baseValue: 0,
      softMin: -1.2,
      softMax: 1,
      weights: {
        pleasure: 0.5,
        happiness: 0.28,
        sadness: -0.18,
        anger: -0.22,
        expressionScale: 0.08
      }
    },
    browLAngle: {
      baseValue: 0,
      softMin: -0.8,
      softMax: 0.45,
      weights: {
        anger: -0.48,
        sadness: 0.18,
        dominance: -0.14
      }
    },
    browRAngle: {
      baseValue: 0,
      softMin: -0.8,
      softMax: 0.45,
      weights: {
        anger: -0.48,
        sadness: 0.18,
        dominance: -0.14
      }
    },
    browLForm: {
      baseValue: 0,
      softMin: -0.55,
      softMax: 0.35,
      weights: {
        anger: -0.34,
        sadness: -0.16,
        happiness: 0.1
      }
    },
    browRForm: {
      baseValue: 0,
      softMin: -0.55,
      softMax: 0.35,
      weights: {
        anger: -0.34,
        sadness: -0.16,
        happiness: 0.1
      }
    },
    browLY: {
      baseValue: 0,
      softMin: -0.35,
      softMax: 0.3,
      weights: {
        happiness: 0.14,
        surprise: 0.2,
        sadness: -0.12
      }
    },
    browRY: {
      baseValue: 0,
      softMin: -0.35,
      softMax: 0.3,
      weights: {
        happiness: 0.14,
        surprise: 0.2,
        sadness: -0.12
      }
    },
    eyeOpenL: {
      baseValue: 0.72,
      softMin: 0.28,
      softMax: 1,
      weights: {
        arousal: 0.12,
        surprise: 0.18,
        sadness: -0.08,
        anger: -0.05
      }
    },
    eyeOpenR: {
      baseValue: 0.72,
      softMin: 0.28,
      softMax: 1,
      weights: {
        arousal: 0.12,
        surprise: 0.18,
        sadness: -0.08,
        anger: -0.05
      }
    },
    eyeSmileL: {
      baseValue: 0,
      softMin: 0,
      softMax: 1,
      weights: {
        pleasurePositive: 0.38,
        happiness: 0.42,
        expressionScale: 0.12
      }
    },
    eyeSmileR: {
      baseValue: 0,
      softMin: 0,
      softMax: 1,
      weights: {
        pleasurePositive: 0.38,
        happiness: 0.42,
        expressionScale: 0.12
      }
    },
    eyeForm: {
      baseValue: 0,
      softMin: -1,
      softMax: 1,
      weights: {
        pleasureNegative: 0.26,
        anger: -0.46,
        sadness: 0.22,
        happiness: 0.08
      }
    },
    eyeBallForm: {
      baseValue: 0,
      softMin: -0.3,
      softMax: 0.3,
      weights: {
        arousal: -0.12,
        surprise: -0.1,
        trustSigned: -0.08
      }
    },
    tere: {
      baseValue: 0,
      softMin: 0,
      softMax: 1,
      weights: {
        trustSigned: 0.22,
        expressionScale: 0.08,
        pleasurePositive: 0.1
      }
    },
    angleY: {
      baseValue: 0,
      softMin: -3,
      softMax: 3,
      weights: {
        dominance: 1.1,
        arousal: 0.55,
        surprise: 0.3
      }
    },
    angleZ: {
      baseValue: 0,
      softMin: -5,
      softMax: 5,
      weights: {
        dominance: 1.6,
        pleasure: 0.35,
        anger: -0.3
      }
    }
  },
  impulses: {
    happy: {
      intensity: 0.6,
      durationMs: 800,
      slots: {
        mouthForm: 0.18,
        eyeSmileL: 0.22,
        eyeSmileR: 0.22,
        browLY: 0.08,
        browRY: 0.08
      }
    },
    sad: {
      intensity: 0.55,
      durationMs: 1000,
      slots: {
        mouthForm: -0.2,
        eyeForm: 0.18,
        browLAngle: 0.1,
        browRAngle: 0.1
      }
    },
    angry: {
      intensity: 0.7,
      durationMs: 1200,
      slots: {
        mouthForm: -0.22,
        browLAngle: -0.18,
        browRAngle: -0.18,
        browLForm: -0.15,
        browRForm: -0.15,
        eyeForm: -0.16
      }
    },
    surprised: {
      intensity: 0.75,
      durationMs: 650,
      slots: {
        eyeOpenL: 0.2,
        eyeOpenR: 0.2,
        browLY: 0.16,
        browRY: 0.16,
        eyeBallForm: -0.18
      }
    },
    shy: {
      intensity: 0.5,
      durationMs: 900,
      slots: {
        tere: 0.26,
        eyeOpenL: -0.08,
        eyeOpenR: -0.08,
        browLAngle: 0.08,
        browRAngle: 0.08
      }
    },
    excited: {
      intensity: 0.65,
      durationMs: 900,
      slots: {
        eyeOpenL: 0.12,
        eyeOpenR: 0.12,
        eyeSmileL: 0.16,
        eyeSmileR: 0.16,
        mouthForm: 0.12,
        browLY: 0.1,
        browRY: 0.1
      }
    }
  }
};

export function mergePetEmotionConfig(
  base: PetEmotionConfig,
  override?: PetEmotionConfigOverride | null
): PetEmotionConfig {
  if (!override) {
    return {
      ...base,
      defaultEmotion: cloneRecord(base.defaultEmotion),
      stateSync: { ...base.stateSync },
      smoothing: { ...base.smoothing },
      blink: { ...base.blink },
      lipSync: { ...base.lipSync },
      angleLimits: { ...base.angleLimits },
      aliases: cloneRecord(base.aliases),
      mappings: cloneRecord(base.mappings),
      impulses: cloneRecord(base.impulses)
    };
  }

  return {
    ...base,
    schemaVersion: override.schemaVersion ?? base.schemaVersion,
    defaultEmotion: mergeEmotionalState(base.defaultEmotion, override.defaultEmotion),
    stateSync: {
      ...base.stateSync,
      ...(override.stateSync ?? {})
    },
    smoothing: {
      ...base.smoothing,
      ...(override.smoothing ?? {})
    },
    blink: {
      ...base.blink,
      ...(override.blink ?? {})
    },
    lipSync: {
      ...base.lipSync,
      ...(override.lipSync ?? {})
    },
    angleLimits: {
      ...base.angleLimits,
      ...(override.angleLimits ?? {})
    },
    aliases: mergeNestedRecord(base.aliases, override.aliases),
    mappings: mergeNestedRecord(base.mappings, override.mappings),
    impulses: mergeNestedRecord(base.impulses, override.impulses)
  };
}

export function normalizePetEmotionName(input: string): PetEmotionImpulseName | null {
  const normalized = input.trim().toLowerCase();
  return LEGACY_PET_EMOTION_TO_IMPULSE[normalized] ?? null;
}

function cloneRecord<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeEmotionalState(base: EmotionalState, override?: Partial<EmotionalState>): EmotionalState {
  if (!override) {
    return cloneRecord(base);
  }

  return {
    ...base,
    ...override,
    dimensions: override.dimensions
      ? { ...base.dimensions, ...override.dimensions }
      : { ...base.dimensions },
    ekman: override.ekman
      ? { ...base.ekman, ...override.ekman }
      : { ...base.ekman }
  };
}

function mergeNestedRecord<T extends Record<string, any>, O extends Partial<Record<keyof T, any>> | undefined>(
  base: T,
  override: O
): T {
  const result = cloneRecord(base);
  const mutableResult = result as Record<string, unknown>;
  if (!override) {
    return result;
  }

  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value) || value === null || typeof value !== "object") {
      mutableResult[key] = value;
      continue;
    }

    const current = mutableResult[key];
    if (!current || Array.isArray(current) || typeof current !== "object") {
      mutableResult[key] = value;
      continue;
    }

    mutableResult[key] = {
      ...current,
      ...value
    };
  }

  return result;
}
