import { resolveTheme, THEME_MODE_STORAGE_KEY } from "@shared/theme";
import type { ResolvedTheme, ThemeMode } from "@shared/types";

const DARK_MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function getSystemPrefersDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export function readCachedThemeMode(): ThemeMode {
  try {
    const value = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
    return isThemeMode(value) ? value : "system";
  } catch {
    return "system";
  }
}

export function writeCachedThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore storage write failures in renderer-only cache.
  }
}

export function applyThemeMode(mode: ThemeMode, prefersDark = getSystemPrefersDark()): ResolvedTheme {
  const resolved = resolveTheme(mode, prefersDark);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.theme = resolved;
  return resolved;
}

export function subscribeSystemTheme(listener: (prefersDark: boolean) => void): () => void {
  const mediaQuery = window.matchMedia(DARK_MEDIA_QUERY);
  const handleChange = (event: MediaQueryListEvent) => listener(event.matches);
  mediaQuery.addEventListener("change", handleChange);
  return () => {
    mediaQuery.removeEventListener("change", handleChange);
  };
}
