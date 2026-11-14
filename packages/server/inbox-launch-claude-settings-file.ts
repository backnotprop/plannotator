/**
 * The file may hold secrets: its contents are never logged or sent to a window or an agent, only copied into the
 * per-launch settings file. Never a second `--settings`: Claude Code doesn't say whether two combine.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Larger than any settings file; a path to something else (a log) is refused, not read. */
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

export function claudeSettingsFilePath(typed: string, homeDir: string): string {
  if (typed === "~") return homeDir;
  if (typed.startsWith("~/")) return join(homeDir, typed.slice(2));
  return isAbsolute(typed) ? typed : join(homeDir, typed);
}

export type ClaudeSettingsFileRead = { ok: true; settings: Record<string, unknown> } | { ok: false; text: string };

/** Read at each start, so a fixed file works on the next Try again. */
export function readClaudeSettingsFile(path: string, shown: string): ClaudeSettingsFileRead {
  const fix = "Fix it in Settings → Agents, or clear it there.";
  let text: string;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > SETTINGS_FILE_MAX_BYTES) return { ok: false, text: `Your Claude settings file ${shown} isn't a settings file. ${fix}` };
    text = readFileSync(path, "utf8");
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR";
    return { ok: false, text: missing ? `Your Claude settings file ${shown} isn't there. ${fix}` : `Can't read your Claude settings file ${shown}. ${fix}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, text: `Your Claude settings file ${shown} isn't valid JSON. ${fix}` };
  }
  if (!isRecord(parsed)) return { ok: false, text: `Your Claude settings file ${shown} isn't valid JSON. ${fix}` };
  return { ok: true, settings: parsed };
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The Inbox's keys win (its launch id, key and PATH must reach the session); both sides' allows and hooks are kept. */
export function mergeClaudeLaunchSettings(person: Record<string, unknown>, ours: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...person, ...ours };
  const theirs = (key: string) => (isRecord(person[key]) ? (person[key] as Record<string, unknown>) : {});
  const own = (key: string) => (isRecord(ours[key]) ? (ours[key] as Record<string, unknown>) : {});
  if ("env" in ours) merged.env = { ...theirs("env"), ...own("env") };
  if ("permissions" in ours) {
    const list = (from: Record<string, unknown>) => (Array.isArray(from.allow) ? (from.allow as unknown[]) : []);
    const allow = [...new Set([...list(theirs("permissions")), ...list(own("permissions"))])];
    merged.permissions = { ...theirs("permissions"), ...own("permissions"), allow };
  }
  if ("hooks" in ours) {
    const hooks: Record<string, unknown> = { ...theirs("hooks") };
    for (const [event, entries] of Object.entries(own("hooks"))) {
      const before = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
      hooks[event] = [...before, ...(Array.isArray(entries) ? entries : [])];
    }
    merged.hooks = hooks;
  }
  return merged;
}

/** `claude auth status` runs without the file, so a gateway-only person reads as signed out there. */
export function claudeSettingsSignIn(settings: Record<string, unknown>): boolean {
  if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim()) return true;
  const env = isRecord(settings.env) ? settings.env : {};
  return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
    (name) => typeof env[name] === "string" && (env[name] as string).trim() !== "",
  );
}
