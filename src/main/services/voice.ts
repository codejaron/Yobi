import { promises as fs } from "node:fs";

interface VoiceConfig {
  voice: string;
  rate: string;
  pitch: string;
}

type EdgeTtsResult = string | Buffer | Uint8Array | { audio?: string | Buffer | Uint8Array };

async function resolveToBuffer(result: EdgeTtsResult): Promise<Buffer> {
  if (Buffer.isBuffer(result)) {
    return result;
  }

  if (result instanceof Uint8Array) {
    return Buffer.from(result);
  }

  if (typeof result === "string") {
    if (result.startsWith("data:audio")) {
      const base64 = result.split(",")[1] ?? "";
      return Buffer.from(base64, "base64");
    }

    return fs.readFile(result);
  }

  if (result && typeof result === "object" && "audio" in result && result.audio) {
    return resolveToBuffer(result.audio as EdgeTtsResult);
  }

  throw new Error("Unsupported TTS result payload");
}

export class VoiceService {
  async synthesize(input: { text: string; config: VoiceConfig }): Promise<Buffer> {
    const dynamicImport = new Function("moduleName", "return import(moduleName);") as (
      moduleName: string
    ) => Promise<Record<string, any>>;
    const module = (await dynamicImport("edge-tts-universal")) as Record<string, any>;
    const callTargets = [
      module.generate,
      module.synthesize,
      module.tts,
      module.default?.generate,
      module.default?.synthesize,
      module.default?.tts
    ].filter((candidate): candidate is (...args: any[]) => Promise<EdgeTtsResult> =>
      typeof candidate === "function"
    );

    if (callTargets.length === 0) {
      throw new Error("edge-tts-universal does not expose a supported API");
    }

    const payload = {
      text: input.text,
      voice: input.config.voice,
      rate: input.config.rate,
      pitch: input.config.pitch
    };

    let lastError: unknown;
    for (const fn of callTargets) {
      try {
        const result = await fn(payload);
        return resolveToBuffer(result);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error("Voice synthesis failed");
  }
}
