/**
 * Plannotator Inbox: the outbox for linked machines (docs/agent-guides/
 * inbox-machines.md). Every write the person makes on another machine's
 * thread goes through here, whether that machine is online or asleep: one
 * path, one sender loop per machine. Nothing else in the server queues,
 * retries or tells the person about a write to another machine.
 *
 * The rules (PLAN.md section 12, from the formal model), and where each lives:
 *
 *   1  One key end to end      `submit` keeps the window's own key; a second
 *                              Send under it answers the first one's entry.
 *   2  One queue per machine   `drain`: one sender loop per machine, oldest
 *                              first, one request at a time (FIFO per machine
 *                              is FIFO per thread).
 *   3  Refusals leave          `settle`: a 4xx ends the entry, with a notice.
 *   4  Unlink/revoke empties   `dropMachine`: "not delivered", or "may have
 *                              been delivered" for one that had left.
 *   7  Atomic file             append-only lines; `compact` writes a temp file
 *                              then renames it. Never a rewrite in place.
 *  10  Left is never "not sent" `left` is written before the request goes;
 *                              only an entry that never left reads "not
 *                              delivered".
 *  11  Late words refused      `replyIsStale`, run by the owning machine's
 *                              reply route on `seen_through_seq`.
 *  12  "Sending…" until known  states `queued` and `sending` until the owner
 *                              answers; `delivered` only on its 2xx.
 *  17  Only revoke stops       `classifyAnswer`: 401 device_revoked/invalid
 *                              is `revoked`; every other failure retries.
 *
 * Plus the design review's bound: a write the owner keeps failing with 5xx is
 * parked after OUTBOX_MAX_SERVER_ERRORS tries as "may have been delivered",
 * so one poison entry never blocks a machine's queue for ever. A write this
 * Inbox makes itself (`auto`) that gets a 5xx steps aside until the next try:
 * the person's writes behind it are never held by it.
 *
 * Files: `inbox/outbox/<machine id>.jsonl`, 0600. Each line is a full
 * snapshot of one entry (the store's line rules: the last line per key wins,
 * a torn last line is skipped). Only small JSON is held here, never a file's
 * bytes. A file the window sends (`uploads`, `markups`) never enters the
 * outbox: it streams through while the machine is online. An agent's answer
 * in another computer's thread waits with its files: its entry names this
 * Inbox's own pending uploads (`files`), whose bytes stay in the store's blob
 * folder, kept while the entry waits or its notice stands. They go up in
 * their own lane (inbox-outbox-file-lane.ts), each id there saved on the
 * entry as it comes (`sent_files`); the write queue passes the entry by until
 * they are all there (`outboxWaitsForFiles`), then sends the write once under
 * its key (inbox-outbox-files.ts).
 */

import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JsonLines } from "@plannotator/shared/inbox/devices";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { inboxTidyWords, type InboxSentFromPlace } from "@plannotator/core/inbox-types";
import type { OutboxFile } from "./inbox-outbox-files";

export const INBOX_OUTBOX_DIR = "outbox";
/** The header a linked machine's Inbox sends with a write the person made in its window (`OutboxEntry.window`). */
export const MACHINE_WINDOW_HEADER = "X-Plannotator-Window";
/** A write the owner answered 5xx this many times in a row is parked (not retried again). */
export const OUTBOX_MAX_SERVER_ERRORS = 5;
/** How long a settled entry is kept, so a retried Send under its key still answers it (rule 1). */
export const OUTBOX_KEEP_SETTLED_MS = 7 * 24 * 3600_000;
/** How long a notice nobody dismissed is kept. */
export const OUTBOX_KEEP_NOTICE_MS = 30 * 24 * 3600_000;
/** The largest JSON body the outbox holds. A window's files go straight to the machine; a held agent answer's files are named, not held, here. */
export const OUTBOX_MAX_BODY_BYTES = 256 * 1024;

/**
 * `queued`: never left this Inbox. `sending`: a request left, no answer yet
 * (it may have been applied). `delivered`: the owner answered 2xx.
 * `refused`: the owner answered 4xx. `parked`: repeated 5xx, given up.
 * `dropped`: the link went (Unlink, or the other machine removed this one).
 * `cancelled`: the person cancelled it before it ever left (a launch held for a machine that is asleep); or one of
 * this Inbox's own past its `send_by` (it may have left: `left` says), or behind one that surely did not land (`follows`).
 */
export type OutboxState = "queued" | "sending" | "delivered" | "refused" | "parked" | "dropped" | "cancelled";

export type OutboxNoticeKind = "refused" | "not_delivered" | "may_have_been_delivered";

export interface OutboxEntry {
  v: 1;
  key: string;
  machine: string;
  /** The door route, as `messages/msg_…/reply`. */
  route: string;
  body: Record<string, unknown>;
  /** Queue order within the machine. */
  n: number;
  queued_at: string;
  state: OutboxState;
  /** A request carrying it left this Inbox at least once (rule 10). */
  left: boolean;
  /** 5xx answers in a row. */
  errors: number;
  /** The owner's answer, once there is one (replayed for the same key, rule 1). */
  status: number | null;
  answer: unknown;
  settled_at: string | null;
  /** What the person is told about an entry that did not land (rules 3, 4). */
  notice: { kind: OutboxNoticeKind; at: string } | null;
  dismissed: boolean;
  /**
   * The thread the write is about, as the window that pressed Send named it (`X-Plannotator-Thread`), so the window
   * shows a held answer even when that thread cannot open. Never sent on; absent from an older entry.
   */
  thread?: string | null;
  /** The machine's name, kept when its link went (dropMachine), so what was not sent can still say where it was going. */
  machine_name?: string | null;
  /**
   * A press in this Inbox's window made it (the forward checked the Origin and page session). Sent on as
   * `X-Plannotator-Window`: the other machine answers a permission prompt, or starts, stops or trusts an agent, only for one.
   */
  window?: true;
  /** Where the person was when not at this Inbox's own window (inbox-sent-from.ts). Sent on as `X-Plannotator-Sent-From`. */
  sent_from?: InboxSentFromPlace;
  /**
   * This Inbox made it itself, not a press of the person's (a Combine's archive on that machine, its Undo, its busy
   * mark; inbox-combine-far.ts): never listed as waiting, never a notice. Its maker reads how it ended by its key.
   */
  auto?: true;
  /**
   * This Inbox's own write that undoes another (a Combine's Undo of its archive there), queued right behind it: sent
   * only once that one may have been applied there; one that surely was not (refused, skipped there, taken back before
   * it left) takes this one with it, `cancelled`, never sent.
   */
  follows?: string;
  /**
   * This Inbox's own write that is only worth sending until then (a Combine's archive there: its day): past it, it is
   * never sent again, even one that left once, and ends `cancelled` (`cancel` then takes it back too, unless a request
   * is on its way right now). So nothing of it lands after its maker said it did not.
   */
  send_by?: string;
  /**
   * This Inbox's own write the person is told about when it does not land (an agent's answer in another computer's
   * thread, held while that computer was away; inbox-mcp-far-reply.ts): its refusal is a notice, as a window's write's.
   */
  notify?: true;
  /**
   * That answer's files (inbox-outbox-files.ts): this Inbox's own pending uploads, sent to the machine's `uploads` route
   * just before the write, their ids there put in `body.args.attachments`. Never on the wire as they are.
   */
  files?: OutboxFile[];
  /** Their ids on that machine so far, saved as each one lands, so a retry sends no file twice. */
  sent_files?: string[];
  /**
   * Which try of the files those are (their keys there): one more each time a file stalled (a stuck upload there
   * keeps its key busy) and when that machine forgot the ids.
   */
  files_try?: number;
  /** Its files went again once already, after that machine forgot their ids. */
  files_again?: true;
}

/** Whether a settled entry may have been applied there: delivered (and not skipped there by its guard), given up after 5xx, or taken back after it left. */
export function outboxMayHaveApplied(entry: OutboxEntry): boolean {
  if (entry.state === "delivered") return typeof (entry.answer as { skipped?: unknown } | null)?.skipped !== "string";
  return entry.state === "parked" || ((entry.state === "dropped" || entry.state === "cancelled") && entry.left);
}

/** What one try got back: the owner's status and JSON body, or `null` when the machine could not be reached. */
export type OutboxAnswer = { status: number; body: unknown } | null;

/** A held answer still sending its files (inbox-outbox-file-lane.ts): the write queue passes it by until they are all there. */
export function outboxWaitsForFiles(entry: OutboxEntry): boolean {
  return pending(entry) && !!entry.files && entry.files.length > 0 && (entry.sent_files?.length ?? 0) < entry.files.length;
}

/** An agent's answers in one thread of that machine keep their order among themselves: their session and thread. */
function answerLane(entry: OutboxEntry): string | null {
  return entry.route === "agent-reply" && typeof entry.body.session === "string" ? `${entry.body.session}\u0000${entry.thread ?? ""}` : null;
}

export type AnswerClass = "delivered" | "refused" | "revoked" | "retry";

/**
 * Rules 3 and 17: what the owner's answer means for the entry. 2xx lands; a
 * 401 that says the link is gone stops the machine's queue; 408 and 429 are
 * transient; any other 4xx is the owner's definite refusal; 5xx and no
 * answer at all are retried.
 */
export function classifyAnswer(answer: OutboxAnswer): AnswerClass {
  if (answer === null) return "retry";
  const { status } = answer;
  if (status >= 200 && status < 300) return "delivered";
  if (status === 401) {
    const code = answer.body && typeof answer.body === "object" ? (answer.body as { code?: unknown }).code : undefined;
    return code === "device_revoked" || code === "device_token_invalid" ? "revoked" : "retry";
  }
  if (status === 408 || status === 429) return "retry";
  if (status >= 400 && status < 500) return "refused";
  return "retry";
}

/**
 * Rule 11, on the owning machine: a held reply carries `seen_through_seq`,
 * the newest event-log seq of the thread the person saw. It is stale when an
 * agent wrote to the thread after that: the person answered a thread that has
 * moved on, so the words are refused rather than land on the new question.
 */
export function replyIsStale(messages: readonly InboxMessage[], seenThroughSeq: number, seqOf: (id: string) => number | null): boolean {
  return messages.some((message) => message.author.kind === "agent" && (seqOf(message.id) ?? 0) > seenThroughSeq);
}

/**
 * Rule 8, scoped by one table: every write the device door takes, and why a
 * second copy of it is safe. A copy can reach the owner twice when the door's
 * per-device log cannot see the first (an Inbox restart between the store
 * line and the log line, or a re-pairing, which makes a new device).
 *
 * - `append` writes a new line, so the owner's STORE dedupes it by the key
 *   (reply: `replyByKey`; reask, a thread's new message and compose: the
 *   key on the line they write).
 * - `set` puts a state (read, archived, a pick under its revision, an
 *   annotation under its own id, a star, an agent's face), so a second copy changes nothing more.
 *   A snooze whose time has passed is the exception: it brings back a snooze
 *   still running there (`setHeldSnooze`), so a copy after a newer snooze would
 *   end that one. The owner's door answers a key it has seen without running it.
 * - `file` is an upload or a drawing: never held, sent only while online.
 * - `forge` writes to GitHub or GitLab as that machine's own gh / glab (a PR's
 *   close, reopen or merge): never held, sent only while online, and only from
 *   a press in this Inbox's window. The forge is asked first there, so a second
 *   copy is refused in the forge's words ("It is already closed."). A review
 *   thread's PRs tied there (`pulls/owner`) go the same way; the window sends
 *   it right after the thread's start.
 * - `now` is a write sent only while online, never held, and only from a press
 *   in this Inbox's window (`forwardsNow`; the other machine refuses it at its
 *   door without the window's mark). Two uses: a file a message names,
 *   attached to that message when the person comments on it (the window needs
 *   the attachment at once; the owner adds a file to its message once, so a
 *   second copy answers the same attachment); and a Combine, or a Tidy with the
 *   person's words, which asks an agent there to act on the person's threads
 *   (one held for days would archive threads nobody is looking at); and Show in
 *   Rex for an agent there (`rex/show`), which moves Rex's app at the click; and a routine's Run once now there
 *   (`scheduled/:id/run`), which starts an agent at the press.
 * - `local` is never forwarded: `doorWriteKind` has no kind for it, so the
 *   forward answers 404. A phone reaches it at this Inbox's own door. Reuse
 *   (`uploads/reuse`) is useful only as its answer, the new upload's id: a held
 *   one answers 202 with no id, so the file never reaches the reply, and is
 *   later run for nobody, perhaps on bytes the person never saw. A second copy
 *   at the door mints a second id; nothing names that upload, and the 24-hour
 *   sweep takes it (the blob stays while anything else uses it).
 * - `draft`: its body or its answer carries draft text, words a person is still typing (a reply draft's save, its
 *   Discard). It is never written to a durable record of finished commands: `submit` below throws for it and writes
 *   nothing, and the door's entry for it (inbox-devices.ts, `carries: "draft"`) is never put in its command log. The
 *   forward hands it to the reply-draft module (inbox-machine-drafts.ts), which keeps one file per thread while that
 *   machine cannot take it. A second copy is safe without a record: a save is a compare-and-set, and the owner's store
 *   answers the key it last applied to the draft (`last_key`) without writing again; a Discard names the version it
 *   throws away (`base`, which that door requires). A new route that carries draft text must be `draft`:
 *   inbox-draft-routes.test.ts fails for a route with a `draft` word in its path that is not.
 *
 * inbox-outbox.test.ts fails when a door write has no entry here.
 */
export type DoorWriteKind = "append" | "set" | "file" | "forge" | "now" | "draft" | "local";

export const DOOR_WRITES: Readonly<Record<string, DoorWriteKind>> = {
  "POST threads/:id/seen": "set",
  // Grid's look (inbox-grid-seen.ts): each field keeps its larger value, so a held look lands as of then.
  "POST grid/seen": "set",
  "POST threads/:id/read": "set",
  "POST threads/:id/unread": "set",
  "POST threads/:id/mark-unread": "set",
  "POST threads/:id/snooze": "set",
  // A star and the person's Priority live on the thread's own machine (approval "inbox-linked-marks"), like a snooze.
  "POST threads/:id/pin": "set",
  "POST pins": "set",
  "POST threads/:id/priority": "set",
  // An agent's face or given name lives on the agent's own machine (approval "inbox-linked-marks"), keyed by its id.
  "POST agent-faces": "set",
  // A thread's tag lives on the thread's own machine, named by the tag's name, and a tag's rename, delete and
  // Undo go to each machine that holds it (approval "inbox-thread-tags").
  "POST threads/:id/tags": "set",
  "POST initiatives/:id": "set",
  // A project's tags live on the project's own machine, named by the tag's name, as a thread's do.
  "POST projects/:id/tags": "set",
  // A tag's colour and "Show tag colors" carry the time the person chose, so a held one lands as of then.
  "POST tag-colours": "set",
  // A Board card lives on its project's machine (mark `cards`): a move, an edit, a link or a tag puts a state there,
  // and a link already on the card is kept once. The look never moves back; a drop seen stays seen.
  "POST cards/(crd_[^/]+)": "set",
  "POST cards/seen": "set",
  "POST cards/dropped/seen": "set",
  // A linked machine's PR (mark `pulls`): closed, reopened or merged by the gh / glab of the machine that lists it.
  "POST pulls/close": "forge",
  "POST pulls/reopen": "forge",
  "POST pulls/merge": "forge",
  "POST pulls/owner": "forge",
  // Ship (approval "inbox-ship-mode"): shipped or stopped on the machine of the agent's thread, from a press in a
  // window, now or not at all (a Ship held for days would start an agent nobody is looking at).
  "POST ships": "now",
  "POST ships/stop": "now",
  // This Inbox's own word to each linked computer that it started shipping a PR: held until it lands, so a computer
  // asleep at the Ship stops its older ship of that PR when it is back.
  "POST ships/newer": "set",
  // The PR page's look at a linked machine's PR (approval "inbox-pr-dashboard"): kept there; the newer look wins.
  "POST pulls/looked": "set",
  // A file a linked machine's agent message names, attached there when the person comments on it (approval "inbox-file-refs-open-viewer").
  "POST open-in/file/attach": "now",
  // A thread's PRs live on the thread's machine: an add of one it holds, or a remove of one it does not, changes nothing.
  "POST threads/:id/pulls": "set",
  // A pinned artifact lives on its thread's machine (mark `artifact-pins`): a pin or an unpin puts a state there.
  "POST artifact-pins": "set",
  "POST messages/:id/picks": "set",
  "POST messages/:id/reply": "append",
  "POST messages/:id/resolve": "set",
  "POST messages/:id/to": "set",
  "POST messages/:id/ack": "set",
  "POST messages/:id/send-now": "set",
  "POST messages/:id/take-back": "set",
  "POST messages/:id/reask": "append",
  "POST messages/:id/handoff/undo": "set",
  // Remove an agent from a thread and its Undo (approval "inbox-remove-agent-from-thread"): a mark on the thread's
  // own machine; a second press writes nothing.
  "POST threads/:id/remove-agent": "set",
  "POST threads/:id/remove-agent/undo": "set",
  "POST messages/:id/actions/(a-[0-9a-f]{8}(?:-\\d{1,3})?)": "set",
  // A run starts, stops or opens a terminal now, and a secret's value is never written to the outbox: sent now from a
  // press in a window there, or not at all (inbox-run-routes.ts).
  "POST messages/:id/run": "now",
  "POST messages/:id/secret": "now",
  "POST threads/:id/delete": "set",
  // A reply draft of the machine's thread (mark `reply-drafts`): draft text, so never in this outbox or the door's log.
  "POST threads/:id/draft": "draft",
  "POST threads/:id/draft/delete": "draft",
  "POST annotations": "set",
  "POST annotations/:id/remove": "set",
  "POST messages/:id/guide/reviewed": "set",
  "POST messages/:id/guide/annotations": "set",
  // A file ticked or unticked Viewed in a review on a linked machine's thread (mark `linked-reads`): `{ path, viewed }`,
  // laid over the list kept there (an older window's whole list is still taken). One file's state: a copy sets it again.
  "POST messages/:id/guide/viewed": "set",
  "POST messages/:id/annotations": "set",
  "POST threads/:id/message": "append",
  "POST messages": "append",
  "POST projects/:id/read": "set",
  "POST projects/:id/unread": "set",
  "POST projects/:id/resolve": "set",
  "POST uploads/reuse": "local",
  "POST uploads": "file",
  "POST markups": "file",
  // Tidy and Combine (approval "inbox-multi-select"): a Tidy's notes and a Combine's wake are written under the
  // body's key, so a second copy answers the first; a Combine's Stop and Undo put a state.
  "POST tidy": "append",
  "POST combine": "now",
  "POST combine/(cmb_[^/]+)/cancel": "set",
  "POST combine/(cmb_[^/]+)/undo": "set",
  // A Combine on a linked computer marks this Inbox's picked threads busy while it waits, and lets go: a state per
  // Combine and thread (inbox-combine-across.ts), sent by that Inbox itself, never the person.
  "POST combine/hold": "set",
  // A launched agent's buttons from another machine (remote launch). Stop, Trust folder and Delete put a state; Try
  // again is refused while a start runs and does nothing for a launch that is not failed or stopped.
  "POST launch/:id/stop": "set",
  "POST launch/:id/retry": "set",
  "POST launch/:id/trust": "set",
  "POST launch/:id/delete": "set",
  // Show in Rex for an agent on another machine (inbox-rex-far.ts): a press that moves Rex's app now; held for later it
  // would move it when nobody asked.
  "POST rex/show": "now",
  // Tag an agent on another computer (inbox-far-tags.ts), each sent by the Inbox itself, never the person and never
  // through the forward: a wake kept once per reply and session, an answer written under its idempotency key (its
  // files sent to `uploads` just before it, by the sender loop: inbox-outbox-files.ts), a delivery.
  "POST far-wake": "set",
  "POST agent-reply": "append",
  "POST far-delivered": "set",
  // A routine on a linked computer (mark `routines`), from a press in a window here. A create carries its
  // `idempotency_key`, which that computer keeps on the routine (one key, one routine); an edit, a turn, a delete
  // and a restore put a state; a Stop names the run it was pressed for (`run`), so a late one never ends a later run.
  // Run once now starts an agent at the press or not at all: held, it would start one hours later when nobody asked.
  // A preview is the editor's words for a schedule, wanted now or not at all.
  "POST scheduled": "append",
  "POST scheduled/preview": "now",
  "POST scheduled/(sch_[A-Za-z0-9_-]{1,80})": "set",
  "POST scheduled/(sch_[A-Za-z0-9_-]{1,80})/on": "set",
  "POST scheduled/(sch_[A-Za-z0-9_-]{1,80})/off": "set",
  "POST scheduled/(sch_[A-Za-z0-9_-]{1,80})/run": "now",
  "POST scheduled/(sch_[A-Za-z0-9_-]{1,80})/stop": "set",
  "POST scheduled/(sch_[A-Za-z0-9_-]{1,80})/delete": "set",
  "POST scheduled/(sch_[A-Za-z0-9_-]{1,80})/restore": "set",
  // A capability switch on a linked computer (mark `capabilities`): on or off, a state.
  "POST capabilities": "set",
  "POST link-back": "set",
  "POST unlink": "set",
  // Link two computers through a third (inbox-link-through.ts), each sent by the Inbox itself, never through the
  // forward. An ask is held until the broker is back (one job per pair there, so a second copy changes nothing); a
  // link code and the introduction carrying it are wanted now or not at all (a code lives 10 minutes).
  "POST link-through-ask": "set",
  "POST link-through-offer": "now",
  "POST link-through-introduce": "now",
  // On this table so rule 8 knows it. The forward refuses it before this is read: an Update is never held to run days later.
  "POST update": "set",
};

const DOOR_WRITE_ROUTES = Object.entries(DOOR_WRITES).flatMap(([name, kind]) =>
  kind === "local" ? [] : [{ kind, route: new RegExp(`^${name.slice("POST ".length).replaceAll(":id", "[^/]+")}$`) }],
);

/**
 * The forward's one decision, by route and never by Content-Type: a `file`,
 * a `forge` or a `now` write goes straight through while the machine is online; a `draft` goes to the reply-draft
 * module; every other write is held in the outbox. Null: no forwarded door write has that route, so it is
 * never forwarded (a write rule 8 has not classified, or calls `local`, cannot
 * reach another machine).
 */
export function doorWriteKind(route: string): Exclude<DoorWriteKind, "local"> | null {
  return DOOR_WRITE_ROUTES.find((entry) => entry.route.test(route))?.kind ?? null;
}

/**
 * A write the forward sends now, from a press in the window, or not at all: rule 8's `now` (a Combine), and a Tidy
 * with the person's words, which a later run would apply to threads nobody looked at since. A Tidy without words is
 * held like any append.
 */
export function forwardsNow(route: string, body: Record<string, unknown>): boolean {
  return doorWriteKind(route) === "now" || (route === "tidy" && inboxTidyWords(body.words) !== "");
}

/**
 * The receiving side of `forwardsNow`: a Combine or a Tidy with words that came through this Inbox's door from
 * another machine without the mark of a press in its window. `door` null: not through the door.
 */
export function doorRefusesBare(door: { window: boolean } | null | undefined, route: string, body: Record<string, unknown>): boolean {
  return !!door && !door.window && (route === "combine" || route === "tidy") && forwardsNow(route, body);
}

/** Statuses a proxy in front of the owner answers when the owner itself never got the request (`tailscale serve` with the Inbox down). */
export const GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

const MACHINE_FILE = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;

function isEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return e.v === 1 && typeof e.key === "string" && typeof e.machine === "string" && typeof e.route === "string" && typeof e.n === "number" && typeof e.state === "string";
}

const pending = (entry: OutboxEntry) => entry.state === "queued" || entry.state === "sending";

export interface OutboxChange {
  machine: string;
  entry: OutboxEntry;
}

export class InboxOutbox {
  private readonly dir: string;
  private readonly entries = new Map<string, OutboxEntry>();
  private readonly files = new Map<string, JsonLines<OutboxEntry>>();
  private readonly draining = new Map<string, Promise<DrainResult>>();
  private readonly again = new Set<string>();
  private readonly listeners = new Set<(change: OutboxChange) => void>();
  private readonly waiters = new Map<string, Set<() => void>>();
  /** The keys whose request is on its way now. */
  private readonly inFlight = new Set<string>();
  /** The folder is made with the first held write: an Inbox that never links keeps none. */
  private dirMade = false;
  /** The store's folder, where a held answer's files wait (its pending uploads and blobs). */
  readonly storeDir: string;

  private constructor(
    dataDir: string,
    private readonly now: () => Date,
  ) {
    this.storeDir = inboxDir(dataDir);
    this.dir = join(this.storeDir, INBOX_OUTBOX_DIR);
    for (const name of safeReaddir(this.dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const machine = name.slice(0, -".jsonl".length);
      if (!MACHINE_FILE.test(machine)) continue;
      for (const line of this.file(machine).read()) {
        if (isEntry(line) && line.machine === machine) this.entries.set(line.key, line);
      }
    }
    this.compact();
  }

  static open(dataDir: string, now: () => Date = () => new Date()): InboxOutbox {
    return new InboxOutbox(dataDir, now);
  }

  private file(machine: string): JsonLines<OutboxEntry> {
    let file = this.files.get(machine);
    if (!file) {
      file = new JsonLines<OutboxEntry>(join(this.dir, `${machine}.jsonl`));
      this.files.set(machine, file);
    }
    return file;
  }

  /** Write the entry's new snapshot, then tell the listeners. The line is on disk before anyone hears of it. */
  private save(entry: OutboxEntry): OutboxEntry {
    if (!this.dirMade) {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.dirMade = true;
    }
    this.file(entry.machine).append(entry);
    this.entries.set(entry.key, entry);
    for (const listener of this.listeners) listener({ machine: entry.machine, entry });
    if (!pending(entry)) {
      for (const wake of this.waiters.get(entry.key) ?? []) wake();
      this.waiters.delete(entry.key);
    }
    return entry;
  }

  onChange(listener: (change: OutboxChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get(key: string): OutboxEntry | null {
    return this.entries.get(key) ?? null;
  }

  /** A held answer's files so far sent there (inbox-outbox-files.ts), saved before the next request leaves. */
  noteSentFiles(key: string, sent: readonly string[], attempt = 0): void {
    const entry = this.entries.get(key);
    if (entry && pending(entry)) this.save({ ...entry, sent_files: [...sent], ...(attempt > 0 ? { files_try: attempt } : {}) });
  }

  /**
   * A held answer's file that stalled or met a server error there: counted as a 5xx is. Nothing of the answer reached
   * that machine, so after OUTBOX_MAX_SERVER_ERRORS it ends refused (its notice says why), never "may have been delivered".
   */
  filesFailed(key: string, answer: { status: number; body: unknown }): void {
    const entry = this.entries.get(key);
    if (!entry || !pending(entry)) return;
    const errors = entry.errors + 1;
    if (errors >= OUTBOX_MAX_SERVER_ERRORS) this.settle({ ...entry, errors }, answer, "refused");
    else this.save({ ...entry, errors });
  }

  /** A held answer's file that machine refused (or that is no longer here): the answer is refused, a notice. */
  filesRefused(key: string, answer: { status: number; body: unknown }): void {
    const entry = this.entries.get(key);
    if (entry && pending(entry)) this.settle(entry, answer, "refused");
  }

  /**
   * That machine forgot a held answer's file ids (its upload sweep took them while it was away a day): its files go
   * again, once, under new keys. False when they went again already (the refusal then stands).
   */
  filesForgotten(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry || !pending(entry) || entry.files_again) return false;
    this.save({ ...entry, sent_files: [], files_try: (entry.files_try ?? 0) + 1, files_again: true });
    return true;
  }

  /** A machine's entries in queue order (all of them, or only those not settled). */
  list(machine: string, only: "pending" | "all" = "all"): OutboxEntry[] {
    return [...this.entries.values()].filter((e) => e.machine === machine && (only === "all" || pending(e))).sort((a, b) => a.n - b.n);
  }

  /** Every entry the person has not been told about yet, or not dismissed: refusals and losses (rules 3, 4). */
  notices(): OutboxEntry[] {
    return [...this.entries.values()].filter((e) => e.notice !== null && !e.dismissed && (!e.auto || e.notify)).sort((a, b) => (a.notice!.at < b.notice!.at ? -1 : 1));
  }

  dismiss(key: string): OutboxEntry | null {
    const entry = this.entries.get(key);
    if (!entry || entry.dismissed || entry.notice === null) return entry ?? null;
    return this.save({ ...entry, dismissed: true });
  }

  /**
   * Rule 1: queue the window's write under its own key. The same key again
   * (a retried Send, a page that lost the answer) answers the entry it made,
   * whatever state it is in, and queues nothing. The same key on another
   * route or machine is refused, as the door refuses it. A `draft` route is
   * refused before anything is written: draft text is never held here.
   */
  submit(
    machine: string,
    route: string,
    body: Record<string, unknown>,
    thread: string | null = null,
    window = false,
    sentFrom: InboxSentFromPlace | null = null,
    auto = false,
    own: { follows?: string; send_by?: string; notify?: boolean; files?: readonly OutboxFile[] } = {},
  ): { entry: OutboxEntry; fresh: boolean } {
    if (doorWriteKind(route) === "draft") throw new InboxError("draft_not_held", "A draft is never held in the outbox.", { field: "route" });
    if (!MACHINE_FILE.test(machine)) throw new InboxError("validation_error", "machine: an ibx_ id.", { field: "machine" });
    const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
    if (!key) throw new InboxError("validation_error", "idempotency_key: required on a write to another machine.", { field: "idempotency_key" });
    if (JSON.stringify(body).length > OUTBOX_MAX_BODY_BYTES) {
      throw new InboxError("validation_error", `body: at most ${OUTBOX_MAX_BODY_BYTES} bytes are held for another machine; send files while it is online.`, { field: "body" });
    }
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.machine !== machine || existing.route !== route) {
        throw new InboxError("idempotency_key_reused", "This idempotency_key was already used on another route.", { field: "idempotency_key" });
      }
      return { entry: existing, fresh: false };
    }
    const n = Math.max(0, ...this.list(machine).map((e) => e.n)) + 1;
    const entry = this.save({
      v: 1,
      key,
      machine,
      route,
      body: { ...body, idempotency_key: key },
      n,
      queued_at: this.now().toISOString(),
      state: "queued",
      left: false,
      errors: 0,
      status: null,
      answer: null,
      settled_at: null,
      notice: null,
      dismissed: false,
      thread,
      ...(window ? { window: true as const } : {}),
      ...(sentFrom ? { sent_from: sentFrom } : {}),
      ...(auto ? { auto: true as const } : {}),
      ...(auto && own.follows ? { follows: own.follows } : {}),
      ...(auto && own.send_by ? { send_by: own.send_by } : {}),
      ...(auto && own.notify ? { notify: true as const } : {}),
      ...(auto && own.files && own.files.length > 0 ? { files: own.files.map((file) => ({ ...file })) } : {}),
    });
    return { entry, fresh: true };
  }

  /**
   * A reply draft's words held for a machine whose link went (inbox-machine-drafts.ts `forget`): one line of the
   * "Not sent" list, written already `dropped` with its notice, so it is shown and dismissed as any write that was
   * waiting for that machine. Never queued and never sent: `submit` refuses a draft route.
   */
  recordLostDraft(machine: string, thread: string, words: string, machineName: string | null): OutboxEntry {
    if (!MACHINE_FILE.test(machine)) throw new InboxError("validation_error", "machine: an ibx_ id.", { field: "machine" });
    const key = crypto.randomUUID();
    const at = this.now().toISOString();
    return this.save({
      v: 1,
      key,
      machine,
      route: `threads/${thread}/draft`,
      body: { idempotency_key: key, body: words },
      n: Math.max(0, ...this.list(machine).map((e) => e.n)) + 1,
      queued_at: at,
      state: "dropped",
      left: false,
      errors: 0,
      status: null,
      answer: null,
      settled_at: at,
      notice: { kind: "not_delivered", at },
      dismissed: false,
      thread,
      ...(machineName ? { machine_name: machineName } : {}),
    });
  }

  /**
   * The person cancels a write that waits and never left (rule 10: one that left may have landed, so it stays). The
   * sender loop sends nothing it finds cancelled. Answers the entry as it is now; null when there is no such key.
   */
  cancel(key: string): OutboxEntry | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    // Past its `send_by`, one that left is taken back too, once no request of it is on its way: none leaves again.
    const expired = !!entry.send_by && pending(entry) && this.pastSendBy(entry) && !this.inFlight.has(key);
    if (!expired && (entry.state !== "queued" || entry.left)) return entry;
    return this.save({ ...entry, state: "cancelled", settled_at: this.now().toISOString() });
  }

  private pastSendBy(entry: OutboxEntry): boolean {
    return !!entry.send_by && this.now().getTime() >= Date.parse(entry.send_by);
  }

  /** Resolves when the entry settles, or after `ms`, whichever is first. */
  waitSettled(key: string, ms: number): Promise<OutboxEntry | null> {
    const entry = this.entries.get(key);
    if (!entry || !pending(entry) || ms <= 0) return Promise.resolve(entry ?? null);
    return new Promise((resolve) => {
      const set = this.waiters.get(key) ?? new Set();
      const done = () => {
        clearTimeout(timer);
        set.delete(done);
        resolve(this.entries.get(key) ?? null);
      };
      const timer = setTimeout(done, ms);
      set.add(done);
      this.waiters.set(key, set);
    });
  }

  private settle(entry: OutboxEntry, answer: { status: number; body: unknown }, state: "delivered" | "refused"): OutboxEntry {
    const at = this.now().toISOString();
    return this.save({
      ...entry,
      state,
      status: answer.status,
      answer: answer.body,
      settled_at: at,
      notice: state === "refused" ? { kind: "refused", at } : null,
    });
  }

  /**
   * Rule 4: the link to `machine` is gone (Unlink here or there, or the
   * owner removed this Inbox). Every entry still waiting ends with a notice:
   * "not delivered" when no request ever left, "may have been delivered"
   * when one did (rule 10).
   */
  dropMachine(machine: string, name: string | null = null): OutboxEntry[] {
    const at = this.now().toISOString();
    // Ended earlier without a name (a drain that met the other side's Unlink): its name too, now it is known.
    if (name) for (const entry of this.list(machine)) if (entry.state === "dropped" && !entry.machine_name) this.save({ ...entry, machine_name: name });
    return this.list(machine, "pending").map((entry) =>
      this.save({
        ...entry,
        state: "dropped",
        settled_at: at,
        notice: { kind: entry.left ? "may_have_been_delivered" : "not_delivered", at },
        // The machine is forgotten with its link: its name stays with what was not sent to it.
        ...(name ? { machine_name: name } : {}),
      }),
    );
  }

  /**
   * Rule 2: the one sender loop for a machine. Sends its waiting entries
   * oldest first, one at a time; each waits for the one before it to have a
   * definite result. Stops at the first try that cannot finish (the machine
   * unreachable, or a 5xx under the bound) so the order holds. A call while
   * the loop runs makes it look again before it returns, so a write queued
   * meanwhile is never left behind.
   */
  drain(machine: string, send: (entry: OutboxEntry) => Promise<OutboxAnswer>): Promise<DrainResult> {
    const running = this.draining.get(machine);
    if (running) {
      this.again.add(machine);
      return running;
    }
    const run = (async (): Promise<DrainResult> => {
      try {
        for (;;) {
          this.again.delete(machine);
          const result = await this.drainOnce(machine, send);
          if (result !== "empty" || !this.again.has(machine)) return result;
        }
      } finally {
        this.draining.delete(machine);
      }
    })();
    this.draining.set(machine, run);
    return run;
  }

  private async drainOnce(machine: string, send: (entry: OutboxEntry) => Promise<OutboxAnswer>): Promise<DrainResult> {
    // This Inbox's own writes (`auto`) yield: once one fails with a 5xx, they all wait (in their order) for the next
    // try, and the person's writes behind them go now.
    let ownFailed = false;
    for (;;) {
      // A held answer whose files are still going up (their own lane, inbox-outbox-file-lane.ts) is not this queue's
      // yet, and nor is a later answer of the same agent in the same thread: it stays behind the one before it.
      const waiting = new Set<string>();
      const head = this.list(machine, "pending").find((e) => {
        const lane = answerLane(e);
        if (outboxWaitsForFiles(e) || (lane !== null && waiting.has(lane))) {
          if (lane !== null) waiting.add(lane);
          return false;
        }
        return !(ownFailed && e.auto);
      });
      if (!head) return ownFailed ? "server_error" : "empty";
      // This Inbox's own: one past its day is never sent again; one behind a write that surely did not land goes with it.
      const before = head.follows ? this.entries.get(head.follows) : undefined;
      if (this.pastSendBy(head) || (!head.left && before && !pending(before) && !outboxMayHaveApplied(before))) {
        this.save({ ...head, state: "cancelled", settled_at: this.now().toISOString() });
        continue;
      }
      // Rule 10: on disk as having left before a byte goes out.
      const leaving = head.left ? head : this.save({ ...head, state: "sending", left: true });
      let answer: OutboxAnswer;
      this.inFlight.add(leaving.key);
      try {
        answer = await send(leaving);
      } catch {
        answer = null;
      } finally {
        this.inFlight.delete(leaving.key);
      }
      const current = this.entries.get(leaving.key);
      // Dropped while in flight (Unlink): its notice already says it may have landed.
      if (!current || !pending(current)) continue;
      // That machine forgot its files' ids: it waits for them again (`filesForgotten`), never settled by that refusal.
      if (outboxWaitsForFiles(current)) continue;
      const verdict = classifyAnswer(answer);
      if (verdict === "delivered" || verdict === "refused") {
        this.settle(current, answer!, verdict);
        continue;
      }
      if (verdict === "revoked") {
        this.dropMachine(machine);
        return "revoked";
      }
      // No answer, or a proxy's answer for an owner that never got the request: not counted toward parking.
      if (answer === null || GATEWAY_STATUSES.has(answer.status)) return "unreachable";
      // A 5xx: counted, and parked once it keeps happening, so the queue moves on.
      const errors = current.errors + 1;
      if (errors >= OUTBOX_MAX_SERVER_ERRORS) {
        const at = this.now().toISOString();
        this.save({ ...current, errors, state: "parked", status: answer.status, answer: answer.body, settled_at: at, notice: { kind: "may_have_been_delivered", at } });
        continue;
      }
      this.save({ ...current, errors });
      if (current.auto) {
        ownFailed = true;
        continue;
      }
      return "server_error";
    }
  }

  /**
   * Rule 7: drop what is no longer needed (settled entries past their keep,
   * notices past theirs) by writing each machine's kept entries to a temp
   * file and renaming it over the old one. Runs at open only.
   */
  compact(): void {
    const now = this.now().getTime();
    const keep = (entry: OutboxEntry) => {
      if (pending(entry)) return true;
      const settled = entry.settled_at ? Date.parse(entry.settled_at) : now;
      // Not sent because the link went: its words are the only copy, so it stays until the person dismisses it.
      if (entry.state === "dropped" && !entry.dismissed) return true;
      if (entry.notice !== null && !entry.dismissed) return now - settled < OUTBOX_KEEP_NOTICE_MS;
      return now - settled < OUTBOX_KEEP_SETTLED_MS;
    };
    const machines = new Set([...this.entries.values()].map((e) => e.machine));
    for (const name of safeReaddir(this.dir)) {
      const machine = name.endsWith(".jsonl") ? name.slice(0, -".jsonl".length) : "";
      if (MACHINE_FILE.test(machine)) machines.add(machine);
    }
    for (const machine of machines) {
      const all = this.list(machine);
      const kept = all.filter(keep);
      const path = join(this.dir, `${machine}.jsonl`);
      const lines = this.file(machine).read().length;
      if (kept.length === all.length && lines === all.length) continue;
      for (const entry of all) if (!keep(entry)) this.entries.delete(entry.key);
      if (kept.length === 0) {
        rmSync(path, { force: true });
        this.files.delete(machine);
        continue;
      }
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(""), { mode: 0o600 });
      renameSync(temp, path);
      this.files.delete(machine);
    }
  }
}

/** How a drain ended: nothing left, the machine unreachable, a 5xx to retry later, or the link revoked. */
export type DrainResult = "empty" | "unreachable" | "server_error" | "revoked";

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
