import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

test("worker generateStructuredJson retries until local parsing and validation succeed", async () => {
  const { generateStructuredJson } = await import(
    pathToFileURL(path.join(process.cwd(), "src", "main", "workers", "structured-json.cjs")).href
  ) as {
    generateStructuredJson: (input: {
      prompt: string;
      schema: z.ZodTypeAny;
      maxAttempts?: number;
      generateTextFn: (input: { prompt?: unknown }) => Promise<{ text: string; usage?: unknown }>;
    }) => Promise<{ object: unknown; attempts: number; text: string }>;
  };

  const seenPrompts: string[] = [];
  const result = await generateStructuredJson({
    prompt: "Return JSON.",
    schema: z.object({
      ok: z.boolean(),
      count: z.number().int()
    }).strict(),
    maxAttempts: 3,
    generateTextFn: async ({ prompt }) => {
      seenPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null));
      if (seenPrompts.length === 1) {
        return { text: "not json" };
      }
      if (seenPrompts.length === 2) {
        return { text: "{\"ok\":true}" };
      }
      return { text: "{\"ok\":true,\"count\":3}" };
    }
  });

  assert.deepEqual(result.object, { ok: true, count: 3 });
  assert.equal(result.attempts, 3);
  assert.match(seenPrompts[1] ?? "", /Previous attempt failed/i);
});

test("worker generateStructuredJson throws after three invalid attempts", async () => {
  const { generateStructuredJson } = await import(
    pathToFileURL(path.join(process.cwd(), "src", "main", "workers", "structured-json.cjs")).href
  ) as {
    generateStructuredJson: (input: {
      prompt: string;
      schema: z.ZodTypeAny;
      maxAttempts?: number;
      generateTextFn: (input: { prompt?: unknown }) => Promise<{ text: string; usage?: unknown }>;
    }) => Promise<{ object: unknown; attempts: number; text: string }>;
  };

  let attempts = 0;
  await assert.rejects(
    () =>
      generateStructuredJson({
        prompt: "Return JSON.",
        schema: z.object({
          ok: z.boolean()
        }).strict(),
        maxAttempts: 3,
        generateTextFn: async () => {
          attempts += 1;
          return { text: "{\"missing\":true}" };
        }
      }),
    /failed after 3 attempts/i
  );

  assert.equal(attempts, 3);
});

test("worker generateStructuredJson strips unrecognized keys before failing validation", async () => {
  const { generateStructuredJson } = await import(
    pathToFileURL(path.join(process.cwd(), "src", "main", "workers", "structured-json.cjs")).href
  ) as {
    generateStructuredJson: (input: {
      prompt: string;
      schema: z.ZodTypeAny;
      maxAttempts?: number;
      generateTextFn: (input: { prompt?: unknown }) => Promise<{ text: string; usage?: unknown }>;
    }) => Promise<{ object: unknown; attempts: number; text: string }>;
  };

  const result = await generateStructuredJson({
    prompt: "Return JSON.",
    schema: z.object({
      graph: z.object({
        nodes: z.array(
          z.object({
            content: z.string(),
            type: z.string()
          }).strict()
        )
      }).strict()
    }).strict(),
    maxAttempts: 1,
    generateTextFn: async () => ({
      text: "{\"graph\":{\"nodes\":[{\"id\":\"n1\",\"content\":\"hello\",\"type\":\"fact\"}]}}"
    })
  });

  assert.deepEqual(result.object, {
    graph: {
      nodes: [
        {
          content: "hello",
          type: "fact"
        }
      ]
    }
  });
});
