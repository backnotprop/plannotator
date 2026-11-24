/**
 * The files of a thread for a paired cloud agent (the agent door, contract
 * section 13 point 6). A local agent opens a file of a message by the path
 * read_thread gives; a cloud agent has that path too, and runs on another
 * machine, so through the door read_thread lists each file with its path on
 * the person's computer and the command that fetches its bytes, and
 * `fetch_file { message_id, file, offset }` answers them one piece at a time
 * (`plannotator inbox call fetch_file` loops the pieces and saves it).
 *
 * What it serves:
 *  - the message must be one read_thread shows this agent: in the thread the
 *    store gives it (`InboxStore.agentThread`, the read windowedThread makes);
 *  - the file is one of that message's: an attached file or a picture its body
 *    shows (`attachments`, `inline_images`, by their `att_` id, their path as
 *    read_thread lists it, or their name when only one has it), or a drawing
 *    the person made on an image, named in their own message's words by its
 *    place in the Inbox's markups folder (`<sha256>.png`);
 *  - the bytes are the Inbox's own copy: the sent blob (`inbox/blobs/<sha256>`,
 *    opened as the browser's `?version=sent` download opens it, no symlink
 *    followed) or the drawing (`inbox/markups/<name>`, the same);
 *  - a dotenv name, and a file past 100 MB (an upload's cap), are refused.
 */

import { constants, lstatSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { join, sep } from "node:path";
import { isDotenvFileName } from "@plannotator/core/annotatable";
import { INBOX_UPLOAD_MAX_BYTES, isInboxTextKind, type InboxAttachment, type InboxMessageWire } from "@plannotator/core/inbox-types";
import { INBOX_AGENT_FETCH_FILE } from "@plannotator/shared/inbox/agent-pairing";
import { openInboxAttachmentVersion } from "@plannotator/shared/inbox/attachments";
import { inboxMarkupsDir, isInboxMarkupName } from "@plannotator/shared/inbox/markups";
import { inboxOwnSecretRefusal } from "@plannotator/shared/inbox/own-secrets";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { ok, type ToolResult } from "./inbox-mcp-result";

/**
 * One piece's bytes. Through the relay an answer of n bytes is a frame of
 * about 16n/9 under Cloudflare's 32 MiB (inbox-relay.ts), and the JSON
 * carries the piece as base64: 1 MiB is a frame of about 2.4 MiB, which the
 * agent's 10 s read of the relay takes at 2 Mbit/s (4 MiB, about 9.5 MiB,
 * needed 8 Mbit/s, and a piece missed in that window was left at the relay).
 * A 100 MB file is 100 calls, each well under a second on a fast link.
 */
export const INBOX_AGENT_FETCH_PIECE_BYTES = 1024 * 1024;

const FIELDS = ["message_id", "file", "offset"] as const;
/** What fetch_file takes, for a far message's pieces too (inbox-agent-door.ts). */
export const inboxAgentFetchFields: readonly string[] = FIELDS;
const MB = 1024 * 1024;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const DRAWING_NAME = /^[0-9a-f]{64}\.(?:png|jpg|webp)/;
const DRAWING_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

/** A file of a message as a cloud agent reads it: what to pass as `file`, its path on the person's computer, and the command that saves it. */
export interface AgentFile {
  file: string;
  name: string;
  kind: string;
  size: number;
  path: string;
  fetch: string;
}

type Source = { record: InboxAttachment } | { drawing: string };

const refuse = (code: string, message: string) => new InboxError(code, message);

/** The drawings a person's message names in its words (`<markups>/<sha256>.png`), by file name, in order, once each. */
export function inboxDrawingsNamed(inboxDirPath: string, message: Pick<InboxMessageWire, "author" | "body">): string[] {
  if (message.author.kind !== "person" || typeof message.body !== "string") return [];
  const prefix = `${inboxMarkupsDir(inboxDirPath)}${sep}`;
  const names: string[] = [];
  for (let at = message.body.indexOf(prefix); at >= 0; at = message.body.indexOf(prefix, at + prefix.length)) {
    const name = DRAWING_NAME.exec(message.body.slice(at + prefix.length, at + prefix.length + 69))?.[0];
    if (name && isInboxMarkupName(name) && !names.includes(name)) names.push(name);
  }
  return names;
}

function sourcesOf(inboxDirPath: string, message: InboxMessageWire): (Omit<AgentFile, "fetch"> & { source: Source })[] {
  const records = [...(message.attachments ?? []), ...(message.inline_images ?? [])].map((record) => ({ file: record.id, name: record.name, kind: record.kind, size: record.size, path: record.path, source: { record } }));
  const drawings = inboxDrawingsNamed(inboxDirPath, message).flatMap((name) => {
    const path = join(inboxMarkupsDir(inboxDirPath), name);
    try {
      const stat = lstatSync(path);
      return stat.isFile() ? [{ file: name, name, kind: "image", size: stat.size, path, source: { drawing: name } }] : [];
    } catch {
      return [];
    }
  });
  return [...records, ...drawings];
}

/** The command that saves one file of a message on the agent's machine. */
export function inboxAgentFetchCommand(messageId: string, file: string): string {
  return `plannotator inbox call ${INBOX_AGENT_FETCH_FILE} '${JSON.stringify({ message_id: messageId, file })}'`;
}

/** A message's files as read_thread lists them through the door: attached files, the pictures its body shows, the person's drawings. */
export function inboxAgentFilesOf(inboxDirPath: string, message: InboxMessageWire): AgentFile[] {
  return sourcesOf(inboxDirPath, message).map(({ source: _source, ...file }) => ({ ...file, fetch: inboxAgentFetchCommand(message.id, file.file) }));
}

async function openSource(inboxDirPath: string, source: Source): Promise<{ handle: FileHandle; size: number; sha256: string; contentType: string }> {
  if ("record" in source) {
    const record = source.record;
    const opened = await openInboxAttachmentVersion(inboxDirPath, record, "sent");
    if (!opened.ok) throw refuse(opened.code, opened.message);
    const contentType = record.media_type ?? (isInboxTextKind(record.kind) ? "text/plain; charset=utf-8" : "application/octet-stream");
    return { handle: opened.handle, size: opened.size, sha256: record.sent_sha256, contentType };
  }
  const name = source.drawing;
  let handle: FileHandle;
  try {
    handle = await open(join(inboxMarkupsDir(inboxDirPath), name), OPEN_FLAGS);
  } catch {
    throw refuse("attachment_missing", `The drawing ${name} is gone.`);
  }
  const stat = await handle.stat().catch(() => null);
  if (!stat?.isFile()) {
    await handle.close().catch(() => {});
    throw refuse("attachment_missing", `The drawing ${name} could not be read.`);
  }
  return { handle, size: stat.size, sha256: name.slice(0, 64), contentType: DRAWING_TYPES[name.slice(65)] ?? "application/octet-stream" };
}

/** A file of a message, found and opened for an agent: what it is, and its bytes' handle (the caller closes it). */
export interface OpenedAgentFile {
  file: string;
  name: string;
  kind: string;
  handle: FileHandle;
  size: number;
  sha256: string;
  contentType: string;
}

/**
 * One file of a message read_thread shows `session` (null: a linked machine's agent, which reads as a guest), opened
 * after the refusals: no such message or file, a dotenv name, the Inbox's own keys (own-secrets.ts), past 100 MB.
 * `whose`: who is fetching, for the size refusal's words.
 */
export async function openInboxAgentFile(store: InboxStore, session: string | null, args: Record<string, unknown>, whose = "a cloud agent"): Promise<OpenedAgentFile> {
  const messageId = typeof args.message_id === "string" ? args.message_id.trim() : "";
  if (!messageId) throw refuse("validation_error", "message_id: the id of the message the file is on, as read_thread shows it.");
  const stored = store.message(messageId);
  // read_thread's own reach: the thread as the store gives it to this agent (windowedThread), with this message in it.
  const message = stored ? store.agentThread(stored.thread_id, session)?.messages.find((m) => m.id === messageId) : undefined;
  if (!message) throw refuse("message_not_found", `No message ${messageId}.`);

  const wanted = typeof args.file === "string" ? args.file.trim() : "";
  if (!wanted) throw refuse("validation_error", "file: one of the message's files, as read_thread lists it.");
  const files = sourcesOf(store.dir, message);
  const listed = files.map((f) => (f.file === f.name ? f.file : `${f.file} (${f.name})`)).join(", ") || "none";
  const named = files.filter((f) => f.name === wanted);
  const hit = files.find((f) => f.file === wanted || f.path === wanted) ?? (named.length === 1 ? named[0] : undefined);
  if (!hit) throw refuse("file_not_found", `${messageId} has no file ${JSON.stringify(wanted)}${named.length > 1 ? " by that name alone" : ""}. Its files: ${listed}.`);
  if (isDotenvFileName(hit.name)) throw refuse("attachment_refused", `${hit.name}: the Inbox does not hand out a .env file.`);
  const ownKey = "record" in hit.source ? inboxOwnSecretRefusal(hit.source.record.path) : null;
  if (ownKey) throw refuse("attachment_refused", `${hit.name}: ${ownKey}`);
  const opened = await openSource(store.dir, hit.source);
  if (opened.size > INBOX_UPLOAD_MAX_BYTES) {
    await opened.handle.close().catch(() => {});
    throw refuse("file_too_large", `${hit.name} is ${Math.ceil(opened.size / MB)} MB; ${whose} fetches a file of at most ${INBOX_UPLOAD_MAX_BYTES / MB} MB.`);
  }
  return { file: hit.file, name: hit.name, kind: hit.kind, ...opened };
}

/**
 * `fetch_file` at the agent door, or null for any other action. `session` is
 * the agent's own, from its pairing: the read it may make is the one
 * read_thread makes for it.
 */
export async function inboxAgentFetchAction(store: InboxStore, session: string, tool: string, args: Record<string, unknown>): Promise<ToolResult | null> {
  if (tool !== INBOX_AGENT_FETCH_FILE) return null;
  const extra = Object.keys(args).find((field) => !(FIELDS as readonly string[]).includes(field));
  if (extra) throw refuse("validation_error", `${extra}: not taken. ${tool} takes: ${FIELDS.join(", ")}.`);
  const offset = args.offset ?? 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw refuse("validation_error", "offset: where the piece starts, in bytes from 0 (the next_offset of the piece before).");
  const opened = await openInboxAgentFile(store, session, args);
  const messageId = (args.message_id as string).trim();
  const hit = opened;
  try {
    if (offset > opened.size) throw refuse("validation_error", `offset: ${hit.name} has ${opened.size} bytes.`);
    const length = Math.min(INBOX_AGENT_FETCH_PIECE_BYTES, opened.size - offset);
    const bytes = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await opened.handle.read(bytes, read, length - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    if (read < length) throw refuse("attachment_missing", `${hit.name} could not be read whole.`);
    const end = offset + length;
    const next = end < opened.size ? end : null;
    return ok(`${hit.name}: bytes ${offset} to ${end} of ${opened.size}${next === null ? ", the end" : `; next offset ${next}`}.`, {
      message_id: messageId,
      file: hit.file,
      name: hit.name,
      kind: hit.kind,
      content_type: opened.contentType,
      size: opened.size,
      sha256: opened.sha256,
      offset,
      next_offset: next,
      data: bytes.toString("base64"),
    });
  } finally {
    await opened.handle.close().catch(() => {});
  }
}
