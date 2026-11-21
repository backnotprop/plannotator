/**
 * An agent on this computer reads a linked machine's thread, and saves one of its files here (inbox-far-read.ts says
 * why and what the other machine answers). In process, from read_thread and `plannotator inbox call fetch_file`:
 * never through the forward's window-only routes, and never written to disk but the file an agent asked to save.
 *
 * Which machine: the one whose list names the thread; for an id no list names (an archived thread, a message id),
 * every online machine that takes `agent-read` is asked at once, and the one that holds it answers. Each ask is
 * bounded (`FAR_READ_WAIT_MS`), so a machine asleep or slow never holds the agent up past it. A machine too old to
 * answer (no `agent-read` mark, or its door does not know the route) is named, with what to do.
 */

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDotenvFileName } from "@plannotator/core/annotatable";
import { INBOX_UPLOAD_MAX_BYTES, isInboxId } from "@plannotator/core/inbox-types";
import { newSavedFile, savedFileName } from "@plannotator/shared/inbox/saved-file";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { AGENT_FILE_NAME_HEADER, AGENT_FILE_ROUTE, AGENT_FILE_SHA_HEADER, AGENT_READ_ROUTE, farReadQuery, machineNameWords, type FarReadAnswer, type FarReadAsk } from "./inbox-far-read";
import { readCapped, type PeerLink } from "./inbox-peer-link";

/** How long one machine may take to answer a read (and a file's first bytes). */
export const FAR_READ_WAIT_MS = 5_000;
/** The most a far read's answer may be: a window of whole messages is far under it. */
const FAR_READ_MAX_BYTES = 16 * 1024 * 1024;
/** A file's bytes that stop arriving for this long end the fetch. */
const FAR_FILE_STALL_MS = 30_000;
const MB = 1024 * 1024;

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
}

/** A file saved here for an agent: where, and what it is. */
export interface FarSavedFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  content_type: string;
  machine: string;
}

async function refusalOf(response: Response): Promise<{ code: string; error: string }> {
  const text = await readCapped(response, 64 * 1024).catch(() => null);
  try {
    const body = JSON.parse(text ?? "") as { code?: unknown; error?: unknown };
    return { code: typeof body.code === "string" ? body.code : "machine_refused", error: typeof body.error === "string" ? body.error : `The other computer answered ${response.status}.` };
  } catch {
    return { code: "machine_refused", error: `The other computer answered ${response.status}.` };
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

export function createMachineAgentRead(deps: MachineAgentReadDeps) {
  const waitMs = deps.waitMs ?? FAR_READ_WAIT_MS;
  const linked = () => [...deps.peers()].filter((peer) => peer.state !== "revoked");
  const nameOf = (peer: PeerLink) => machineNameWords(deps.nameOf(peer.id));

  const askRead = async (peer: PeerLink, ask: FarReadAsk): Promise<Outcome> => {
    const name = nameOf(peer);
    const stop = blocked(peer, name);
    if (stop) return stop;
    try {
      const signal = AbortSignal.timeout(waitMs);
      const response = await peer.request(AGENT_READ_ROUTE, farReadQuery(ask), { method: "GET", headers: {}, signal, timeoutMs: waitMs });
      if (response.status === 404) {
        const { code, error } = await refusalOf(response);
        if (routeUnknown(code)) return { kind: "older", name };
        return code === "thread_not_found" || code === "message_not_found" ? { kind: "missing" } : { kind: "refused", code, error };
      }
      if (response.status >= 500) return { kind: "away", name };
      if (!response.ok) return { kind: "refused", ...(await refusalOf(response)) };
      const text = await readCapped(response, FAR_READ_MAX_BYTES);
      const answer = text === null ? null : (JSON.parse(text) as FarReadAnswer);
      const whole = answer && typeof answer.thread_id === "string" && ("full" in answer ? !!answer.full && Array.isArray(answer.full.messages) : !!answer.result?.thread && Array.isArray(answer.order) && Array.isArray(answer.lines));
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
    if (!id || !isInboxId("msg", id)) return null;
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
   * `plannotator inbox call fetch_file` of a message on a linked machine: its bytes saved in `folder` (or a new temp
   * folder), checked against the size and SHA-256 that machine named. At most 100 MB; a dotenv name is refused here
   * too, whatever that machine sent. A failure leaves no file behind.
   */
  const fetchFile = async (args: { message_id: string; file: string }, folder: string | null): Promise<FarSavedFile> => {
    if (!isInboxId("msg", args.message_id)) throw new InboxError("validation_error", "message_id: the id of the message the file is on, as read_thread shows it.");
    if (!args.file) throw new InboxError("validation_error", "file: one of the message's files, as read_thread lists it.");
    const peers = linked();
    const stops = peers.map((peer) => blocked(peer, nameOf(peer)));
    const askable = peers.filter((_, i) => stops[i] === null);
    const query = `?${new URLSearchParams({ message_id: args.message_id, file: args.file })}`;
    const answers = await Promise.all(
      askable.map(async (peer) => {
        try {
          return { peer, response: await peer.request(AGENT_FILE_ROUTE, query, { method: "GET", headers: {}, timeoutMs: waitMs }) };
        } catch {
          return { peer, response: null };
        }
      }),
    );
    const hit = answers.find((a) => a.response?.ok);
    if (hit) for (const a of answers) if (a !== hit) void a.response?.body?.cancel().catch(() => {});
    if (!hit) {
      const notAsked: Outcome[] = [];
      for (const a of answers) {
        if (!a.response || a.response.status >= 500) {
          void a.response?.body?.cancel().catch(() => {});
          notAsked.push({ kind: "away", name: nameOf(a.peer) });
          continue;
        }
        const { code, error } = await refusalOf(a.response);
        if (routeUnknown(code)) notAsked.push({ kind: "older", name: nameOf(a.peer) });
        else if (code !== "message_not_found") throw new InboxError(code, error);
      }
      const notAnswered: Outcome[] = [...stops.filter((s): s is Outcome => s !== null), ...notAsked];
      throw new InboxError("message_not_found", `${FAR_READ_REFUSALS.fileNotHere(args.message_id)}${notAnswered.length > 0 ? ` ${maybeWords(notAnswered)}` : ""}`);
    }
    return saveAnswer(hit.response!, hit.peer.id, folder);
  };

  return { readThread, fetchFile };
}

/** A far file's answer saved as a new file: checked as it streams (cap, stall), then against the named SHA-256 and size. */
export async function saveAnswer(response: Response, machine: string, folder: string | null): Promise<FarSavedFile> {
  let name = "file";
  try {
    name = decodeURIComponent(response.headers.get(AGENT_FILE_NAME_HEADER) ?? "") || "file";
  } catch {
    name = "file";
  }
  const sha256 = (response.headers.get(AGENT_FILE_SHA_HEADER) ?? "").toLowerCase();
  const declared = Number(response.headers.get("content-length") ?? NaN);
  const contentType = response.headers.get("content-type") ?? "application/octet-stream";
  const cancel = () => void response.body?.cancel().catch(() => {});
  if (isDotenvFileName(name)) {
    cancel();
    throw new InboxError("attachment_refused", `${name}: the Inbox does not hand out a .env file.`);
  }
  if (Number.isFinite(declared) && declared > INBOX_UPLOAD_MAX_BYTES) {
    cancel();
    throw new InboxError("file_too_large", `${name} is ${Math.ceil(declared / MB)} MB; an agent fetches a file of at most ${INBOX_UPLOAD_MAX_BYTES / MB} MB.`);
  }
  const dir = folder ?? (await mkdtemp(join(tmpdir(), "plannotator-file-")));
  await mkdir(dir, { recursive: true });
  const target = await newSavedFile(dir, savedFileName(name));
  const fail = async (error: InboxError): Promise<never> => {
    cancel();
    await target.handle.close().catch(() => {});
    await unlink(target.path).catch(() => {});
    throw error;
  };
  const hash = createHash("sha256");
  let size = 0;
  const reader = response.body?.getReader();
  try {
    for (;;) {
      if (!reader) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const stalled = new Promise<"stalled">((resolve) => (timer = setTimeout(() => resolve("stalled"), FAR_FILE_STALL_MS)));
      const next = await Promise.race([reader.read(), stalled]).finally(() => clearTimeout(timer));
      if (next === "stalled") return await fail(new InboxError("machine_offline", `The other computer stopped sending ${name}. Nothing was saved; fetch it again.`));
      if (next.done) break;
      size += next.value.byteLength;
      if (size > INBOX_UPLOAD_MAX_BYTES) return await fail(new InboxError("file_too_large", `${name} is over ${INBOX_UPLOAD_MAX_BYTES / MB} MB; an agent fetches a file of at most ${INBOX_UPLOAD_MAX_BYTES / MB} MB.`));
      hash.update(next.value);
      await target.handle.write(next.value);
    }
  } catch {
    return await fail(new InboxError("machine_offline", `The other computer stopped sending ${name}. Nothing was saved; fetch it again.`));
  }
  const got = hash.digest("hex");
  if ((Number.isFinite(declared) && size !== declared) || (sha256 && got !== sha256)) {
    return await fail(new InboxError("fetch_mismatch", `${name} arrived as ${size} bytes with SHA-256 ${got}, not as the other computer named it. Nothing was saved; fetch it again.`));
  }
  await target.handle.close();
  return { path: target.path, name, size, sha256: got, content_type: contentType, machine };
}
