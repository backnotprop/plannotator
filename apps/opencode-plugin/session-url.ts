/**
 * Session URL registry — a JSONL file under the Plannotator data dir.
 * Each line is a JSON object: {"url":"http://...","sid":"<session_id>"}.
 *
 * The server plugin writes a line when a session is ready and removes it
 * when the session ends. The TUI plugin polls this file and filters by
 * the current opencode session_id to show only its own URL.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

const FILENAME = "opencode-session-url";

interface SessionEntry {
  url: string;
  sid?: string;
}

function getPath(): string {
  return join(getPlannotatorDataDir(), FILENAME);
}

export function writeSessionUrl(url: string, sid?: string): void {
  try {
    const file = getPath();
    mkdirSync(dirname(file), { recursive: true });
    const entries = readEntries(file);
    // Replace any existing entry with the same URL (update sid)
    const filtered = entries.filter(e => e.url !== url);
    writeFileSync(
      file,
      [...filtered, { url, sid }].map(e => JSON.stringify(e)).join("\n") + "\n",
      { encoding: "utf8" },
    );
  } catch {
    // best-effort — the sidebar is cosmetic
  }
}

export function clearSessionUrl(url?: string): void {
  if (!url) return;
  try {
    const file = getPath();
    if (!existsSync(file)) return;
    const remaining = readEntries(file).filter(e => e.url !== url);
    if (remaining.length > 0) {
      writeFileSync(file, remaining.map(e => JSON.stringify(e)).join("\n") + "\n", { encoding: "utf8" });
    } else {
      rmSync(file, { force: true });
    }
  } catch {
    // best-effort
  }
}

export function readSessionUrl(sid?: string): string {
  try {
    const entries = readEntries(getPath());
    // Filter by session_id when provided (multi-instance), else return all
    const matching = sid
      ? entries.filter(e => e.sid === sid)
      : entries;
    return matching.map(e => e.url).join("\n");
  } catch {
    return "";
  }
}

/** Parse the file as JSONL (one JSON object per line). */
function readEntries(file: string): SessionEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      try { return JSON.parse(l) as SessionEntry; } catch { return null; }
    })
    .filter((e): e is SessionEntry => e !== null);
}
