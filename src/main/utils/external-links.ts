import { shell } from "electron";

const WEB_PROTOCOL_ALLOWLIST = new Set(["https:"]);
const SYSTEM_PROTOCOL_ALLOWLIST = new Set(["x-apple.systempreferences:", "ms-settings:"]);

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export async function openSafeWebUrl(raw: string): Promise<boolean> {
  const parsed = parseUrl(raw);
  if (!parsed || !WEB_PROTOCOL_ALLOWLIST.has(parsed.protocol)) {
    return false;
  }
  await shell.openExternal(parsed.toString());
  return true;
}

export async function openSafeSystemSettingsUrl(raw: string): Promise<boolean> {
  const parsed = parseUrl(raw);
  if (!parsed || !SYSTEM_PROTOCOL_ALLOWLIST.has(parsed.protocol)) {
    return false;
  }
  await shell.openExternal(parsed.toString());
  return true;
}
