import { promises as fs } from "node:fs";
import { CompanionPaths } from "@main/storage/paths";
import type { CharacterProfile } from "@shared/types";

const DEFAULT_CHARACTER: CharacterProfile = {
  id: "default",
  name: "Yobi",
  systemPrompt:
    "你是 Yobi，一位温柔但不黏人的 AI 伙伴。你会关注用户状态、给出简短有温度的回应。避免说教，优先共情、具体、自然。"
};

export class CharacterStore {
  constructor(private readonly paths: CompanionPaths) {}

  async init(): Promise<void> {
    try {
      await fs.access(this.paths.defaultCharacterPath);
    } catch {
      await fs.writeFile(
        this.paths.defaultCharacterPath,
        `${JSON.stringify(DEFAULT_CHARACTER, null, 2)}\n`,
        "utf8"
      );
    }
  }

  async getCharacter(characterId: string): Promise<CharacterProfile> {
    const filePath = `${this.paths.charactersDir}/${characterId}.json`;
    const raw = await fs
      .readFile(filePath, "utf8")
      .catch(() => fs.readFile(this.paths.defaultCharacterPath, "utf8"));

    const parsed = JSON.parse(raw) as CharacterProfile;
    return {
      ...DEFAULT_CHARACTER,
      ...parsed
    };
  }

  async saveCharacter(profile: CharacterProfile): Promise<void> {
    const filePath = `${this.paths.charactersDir}/${profile.id}.json`;
    await fs.writeFile(filePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
  }
}
