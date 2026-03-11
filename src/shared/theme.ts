import type { ResolvedTheme, ThemeMode } from "@shared/types";

export const THEME_MODE_STORAGE_KEY = "yobi.theme-mode";

export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "system") {
    return prefersDark ? "dark" : "light";
  }

  return mode;
}

export function isDarkTheme(mode: ThemeMode, prefersDark: boolean): boolean {
  return resolveTheme(mode, prefersDark) === "dark";
}
