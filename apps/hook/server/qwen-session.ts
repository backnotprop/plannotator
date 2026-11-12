import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RenderedMessage } from "./session-log";

export function sanitizeQwenCwd(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const normalized = platform === "win32" ? cwd.toLowerCase() : cwd;
  return normalized.replace(/[^a-zA-Z0-9]/g, "-");
}

function expandHome(p: string | undefined, home: string): string | undefined {
  const trimmed = p?.trim();
  if (!trimmed) return undefined;
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(home, trimmed.slice(2));
  }
  return trimmed;
}

export function getQwenProjectsDir(opts: { env?: NodeJS.ProcessEnv; home?: string } = {}): string {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const base = expandHome(env.QWEN_RUNTIME_DIR, home) ?? expandHome(env.QWEN_HOME, home);
  return join(base ?? join(home, ".qwen"), "projects");
}

function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value !== "." &&
    value !== ".."
  );
}

function isReadableFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export const QWEN_ASK_AI_CHAT_PREFIX = "a5ca1000";

function newestChatLog(chatsDir: string): string | null {
  let files: string[];
  try {
    files = readdirSync(chatsDir).filter((f) => f.endsWith(".jsonl") && !f.startsWith(QWEN_ASK_AI_CHAT_PREFIX));
  } catch {
    return null;
  }
  let newest: string | null = null;
  let newestMtime = -1;
  for (const f of files) {
    const full = join(chatsDir, f);
    try {
      const stat = statSync(full);
      if (stat.isFile() && stat.mtimeMs > newestMtime) {
        newestMtime = stat.mtimeMs;
        newest = full;
      }
    } catch {
    }
  }
  return newest;
}

export interface QwenSessionLogOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  projectsDir?: string;
}

export function findQwenSessionLog(opts: QwenSessionLogOptions = {}): string | null {
  const env = opts.env ?? process.env;

  const projectDir = env.QWEN_CODE_PROJECT_DIR?.trim();
  const sessionId = env.QWEN_CODE_SESSION_ID?.trim();
  if (projectDir && sessionId && isSafePathSegment(sessionId)) {
    const candidate = join(projectDir, "chats", `${sessionId}.jsonl`);
    if (isReadableFile(candidate)) return candidate;
  }

  const cwd = opts.cwd ?? process.cwd();
  const chatsDir = join(opts.projectsDir ?? getQwenProjectsDir({ env }), sanitizeQwenCwd(cwd), "chats");
  return newestChatLog(chatsDir);
}

interface QwenLogRecord {
  uuid?: unknown;
  parentUuid?: unknown;
  type?: unknown;
  timestamp?: unknown;
  message?: { parts?: unknown };
}

interface ParsedRecord {
  record: QwenLogRecord;
  lineNumber: number;
}

function assistantText(record: QwenLogRecord): string {
  if (record.type !== "assistant") return "";
  const parts = record.message?.parts;
  if (!Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const part = p as { text?: unknown; thought?: unknown };
    if (part.thought) continue;
    if (typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
  }
  return texts.join("\n");
}

function activeBranch(records: ParsedRecord[]): ParsedRecord[] {
  const byUuid = new Map<string, ParsedRecord>();
  let tail: ParsedRecord | undefined;
  for (const entry of records) {
    const uuid = entry.record.uuid;
    if (typeof uuid === "string" && uuid) {
      byUuid.set(uuid, entry);
      tail = entry;
    }
  }
  if (!tail) return [...records].reverse();

  const chain: ParsedRecord[] = [];
  const seen = new Set<string>();
  let current: ParsedRecord | undefined = tail;
  while (current) {
    const uuid = current.record.uuid as string;
    if (seen.has(uuid)) break;
    seen.add(uuid);
    chain.push(current);
    const parent: unknown = current.record.parentUuid;
    current = typeof parent === "string" && parent ? byUuid.get(parent) : undefined;
  }
  return chain;
}

export function getRecentQwenMessages(logPath: string, limit: number): RenderedMessage[] {
  if (limit <= 0) return [];
  let lines: string[];
  try {
    lines = readFileSync(logPath, "utf-8").split("\n");
  } catch {
    return [];
  }

  const records: ParsedRecord[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const record = JSON.parse(line) as unknown;
      if (record && typeof record === "object") records.push({ record: record as QwenLogRecord, lineNumber: i + 1 });
    } catch {
    }
  }

  const out: RenderedMessage[] = [];
  for (const { record, lineNumber } of activeBranch(records)) {
    if (out.length >= limit) break;
    const text = assistantText(record);
    if (!text) continue;
    out.push({
      messageId: typeof record.uuid === "string" && record.uuid ? record.uuid : `qwen-line-${lineNumber}`,
      text,
      lineNumbers: [lineNumber],
      timestamp: typeof record.timestamp === "string" ? record.timestamp : undefined,
    });
  }
  return out;
}
