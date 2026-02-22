import * as React from "react";
import { cn } from "@renderer/lib/utils";

export function Switch({
  checked,
  onChange,
  className,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> & {
  onChange?: (checked: boolean) => void;
}) {
  return (
    <label
      className={cn(
        "relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full border border-border/80 transition-colors",
        checked ? "bg-primary/90" : "bg-muted",
        className
      )}
    >
      <input
        type="checkbox"
        className="sr-only"
        checked={checked}
        onChange={(event) => onChange?.(event.target.checked)}
        {...props}
      />
      <span
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </label>
  );
}
