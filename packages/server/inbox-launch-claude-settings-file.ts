/**
 * Settings → Agents' "Claude settings file" (config.json `inboxLaunch.settingsFile`; issue #3064): a Claude Code
 * settings file of the person's, such as the profile a wrapper applies for a company gateway (`apiKeyHelper`,
 * `env.ANTHROPIC_BASE_URL`). Every Claude Code session the Inbox starts gets its keys: they are merged into the
 * per-launch settings file the Inbox already writes (`launch/<id>/settings.json`, 0600 in a 0700 folder, removed by
 * Delete), with the Inbox's own keys on top. Never a second `--settings` (Claude Code doesn't say whether two
 * combine), and never the shell: a background session gets its env from the settings file, not from whoever ran
 * `claude` (docs/agent-guides/inbox-launch.md "Claude settings file").
 *
 * The file may hold secrets. Its contents are never logged, never sent to a window or an agent, and never copied
 * anywhere but that per-launch file. Words about it name the path only.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Larger than any settings file; a path to something else (a log) is refused, not read. */
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;

/**
 * Where the setting points: `~` and `~/…` are the person's home; a relative path is taken from home too (a hand edit:
 * Settings refuses one); an absolute path as it is.
 */
export function claudeSettingsFilePath(typed: string, homeDir: string): string {
  if (typed === "~") return homeDir;
  if (typed.startsWith("~/")) return join(homeDir, typed.slice(2));
  return isAbsolute(typed) ? typed : join(homeDir, typed);
}

export type ClaudeSettingsFileRead = { ok: true; settings: Record<string, unknown> } | { ok: false; text: string };

/**
 * The file's settings, or why not in the person's words (the run line's failure, Settings' refusal). `shown`: the path
 * as the person reads it (`~/…`). Read at each start, so a fixed file works on the next Try again.
 */
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

/**
 * The person's settings under the Inbox's: every key of theirs stays unless the Inbox sets it. `env` merges name by
 * name (the Inbox's names win: its launch id, key and PATH); `permissions` merges key by key with both `allow` lists
 * kept; `hooks` keeps both, theirs first, event by event. A key of theirs with the wrong shape (an `env` that is not
 * an object) gives way to the Inbox's.
 */
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

/**
 * Whether the file signs Claude Code in by itself (a key helper, a token, a gateway, a cloud provider): then a signed
 * out `claude auth status`, which runs without the file, does not stop a launch. Key names only, never values.
 */
export function claudeSettingsSignIn(settings: Record<string, unknown>): boolean {
  if (typeof settings.apiKeyHelper === "string" && settings.apiKeyHelper.trim()) return true;
  const env = isRecord(settings.env) ? settings.env : {};
  return ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
    (name) => typeof env[name] === "string" && (env[name] as string).trim() !== "",
  );
}
