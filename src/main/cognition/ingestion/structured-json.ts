import { generateText } from "ai";
import { z } from "zod";

type GenerateTextInput = Parameters<typeof generateText>[0];
type GenerateTextResult = Awaited<ReturnType<typeof generateText>>;

export interface GenerateStructuredJsonInput<TSchema extends z.ZodTypeAny> {
  model: GenerateTextInput["model"];
  prompt: string;
  schema: TSchema;
  system?: string;
  providerOptions?: GenerateTextInput["providerOptions"];
  maxOutputTokens?: number;
  maxAttempts?: number;
  generateText?: (input: GenerateTextInput) => Promise<GenerateTextResult>;
}

export interface GenerateStructuredJsonResult<TSchema extends z.ZodTypeAny> {
  object: z.infer<TSchema>;
  text: string;
  usage: GenerateTextResult["usage"];
  attempts: number;
}

export async function generateStructuredJson<TSchema extends z.ZodTypeAny>(
  input: GenerateStructuredJsonInput<TSchema>
): Promise<GenerateStructuredJsonResult<TSchema>> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? 3);
  const runGenerateText = input.generateText ?? generateText;
  let lastError: Error | null = null;
  let lastResponseText = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const prompt = buildAttemptPrompt({
      basePrompt: input.prompt,
      attempt,
      lastError,
      lastResponseText
    });

    try {
      const result = await runGenerateText({
        model: input.model,
        providerOptions: input.providerOptions,
        system: input.system,
        prompt,
        maxOutputTokens: input.maxOutputTokens
      });

      lastResponseText = result.text;
      const parsed = parseStructuredResponse(result.text, input.schema);
      return {
        object: parsed,
        text: result.text,
        usage: result.usage,
        attempts: attempt
      };
    } catch (error) {
      lastError = normalizeError(error);
    }
  }

  throw new Error(`Structured generation failed after ${maxAttempts} attempts: ${lastError?.message ?? "unknown error"}`);
}

function buildAttemptPrompt(input: {
  basePrompt: string;
  attempt: number;
  lastError: Error | null;
  lastResponseText: string;
}): string {
  if (input.attempt === 1 || !input.lastError) {
    return input.basePrompt;
  }

  const retrySections = [
    input.basePrompt,
    "",
    "Previous attempt failed.",
    `Failure reason: ${input.lastError.message}`,
    "Return exactly one valid JSON object that matches the requested structure.",
    "Do not include markdown fences, comments, or any extra text."
  ];

  const responsePreview = input.lastResponseText.trim();
  if (responsePreview) {
    retrySections.push("");
    retrySections.push("Previous response:");
    retrySections.push(truncate(responsePreview, 800));
  }

  return retrySections.join("\n");
}

function parseStructuredResponse<TSchema extends z.ZodTypeAny>(text: string, schema: TSchema): z.infer<TSchema> {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    throw new Error("model response did not contain a JSON object");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new Error(`failed to parse JSON: ${normalizeError(error).message}`);
  }

  let candidateObject = parsed;
  while (true) {
    const validated = schema.safeParse(candidateObject);
    if (validated.success) {
      return validated.data;
    }

    const repaired = stripUnknownKeys(candidateObject, validated.error);
    if (repaired.changed) {
      candidateObject = repaired.value;
      continue;
    }

    const firstIssue = validated.error.issues[0];
    if (!firstIssue) {
      throw new Error("schema validation failed");
    }
    const issuePath = firstIssue.path.length > 0 ? firstIssue.path.join(".") : "<root>";
    throw new Error(`schema validation failed at ${issuePath}: ${firstIssue.message}`);
  }
}

function extractJsonCandidate(rawText: string): string | null {
  const trimmed = stripCodeFence(rawText.trim());
  if (!trimmed) {
    return null;
  }

  if (isJson(trimmed)) {
    return trimmed;
  }

  const startIndex = findFirstJsonStart(trimmed);
  if (startIndex < 0) {
    return null;
  }

  const candidate = findBalancedJsonSlice(trimmed, startIndex);
  if (!candidate) {
    return null;
  }

  return isJson(candidate) ? candidate : null;
}

function stripCodeFence(text: string): string {
  const match = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() ?? text;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function findFirstJsonStart(text: string): number {
  const objectIndex = text.indexOf("{");
  const arrayIndex = text.indexOf("[");

  if (objectIndex === -1) {
    return arrayIndex;
  }
  if (arrayIndex === -1) {
    return objectIndex;
  }

  return Math.min(objectIndex, arrayIndex);
}

function findBalancedJsonSlice(text: string, startIndex: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];
    if (!char) {
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) {
        return null;
      }
      stack.pop();
      if (stack.length === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return null;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function stripUnknownKeys(value: unknown, error: z.ZodError): { value: unknown; changed: boolean } {
  const cloned = structuredClone(value);
  let changed = false;

  for (const issue of error.issues) {
    if (issue.code !== "unrecognized_keys" || issue.keys.length === 0) {
      continue;
    }

    const target = getNestedValue(cloned, issue.path);
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      continue;
    }

    for (const key of issue.keys) {
      if (key in target) {
        delete (target as Record<string, unknown>)[key];
        changed = true;
      }
    }
  }

  return {
    value: cloned,
    changed
  };
}

function getNestedValue(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
  let current = root;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }

    if (typeof segment === "symbol") {
      return undefined;
    }

    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
