import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import type { FilePart, ImagePart, UserContent } from "ai";
import type {
  AttachmentReferenceNote,
  ChatAttachment,
  ChatAttachmentKind,
  ConsoleChatAttachmentInput
} from "@shared/types";
import type { CompanionPaths } from "@main/storage/paths";

export const CHAT_MEDIA_RETENTION_DAYS = 7;
export const MAX_ATTACHMENTS_PER_MESSAGE = 3;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_REUSE_USER_MESSAGE_WINDOW = 4;

const IMAGE_SIGNATURES: Array<{ mimeType: string; matches: (buffer: Buffer) => boolean; extension: string }> = [
  {
    mimeType: "image/png",
    extension: ".png",
    matches: (buffer) =>
      buffer.length >= 8 &&
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
  },
  {
    mimeType: "image/jpeg",
    extension: ".jpg",
    matches: (buffer) => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  },
  {
    mimeType: "image/gif",
    extension: ".gif",
    matches: (buffer) =>
      (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii") === "GIF87a") ||
      (buffer.length >= 6 && buffer.subarray(0, 6).toString("ascii") === "GIF89a")
  },
  {
    mimeType: "image/webp",
    extension: ".webp",
    matches: (buffer) =>
      buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP"
  }
];

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".jsonl",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".scss",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".py",
  ".java",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".cs",
  ".go",
  ".rs",
  ".rb",
  ".php",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".csv",
  ".log"
]);

const TEXT_MIME_HINTS = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "application/x-javascript",
  "application/javascript",
  "application/xml",
  "text/xml",
  "text/x-python",
  "text/x-java-source",
  "text/x-c",
  "text/x-c++src",
  "text/x-shellscript",
  "text/csv"
]);

function sanitizePathSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
  const trimmed = normalized.replace(/^-+|-+$/g, "");
  return trimmed || fallback;
}

function sanitizeFilename(value: string | undefined, fallbackBase: string, extensionHint = ""): string {
  const candidate = (value ?? "").trim();
  const basename = candidate ? path.basename(candidate) : `${fallbackBase}${extensionHint}`;
  const ext = path.extname(basename).toLowerCase();
  const name = basename.slice(0, basename.length - ext.length) || fallbackBase;
  const safeName = sanitizePathSegment(name, fallbackBase);
  const safeExt = ext || extensionHint;
  return `${safeName}${safeExt}`;
}

function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function detectImageSignature(buffer: Buffer): { mimeType: string; extension: string } | null {
  for (const entry of IMAGE_SIGNATURES) {
    if (entry.matches(buffer)) {
      return {
        mimeType: entry.mimeType,
        extension: entry.extension
      };
    }
  }

  return null;
}

function isPdfBuffer(buffer: Buffer): boolean {
  return buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "%PDF";
}

function isProbablyText(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }

  let suspicious = 0;
  const sampleSize = Math.min(buffer.length, 4096);
  for (let index = 0; index < sampleSize; index += 1) {
    const value = buffer[index];
    if (typeof value !== "number") {
      continue;
    }

    if (value === 0) {
      return false;
    }

    const isAsciiText =
      value === 0x09 ||
      value === 0x0a ||
      value === 0x0d ||
      (value >= 0x20 && value <= 0x7e);
    if (isAsciiText || value >= 0x80) {
      continue;
    }

    suspicious += 1;
  }

  return suspicious / sampleSize < 0.1;
}

function resolveConsoleAttachmentSpec(input: ConsoleChatAttachmentInput, index: number): {
  buffer: Buffer;
  kind: ChatAttachmentKind;
  filename: string;
  mimeType: string;
} {
  const raw = String(input.dataBase64 ?? "").trim();
  if (!raw) {
    throw new Error(`附件 ${index + 1} 内容为空`);
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(raw, "base64");
  } catch {
    throw new Error(`附件 ${index + 1} 不是合法的 base64 数据`);
  }

  if (buffer.length === 0) {
    throw new Error(`附件 ${index + 1} 内容为空`);
  }

  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new Error(`附件 ${index + 1} 超过 10MB 限制`);
  }

  const imageSignature = detectImageSignature(buffer);
  if (imageSignature) {
    return {
      buffer,
      kind: "image",
      mimeType: imageSignature.mimeType,
      filename: sanitizeFilename(input.name, `image-${index + 1}`, imageSignature.extension)
    };
  }

  if (isPdfBuffer(buffer)) {
    return {
      buffer,
      kind: "file",
      mimeType: "application/pdf",
      filename: sanitizeFilename(input.name, `document-${index + 1}`, ".pdf")
    };
  }

  const extension = path.extname(input.name ?? "").toLowerCase();
  const mimeHint = String(input.mimeType ?? "").trim().toLowerCase();
  const looksLikeText =
    TEXT_EXTENSIONS.has(extension) ||
    TEXT_MIME_HINTS.has(mimeHint) ||
    mimeHint.startsWith("text/");

  if (looksLikeText && isProbablyText(buffer)) {
    return {
      buffer,
      kind: "file",
      mimeType: "text/plain",
      filename: sanitizeFilename(input.name, `text-${index + 1}`, extension || ".txt")
    };
  }

  throw new Error(`附件 ${index + 1} 类型不受支持，仅支持图片、PDF 和文本/代码文件`);
}

async function writeAttachmentFile(targetPath: string, buffer: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, buffer);
}

export function attachmentToReferenceNote(
  attachment: ChatAttachment,
  reason: AttachmentReferenceNote["reason"]
): AttachmentReferenceNote {
  return {
    attachmentId: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    path: attachment.path,
    reason
  };
}

export function buildAttachmentReferenceText(input: {
  attachments: ChatAttachment[];
  reason: AttachmentReferenceNote["reason"];
}): string {
  const title =
    input.reason === "missing"
      ? "[附件引用：缓存缺失]"
      : input.reason === "unsupported"
        ? "[附件引用：当前模型不支持该附件类型]"
        : "[附件引用：已超出自动复用窗口]";
  return [
    title,
    ...input.attachments.map((attachment) =>
      `- ${attachment.filename} | ${attachment.mimeType} | ${attachment.path} | id=${attachment.id}`
    )
  ].join("\n");
}

export async function attachmentToPart(
  attachment: ChatAttachment
): Promise<ImagePart | FilePart | null> {
  try {
    const buffer = await fs.readFile(attachment.path);
    if (attachment.kind === "image" || attachment.mimeType.startsWith("image/")) {
      return {
        type: "image",
        image: buffer,
        mediaType: attachment.mimeType
      };
    }

    return {
      type: "file",
      data: buffer,
      filename: attachment.filename,
      mediaType: attachment.mimeType
    };
  } catch {
    return null;
  }
}

export async function buildUserContentWithAttachments(input: {
  text: string;
  attachments: ChatAttachment[];
  includeMedia: boolean;
  fallbackReason?: AttachmentReferenceNote["reason"];
}): Promise<{ content: UserContent; references: AttachmentReferenceNote[] }> {
  const normalizedText = input.text.trim();
  const references: AttachmentReferenceNote[] = [];
  const fallbackReason = input.fallbackReason ?? "expired";

  if (input.attachments.length === 0) {
    return {
      content: normalizedText,
      references
    };
  }

  if (!input.includeMedia) {
    references.push(...input.attachments.map((attachment) => attachmentToReferenceNote(attachment, fallbackReason)));
    const referenceBlock = buildAttachmentReferenceText({
      attachments: input.attachments,
      reason: fallbackReason
    });

    return {
      content: [normalizedText, referenceBlock].filter(Boolean).join("\n\n"),
      references
    };
  }

  const parts: Array<{ type: "text"; text: string } | ImagePart | FilePart> = [];
  if (normalizedText) {
    parts.push({
      type: "text",
      text: normalizedText
    });
  }

  for (const attachment of input.attachments) {
    const part = await attachmentToPart(attachment);
    if (!part) {
      references.push(attachmentToReferenceNote(attachment, "missing"));
      continue;
    }
    parts.push(part);
  }

  if (references.length > 0) {
    parts.push({
      type: "text",
      text: buildAttachmentReferenceText({
        attachments: references.map((reference) => ({
          id: reference.attachmentId,
          kind: reference.mimeType.startsWith("image/") ? "image" : "file",
          filename: reference.filename,
          mimeType: reference.mimeType,
          size: 0,
          path: reference.path,
          source: "user-upload",
          createdAt: new Date(0).toISOString()
        })),
        reason: "missing"
      })
    });
  }

  return {
    content: parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts,
    references
  };
}

export class ChatMediaStore {
  constructor(private readonly paths: CompanionPaths) {}

  getReadRoots(): string[] {
    return [this.paths.chatMediaDir];
  }

  async storeConsoleAttachments(input: {
    attachments: ConsoleChatAttachmentInput[];
    threadId: string;
  }): Promise<ChatAttachment[]> {
    const attachments = input.attachments ?? [];
    if (attachments.length === 0) {
      return [];
    }

    if (attachments.length > MAX_ATTACHMENTS_PER_MESSAGE) {
      throw new Error(`单条消息最多只能附加 ${MAX_ATTACHMENTS_PER_MESSAGE} 个文件`);
    }

    const resolved = attachments.map((attachment, index) => resolveConsoleAttachmentSpec(attachment, index));
    const totalBytes = resolved.reduce((sum, item) => sum + item.buffer.length, 0);
    if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
      throw new Error("单条消息附件总大小不能超过 20MB");
    }

    const targetDir = path.join(this.paths.chatMediaDir, sanitizePathSegment(input.threadId, "thread"));
    const createdAt = new Date().toISOString();

    return Promise.all(
      resolved.map(async (attachment) => {
        const id = randomUUID();
        const targetPath = path.join(targetDir, `${id}-${attachment.filename}`);
        await writeAttachmentFile(targetPath, attachment.buffer);
        return {
          id,
          kind: attachment.kind,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.buffer.length,
          path: targetPath,
          source: "user-upload" as const,
          createdAt
        };
      })
    );
  }

  async storeInboundImage(input: {
    channel: "telegram" | "qq" | "feishu";
    chatId: string;
    data: Buffer;
    filename?: string;
  }): Promise<ChatAttachment> {
    if (input.data.length === 0) {
      throw new Error("图片内容为空");
    }

    if (input.data.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`图片超过 ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))}MB 限制`);
    }

    const detectedImage = detectImageSignature(input.data);
    if (!detectedImage) {
      throw new Error("图片类型不受支持，仅支持 PNG/JPEG/GIF/WEBP");
    }

    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const targetDir = path.join(
      this.paths.chatMediaDir,
      "inbound",
      sanitizePathSegment(input.channel, "channel"),
      sanitizePathSegment(input.chatId, "chat")
    );
    const filename = sanitizeFilename(
      input.filename,
      `${input.channel}-image`,
      detectedImage.extension
    );
    const targetPath = path.join(targetDir, `${id}-${filename}`);
    await writeAttachmentFile(targetPath, input.data);

    return {
      id,
      kind: "image",
      filename,
      mimeType: detectedImage.mimeType,
      size: input.data.length,
      path: targetPath,
      source: "user-upload",
      createdAt
    };
  }

  async storeToolMedia(input: {
    mediaType: string;
    data: Buffer;
    prefix: string;
    filename?: string;
    source?: ChatAttachment["source"];
  }): Promise<ChatAttachment> {
    const createdAt = new Date().toISOString();
    const id = randomUUID();
    const detectedImage = input.mediaType.startsWith("image/") ? detectImageSignature(input.data) : null;
    const extensionHint =
      input.mediaType === "application/pdf"
        ? ".pdf"
        : detectedImage?.extension ?? path.extname(input.filename ?? "");
    const filename = sanitizeFilename(input.filename, input.prefix, extensionHint);
    const targetDir = path.join(this.paths.chatMediaDir, "tool-output");
    const targetPath = path.join(targetDir, `${id}-${filename}`);
    await writeAttachmentFile(targetPath, input.data);

    return {
      id,
      kind: input.mediaType.startsWith("image/") ? "image" : "file",
      filename,
      mimeType: input.mediaType,
      size: input.data.length,
      path: targetPath,
      source: input.source ?? "tool-generated",
      createdAt
    };
  }

  async readImagePreviewDataUrl(input: {
    path: string;
    mimeType?: string | null;
  }): Promise<string | null> {
    const mimeType = String(input.mimeType ?? "").trim().toLowerCase();
    if (!mimeType.startsWith("image/")) {
      return null;
    }

    const targetPath = path.resolve(input.path);
    const chatMediaRoot = path.resolve(this.paths.chatMediaDir);
    if (!isPathInsideRoot(targetPath, chatMediaRoot)) {
      return null;
    }

    try {
      const buffer = await fs.readFile(targetPath);
      const detected = detectImageSignature(buffer);
      if (!detected) {
        return null;
      }

      return `data:${detected.mimeType};base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    }
  }

  async cleanupExpired(retentionDays = CHAT_MEDIA_RETENTION_DAYS, now = new Date()): Promise<number> {
    const threshold = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
    return removeExpiredEntries(this.paths.chatMediaDir, threshold);
  }
}

async function removeExpiredEntries(targetDir: string, thresholdMs: number): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(targetDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let removed = 0;
  for (const entry of entries) {
    const entryPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      removed += await removeExpiredEntries(entryPath, thresholdMs);
      try {
        const remaining = await fs.readdir(entryPath);
        if (remaining.length === 0) {
          await fs.rmdir(entryPath);
        }
      } catch {
        // Ignore cleanup failures.
      }
      continue;
    }

    try {
      const stats = await fs.stat(entryPath);
      if (stats.mtimeMs <= thresholdMs) {
        await fs.unlink(entryPath);
        removed += 1;
      }
    } catch {
      // Ignore cleanup failures.
    }
  }

  return removed;
}
