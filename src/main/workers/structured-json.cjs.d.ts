import type { z } from "zod";

export interface GenerateStructuredJsonResult<TSchema extends z.ZodTypeAny> {
  object: z.infer<TSchema>;
  text: string;
  usage?: unknown;
  attempts: number;
}

export function generateStructuredJson<TSchema extends z.ZodTypeAny>(input: {
  model?: unknown;
  prompt: string;
  schema: TSchema;
  system?: string;
  providerOptions?: unknown;
  maxOutputTokens?: number;
  maxAttempts?: number;
  generateTextFn?: (input: { prompt?: unknown }) => Promise<{ text: string; usage?: unknown }>;
}): Promise<GenerateStructuredJsonResult<TSchema>>;
