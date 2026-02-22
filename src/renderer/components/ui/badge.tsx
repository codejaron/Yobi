import type { ReactNode } from "react";
import { cn } from "@renderer/lib/utils";

export function Badge({
  children,
  className
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border border-border/80 bg-white/80 px-2.5 py-0.5 text-xs font-medium text-foreground/90",
        className
      )}
    >
      {children}
    </span>
  );
}
