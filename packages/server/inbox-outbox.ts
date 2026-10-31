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
 * so one poison entry never blocks a machine's queue for ever.
 *
 * Files: `inbox/outbox/<machine id>.jsonl`, 0600. Each line is a full
 * snapshot of one entry (the store's line rules: the last line per key wins,
 * a torn last line is skipped). Only small JSON writes are held: a file
 * upload never enters the outbox.
 */

import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { JsonLines } from "@plannotator/shared/inbox/devices";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import type { InboxMessage } from "@plannotator/core/inbox-types";

export const INBOX_OUTBOX_DIR = "outbox";
/** A write the owner answered 5xx this many times in a row is parked (not retried again). */
export const OUTBOX_MAX_SERVER_ERRORS = 5;
/** How long a settled entry is kept, so a retried Send under its key still answers it (rule 1). */
export const OUTBOX_KEEP_SETTLED_MS = 7 * 24 * 3600_000;
/** How long a notice nobody dismissed is kept. */
export const OUTBOX_KEEP_NOTICE_MS = 30 * 24 * 3600_000;
/** The largest JSON body the outbox holds. Files go straight to the machine, never through here. */
export const OUTBOX_MAX_BODY_BYTES = 256 * 1024;

/**
 * `queued`: never left this Inbox. `sending`: a request left, no answer yet
 * (it may have been applied). `delivered`: the owner answered 2xx.
 * `refused`: the owner answered 4xx. `parked`: repeated 5xx, given up.
 * `dropped`: the link went (Unlink, or the other machine removed this one).
 */
export type OutboxState = "queued" | "sending" | "delivered" | "refused" | "parked" | "dropped";

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
}

/** What one try got back: the owner's status and JSON body, or `null` when the machine could not be reached. */
export type OutboxAnswer = { status: number; body: unknown } | null;

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
 *   annotation under its own id), so a second copy changes nothing more.
 * - `file` is an upload or a drawing: never held, sent only while online.
 *
 * inbox-outbox.test.ts fails when a door write has no entry here.
 */
export const DOOR_WRITES: Readonly<Record<string, "append" | "set" | "file">> = {
  "POST threads/:id/seen": "set",
  "POST threads/:id/read": "set",
  "POST threads/:id/unread": "set",
  "POST messages/:id/picks": "set",
  "POST messages/:id/reply": "append",
  "POST messages/:id/resolve": "set",
  "POST messages/:id/to": "set",
  "POST messages/:id/ack": "set",
  "POST messages/:id/send-now": "set",
  "POST messages/:id/reask": "append",
  "POST messages/:id/handoff/undo": "set",
  "POST messages/:id/actions/(a-[0-9a-f]{8}(?:-\\d{1,3})?)": "set",
  "POST threads/:id/delete": "set",
  "POST annotations": "set",
  "POST annotations/:id/remove": "set",
  "POST messages/:id/guide/reviewed": "set",
  "POST messages/:id/guide/annotations": "set",
  "POST messages/:id/annotations": "set",
  "POST threads/:id/message": "append",
  "POST messages": "append",
  "POST projects/:id/read": "set",
  "POST projects/:id/unread": "set",
  "POST projects/:id/resolve": "set",
  "POST uploads": "file",
  "POST markups": "file",
  "POST link-back": "set",
  "POST unlink": "set",
};

const DOOR_WRITE_ROUTES = Object.entries(DOOR_WRITES).map(([name, kind]) => ({
  kind,
  route: new RegExp(`^${name.slice("POST ".length).replaceAll(":id", "[^/]+")}$`),
}));

/**
 * The forward's one decision, by route and never by Content-Type: a `file`
 * goes straight through while the machine is online; every other write is
 * held in the outbox. Null: no door write has that route, so it is never
 * forwarded (a write rule 8 has not classified cannot reach another machine).
 */
export function doorWriteKind(route: string): "append" | "set" | "file" | null {
  return DOOR_WRITE_ROUTES.find((entry) => entry.route.test(route))?.kind ?? null;
}

/** Statuses a proxy in front of the owner answers when the owner itself never got the request (`tailscale serve` with the Inbox down). */
const GATEWAY_STATUSES = new Set([502, 503, 504]);

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
  /** The folder is made with the first held write: an Inbox that never links keeps none. */
  private dirMade = false;

  private constructor(
    dataDir: string,
    private readonly now: () => Date,
  ) {
    this.dir = join(inboxDir(dataDir), INBOX_OUTBOX_DIR);
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

  /** A machine's entries in queue order (all of them, or only those not settled). */
  list(machine: string, only: "pending" | "all" = "all"): OutboxEntry[] {
    return [...this.entries.values()].filter((e) => e.machine === machine && (only === "all" || pending(e))).sort((a, b) => a.n - b.n);
  }

  /** Every entry the person has not been told about yet, or not dismissed: refusals and losses (rules 3, 4). */
  notices(): OutboxEntry[] {
    return [...this.entries.values()].filter((e) => e.notice !== null && !e.dismissed).sort((a, b) => (a.notice!.at < b.notice!.at ? -1 : 1));
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
   * route or machine is refused, as the door refuses it.
   */
  submit(machine: string, route: string, body: Record<string, unknown>, thread: string | null = null): { entry: OutboxEntry; fresh: boolean } {
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
    });
    return { entry, fresh: true };
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
    for (;;) {
      const head = this.list(machine, "pending")[0];
      if (!head) return "empty";
      // Rule 10: on disk as having left before a byte goes out.
      const leaving = head.left ? head : this.save({ ...head, state: "sending", left: true });
      let answer: OutboxAnswer;
      try {
        answer = await send(leaving);
      } catch {
        answer = null;
      }
      const current = this.entries.get(leaving.key);
      // Dropped while in flight (Unlink): its notice already says it may have landed.
      if (!current || !pending(current)) continue;
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
