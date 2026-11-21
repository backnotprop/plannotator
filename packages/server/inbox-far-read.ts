/**
 * An agent reads a thread on a linked machine (the owner, 2026-11-21: "An agent should be able to read any thread
 * across any computer if they're already connected"). The link between the two Inboxes is the permission: no other
 * check, setting or confirmation.
 *
 * The thread's own machine (B) answers two door routes only a linked machine's token reaches (`DOOR_OWN_ROUTES` in
 * inbox-devices.ts, mark `agent-read`):
 *  - `GET agent-read?thread_id=&message_id=&limit=&expand=&before=&after=&format=`: read_thread's read of one of its
 *    threads, as data (`windowedThread`, its PRs and steps lines), for a reader with no session here: it marks
 *    nothing read and settles nothing (a guest's read). Each message's files are listed as a cloud agent's are, with
 *    the command that saves a copy (`inboxAgentFilesOf`).
 *  - `GET agent-file?message_id=&file=`: one of those files' bytes (`openInboxAgentFile`: a file read_thread lists, not
 *    a dotenv name, not the Inbox's own keys, at most 100 MB), with its name and SHA-256 in headers.
 * Nothing else on B's disk is reached: a file a message only names (`open-in/file/*`), a Markdown file's pictures and
 * the documents next to a file stay the window's alone (`forwardedFileReadRefusal`, inbox-machines.ts).
 *
 * The reader's machine (A) renders B's read with the same `windowedThreadText` a local read uses
 * (`farThreadReadText`), so the text is the same, with one line first saying which computer the thread is on and its
 * own window's link in place of B's. Asking B, and saving a fetched file, is inbox-machine-agent-read.ts.
 */

import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxViewingLine } from "@plannotator/shared/inbox/uploads";
import { inboxAgentFilesOf, openInboxAgentFile } from "./inbox-agent-files";
import { windowedThread, windowedThreadText, type ThreadWindowResult } from "./inbox-mcp-read";
import { threadPullsText, type InboxPullsMcpContext } from "./inbox-mcp-pulls";
import { threadStepsText } from "./inbox-mcp-steps";

/** The door's own route names (inbox-devices.ts `DOOR_OWN_ROUTES`). */
export const AGENT_READ_ROUTE = "agent-read";
export const AGENT_FILE_ROUTE = "agent-file";

/** The headers a fetched file's name and SHA-256 ride in (its type and length in the usual ones). */
export const AGENT_FILE_NAME_HEADER = "X-Plannotator-File-Name";
export const AGENT_FILE_SHA_HEADER = "X-Plannotator-File-Sha256";

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
  | { thread_id: string; full: Record<string, unknown> & { messages: unknown[] } };

/** The ask as a door query: only what read_thread takes. */
export function farReadQuery(ask: FarReadAsk): string {
  const query = new URLSearchParams();
  for (const key of ["thread_id", "message_id", "before", "after", "format"] as const) {
    const value = ask[key];
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  if (ask.limit !== undefined) query.set("limit", String(ask.limit));
  if (ask.expand?.length) query.set("expand", ask.expand.join(","));
  return `?${query}`;
}

/** A bound as read_thread takes it: a message id, or a cursor. */
const boundOf = (value: string | null): string | number | undefined => (value === null || value === "" ? undefined : /^\d{1,15}$/.test(value) ? Number(value) : value);

function askOf(url: URL): FarReadAsk {
  const q = url.searchParams;
  const limit = q.get("limit");
  const n = limit === null ? undefined : Number(limit);
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 100)) throw new InboxError("validation_error", "limit: a whole number from 1 to 100.");
  const expand = q.get("expand");
  return {
    thread_id: q.get("thread_id") || undefined,
    message_id: q.get("message_id") || undefined,
    ...(n !== undefined ? { limit: n } : {}),
    ...(expand ? { expand: expand.split(",").filter(Boolean) } : {}),
    before: boundOf(q.get("before")),
    after: boundOf(q.get("after")),
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

/** `GET agent-read` on B: read_thread's read of one of its threads, as data. Reads only: nothing is marked or settled. */
export function agentReadDoorAnswer(host: AgentReadHost, url: URL): Response {
  try {
    const { store } = host;
    const ask = askOf(url);
    const threadId = threadOfAsk(store, ask);
    if (ask.format === "full") {
      const records = store.agentThread(threadId, null);
      if (!records) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
      const full = { ...records, messages: records.messages.map((m) => (m.viewing ? { ...m, viewing: inboxViewingLine(m) } : m)) };
      return Response.json({ thread_id: threadId, full } satisfies FarReadAnswer, { headers: { "Cache-Control": "no-store" } });
    }
    const filesOf = (message: Parameters<typeof inboxAgentFilesOf>[1]) => inboxAgentFilesOf(store.dir, message);
    const { result, order } = windowedThread(store, threadId, { ...ask, caller: null, names: host.sessionName, filesOf }, "");
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
function handleStream(opened: { handle: { read: (b: Buffer, o: number, l: number, p: number) => Promise<{ bytesRead: number }>; close: () => Promise<void> }; size: number }): ReadableStream<Uint8Array> {
  let at = 0;
  const close = () => void opened.handle.close().catch(() => {});
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const length = Math.min(1024 * 1024, opened.size - at);
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

/** `GET agent-file` on B: one file read_thread lists, its bytes, with its name and SHA-256. */
export async function agentFileDoorAnswer(store: InboxStore, url: URL): Promise<Response> {
  try {
    const args = { message_id: url.searchParams.get("message_id") ?? "", file: url.searchParams.get("file") ?? "" };
    const opened = await openInboxAgentFile(store, null, args, "an agent on another computer");
    return new Response(handleStream(opened), {
      headers: {
        "Content-Type": opened.contentType,
        "Content-Length": String(opened.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        [AGENT_FILE_NAME_HEADER]: encodeURIComponent(opened.name),
        [AGENT_FILE_SHA_HEADER]: opened.sha256,
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

/** A far windowed read as the local read's text: the line that says where, then exactly what a local read prints. */
export function farThreadReadText(answer: Extract<FarReadAnswer, { result: unknown }>, machine: string, url: string): { text: string; result: ThreadWindowResult } {
  const result = { ...answer.result, url };
  const name = machineNameWords(machine);
  const files = result.thread.messages.some((m) => (m.files?.length ?? 0) > 0);
  const head = `${FAR_READ_WORDS.on(name)}${files ? FAR_READ_WORDS.files(name) : ""}`;
  return { text: `${head}\n${windowedThreadText(result, answer.order, "", answer.lines)}`, result };
}
