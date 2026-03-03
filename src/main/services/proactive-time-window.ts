interface QuietHoursConfig {
  enabled: boolean;
  startMinuteOfDay: number;
  endMinuteOfDay: number;
}

function minuteOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

export function isWithinQuietHours(now: Date, quietHours: QuietHoursConfig): boolean {
  if (!quietHours.enabled) {
    return false;
  }

  const start = quietHours.startMinuteOfDay;
  const end = quietHours.endMinuteOfDay;
  const current = minuteOfDay(now);

  if (start < end) {
    return current >= start && current < end;
  }

  return current >= start || current < end;
}
