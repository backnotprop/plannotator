/**
 * An agent on this computer reads a linked machine's thread, and fetches one of its files (inbox-far-read.ts says why
 * and what the other machine answers). In process, from read_thread and `plannotator inbox call fetch_file`: never
 * through the forward's window-only routes. This Inbox writes nothing of either to disk: a fetched file's bytes stream
 * on to the command, which saves them in its own process (apps/hook/server/inbox-call-far-fetch.ts), so the agent's
 * own sandbox decides where it may write.
 *
 * Which machine: the one whose list names the thread; for an id no list names (an archived thread, a message id),
 * every online machine that takes `agent-read` is asked at once, and the one that holds it answers. Each ask is
 * bounded (`FAR_READ_WAIT_MS`), so a machine asleep or slow never holds the agent up past it. A machine too old to
 * answer (no `agent-read` mark, or its door does not know the route) is named, with what to do.
 */

import { isInboxId } from "@plannotator/core/inbox-types";
import { inboxStopNoticeReply } from "@plannotator/shared/inbox/connection";
import {
  FETCHED_FILE_MACHINE_HEADER,
  FETCHED_FILE_MAX_BYTES,
  FETCHED_FILE_NAME_HEADER,
  FETCHED_FILE_SHA_HEADER,
  FETCHED_FILE_SIZE_HEADER,
  FETCHED_FILE_WORDS,
  fetchedNameHeader,
  fetchedNameOf,
  fetchedShaOf,
  fetchedSizeOf,
  fetchedTypeOf,
  savedNameIsDotenv,
} from "@plannotator/shared/inbox/saved-file";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { AGENT_FILE_NAME_HEADER, AGENT_FILE_PIECE_MAX_BYTES, AGENT_FILE_ROUTE, AGENT_FILE_SHA_HEADER, AGENT_READ_ROUTE, farReadQuery, machineNameWords, type FarReadAnswer, type FarReadAsk } from "./inbox-far-read";
import { readCapped, type PeerLink } from "./inbox-peer-link";
import { farPieceOf, FAR_PIECE_WAIT_MS, type FarFilePiece } from "./inbox-machine-agent-piece";

/** How long one machine may take to answer a read (and a file's first bytes). */
export const FAR_READ_WAIT_MS = 5_000;
/** The most a far read's answer may be: a window of whole messages is far under it. */
const FAR_READ_MAX_BYTES = 16 * 1024 * 1024;
/** A file's bytes that stop arriving for this long end the fetch. */
const FAR_FILE_STALL_MS = 30_000;

/** The mark a machine's list carries when its agents' reads of its threads are answered (`INBOX_LINKED_MARKS`). */
export const AGENT_READ_MARK = "agent-read";

/** DRAFT words (the owner's to approve): why a linked machine's thread or file could not be read. */
export const FAR_READ_REFUSALS = {
  older: (name: string) => `This thread is on ${name}, whose Plannotator is too old to share threads with agents. Ask the person to update Plannotator on ${name}.`,
  away: (name: string) => `This thread is on ${name}, which cannot be reached now (asleep, offline or still connecting). Try again when ${name} is back.`,
  maybeOlder: (name: string) => `It may be on ${name}, whose Plannotator is too old to share threads with agents: ask the person to update it there.`,
  maybeAway: (name: string) => `It may be on ${name}, which cannot be reached now.`,
  notHere: (id: string) => `No thread ${id} on this computer or the computers linked to it.`,
  fileNotHere: (id: string) => `No message ${id} on this computer or the computers linked to it.`,
  fileLocal: (id: string) => `${id} is on this computer: read_thread lists its files with their paths here.`,
  fileUnreadable: (name: string) => `${name} sent a file this Inbox cannot use. Nothing was saved; fetch it again.`,
  conflict: "Two linked machines both claim this thread, so it opens on neither.",
} as const;

type Outcome =
  | { kind: "found"; peer: PeerLink; answer: FarReadAnswer }
  | { kind: "missing" }
  | { kind: "older"; name: string }
  | { kind: "away"; name: string }
  | { kind: "refused"; code: string; error: string };

export interface MachineAgentReadDeps {
  peers: () => Iterable<PeerLink>;
  /** A linked machine's name, as this Inbox calls it. */
  nameOf: (id: string) => string;
  waitMs?: number;
  /** Tests: how long a file's bytes may stop arriving. */
  stallMs?: number;
}

/** A body as text, at most `maxBytes` and read for at most `waitMs`, else null: its stream is let go either way. */
async function readBounded(response: Response, maxBytes: number, waitMs: number): Promise<string | null> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const deadline = Date.now() + waitMs;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), Math.max(0, deadline - Date.now()))));
      const next = await Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
      if (next === "late") break;
      if (next.done) return Buffer.concat(chunks).toString("utf8");
      size += next.value.byteLength;
      if (size > maxBytes) break;
      chunks.push(next.value);
    }
  } catch {
    // The line dropped: no words.
  }
  void reader.cancel().catch(() => {});
  return null;
}

/** A refusal's code and words, read for at most `waitMs`: a far side that sends its headers and then stalls never holds the agent. */
async function refusalOf(response: Response, waitMs: number): Promise<{ code: string; error: string }> {
  const plain = { code: "machine_refused", error: `The other computer answered ${response.status}.` };
  const text = await readBounded(response, 64 * 1024, waitMs);
  if (text === null) return plain;
  try {
    const body = JSON.parse(text) as { code?: unknown; error?: unknown };
    return { code: typeof body.code === "string" ? body.code : plain.code, error: typeof body.error === "string" ? body.error : plain.error };
  } catch {
    return plain;
  }
}

/** A door that does not know the route: an older Plannotator. */
const routeUnknown = (code: string) => code === "device_route_not_found" || code === "not_found";

/** Whether a machine can be asked now: online, and (when its list is known) taking `agent-read`. */
function blocked(peer: PeerLink, name: string): Outcome | null {
  if (peer.state === "needs_update" || (peer.list && !peer.list.marks.includes(AGENT_READ_MARK))) return { kind: "older", name };
  if (peer.state !== "online") return { kind: "away", name };
  return null;
}

/** The words for machines that could not be asked, after "No thread …": each one, and what to do. */
function maybeWords(outcomes: readonly Outcome[]): string {
  return outcomes
    .flatMap((o) => (o.kind === "older" ? [FAR_READ_REFUSALS.maybeOlder(o.name)] : o.kind === "away" ? [FAR_READ_REFUSALS.maybeAway(o.name)] : []))
    .join(" ");
}

/** An id read_thread may name a far message by: a message id, or a stop notice's (`<reply>-stop`, resolved there). */
const farMessageId = (id: string): boolean => isInboxId("msg", inboxStopNoticeReply(id) ?? id);

export function createMachineAgentRead(deps: MachineAgentReadDeps) {
  const waitMs = deps.waitMs ?? FAR_READ_WAIT_MS;
  const stallMs = deps.stallMs ?? FAR_FILE_STALL_MS;
  const linked = () => [...deps.peers()].filter((peer) => peer.state !== "revoked");
  const nameOf = (peer: PeerLink) => machineNameWords(deps.nameOf(peer.id));

  const askRead = async (peer: PeerLink, ask: FarReadAsk): Promise<Outcome> => {
    const name = nameOf(peer);
    const stop = blocked(peer, name);
    if (stop) return stop;
    try {
      const signal = AbortSignal.timeout(waitMs);
      const response = await peer.request(AGENT_READ_ROUTE, farReadQuery(ask, deps.nameOf(peer.id)), { method: "GET", headers: {}, signal, timeoutMs: waitMs });
      if (response.status === 404) {
        const { code, error } = await refusalOf(response, waitMs);
        if (routeUnknown(code)) return { kind: "older", name };
        // That machine has no such thread (or, asked by a message id alone, no such message): another may. A message
        // missing from a thread it holds is its own refusal, as a local read says it.
        if (code === "thread_not_found" || (code === "message_not_found" && !ask.thread_id)) return { kind: "missing" };
        return { kind: "refused", code, error };
      }
      if (response.status >= 500) {
        void response.body?.cancel().catch(() => {});
        return { kind: "away", name };
      }
      if (!response.ok) return { kind: "refused", ...(await refusalOf(response, waitMs)) };
      const text = await readCapped(response, FAR_READ_MAX_BYTES);
      const answer = text === null ? null : (JSON.parse(text) as FarReadAnswer);
      const whole = answer && isInboxId("msg", answer.thread_id) && ("full" in answer ? !!answer.full && Array.isArray(answer.full.messages) : !!answer.result?.thread && Array.isArray(answer.result.thread.messages) && Array.isArray(answer.order) && Array.isArray(answer.lines));
      return whole ? { kind: "found", peer, answer: answer! } : { kind: "refused", code: "machine_answer_unreadable", error: `${name} sent a read this Inbox cannot use.` };
    } catch {
      return { kind: "away", name };
    }
  };

  /**
   * read_thread of an id this Inbox's store does not hold: the linked machine's read, or null when no linked machine
   * holds it (the caller says "No thread …" as before). Throws when it is there but cannot be read now, with why.
   */
  const readThread = async (ask: FarReadAsk): Promise<{ machine: string; name: string; answer: FarReadAnswer } | null> => {
    const id = ask.thread_id ?? ask.message_id;
    if (!id || !(ask.thread_id ? isInboxId("msg", id) : farMessageId(id))) return null;
    const peers = linked();
    if (peers.length === 0) return null;
    const listed = ask.thread_id ? peers.filter((peer) => peer.list?.rows.some((row) => row.thread_id === ask.thread_id)) : [];
    if (listed.length > 1) throw new InboxError("machine_conflict", FAR_READ_REFUSALS.conflict);
    const outcomes = await Promise.all((listed.length === 1 ? listed : peers).map((peer) => askRead(peer, ask)));
    const found = outcomes.filter((o): o is Extract<Outcome, { kind: "found" }> => o.kind === "found");
    if (found.length > 1) throw new InboxError("machine_conflict", FAR_READ_REFUSALS.conflict);
    if (found.length === 1) return { machine: found[0]!.peer.id, name: nameOf(found[0]!.peer), answer: found[0]!.answer };
    const refused = outcomes.find((o): o is Extract<Outcome, { kind: "refused" }> => o.kind === "refused");
    if (refused) throw new InboxError(refused.code, refused.error);
    if (listed.length === 1) {
      const only = outcomes[0]!;
      if (only.kind === "older") throw new InboxError("machine_needs_update", FAR_READ_REFUSALS.older(only.name));
      if (only.kind === "away") throw new InboxError("machine_offline", FAR_READ_REFUSALS.away(only.name));
      return null;
    }
    const maybe = maybeWords(outcomes);
    if (!maybe) return null;
    throw new InboxError("thread_not_found", `${FAR_READ_REFUSALS.notHere(id)} ${maybe}`);
  };

  /**
   * `plannotator inbox call fetch_file` of a message on a linked machine: that machine's answer, streamed on as it
   * arrives (`relayFile`), never written here. `signal`: the command's request, so a command that gave up stops the
   * far fetch too.
   */
  const fetchFile = async (args: { message_id: string; file: string }, signal?: AbortSignal): Promise<Response> => {
    const hit = await askFile(args, {}, signal);
    return relayFile(hit.response, hit.peer.id, nameOf(hit.peer), stallMs);
  };

  /**
   * A paired cloud agent's fetch_file of a file a linked machine holds: one piece (1 MiB at most) at `offset`, read
   * there by range and held here in memory for this answer only. Null when no machine is linked.
   */
  const filePiece = async (args: { message_id: string; file: string }, offset: number): Promise<FarFilePiece | null> => {
    if (linked().length === 0) return null;
    const hit = await askFile(args, { offset: String(offset), length: String(AGENT_FILE_PIECE_MAX_BYTES) }, AbortSignal.timeout(Math.max(waitMs, FAR_PIECE_WAIT_MS)));
    const name = nameOf(hit.peer);
    return farPieceOf(hit.response, offset, { older: FAR_READ_REFUSALS.older(name), unreadable: FAR_READ_REFUSALS.fileUnreadable(name) });
  };

  /** The machine that holds the file, and its answer; or why none can give it. */
  const askFile = async (args: { message_id: string; file: string }, more: Record<string, string>, signal?: AbortSignal): Promise<{ peer: PeerLink; response: Response }> => {
    if (!isInboxId("msg", args.message_id)) throw new InboxError("validation_error", "message_id: the id of the message the file is on, as read_thread shows it.");
    if (!args.file) throw new InboxError("validation_error", "file: one of the message's files, as read_thread lists it.");
    const peers = linked();
    const stops = peers.map((peer) => blocked(peer, nameOf(peer)));
    const askable = peers.filter((_, i) => stops[i] === null);
    const query = `?${new URLSearchParams({ message_id: args.message_id, file: args.file, ...more })}`;
    const answers = await Promise.all(
      askable.map(async (peer) => {
        try {
          return { peer, response: await peer.request(AGENT_FILE_ROUTE, query, { method: "GET", headers: {}, timeoutMs: waitMs, ...(signal ? { signal } : {}) }) };
        } catch {
          return { peer, response: null };
        }
      }),
    );
    const hit = answers.find((a) => a.response?.ok);
    // Every answer but the one used is let go: a refusal's body is read below only when no machine has the file.
    for (const a of answers) if (a !== hit && (hit || !a.response || a.response.status >= 500)) void a.response?.body?.cancel().catch(() => {});
    if (signal?.aborted) {
      void hit?.response?.body?.cancel().catch(() => {});
      throw new InboxError("fetch_cancelled", "The fetch was given up.");
    }
    if (!hit) {
      const notAsked: Outcome[] = [];
      const refusals = await Promise.all(answers.map(async (a) => (!a.response || a.response.status >= 500 ? null : await refusalOf(a.response, waitMs))));
      for (const [i, a] of answers.entries()) {
        const refusal = refusals[i];
        if (!refusal) notAsked.push({ kind: "away", name: nameOf(a.peer) });
        else if (routeUnknown(refusal.code)) notAsked.push({ kind: "older", name: nameOf(a.peer) });
        else if (refusal.code !== "message_not_found") throw new InboxError(refusal.code, refusal.error);
      }
      const notAnswered: Outcome[] = [...stops.filter((s): s is Outcome => s !== null), ...notAsked];
      throw new InboxError("message_not_found", `${FAR_READ_REFUSALS.fileNotHere(args.message_id)}${notAnswered.length > 0 ? ` ${maybeWords(notAnswered)}` : ""}`);
    }
    return { peer: hit.peer, response: hit.response! };
  };

  return { readThread, fetchFile, filePiece };
}

/**
 * A far file's answer passed on to the command that saves it: refused before a byte goes when its name is a dotenv
 * one, its length is past 100 MB or not said, or its SHA-256 is not one; then streamed as it arrives (no buffering),
 * cut off past its length or 100 MB, or after `stallMs` with no bytes. Its name, SHA-256, length and type go in
 * headers this Inbox builds (inbox-call-far-fetch.ts reads them), never a far header as it came.
 */
export function relayFile(response: Response, machine: string, machineName: string, stallMs = FAR_FILE_STALL_MS): Response {
  const name = fetchedNameOf(response.headers.get(AGENT_FILE_NAME_HEADER));
  const sha256 = fetchedShaOf(response.headers.get(AGENT_FILE_SHA_HEADER));
  const declared = fetchedSizeOf(response.headers.get(FETCHED_FILE_SIZE_HEADER) ?? response.headers.get("content-length"));
  const cancel = () => void response.body?.cancel().catch(() => {});
  if (savedNameIsDotenv(name)) {
    cancel();
    throw new InboxError("attachment_refused", FETCHED_FILE_WORDS.dotenv(name));
  }
  if (declared !== null && declared > FETCHED_FILE_MAX_BYTES) {
    cancel();
    throw new InboxError("file_too_large", FETCHED_FILE_WORDS.tooLarge(name, declared));
  }
  if (declared === null || sha256 === null || !response.body) {
    cancel();
    throw new InboxError("machine_answer_unreadable", FAR_READ_REFUSALS.fileUnreadable(machineName));
  }
  const reader = response.body.getReader();
  let size = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<"stalled">((resolve) => (timer = setTimeout(() => resolve("stalled"), stallMs)));
      try {
        const next = await Promise.race([reader.read(), stalled]);
        if (next === "stalled") throw new InboxError("machine_offline", FETCHED_FILE_WORDS.stopped(name));
        if (next.done) {
          if (size !== declared) throw new InboxError("machine_offline", FETCHED_FILE_WORDS.stopped(name));
          controller.close();
          return;
        }
        size += next.value.byteLength;
        if (size > declared || size > FETCHED_FILE_MAX_BYTES) throw new InboxError("file_too_large", FETCHED_FILE_WORDS.over(name));
        controller.enqueue(next.value);
      } catch (error) {
        void reader.cancel().catch(() => {});
        controller.error(error);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel() {
      void reader.cancel().catch(() => {});
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": fetchedTypeOf(response.headers.get("content-type")),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      [FETCHED_FILE_NAME_HEADER]: fetchedNameHeader(name),
      [FETCHED_FILE_SHA_HEADER]: sha256,
      [FETCHED_FILE_SIZE_HEADER]: String(declared),
      [FETCHED_FILE_MACHINE_HEADER]: machine,
    },
  });
}
