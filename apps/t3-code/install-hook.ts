import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseT3HookCommand, t3HookCommand } from "@plannotator/shared/t3-hook-command";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readSettings(file: string): { settings: Record<string, unknown>; original?: string; mode: number } {
  if (!existsSync(file)) return { settings: {}, mode: 0o600 };
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Claude settings must be a regular JSON file: ${file}`);
  const original = readFileSync(file, "utf8");
  const settings = record(JSON.parse(original) as unknown);
  if (!settings) throw new Error(`Claude settings must contain a JSON object: ${file}`);
  return { settings, original, mode: stat.mode & 0o777 };
}

function ownedHook(value: unknown): boolean {
  const hook = record(value);
  return hook?.type === "command" && typeof hook.command === "string" && parseT3HookCommand(hook.command) !== undefined;
}

export function configureT3Hook(file: string, executable: string, dataDir: string, enabled: boolean): boolean {
  const { settings, original, mode } = readSettings(file);
  const hooks = settings.hooks === undefined ? {} : record(settings.hooks);
  if (!hooks) throw new Error("Claude hooks must be an object; existing settings were preserved.");
  const entries = hooks.PreToolUse === undefined ? [] : hooks.PreToolUse;
  if (!Array.isArray(entries)) throw new Error("Claude PreToolUse hooks must be an array; existing settings were preserved.");
  let removed = false;
  const nextEntries: unknown[] = [];
  for (const value of entries) {
    const entry = record(value);
    if (entry?.matcher !== "Bash") { nextEntries.push(value); continue; }
    if (!Array.isArray(entry.hooks)) throw new Error("Claude Bash hooks must be an array; existing settings were preserved.");
    const retained = entry.hooks.filter((hook) => !ownedHook(hook));
    if (retained.length === entry.hooks.length) { nextEntries.push(value); continue; }
    removed = true;
    const hasCustomFields = Object.keys(entry).some((key) => key !== "matcher" && key !== "hooks");
    if (retained.length || hasCustomFields) nextEntries.push({ ...entry, hooks: retained });
  }
  if (!enabled && !removed) return false;
  if (enabled) nextEntries.push({ matcher: "Bash", hooks: [{ type: "command", command: t3HookCommand(resolve(executable), resolve(dataDir)), timeout: 10 }] });
  if (nextEntries.length) hooks.PreToolUse = nextEntries;
  else delete hooks.PreToolUse;
  if (Object.keys(hooks).length) settings.hooks = hooks;
  else delete settings.hooks;
  const next = JSON.stringify(settings, null, 2) + "\n";
  if (next === original) return false;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (original !== undefined) {
    try { writeFileSync(file + ".plannotator-t3.bak", original, { flag: "wx", mode: 0o600 }); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error; }
  }
  const temporary = file + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, next, { flag: "wx", mode });
    const current = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (current !== original) throw new Error("Claude settings changed during installation; retry without overwriting them.");
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
  return true;
}

export function hasPlanHookOverlap(file: string): boolean {
  const { settings } = readSettings(file);
  const hooks = record(settings.hooks);
  if (!hooks) return false;
  for (const [event, matcher] of [["PermissionRequest", "ExitPlanMode"], ["PreToolUse", "EnterPlanMode"]]) {
    const entries = hooks[event!];
    if (!Array.isArray(entries)) continue;
    for (const value of entries) {
      const entry = record(value);
      if (entry?.matcher !== matcher || !Array.isArray(entry.hooks)) continue;
      if (entry.hooks.some((value) => {
        const hook = record(value);
        return hook?.type === "command" && typeof hook.command === "string" && /\bplannotator(?:\.exe)?\b/.test(hook.command);
      })) return true;
    }
  }
  return false;
}
