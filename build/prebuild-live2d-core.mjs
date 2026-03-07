import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const targetPath = path.join(projectRoot, "resources", "live2dcubismcore.min.js");
const tempPath = `${targetPath}.tmp`;

const coreUrl =
  process.env.CUBISM_CORE_URL?.trim() ||
  "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js";
const forceDownload = process.env.CUBISM_CORE_FORCE_DOWNLOAD === "1";
const skipDownload = process.env.CUBISM_CORE_SKIP_DOWNLOAD === "1";

function hasCubismBanner(content) {
  return content.includes("Live2D Cubism Core");
}

async function readBannerSample(filePath) {
  const data = await readFile(filePath);
  return data.toString("utf8", 0, Math.min(data.length, 4096));
}

async function downloadCore(url) {
  const response = await fetch(url, {
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(`download failed with status ${response.status} ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const data = Buffer.from(arrayBuffer);
  if (data.length < 1024) {
    throw new Error(`downloaded file is too small (${data.length} bytes)`);
  }
  const sample = data.toString("utf8", 0, Math.min(data.length, 4096));
  if (!hasCubismBanner(sample)) {
    throw new Error("downloaded file does not look like live2dcubismcore.min.js");
  }
  return data;
}

async function main() {
  await mkdir(path.dirname(targetPath), { recursive: true });

  if (!forceDownload && existsSync(targetPath)) {
    try {
      const sample = await readBannerSample(targetPath);
      if (hasCubismBanner(sample)) {
        console.log(`[live2d-core] reusing existing file at ${targetPath}`);
        return;
      }
      console.warn("[live2d-core] existing file is invalid, re-downloading...");
    } catch {
      console.warn("[live2d-core] failed to read existing file, re-downloading...");
    }
  }

  if (skipDownload) {
    if (existsSync(targetPath)) {
      console.log(`[live2d-core] skip enabled, keeping existing file at ${targetPath}`);
      return;
    }
    throw new Error("CUBISM_CORE_SKIP_DOWNLOAD=1 but core file does not exist");
  }

  console.log(`[live2d-core] downloading from ${coreUrl}`);
  const fileData = await downloadCore(coreUrl);
  await writeFile(tempPath, fileData);
  await rename(tempPath, targetPath);

  const hash = createHash("sha256").update(fileData).digest("hex");
  console.log(`[live2d-core] saved ${fileData.length} bytes to ${targetPath}`);
  console.log(`[live2d-core] sha256=${hash}`);
}

main().catch(async (error) => {
  await rm(tempPath, { force: true }).catch(() => undefined);
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[live2d-core] prebuild failed: ${message}`);
  process.exitCode = 1;
});
