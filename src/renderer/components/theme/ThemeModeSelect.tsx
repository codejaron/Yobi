import type { ThemeMode } from "@shared/types";
import { Select } from "@renderer/components/ui/select";

interface ThemeModeSelectProps {
  value: ThemeMode;
  onChange: (value: ThemeMode) => void;
  disabled?: boolean;
  className?: string;
}

export function ThemeModeSelect({ value, onChange, disabled, className }: ThemeModeSelectProps) {
  return (
    <Select
      aria-label="主题模式"
      value={value}
      disabled={disabled}
      className={className}
      onChange={(event) => onChange(event.target.value as ThemeMode)}
    >
      <option value="system">跟随系统</option>
      <option value="light">浅色</option>
      <option value="dark">暗黑</option>
    </Select>
  );
}
