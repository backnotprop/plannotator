/**
 * DeepSeek Harness (DSH) Session Reader
 *
 * Extracts recent rendered assistant messages from a DSH session log for
 * annotate-last. DSH stores each session at
 *   $DSH_HOME/sessions/<project-key>/<encoded-session-id>/session.v<N>.jsonl.zstd
 * (DSH_HOME defaults to ~/.dsh). Older generations are `session.jsonl` /
 * `session.v<N>.jsonl`, with or without `.zstd`; the newest generation is the
 * live one.
 *
 * Detection: DSH sets DSH_SHELL=1, DSH_HOME and DSH_SESSION_ID (the calling
 * agent's session; a subagent's shell gets the subagent's own session) in
 * every shell it spawns. The project key is derived from the session's
 * original cwd, so the session is found by scanning every project directory
 * for the encoded id rather than by recomputing the key.
 *
 * The `.zstd` file is a run of zstd frames, one per append batch; decompressing
 * the whole file yields the JSONL. Line 1 is the session header. Assistant
 * text rows look like:
 *   {"type":"assistant/message","seq":N,"time":MS,"data":{"turn":T,"step":S,
 *    "message":{"id":"...","role":"assistant","content":[{"type":"text","text":"..."}]}}}
 * Only `text` blocks are rendered; reasoning, tool-call, tool-result, image and
 * file blocks are skipped.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RenderedMessage } from "./session-log";

/** DSH_HOME as DSH resolves it: a blank value counts as unset. */
export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const raw = env.DSH_HOME?.trim();
  return raw ? raw : join(homedir(), ".dsh");
}

/**
 * DSH's single-path-segment encoding of a session id (encodeSegment in
 * DSH's session-persistence-jsonl format.ts): `[A-Za-z0-9._-]` stay literal,
 * every other UTF-16 code unit (including `~`) becomes `~XXXX`, and `.` / `..`
 * are escaped whole.
 */
export function encodeDshSegment(raw: string): string {
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    out += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)
      ? ch
      : "~" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

const SESSION_LOG_NAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/;

/** The newest-generation log in one session directory, or null when it has none. */
function newestGenerationLog(sessionDir: string): { path: string; version: number; mtimeMs: number } | null {
  let best: { path: string; version: number; mtimeMs: number } | null = null;
  let names: string[];
  try {
    names = readdirSync(sessionDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const match = SESSION_LOG_NAME.exec(name);
    if (!match) continue;
    const version = match[1] ? Number(match[1]) : 0;
    const path = join(sessionDir, name);
    let mtimeMs: number;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    if (!best || version > best.version || (version === best.version && mtimeMs > best.mtimeMs)) {
      best = { path, version, mtimeMs };
    }
  }
  return best;
}

/**
 * Find the live log of a DSH session by id under `$DSH_HOME/sessions`.
 * Returns null when DSH_HOME has no session directory with that id.
 */
export function findDshSessionLog(
  sessionId: string,
  opts: { dshHome?: string } = {},
): string | null {
  if (!sessionId) return null;
  const sessionsRoot = join(opts.dshHome ?? resolveDshHome(), "sessions");
  const segment = encodeDshSegment(sessionId);
  let projects: string[];
  try {
    projects = readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const project of projects) {
    const log = newestGenerationLog(join(sessionsRoot, project, segment));
    if (log && (!best || log.mtimeMs > best.mtimeMs)) best = log;
  }
  return best?.path ?? null;
}

const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decode one run of whole zstd frames; throws when the run is not one. */
export type DshFrameDecoder = (frames: Uint8Array) => string;

const decodeZstd: DshFrameDecoder = (frames) => Buffer.from(Bun.zstdDecompressSync(frames)).toString("utf-8");

/** Where each frame after the first may start: every later frame magic, in order. */
function laterFrameStarts(bytes: Buffer): number[] {
  const starts: number[] = [];
  for (let at = bytes.indexOf(ZSTD_FRAME_MAGIC, 1); at !== -1; at = bytes.indexOf(ZSTD_FRAME_MAGIC, at + 1)) {
    starts.push(at);
  }
  return starts;
}

/** How many later segments a resync probe joins to find one decodable run. */
const RESYNC_JOINS = 8;

/**
 * Decompress a multi-frame log. DSH appends one zstd frame per write, so the
 * whole file usually decodes at once. When it does not, walk forward one
 * frame at a time:
 * - a run that fails is joined with the next one (a magic number inside
 *   compressed data split a frame), unless a decodable run starts where it
 *   ends: then it is a damaged frame, skipped, and the scan resyncs there.
 *   That run may itself hold a stray magic, so it may join up to
 *   RESYNC_JOINS more segments; every newer frame is kept;
 * - the last run may also end in a frame being written (a read racing an
 *   append) or a 1-3 byte partial magic: the cut tail is tried, else dropped.
 * Cost: where frames decode, each byte is decoded about twice (the whole-file
 * attempt, then its own frame). Around a damaged or split frame, each failed
 * run adds up to RESYNC_JOINS probes, and a failing decode stops at the first
 * bad block, so damage costs a few extra decodes per segment, not a decode of
 * the whole prefix per frame as a backward retry would.
 * Throws when nothing decodes. Exported for tests (`decode` counts calls).
 */
export function decompressDshLog(bytes: Buffer, decode: DshFrameDecoder = decodeZstd): string {
  let lastError: unknown;
  const tryDecode = (from: number, to: number): string | undefined => {
    try {
      return decode(bytes.subarray(from, to));
    } catch (error) {
      lastError = error;
      return undefined;
    }
  };

  const whole = tryDecode(0, bytes.length);
  if (whole !== undefined) return whole;

  // One run of frames; the run that ends the file may also end in a frame
  // being written or a 1-3 byte partial magic, so its cut tails are tried.
  const decodeRun = (start: number, end: number): string | undefined => {
    let text = tryDecode(start, end);
    if (text === undefined && end === bytes.length) {
      for (let cut = 1; cut <= 3 && end - cut > start && text === undefined; cut++) text = tryDecode(start, end - cut);
    }
    return text;
  };

  const ends = [...laterFrameStarts(bytes), bytes.length];
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < ends.length; i++) {
    const to = ends[i];
    const text = decodeRun(from, to);
    if (text !== undefined) {
      parts.push(text);
      from = to;
      continue;
    }
    for (let j = i + 1; j < ends.length && j <= i + RESYNC_JOINS; j++) {
      if (decodeRun(to, ends[j]) !== undefined) {
        from = to;
        break;
      }
    }
  }
  if (parts.length === 0) throw lastError;
  return parts.join("");
}

/**
 * The log as JSONL text. A `.zstd` log is read whole and decompressed; one
 * retry covers a read that fails outright.
 */
function readDshSessionText(logPath: string): string | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const bytes = readFileSync(logPath);
      return logPath.endsWith(".zstd") ? decompressDshLog(bytes) : bytes.toString("utf-8");
    } catch {
      if (attempt === 0) Bun.sleepSync(100);
    }
  }
  return null;
}

interface DshContentBlock {
  type?: string;
  text?: unknown;
}

interface DshSessionRow {
  type?: string;
  time?: unknown;
  data?: {
    message?: {
      id?: unknown;
      role?: unknown;
      content?: unknown;
    };
  };
}

/** A row's epoch-millisecond `time` as ISO 8601, when it is one. */
function isoTime(value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * Extract up to `limit` recent rendered assistant messages from a DSH session
 * log, newest-first. A message's text blocks are joined with newlines; a
 * message with no text (tool calls or reasoning only) is skipped.
 */
export function getRecentDshMessages(
  logPath: string,
  limit: number,
): RenderedMessage[] {
  if (limit <= 0) return [];
  const text = readDshSessionText(logPath);
  if (text === null) return [];
  const lines = text.split("\n");

  const messages: RenderedMessage[] = [];
  const seen = new Set<string>();
  for (let i = lines.length - 1; i >= 0 && messages.length < limit; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let row: DshSessionRow;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.type !== "assistant/message") continue;
    const message = row.data?.message;
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) continue;
    const texts = (message.content as DshContentBlock[])
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text as string)
      .filter((blockText) => blockText.trim());
    if (texts.length === 0) continue;
    const messageId = typeof message.id === "string" && message.id ? message.id : `dsh-msg-${i + 1}`;
    if (seen.has(messageId)) continue;
    seen.add(messageId);
    const timestamp = isoTime(row.time);
    messages.push({
      messageId,
      text: texts.join("\n"),
      lineNumbers: [i + 1],
      ...(timestamp && { timestamp }),
    });
  }
  return messages;
}
