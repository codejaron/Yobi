import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { generateStructuredJson } from "../cognition/ingestion/structured-json.js";

test("generateStructuredJson retries provider text until local JSON parsing and schema validation succeed", async () => {
  const attemptPrompts: string[] = [];
  const result = await generateStructuredJson({
    model: {} as never,
    prompt: "Return JSON.",
    schema: z.object({
      ok: z.boolean(),
      count: z.number().int()
    }).strict(),
    maxAttempts: 3,
    generateText: async ({ prompt }) => {
      attemptPrompts.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt ?? null));
      if (attemptPrompts.length === 1) {
        return {
          text: "not json",
          usage: undefined
        } as never;
      }
      if (attemptPrompts.length === 2) {
        return {
          text: "{\"ok\":true}",
          usage: undefined
        } as never;
      }
      return {
        text: "{\"ok\":true,\"count\":3}",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15
        }
      } as never;
    }
  });

  assert.deepEqual(result.object, {
    ok: true,
    count: 3
  });
  assert.equal(result.attempts, 3);
  assert.equal(attemptPrompts.length, 3);
  assert.match(attemptPrompts[1] ?? "", /Previous attempt failed/i);
  assert.match(attemptPrompts[2] ?? "", /Previous attempt failed/i);
});

test("generateStructuredJson throws after three invalid attempts", async () => {
  let attempts = 0;

  await assert.rejects(
    () =>
      generateStructuredJson({
        model: {} as never,
        prompt: "Return JSON.",
        schema: z.object({
          ok: z.boolean()
        }).strict(),
        maxAttempts: 3,
        generateText: async () => {
          attempts += 1;
          return {
            text: "{\"missing\":true}",
            usage: undefined
          } as never;
        }
      }),
    /failed after 3 attempts/i
  );

  assert.equal(attempts, 3);
});

test("generateStructuredJson strips unrecognized keys before failing validation", async () => {
  const result = await generateStructuredJson({
    model: {} as never,
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
    generateText: async () =>
      ({
        text: "{\"graph\":{\"nodes\":[{\"id\":\"n1\",\"content\":\"hello\",\"type\":\"fact\"}]}}",
        usage: undefined
      }) as never
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
