/**
 * An agent reads a thread on a linked machine (the owner, 2026-11-21: "An agent should be able to read any thread
 * across any computer if they're already connected"). The link between the two Inboxes is the permission: no other
 * check, setting or confirmation.
 *
 * The thread's own machine (B) answers two door routes only a linked machine's token reaches (`DOOR_OWN_ROUTES` in
 * inbox-devices.ts, mark `agent-read`):
 *  - `GET agent-read?thread_id=&message_id=&limit=&expand=&before=&after=&format=&shown_as=`: read_thread's read of
 *    one of its threads, as data (`windowedThread`, its PRs and steps lines), for a reader with no session here: it
 *    marks nothing read and settles nothing (a guest's read). Where the person wrote each message is worded from the
 *    reader's side (`shown_as`: the reader's name for B; inbox-sent-from-reader.ts). Each message's files are listed
 *    as a cloud agent's are, with the command that saves a copy (`inboxAgentFilesOf`).
 *  - `GET agent-file?message_id=&file=`: one of those files' bytes (`openInboxAgentFile`: a file read_thread lists, not
 *    a dotenv name, not the Inbox's own keys, at most 100 MB), with its name and SHA-256 in headers.
 * Nothing else on B's disk is reached: a file a message only names (`open-in/file/*`), a Markdown file's pictures and
 * the documents next to a file stay the window's alone (`forwardedFileReadRefusal`, inbox-machines.ts).
 *
 * The reader's machine (A) renders B's read with the same `windowedThreadText` a local read uses
 * (`farThreadReadText`), so the text is the same, with one line first saying which computer the thread is on and its
 * own window's link in place of B's. Asking B, and saving a fetched file, is inbox-machine-agent-read.ts.
 */

import { inboxStopNoticeReply } from "@plannotator/shared/inbox/connection";
import { FETCHED_FILE_NAME_HEADER, FETCHED_FILE_SHA_HEADER, FETCHED_FILE_SIZE_HEADER, fetchedNameHeader } from "@plannotator/shared/inbox/saved-file";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { isInboxAttachmentId, isInboxId } from "@plannotator/core/inbox-types";
import { inboxAgentFetchCommand, inboxAgentFilesOf, openInboxAgentFile, type AgentFile } from "./inbox-agent-files";
import { inboxFullReadLines, windowedThread, windowedThreadText, type ThreadWindowResult } from "./inbox-mcp-read";
import { FAR_READ_SHOWN_AS, inboxMessageForReader, inboxSentFromReader } from "./inbox-sent-from-reader";
import { threadPullsText, type InboxPullsMcpContext } from "./inbox-mcp-pulls";
import { threadStepsText } from "./inbox-mcp-steps";

/** The door's own route names (inbox-devices.ts `DOOR_OWN_ROUTES`). */
export const AGENT_READ_ROUTE = "agent-read";
export const AGENT_FILE_ROUTE = "agent-file";

/** The headers a fetched file's name and SHA-256 ride in (its type and length in the usual ones). */
export const AGENT_FILE_NAME_HEADER = FETCHED_FILE_NAME_HEADER;
export const AGENT_FILE_SHA_HEADER = FETCHED_FILE_SHA_HEADER;

/** read_thread's options, as the reader's Inbox passes them on. */
export interface FarReadAsk {
  thread_id?: string;
  message_id?: string;
  limit?: number;
  expand?: string[];
  before?: string | number;
  after?: string | number;
  format?: "full";
}

/** B's answer: the windowed read (`url` empty, the reader's Inbox puts its own), or the full records. */
export type FarReadAnswer =
  | { thread_id: string; result: ThreadWindowResult; order: string[]; lines: string[]; steps?: unknown[]; pulls?: unknown[] }
  | { thread_id: string; full: Record<string, unknown> & { messages: unknown[] }; cursor?: number };

/**
 * The ask as a door query: only what read_thread takes. A bound keeps its type: a number goes as `#<number>`, a string
 * as it is, so the owner reads `before: 1.5` and `before: "1.5"` exactly as a local read_thread would.
 */
export function farReadQuery(ask: FarReadAsk, shownAs = ""): string {
  const query = new URLSearchParams();
  // The name this Inbox shows for the machine asked: what the person wrote there reads as written on it.
  if (shownAs) query.set(FAR_READ_SHOWN_AS, shownAs);
  for (const key of ["thread_id", "message_id", "before", "after", "format"] as const) {
    const value = ask[key];
    if (typeof value === "number") query.set(key, `#${value}`);
    else if (value !== undefined && value !== "") query.set(key, value);
  }
  if (ask.limit !== undefined) query.set("limit", String(ask.limit));
  if (ask.expand?.length) query.set("expand", ask.expand.join(","));
  return `?${query}`;
}

/** A bound as the reader's read_thread took it: `#<number>` a cursor (a number there), anything else a string. */
function boundOf(value: string | null, name: string): string | number | undefined {
  if (value === null || value === "") return undefined;
  if (!value.startsWith("#")) return value;
  const n = Number(value.slice(1));
  if (value.length === 1 || !Number.isFinite(n) || n < 0) throw new InboxError("validation_error", `${name}: a message id of this thread, or a cursor.`);
  return n;
}

/** A message id as read_thread resolves it: a stop notice's id (`<reply>-stop`) is its reply's (`ownMessageId` in inbox-mcp.ts). */
function ownId<T extends string | number | undefined>(store: InboxStore, id: T): T {
  if (typeof id !== "string") return id;
  const reply = inboxStopNoticeReply(id);
  return (reply && store.message(reply) ? reply : id) as T;
}

/** The ask from the door's query, its ids resolved as the local read resolves them (inbox-mcp.ts's read_thread). */
function askOf(store: InboxStore, url: URL): FarReadAsk {
  const q = url.searchParams;
  const limit = q.get("limit");
  const n = limit === null ? undefined : Number(limit);
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 100)) throw new InboxError("validation_error", "limit: a whole number from 1 to 100.");
  const expand = q.get("expand");
  return {
    thread_id: q.get("thread_id") || undefined,
    message_id: ownId(store, q.get("message_id") || undefined),
    ...(n !== undefined ? { limit: n } : {}),
    ...(expand ? { expand: expand.split(",").filter(Boolean).map((id) => ownId(store, id)) } : {}),
    before: ownId(store, boundOf(q.get("before"), "before")),
    after: ownId(store, boundOf(q.get("after"), "after")),
    ...(q.get("format") === "full" ? { format: "full" as const } : {}),
  };
}

/** The thread an ask names, as the local read finds it (`threadOf` in inbox-mcp.ts). */
function threadOfAsk(store: InboxStore, ask: FarReadAsk): string {
  if (ask.thread_id) {
    const root = store.message(ask.thread_id);
    if (!root || root.thread_id !== root.id) throw new InboxError("thread_not_found", `No thread ${ask.thread_id}.`);
    if (ask.message_id) {
      const message = store.message(ask.message_id);
      if (!message) throw new InboxError("message_not_found", `No message ${ask.message_id}.`);
      if (message.thread_id !== root.id) throw new InboxError("validation_error", `message_id: ${ask.message_id} is in thread ${message.thread_id}, not ${root.id}; pass one of them.`);
    }
    return root.id;
  }
  if (!ask.message_id) throw new InboxError("validation_error", "thread_id: required (or message_id).");
  const message = store.message(ask.message_id);
  if (!message) throw new InboxError("message_not_found", `No message ${ask.message_id}.`);
  return message.thread_id;
}

/** What B needs to answer a read: its store, its session names, its PRs (the MCP context's), and whether the person has steps on. */
export interface AgentReadHost extends InboxPullsMcpContext {
  stepsOn?: () => boolean;
}

const refusal = (error: unknown): Response => {
  if (!(error instanceof InboxError)) return Response.json({ error: "Internal error.", code: "internal_error" }, { status: 500 });
  const status = error.code === "thread_not_found" || error.code === "message_not_found" || error.code === "file_not_found" ? 404 : error.code === "validation_error" ? 422 : 400;
  return Response.json({ error: error.message, code: error.code }, { status, headers: { "Cache-Control": "no-store" } });
};

/**
 * `GET agent-read` on B: read_thread's read of one of its threads, as data. Reads only: nothing is marked or settled.
 * `reader`: the name a message forwarded by the reading computer records here, from its door token
 * (`inboxMachineRecordName`); with the query's `shown_as`, each message's "sent from" line is worded from the reader's
 * side (inbox-sent-from-reader.ts).
 */
export function agentReadDoorAnswer(host: AgentReadHost, url: URL, reader = ""): Response {
  try {
    const { store } = host;
    const ask = askOf(store, url);
    const threadId = threadOfAsk(store, ask);
    const farReader = inboxSentFromReader(reader, url.searchParams.get(FAR_READ_SHOWN_AS));
    if (ask.format === "full") {
      const records = store.agentThread(threadId, null);
      if (!records) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
      // Each record's view and place as their lines, as a local full read gives them, the place from the reader's side.
      const full = { ...records, messages: records.messages.map((m) => inboxFullReadLines(inboxMessageForReader(m, farReader))) };
      // With the store's cursor as it was read: a Combine's archive there is skipped after an Unarchive since (inbox-combine-guard.ts).
      return Response.json({ thread_id: threadId, full, cursor: store.cursor() } satisfies FarReadAnswer, { headers: { "Cache-Control": "no-store" } });
    }
    const filesOf = (message: Parameters<typeof inboxAgentFilesOf>[1]) => inboxAgentFilesOf(store.dir, message);
    const { result, order } = windowedThread(store, threadId, { ...ask, caller: null, names: host.sessionName, filesOf, farReader }, "");
    const steps = host.stepsOn?.() ? threadStepsText(store, threadId, null, host.sessionName) : [];
    const pulls = threadPullsText(host, threadId, null);
    const answer: FarReadAnswer = {
      thread_id: threadId,
      result,
      order,
      lines: [...pulls, ...steps],
      ...(steps.length > 0 ? { steps: store.threadSteps(threadId).map(({ agent, steps: list, updated_at }) => ({ agent, steps: list, updated_at })) } : {}),
      ...(pulls.length > 0 ? { pulls: store.threadPulls(threadId).map(({ pull: _key, id: _id, ...rest }) => rest) } : {}),
    };
    return Response.json(answer, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return refusal(error);
  }
}

/** A file handle's bytes as a stream, closed at the end or when the reader goes. */
function handleStream(opened: { handle: { read: (b: Buffer, o: number, l: number, p: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> }; size: number }, from = 0, end = opened.size): ReadableStream<Uint8Array> {
  let at = from;
  const close = () => void opened.handle.close().catch(() => {});
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const length = Math.min(1024 * 1024, end - at);
        if (length <= 0) {
          close();
          controller.close();
          return;
        }
        const bytes = Buffer.alloc(length);
        const { bytesRead } = await opened.handle.read(bytes, 0, length, at);
        if (bytesRead === 0) throw new Error("short read");
        at += bytesRead;
        controller.enqueue(bytes.subarray(0, bytesRead));
      } catch (error) {
        close();
        controller.error(error);
      }
    },
    cancel: close,
  });
}

/** The most `length` a piece read (`offset=`) takes: the agent door's piece. */
export const AGENT_FILE_PIECE_MAX_BYTES = 1024 * 1024;
/** The header that says where a piece read starts: a door that does not send it reads the whole file (an older one). */
export const AGENT_FILE_OFFSET_HEADER = "X-Plannotator-File-Offset";

/** A piece read's `offset` and `length` from the query, or null for the whole file. Throws for one that does not read. */
function pieceAsk(url: URL, size: number, name: string): { offset: number; length: number } | null {
  const offset = url.searchParams.get("offset");
  if (offset === null) return null;
  const at = Number(offset);
  if (!Number.isInteger(at) || at < 0) throw new InboxError("validation_error", "offset: where the piece starts, in bytes from 0.");
  if (at > size) throw new InboxError("validation_error", `offset: ${name} has ${size} bytes.`);
  const asked = Number(url.searchParams.get("length") ?? AGENT_FILE_PIECE_MAX_BYTES);
  if (!Number.isInteger(asked) || asked < 1) throw new InboxError("validation_error", "length: a whole number of bytes, at least 1.");
  return { offset: at, length: Math.min(asked, AGENT_FILE_PIECE_MAX_BYTES, size - at) };
}

/**
 * `GET agent-file` on B: one file read_thread lists, its bytes, with its name and SHA-256 (the whole file's). With
 * `offset` (and `length`, at most 1 MiB): only that piece, said in `X-Plannotator-File-Offset`, so the person's
 * computer serves a cloud agent's pieces without reading the whole file each time.
 */
export async function agentFileDoorAnswer(store: InboxStore, url: URL): Promise<Response> {
  try {
    const args = { message_id: url.searchParams.get("message_id") ?? "", file: url.searchParams.get("file") ?? "" };
    const opened = await openInboxAgentFile(store, null, args, "an agent on another computer");
    let piece: { offset: number; length: number } | null;
    try {
      piece = pieceAsk(url, opened.size, opened.name);
    } catch (error) {
      await opened.handle.close().catch(() => {});
      throw error;
    }
    return new Response(piece ? handleStream(opened, piece.offset, piece.offset + piece.length) : handleStream(opened), {
      headers: {
        "Content-Type": opened.contentType,
        "Content-Length": String(piece ? piece.length : opened.size),
        ...(piece ? { [AGENT_FILE_OFFSET_HEADER]: String(piece.offset) } : {}),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        [AGENT_FILE_NAME_HEADER]: fetchedNameHeader(opened.name),
        [AGENT_FILE_SHA_HEADER]: opened.sha256,
        // Its length again, where no proxy on the way rewrites it.
        [FETCHED_FILE_SIZE_HEADER]: String(opened.size),
      },
    });
  } catch (error) {
    return refusal(error);
  }
}

/** DRAFT words (the owner's to approve): the line a far read starts with. */
export const FAR_READ_WORDS = {
  /** Which computer the thread is on. */
  on: (machine: string) => `This thread is on ${machine}.`,
  /** When a message shows files: their paths are that computer's, and how to get a copy here. */
  files: (machine: string) => ` Its files are on ${machine}; the command after each saves a copy on this computer and prints its path.`,
} as const;

/** A machine's name on one line, for the words. */
export const machineNameWords = (name: string): string => name.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Cf}]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "another computer";

/** Terminal escapes (CSI, OSC and the short ones, 7- and 8-bit): a far string never carries one into what this computer prints. */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;
/** Control characters but a line break and a tab. */
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;
/** On one line: no control character, line break or line separator at all. */
export const oneLine = (text: string): string => text.replace(ESCAPES, "").replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim();

/** The thread's own words (a message's body, its first words), printed as a local read prints them. */
const CONTENT_KEYS = new Set(["body", "words"]);

/** Every far string but the thread's own words with no terminal escape and no control character but a line break or tab. */
export function cleanStrings(value: unknown, key = ""): unknown {
  if (typeof value === "string") return CONTENT_KEYS.has(key) ? value : value.replace(ESCAPES, "").replace(CONTROLS, "");
  if (Array.isArray(value)) return value.map((item) => cleanStrings(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cleanStrings(v, k)]));
  return value;
}

/** A file id read_thread lists: an attachment's `att_` id, or a person's drawing by its name. */
const isFileId = (file: unknown): file is string => isInboxAttachmentId(file) || (typeof file === "string" && /^[0-9a-f]{64}\.(png|jpg|webp)$/.test(file));

/**
 * A far message's files as this computer lists them: only ids that read as one, each command rebuilt here from the
 * message id and the file id (never the far one), and its name, kind and path (the owner's, inert text: the file is
 * reached by the command) each on one line.
 */
function farFiles(messageId: unknown, files: unknown): AgentFile[] {
  if (!Array.isArray(files) || !isInboxId("msg", messageId)) return [];
  return files.flatMap((f: Partial<AgentFile>) =>
    f && isFileId(f.file)
      ? [{ file: f.file, name: oneLine(String(f.name ?? "")) || "file", kind: oneLine(String(f.kind ?? "")) || "file", size: typeof f.size === "number" && Number.isFinite(f.size) && f.size >= 0 ? f.size : 0, path: oneLine(String(f.path ?? "")), fetch: inboxAgentFetchCommand(messageId, f.file) }]
      : [],
  );
}

/**
 * B's answer as this computer prints it: what a local read would print of the same thread. Its words as they are
 * (a local read prints a body as it was sent), every other string with no terminal escape or control character, and
 * each file's command made here.
 */
export function farAnswerCleaned<T extends FarReadAnswer>(answer: T): T {
  const clean = cleanStrings(answer) as T;
  const messages = "full" in clean ? (clean.full.messages as Record<string, unknown>[]) : (clean.result?.thread?.messages as unknown as Record<string, unknown>[] | undefined);
  for (const message of messages ?? []) {
    if (message && typeof message === "object" && "files" in message) message.files = farFiles(message.id, message.files);
  }
  return clean;
}

/** A far windowed read as the local read's text: the line that says where, then exactly what a local read prints. */
export function farThreadReadText(answer: Extract<FarReadAnswer, { result: unknown }>, machine: string, url: string): { text: string; result: ThreadWindowResult } {
  const result = { ...answer.result, url };
  const name = machineNameWords(machine);
  const files = result.thread.messages.some((m) => (m.files?.length ?? 0) > 0);
  const head = `${FAR_READ_WORDS.on(name)}${files ? FAR_READ_WORDS.files(name) : ""}`;
  return { text: `${head}\n${windowedThreadText(result, answer.order, "", answer.lines)}`, result };
}
