import type { EmbedderRuntimeStatus } from "@shared/types";

interface EmbedderDisplay {
  statusLabel: string;
  engineLabel: string;
  modelLabel: string | null;
  detailLabel: string | null;
}

function cleanModelName(raw: string): string {
  const fileName = raw.replace(/^.*[:/\\]/, "").replace(/\.gguf$/i, "");
  const lower = fileName.toLowerCase();

  if (lower.startsWith("embeddinggemma-300m-qat-q8_0")) {
    return "EmbeddingGemma 300M · Q8_0";
  }

  return fileName
    .replace(/[-_]+/g, " ")
    .replace(/\bqat\b/gi, "QAT")
    .replace(/\bq(\d+_\d+)\b/gi, (_match, quant) => `Q${quant}`)
    .replace(/\b(\d+)m\b/gi, (_match, size) => `${size}M`)
    .replace(/\s+/g, " ")
    .trim();
}

export function formatEmbedderDisplay(embedder: EmbedderRuntimeStatus | null | undefined): EmbedderDisplay {
  if (!embedder) {
    return {
      statusLabel: "未知",
      engineLabel: "未上报",
      modelLabel: null,
      detailLabel: null
    };
  }

  const message = embedder.message?.trim() || "";
  const modelMatch = message.match(/([A-Za-z0-9._-]+\.gguf)/i);
  const modelLabel = modelMatch ? cleanModelName(modelMatch[1]) : null;

  if (embedder.status === "ready") {
    if (message.startsWith("llama-local-embedder:")) {
      return {
        statusLabel: "已就绪",
        engineLabel: "本地 GGUF 嵌入",
        modelLabel,
        detailLabel: null
      };
    }

    if (message.startsWith("heuristic fallback:")) {
      return {
        statusLabel: "回退模式",
        engineLabel: "启发式语义检索",
        modelLabel,
        detailLabel: message.replace(/^heuristic fallback:\s*/i, "") || null
      };
    }

    if (message.includes("heuristic-local-embedder")) {
      return {
        statusLabel: "已就绪",
        engineLabel: "启发式语义检索",
        modelLabel,
        detailLabel: null
      };
    }

    return {
      statusLabel: "已就绪",
      engineLabel: "语义记忆检索",
      modelLabel,
      detailLabel: message || null
    };
  }

  if (embedder.status === "loading") {
    return {
      statusLabel: "加载中",
      engineLabel: "正在初始化嵌入引擎",
      modelLabel,
      detailLabel: null
    };
  }

  if (embedder.status === "error") {
    return {
      statusLabel: "异常",
      engineLabel: "嵌入引擎初始化失败",
      modelLabel,
      detailLabel: message || null
    };
  }

  return {
    statusLabel: "已关闭",
    engineLabel: "本地语义检索已关闭",
    modelLabel,
    detailLabel: null
  };
}
