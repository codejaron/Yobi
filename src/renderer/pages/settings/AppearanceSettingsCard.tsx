import { resolveTheme } from "@shared/theme";
import type { ThemeMode } from "@shared/types";
import { ThemeModeSelect } from "@renderer/components/theme/ThemeModeSelect";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@renderer/components/ui/card";
import { Label } from "@renderer/components/ui/label";

interface AppearanceSettingsCardProps {
  themeMode: ThemeMode;
  onThemeModeChange: (mode: ThemeMode) => void;
  themeSaving: boolean;
}

function themeModeDescription(mode: ThemeMode, resolvedTheme: "light" | "dark"): string {
  if (mode === "system") {
    return `当前跟随系统，实际为${resolvedTheme === "dark" ? "暗黑" : "浅色"}。`;
  }

  return `当前固定为${mode === "dark" ? "暗黑" : "浅色"}模式。`;
}

export function AppearanceSettingsCard({
  themeMode,
  onThemeModeChange,
  themeSaving
}: AppearanceSettingsCardProps) {
  const prefersDark = typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  const resolvedTheme = resolveTheme(themeMode, prefersDark);

  return (
    <Card>
      <CardHeader>
        <CardTitle>外观主题</CardTitle>
        <CardDescription>支持浅色、暗黑和跟随系统；切换后会立即生效并自动保存。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="surface-panel space-y-2 p-4">
          <Label htmlFor="appearance-theme-mode">主题模式</Label>
          <ThemeModeSelect
            value={themeMode}
            onChange={onThemeModeChange}
            disabled={themeSaving}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">{themeModeDescription(themeMode, resolvedTheme)}</p>
        </div>
      </CardContent>
    </Card>
  );
}
