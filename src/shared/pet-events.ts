import type { EmotionalState, VoiceSessionPhase } from "./types";
import type { PetEmotionImpulseName } from "./pet-emotion";

export type PetEvent =
  | { type: "emotion"; value: string }
  | { type: "emotion-state"; emotional: EmotionalState }
  | { type: "emotion-impulse"; name: PetEmotionImpulseName; intensity?: number; durationMs?: number }
  | { type: "expression"; id: string }
  | { type: "talking"; value: string }
  | { type: "speech"; audioBase64: string; mimeType?: string }
  | { type: "voice-state"; phase: VoiceSessionPhase; mode: "ptt" | "free" }
  | { type: "speech-level"; level: number }
  | { type: "ptt"; state: "start" | "stop" | "cancel"; reason?: string }
  | { type: "thinking"; value: "start" | "stop" };
