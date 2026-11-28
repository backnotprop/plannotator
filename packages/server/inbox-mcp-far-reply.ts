/**
 * An agent here writes into a thread on another linked computer (inbox-far-tags.ts is that computer's side). Any
 * session here may, as it may write in any thread it can read here: send_message with `reply_to` a message or thread
 * of a linked computer goes to that computer's door (`POST agent-reply`), as this Inbox's own held write, at once
 * while it is online and when it is back otherwise. That computer runs its own send_message as this session, with
 * this computer named, so every field works as there: steps, PRs, Priority, a thread name, a branch report.
 *
 * What lives on this disk is read here and sent along: each attached file and each picture the body shows from this
 * disk is read by this Inbox's own file rules, kept here with the answer while it waits (inbox-outbox-files.ts), and
 * sent to that computer's `uploads` route just before the answer (as a window's reply on another computer sends its
 * files), and a branch report gets its head and remote from this computer's git.
 */

import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES, type InboxAttachment } from "@plannotator/core/inbox-types";
import { childEnv } from "@plannotator/shared/child-env";
import { planAgentBodyPictures } from "@plannotator/shared/inbox/agent-pictures";
import { recordInboxAttachments } from "@plannotator/shared/inbox/attachments";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { sameInboxSend, type InboxSendCall } from "@plannotator/shared/inbox/send-same";
import type { OutboxEntry } from "./inbox-outbox";
import { checkOutboxFiles, holdOutboxFiles, outboxFileTooLarge, type OutboxFile } from "./inbox-outbox-files";
import type { PeerLink } from "./inbox-peer-link";
import { FAR_AGENT_REPLY_ROUTE, TAG_ACROSS_MARK } from "./inbox-far-tags";
import { farReplyRefusal } from "./inbox-mcp-far-read";

/** How long send_message waits for the other computer's answer while it is online. */
const FAR_REPLY_WAIT_MS = 6_000;
/**
 * With files, which go first: the whole wait, kept well under the shortest tool time limit of a host that calls
 * this (Codex's 60 s default for an MCP tool), so the agent never times out and sends it again under a new key. Past
 * it the agent is told it waits, and the outbox goes on sending it, once.
 */
export const FAR_FILES_WAIT_MS = 45_000;

export interface FarReplyDeps {
  /** The linked computer whose thread `id` (a message or thread id) is, and that thread; null: none (the send goes on as before). */
  placeOf: (id: string) => Promise<{ machine: string; thread_id: string } | null>;
  nameOf: (machine: string) => string | null;
  /** Whether that computer's list says it takes an agent's answer (mark `tag-across`); null while this Inbox holds no list of it. */
  takes: (machine: string) => boolean | null;
  answersInReply?: (machine: string) => boolean;
  holdWrite: (machine: string, route: string, body: Record<string, unknown>, thread: string | null, waitMs: number, own?: { notify?: boolean; files?: readonly OutboxFile[] }) => Promise<OutboxEntry | null> | null;
  /** A held write of this Inbox's own, by its key (null: never held). */
  heldWrite: (key: string) => OutboxEntry | null;
  /** Its notice dismissed: the agent was told already. */
  dismissHeld: (key: string) => void;
  /** Files on this disk, read by this Inbox's attachment rules (no folder, no dotenv file, it must exist). */
  readFiles: (paths: string[], base: string | undefined) => Promise<InboxAttachment[]>;
  /** Those files kept here with the answer (pending uploads), by the other computer's upload rules. */
  holdFiles: (files: readonly { attachment: InboxAttachment; name: string }[]) => Promise<OutboxFile[]>;
}

/** What this file needs of the linked machines (inbox-machines.ts) and of the wakes this Inbox was handed (inbox-far-wakes.ts). */
interface FarReplyMachines {
  peerLinks: () => readonly PeerLink[];
  nameOf: (machine: string) => string | null;
  holdWrite: FarReplyDeps["holdWrite"];
  heldWrite: FarReplyDeps["heldWrite"];
  dismissHeld: FarReplyDeps["dismissHeld"];
  readThread: (ask: { thread_id?: string; message_id?: string; limit?: number }) => Promise<{ machine: string; answer: { thread_id: string } } | null>;
}

/** An answer's files read by this Inbox's attachment rules, each cut off at the size that computer takes (one that grew since it was checked). */
export const readFarFiles = (storeDir: string, paths: string[], base: string | undefined) =>
  recordInboxAttachments(storeDir, paths, { base: base ?? "/", at: new Date().toISOString(), maxBytes: { bytes: INBOX_UPLOAD_MAX_BYTES, refusal: outboxFileTooLarge } });

/** The deps over this Inbox's linked machines: where a far id is (a wake's, a listed thread's, else asked), and its files kept here. */
export function farReplyDeps(machines: FarReplyMachines, wakes: { placeOf: (id: string) => { machine: string; thread_id: string } | null }, storeDir: string): FarReplyDeps {
  const peer = (machine: string) => machines.peerLinks().find((p) => p.id === machine) ?? null;
  return {
    placeOf: async (id) => {
      const handed = wakes.placeOf(id);
      if (handed) return handed;
      const listed = machines.peerLinks().find((p) => p.list?.rows.some((row) => row.thread_id === id));
      if (listed) return { machine: listed.id, thread_id: id };
      // A message id alone: the computer that holds it says which thread (the far read's own ask).
      const found = await machines.readThread({ message_id: id.replace(/-stop$/, ""), limit: 1 });
      return found ? { machine: found.machine, thread_id: found.answer.thread_id } : null;
    },
    nameOf: machines.nameOf,
    takes: (machine) => {
      const link = peer(machine);
      if (!link) return false;
      return link.list ? link.list.marks.includes(TAG_ACROSS_MARK) : null;
    },
    answersInReply: (machine) => peer(machine)?.list?.marks.includes(ANSWERED_IN_REPLY_MARK) ?? false,
    holdWrite: machines.holdWrite,
    heldWrite: machines.heldWrite,
    dismissHeld: machines.dismissHeld,
    readFiles: (paths, base) => readFarFiles(storeDir, paths, base),
    holdFiles: (files) => holdOutboxFiles(storeDir, files, new Date().toISOString()),
  };
}

/**
 * The result lines (plain status, DRAFT). One place, so a change is one edit.
 */
export const FAR_REPLY_WORDS = {
  held: (thread: string, machine: string) => `Waiting for ${machine}: your message goes into thread ${thread} when ${machine} is back.`,
  notMarked: (machine: string) => `No question was marked answered: ${machine}, which holds this thread, runs an older Plannotator, so the card stays open there.`,
};

export const ANSWERED_IN_REPLY_MARK = "answered-in-reply";

/** A branch report's head and remote, read from this computer's git where the agent works, when it did not name them. */
function branchHere(value: unknown, folder: string | undefined): unknown {
  if (!value || typeof value !== "object" || !folder) return value;
  const branch = { ...(value as Record<string, unknown>) };
  const git = (...args: string[]) => {
    const run = spawnSync("git", ["-C", folder, ...args], { encoding: "utf8", timeout: 5_000, env: childEnv(), windowsHide: true });
    return run.status === 0 ? run.stdout.trim() : "";
  };
  if (typeof branch.head !== "string" && typeof branch.name === "string") {
    const head = git("rev-parse", "--verify", "--quiet", `${branch.name}^{commit}`);
    if (head) branch.head = head;
  }
  if (typeof branch.remote_url !== "string") {
    const remote = git("remote", "get-url", "origin");
    if (remote) branch.remote_url = remote;
  }
  return branch;
}

/** A far answer's send_message arguments as a local send compares them for a reused key (its `thread` is a reply's). */
function farCall(args: Record<string, unknown>): InboxSendCall {
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const ids = (value: unknown) => (Array.isArray(value) ? value.map((id) => (typeof id === "string" ? id.trim() : JSON.stringify(id))) : value === undefined || value === null ? [] : [JSON.stringify(value)]);
  const guide = args.guide && typeof args.guide === "object" ? text((args.guide as { input_sha256?: unknown }).input_sha256) : text(args.guide);
  const live = ids(Array.isArray(args.live_sites) ? args.live_sites.map((site) => (site && typeof site === "object" ? (site as { id?: unknown }).id : site)) : args.live_sites);
  return { body: text(args.body) ?? "", reply_to: text(args.reply_to), thread_name: null, reply_thread: text(args.thread)?.trim() || null, guide, supersedes: ids(args.supersedes), done: ids(args.done), answered: ids(Array.isArray(args.answered_in_reply) ? args.answered_in_reply.map((entry) => (entry && typeof entry === "object" ? (entry as { question?: unknown }).question : entry)) : args.answered_in_reply), live };
}

export async function farAgentReply(
  deps: FarReplyDeps,
  input: Record<string, unknown> & { body: string; reply_to?: string; idempotency_key?: string; agent_session?: string; agent_name?: string; agent_host?: string; project_path?: string },
  nextStep: () => Promise<string>,
  workingFolder: string | undefined,
): Promise<{ text: string; structured: Record<string, unknown> } | null> {
  // The agent's whole wait with files, the far read and the copy here included, is FAR_FILES_WAIT_MS.
  const started = Date.now();
  const replyTo = input.reply_to?.trim();
  const session = input.agent_session?.trim();
  if (!replyTo || !session) return null;
  const place = await deps.placeOf(replyTo);
  if (!place) return null;
  const name = deps.nameOf(place.machine) ?? "the other computer";
  // An older Plannotator there takes no answer: refused as before, never held to be refused later.
  if (deps.takes(place.machine) === false) throw new InboxError("thread_on_other_machine", farReplyRefusal(replyTo, name));
  const here = workingFolder && isAbsolute(workingFolder) ? workingFolder : input.project_path && isAbsolute(input.project_path) ? input.project_path : undefined;
  // Files and the pictures the body shows from this disk: read here, sent there, named as the body names them.
  const given = Array.isArray(input.attachments) ? (input.attachments as unknown[]).filter((item): item is string => typeof item === "string") : [];
  const pictures = here ? planAgentBodyPictures(input.body, given, here, (path) => existsSync(path) && statSync(path).isFile()) : { body: input.body, files: [] };
  const files = [...given.map((path) => ({ path, name: null as string | null })), ...pictures.files.map((file) => ({ path: file.path, name: file.name as string | null }))];
  const key = input.idempotency_key?.trim() || `far-reply:${randomUUID()}`;
  // The outbox is this whole computer's, and the thread's computer keeps keys per project: each key is this session's
  // own (two sessions may both send "reply-1"), and the outbox's is this thread's too. The same session's retry is the
  // same send; its key reused for other words is refused, as a local send refuses it.
  const scoped = (...parts: string[]) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
  const heldKey = `far-reply:${scoped(session, place.thread_id, key)}`;
  const before = deps.heldWrite(heldKey);
  const was = before?.body.args && typeof before.body.args === "object" ? (before.body.args as Record<string, unknown>) : null;
  const asks = Array.isArray(input.answered_in_reply) && input.answered_in_reply.length > 0;
  const unmarked = asks && (was ? !Array.isArray(was.answered_in_reply) : !deps.answersInReply?.(place.machine));
  if (unmarked) {
    const { answered_in_reply: _answered, ...without } = input;
    input = without as typeof input;
  }
  if (before && !sameInboxSend(farCall(was ?? {}), farCall({ ...input, body: pictures.body, reply_to: replyTo }))) {
    throw new InboxError("idempotency_key_reused", "This idempotency_key was already used for a different message.");
  }
  // Kept here with the answer, online or away: the outbox sends them just before it (inbox-outbox-files.ts). Refused
  // now by the rules that computer's `uploads` route applies, never when it is back.
  let keptFiles: OutboxFile[] = [];
  if (!before && files.length > 0) {
    // Size and name first, so a file that computer would refuse is never copied here.
    checkOutboxFiles(files, here ?? "/");
    const read = await deps.readFiles(files.map((file) => file.path), here);
    keptFiles = await deps.holdFiles(read.map((attachment, i) => ({ attachment, name: files[i]!.name ?? attachment.name })));
  }
  const { agent_session: _session, agent_name: _name, agent_host: _host, project_path: _path, attachments: _attachments, ...rest } = input;
  const args: Record<string, unknown> = { ...rest, body: pictures.body, reply_to: replyTo, idempotency_key: `far:${scoped(session, key)}` };
  if (args.branch !== undefined) args.branch = branchHere(args.branch, here);
  const withFiles = (before?.files?.length ?? keptFiles.length) > 0;
  const held = deps.holdWrite(
    place.machine,
    FAR_AGENT_REPLY_ROUTE,
    before?.body ?? { idempotency_key: heldKey, session, ...(input.agent_host ? { host: input.agent_host } : {}), ...(input.agent_name ? { name: input.agent_name } : {}), args },
    place.thread_id,
    withFiles ? Math.max(0, FAR_FILES_WAIT_MS - (Date.now() - started)) : FAR_REPLY_WAIT_MS,
    // Refused after the agent was told it waits: the person sees it under that thread.
    { notify: true, files: keptFiles },
  );
  if (!held) return null;
  const entry = await held;
  const machine = { id: place.machine, name };
  if (entry?.state === "delivered") {
    // That computer's own send_message answer: its words and its fields, as a local send's.
    const answer = (entry.answer ?? {}) as { text?: unknown; structured?: unknown };
    const structured = answer.structured && typeof answer.structured === "object" ? (answer.structured as Record<string, unknown>) : {};
    const text = typeof answer.text === "string" ? answer.text : `${await nextStep()}`;
    return { text: unmarked ? `${FAR_REPLY_WORDS.notMarked(name)}\n${text}` : text, structured: { ...structured, machine, ...(unmarked ? { answered_in_reply_not_marked: true } : {}) } };
  }
  if (entry && (entry.state === "refused" || entry.state === "dropped" || entry.state === "cancelled")) {
    // The agent is told now: the window has nothing to add.
    deps.dismissHeld(heldKey);
    const answer = (entry.answer ?? {}) as { code?: unknown; error?: unknown };
    throw new InboxError(typeof answer.code === "string" ? answer.code : "machine_refused", typeof answer.error === "string" ? answer.error : `${name} did not take the message.`);
  }
  return { text: `${unmarked ? `${FAR_REPLY_WORDS.notMarked(name)}\n` : ""}${FAR_REPLY_WORDS.held(place.thread_id, name)} ${await nextStep()}`, structured: { thread_id: place.thread_id, held: true, machine, ...(unmarked ? { answered_in_reply_not_marked: true } : {}) } };
}
