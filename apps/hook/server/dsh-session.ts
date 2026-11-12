import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { RenderedMessage } from "./session-log";

export function resolveDshHome(env: Record<string, string | undefined> = process.env): string {
  const raw = env.DSH_HOME?.trim();
  return raw ? raw : join(homedir(), ".dsh");
}

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

export type DshFrameDecoder = (frames: Uint8Array) => string;

const decodeZstd: DshFrameDecoder = (frames) => Buffer.from(Bun.zstdDecompressSync(frames)).toString("utf-8");

function laterFrameStarts(bytes: Buffer): number[] {
  const starts: number[] = [];
  for (let at = bytes.indexOf(ZSTD_FRAME_MAGIC, 1); at !== -1; at = bytes.indexOf(ZSTD_FRAME_MAGIC, at + 1)) {
    starts.push(at);
  }
  return starts;
}

const RESYNC_JOINS = 8;

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

function isoTime(value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

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
