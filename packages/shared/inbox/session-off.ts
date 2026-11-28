import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEPT_MS = 30 * 24 * 60 * 60 * 1000;

function offDirOf(dataDir: string): string {
  return join(dataDir, "inbox", "sessions-off");
}

function offFileOf(dataDir: string, sessionId: string): string {
  return join(offDirOf(dataDir), sessionId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

export function isInboxSessionOff(dataDir: string, sessionId: string): boolean {
  if (!sessionId) return false;
  try {
    return existsSync(offFileOf(dataDir, sessionId));
  } catch {
    return false;
  }
}

export function setInboxSessionOff(dataDir: string, sessionId: string, off: boolean): void {
  if (!sessionId) return;
  const file = offFileOf(dataDir, sessionId);
  try {
    if (!off) {
      rmSync(file, { force: true });
      return;
    }
    mkdirSync(offDirOf(dataDir), { recursive: true, mode: 0o700 });
    writeFileSync(file, String(Date.now()), { mode: 0o600 });
    pruneOld(dataDir);
  } catch {
    return;
  }
}

function pruneOld(dataDir: string): void {
  const dir = offDirOf(dataDir);
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    if (now - statSync(file).mtimeMs > KEPT_MS) rmSync(file, { force: true });
  }
}
