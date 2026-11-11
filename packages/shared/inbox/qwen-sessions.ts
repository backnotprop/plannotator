/** Qwen Code's session registry, read only: `$QWEN_HOME/sessions/<pid>.json` (or `<pid>-<8 hex>.json`), written by Qwen. Read on every call because `/clear` and `/resume` give the session a new id under the same process. Never written or deleted here. */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseQwenSessionRecord, qwenRecordFilePid, type InboxQwenSessionRecord } from "@plannotator/core/inbox-types";

/** A record is a few hundred bytes; anything far larger is not one. */
const RECORD_MAX_BYTES = 64 * 1024;

/** A `.env` file is a few lines; anything far larger is not read. */
const DOTENV_MAX_BYTES = 256 * 1024;

/** dotenv's line rule (the `dotenv` package Qwen uses): `[export ]KEY=value`, quoted or bare, `#` comments. */
const DOTENV_LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/gm;

export function dotenvValue(path: string, key: string): string | undefined {
  let text: string;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > DOTENV_MAX_BYTES) return undefined;
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const match of text.replace(/\r\n?/gm, "\n").matchAll(DOTENV_LINE)) {
    if (match[1] !== key) continue;
    let value = (match[2] ?? "").trim();
    const quote = value[0];
    value = value.replace(/^(['"`])([\s\S]*)\1$/gm, "$2");
    if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    found = value;
  }
  return found;
}

/** `QWEN_HOME` as a Qwen process sees it: the environment variable (even empty), else the first of `~/.qwen/.env` and `~/.env` that sets it. Not trimmed, as Qwen does not trim it. */
export function qwenHomeSetting(env: Readonly<Record<string, string | undefined>>, homeDir: string): string | null {
  if (Object.hasOwn(env, "QWEN_HOME") && env.QWEN_HOME !== undefined) return env.QWEN_HOME || null;
  for (const file of [join(homeDir, ".qwen", ".env"), join(homeDir, ".env")]) {
    const value = dotenvValue(file, "QWEN_HOME");
    if (value) return value;
  }
  return null;
}

function expandQwenHome(value: string, homeDir: string): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homeDir, ...(value === "~" ? [] : value.slice(2).split(/[/\\]+/).filter(Boolean)));
  }
  return value;
}

export function qwenHomeIsRelative(env: Readonly<Record<string, string | undefined>>, homeDir: string): boolean {
  const value = qwenHomeSetting(env, homeDir);
  return value !== null && !isAbsolute(expandQwenHome(value, homeDir));
}

/** Qwen's home as Qwen resolves it: `QWEN_HOME` IS the folder (not a parent of `.qwen`), `~` expanded, a relative one resolved against `cwd`; else `~/.qwen`. */
export function qwenHome(env: Readonly<Record<string, string | undefined>>, homeDir: string, cwd: string): string {
  const value = qwenHomeSetting(env, homeDir);
  if (value === null) return join(homeDir, ".qwen");
  const expanded = expandQwenHome(value, homeDir);
  return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

export function qwenSessionsDir(home: string): string {
  return join(home, "sessions");
}

export function readQwenSessionRecord(path: string, file: { pid: number; shared: boolean }): InboxQwenSessionRecord | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return null;
    return parseQwenSessionRecord(JSON.parse(readFileSync(path, "utf8")) as unknown, file);
  } catch {
    return null;
  }
}

export function listQwenSessionRecords(home: string): InboxQwenSessionRecord[] {
  const dir = qwenSessionsDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: InboxQwenSessionRecord[] = [];
  for (const name of names) {
    const file = qwenRecordFilePid(name);
    if (!file) continue;
    const record = readQwenSessionRecord(join(dir, name), file);
    if (record) records.push(record);
  }
  return records;
}

/** Null when the process has none or several: only the call itself can say which. */
export function qwenSessionOfProcess(home: string, pid: number): InboxQwenSessionRecord | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const dir = qwenSessionsDir(home);
  const bare = readQwenSessionRecord(join(dir, `${pid}.json`), { pid, shared: false });
  if (bare) return bare;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const mine = names.filter((name) => name.startsWith(`${pid}-`)).flatMap((name) => {
    const file = qwenRecordFilePid(name);
    const record = file && file.pid === pid ? readQwenSessionRecord(join(dir, name), file) : null;
    return record ? [record] : [];
  });
  return mine.length === 1 ? mine[0]! : null;
}
