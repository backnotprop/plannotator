/**
 * Host messages side channel for `annotate-last --stdin`.
 *
 * A host that starts the CLI detached (the Claude Code mod in
 * `apps/hook/hooks/mod/`) has no transcript file for the CLI to read, so it
 * hands the newest assistant text over on stdin. That alone loses the message
 * picker the classic path offers. When the host also sets
 * `PLANNOTATOR_HOST_MESSAGES_FILE` to a `messages.json` it wrote, the CLI
 * reads the recent assistant messages from it instead:
 *
 *   { "v": 1, "messages": [{ "messageId": "…", "text": "…", "timestamp"?: "…" }] }
 *
 * newest first, index 0 opened by default. Why a variable and not a new flag:
 * a CLI that predates this ignores the variable and still reads the newest
 * text from stdin (today's behavior), while an unknown flag would either be
 * ignored silently (a different code path) or read the JSON as the message.
 *
 * The variable is taken once at startup and removed from `process.env`, like
 * the host result file, so nothing the server spawns inherits it.
 */

import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, resolve, sep } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

export const HOST_MESSAGES_FILE_ENV = "PLANNOTATOR_HOST_MESSAGES_FILE";

/** The picker's own limit on the classic path (RECENT_MESSAGES_LIMIT). */
export const MAX_HOST_MESSAGES = 25;
/** Per message, in UTF-8 bytes. */
export const MAX_HOST_MESSAGE_BYTES = 2 * 1024 * 1024;
/** The whole file, in bytes. */
export const MAX_HOST_MESSAGES_FILE_BYTES = 8 * 1024 * 1024;
const MAX_ID_LENGTH = 128;
const MAX_TIMESTAMP_LENGTH = 64;

export interface HostMessage {
  messageId: string;
  text: string;
  timestamp?: string;
}

let takenPath: string | undefined;
let taken = false;

/** Only a `messages.json` inside the mod's launch area of the data dir is read. */
export function isAllowedHostMessagesPath(path: string, dataDir: string = getPlannotatorDataDir()): boolean {
  if (!isAbsolute(path) || basename(path) !== "messages.json") return false;
  const root = resolve(dataDir, "claude-code-mod") + sep;
  return resolve(path).startsWith(root);
}

/** Read the side-channel path once and scrub it from the environment. */
export function takeHostMessagesPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!taken) {
    taken = true;
    const value = env[HOST_MESSAGES_FILE_ENV];
    delete env[HOST_MESSAGES_FILE_ENV];
    const path = value && value.trim() ? value : undefined;
    if (path && !isAllowedHostMessagesPath(path)) {
      console.error(`Plannotator: ignoring ${HOST_MESSAGES_FILE_ENV}: not a messages.json under the data dir's claude-code-mod/ folder.`);
      takenPath = undefined;
    } else {
      takenPath = path;
    }
  }
  return takenPath;
}

export type HostMessagesParse = { ok: true; messages: HostMessage[] } | { ok: false; error: string };

function fail(error: string): HostMessagesParse {
  return { ok: false, error: `invalid host messages: ${error}` };
}

/**
 * Validate the payload fail-closed: version 1, 1..25 messages, string fields
 * only, bounded sizes, non-empty text, unique ids. Error text never quotes the
 * payload.
 */
export function parseHostMessages(text: string): HostMessagesParse {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("expected an object");
  const record = value as Record<string, unknown>;
  if (record.v !== 1) return fail("unsupported version");
  const list = record.messages;
  if (!Array.isArray(list)) return fail("messages must be an array");
  if (list.length === 0) return fail("no messages");
  if (list.length > MAX_HOST_MESSAGES) return fail(`more than ${MAX_HOST_MESSAGES} messages`);
  const seen = new Set<string>();
  const messages: HostMessage[] = [];
  for (const [index, item] of list.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail(`message ${index} is not an object`);
    const entry = item as Record<string, unknown>;
    const { messageId, text: body, timestamp } = entry;
    if (typeof messageId !== "string" || !messageId || messageId.length > MAX_ID_LENGTH) {
      return fail(`message ${index} has no valid messageId`);
    }
    if (seen.has(messageId)) return fail(`duplicate messageId at ${index}`);
    seen.add(messageId);
    if (typeof body !== "string" || !body.trim()) return fail(`message ${index} has no text`);
    if (Buffer.byteLength(body, "utf8") > MAX_HOST_MESSAGE_BYTES) return fail(`message ${index} is too large`);
    if (timestamp !== undefined && (typeof timestamp !== "string" || timestamp.length > MAX_TIMESTAMP_LENGTH)) {
      return fail(`message ${index} has an invalid timestamp`);
    }
    messages.push({ messageId, text: body, ...(timestamp ? { timestamp } : {}) });
  }
  return { ok: true, messages };
}

/** Read and validate the file the host wrote. */
export function readHostMessages(path: string): HostMessagesParse {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return fail("not a regular file");
    size = stat.size;
  } catch {
    return fail("file not found");
  }
  if (size > MAX_HOST_MESSAGES_FILE_BYTES) return fail("file is too large");
  try {
    return parseHostMessages(readFileSync(path, "utf8"));
  } catch {
    return fail("file could not be read");
  }
}
