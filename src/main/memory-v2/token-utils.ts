export function estimateTokenCount(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return 0;
  }

  const cjkChars = (normalized.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinWords = normalized.match(/[A-Za-z0-9_]+/g)?.length ?? 0;
  const punctuation = (normalized.match(/[，。！？、,.!?;:()[\]{}"“”‘’`~]/g) ?? []).length;
  return Math.max(1, Math.ceil(cjkChars * 1.2 + latinWords * 0.35 + punctuation * 0.2));
}
