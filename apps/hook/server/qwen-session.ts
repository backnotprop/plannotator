/**
 * Qwen Code session log resolver, for `plannotator last` under Qwen Code.
 *
 * Ported from the NonoElRobot fork of Plannotator (commit c6a02a0,
 * apps/hook/server/qwen-session.ts), with credit. Changed here: messages are
 * read along the active branch of the record tree, so a `/rewind` never
 * offers a reply the person rewound away.
 *
 * Qwen Code records each session at
 *   <runtime base>/projects/<sanitized cwd>/chats/<session id>.jsonl
 * where the runtime base is $QWEN_RUNTIME_DIR, else $QWEN_HOME, else ~/.qwen
 * (Qwen's Storage.getRuntimeBaseDir / getProjectDir). Qwen sets two variables
 * for its shell tool and its hooks that name that file directly:
 *   QWEN_CODE_PROJECT_DIR = <runtime base>/projects/<sanitized cwd>
 *   QWEN_CODE_SESSION_ID  = <session id>
 *
 * Each line is one record: `uuid`, `parentUuid`, `type` ("user" |
 * "assistant" | "tool_result" | "system"), `timestamp`, and for messages
 * `message.parts` (Gemini-style: `{ text, thought? }` or `{ functionCall }`).
 * Records form a tree through `parentUuid`; `/rewind` re-roots the chain, so
 * the active conversation is the chain that ends at the last record.
 * Subagent runs are kept in separate files, so the main log holds only the
 * main conversation.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RenderedMessage } from "./session-log";

/**
 * Qwen's project folder name for a cwd: lowercased on Windows, every
 * character outside [a-zA-Z0-9] replaced with `-` (Qwen's sanitizeCwd).
 */
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

/** The folder holding Qwen's per-project folders: $QWEN_RUNTIME_DIR > $QWEN_HOME > ~/.qwen, then `projects`. */
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

/**
 * The start of every Ask AI Qwen session id (QWEN_ASK_AI_SESSION_PREFIX in
 * packages/ai/providers/qwen-events.ts; qwen-session.test.ts pins the two
 * equal). Those chats are Plannotator's own questions, never the session the
 * person means by "last".
 */
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
      // Gone between readdir and stat.
    }
  }
  return newest;
}

export interface QwenSessionLogOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Test seam: replaces the resolved projects folder. */
  projectsDir?: string;
}

/**
 * The JSONL log of the current Qwen Code session.
 *
 * Prefers the variables Qwen sets (QWEN_CODE_PROJECT_DIR +
 * QWEN_CODE_SESSION_ID), which name the log. When either is missing, or the
 * named log does not exist, falls back to the newest chat of the cwd's
 * project folder (the CLI runs in the session's folder when its shell runs it),
 * leaving out Plannotator's own Ask AI chats.
 */
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

/** The rendered text of an assistant record: its non-thought text parts, or "" when it has none. */
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

/**
 * The records of the active conversation, newest first: the parentUuid chain
 * that ends at the last record. A log whose records carry no uuid (an older
 * format) is read in file order instead. The walk stops at a parent it cannot
 * find or one it has already seen.
 */
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

/**
 * Up to `limit` of the most recent rendered assistant messages in a Qwen
 * session log, newest first, along the active branch.
 *
 * A rendered message is an "assistant" record with at least one non-empty
 * text part that is not a thought. Records holding only tool calls are
 * skipped, as are malformed lines. Each assistant record is one whole model
 * response, so no chunks need joining.
 */
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
      // Malformed line (a write cut short): skip it.
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
