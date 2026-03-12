import { stripEmotionTags } from "@main/core/emotion-tags";

export interface SentenceChunkBufferOptions {
  firstChunkMinChars: number;
  subsequentChunkMinChars: number;
}

function clampMinChars(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.max(1, Math.round(value));
}

function findBoundaryIndex(text: string, minChars: number): number {
  if (text.length < minChars) {
    return -1;
  }

  const punctuationPattern = /[。！？!?]/g;
  let match: RegExpExecArray | null = null;
  while ((match = punctuationPattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minChars) {
      return end;
    }
  }

  const commaPattern = /[，、,；;：:]/g;
  while ((match = commaPattern.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (end >= minChars) {
      return end;
    }
  }

  return -1;
}

export class SentenceChunkBuffer {
  private readonly firstChunkMinChars: number;
  private readonly subsequentChunkMinChars: number;
  private rawText = "";
  private visibleText = "";
  private emittedLength = 0;
  private emittedChunks = 0;

  constructor(options: SentenceChunkBufferOptions) {
    this.firstChunkMinChars = clampMinChars(options.firstChunkMinChars, 8);
    this.subsequentChunkMinChars = clampMinChars(options.subsequentChunkMinChars, 16);
  }

  push(delta: string): string[] {
    if (!delta) {
      return [];
    }

    this.rawText += delta;
    this.visibleText = stripEmotionTags(this.rawText);

    const emitted: string[] = [];
    while (true) {
      const pending = this.visibleText.slice(this.emittedLength).trimStart();
      if (!pending) {
        this.emittedLength = this.visibleText.length;
        break;
      }

      const requiredChars = this.emittedChunks === 0 ? this.firstChunkMinChars : this.subsequentChunkMinChars;
      const boundary = findBoundaryIndex(pending, requiredChars);
      if (boundary < 0) {
        break;
      }

      const chunk = pending.slice(0, boundary).trim();
      if (chunk) {
        emitted.push(chunk);
        this.emittedChunks += 1;
      }

      const visibleOffset = this.visibleText.indexOf(pending, this.emittedLength);
      const nextEmittedLength = visibleOffset >= 0 ? visibleOffset + boundary : this.visibleText.length;
      this.emittedLength = nextEmittedLength;
    }

    return emitted;
  }

  flush(): string[] {
    const pending = this.getPendingText();
    if (!pending) {
      this.reset();
      return [];
    }

    this.reset();
    return [pending];
  }

  getPendingText(): string {
    return this.visibleText.slice(this.emittedLength).trim();
  }

  reset(): void {
    this.rawText = "";
    this.visibleText = "";
    this.emittedLength = 0;
    this.emittedChunks = 0;
  }
}
