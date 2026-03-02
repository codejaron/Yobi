import { memo, useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Check, Copy } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneLight } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { cn } from "@renderer/lib/utils";

interface MarkdownContentProps {
  markdown: string;
  variant: "chat" | "memory";
  className?: string;
}

interface MarkdownCodeBlockProps {
  code: string;
  language: string | null;
}

const markdownCodeStyle: CSSProperties = {
  margin: 0,
  background: "transparent",
  padding: "1rem 1rem 0.95rem",
  fontSize: "0.82rem",
  lineHeight: 1.65
};

function fallbackCopyText(value: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

async function copyText(value: string): Promise<boolean> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // ignore clipboard fallback
    }
  }

  return fallbackCopyText(value);
}

function MarkdownCodeBlock({ code, language }: MarkdownCodeBlockProps) {
  const [copyState, setCopyState] = useState<"idle" | "success" | "error">("idle");

  const handleCopy = useCallback(async () => {
    const copied = await copyText(code);
    setCopyState(copied ? "success" : "error");
  }, [code]);

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setCopyState("idle");
    }, 1600);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [copyState]);

  const copyLabel = copyState === "success" ? "已复制" : copyState === "error" ? "复制失败" : "复制";

  return (
    <div className="yobi-markdown__code-block">
      <button
        type="button"
        className={cn(
          "yobi-markdown__copy-btn",
          copyState === "success" ? "yobi-markdown__copy-btn--success" : ""
        )}
        onClick={() => void handleCopy()}
        aria-label={language ? `复制 ${language} 代码` : "复制代码"}
      >
        {copyState === "success" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        <span>{copyLabel}</span>
      </button>
      <SyntaxHighlighter
        language={language ?? undefined}
        style={oneLight}
        customStyle={markdownCodeStyle}
        wrapLongLines
        showLineNumbers={false}
      >
        {code}
      </SyntaxHighlighter>
    </div>
  );
}

const markdownComponents: Components = {
  pre({ children }) {
    return <>{children}</>;
  },
  a({ href, title, children }) {
    return (
      <a href={href} title={title} target={href ? "_blank" : undefined} rel={href ? "noreferrer noopener" : undefined}>
        {children}
      </a>
    );
  },
  img({ src, alt, title }) {
    return <img src={src} alt={alt ?? ""} title={title} loading="lazy" />;
  },
  table({ children }) {
    return (
      <div className="yobi-markdown__table-wrap">
        <table>{children}</table>
      </div>
    );
  },
  code(props) {
    const inline = (props as { inline?: boolean }).inline ?? false;
    const className = props.className ?? "";
    const languageMatch = /language-([\w-]+)/.exec(className);
    const language = languageMatch?.[1] ?? null;
    const codeText = String(props.children ?? "").replace(/\n$/, "");

    if (inline) {
      return <code>{props.children}</code>;
    }

    if (!language && !codeText.includes("\n")) {
      return <code>{props.children}</code>;
    }

    return <MarkdownCodeBlock code={codeText} language={language} />;
  }
};

function MarkdownContentComponent({ markdown, variant, className }: MarkdownContentProps) {
  return (
    <div
      className={cn(
        "yobi-markdown",
        variant === "chat" ? "yobi-markdown--chat" : "yobi-markdown--memory",
        className
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

export const MarkdownContent = memo(MarkdownContentComponent);
MarkdownContent.displayName = "MarkdownContent";
