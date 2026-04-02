import type { EmotionalState, VoiceSessionPhase } from "./types";
import type { PetEmotionImpulseName } from "./pet-emotion";

export interface PetSpeechEnqueueEvent {
  type: "speech-enqueue";
  chunkId: string;
  audioBase64: string;
  mimeType?: string;
  text: string;
  generation: number;
}

export interface PetSpeechClearEvent {
  type: "speech-clear";
  generation: number;
  reason?: string;
}

export type PetEvent =
  | { type: "emotion"; value: string }
  | { type: "emotion-state"; emotional: EmotionalState }
  | { type: "emotion-impulse"; name: PetEmotionImpulseName; intensity?: number; durationMs?: number }
  | { type: "expression"; id: string }
  | { type: "talking"; value: string }
  | PetSpeechEnqueueEvent
  | PetSpeechClearEvent
  | { type: "voice-state"; phase: VoiceSessionPhase; mode: "ptt" | "free" }
  | { type: "ptt"; state: "start" | "stop" | "cancel"; reason?: string }
  | { type: "thinking"; value: "start" | "stop" };

export type PetVoiceEvent =
  | {
      type: "speech-playback-started";
      chunkId: string;
      text: string;
      generation: number;
    }
  | {
      type: "speech-playback-ended";
      chunkId: string;
      text: string;
      generation: number;
    }
  | {
      type: "speech-playback-error";
      chunkId: string;
      message: string;
      generation: number;
    }
  | {
      type: "speech-playback-cleared";
      generation: number;
    }
  | {
      type: "speech-reference-frame";
      pcm: number[];
      sampleRate: number;
      generation: number;
    };
