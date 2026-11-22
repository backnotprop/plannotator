/**
 * The cross-computer half of a Combine (approval "inbox-combine-across-computers"; inbox-combine.ts runs the Combine,
 * inbox-combine-far.ts reaches the other computer). For each picked thread on the other computer:
 *
 *  - Busy there while the Combine waits: `POST combine/hold` there (`acquire`) before anything is written, refused
 *    with that computer's own "… is already being combined." when it is in one of its own waiting Combines or held by
 *    another; let go (`release`) once the Combine is done, failed or stopped. That computer keeps the hold for at most
 *    `HOLD_MS` (`holdRoute`, `held`), so a link that went never leaves a thread busy for good.
 *  - Its files and pictures copied in at the start, while that computer is surely on (`copyFiles`), and attached to the
 *    new thread's first message once it arrives (`attach`). A file that cannot be copied (too large, gone, refused,
 *    past `FILES_MAX`) is left out; the Combine goes on.
 *  - Archived there on arrival with what the read saw (`archive`; inbox-combine-guard.ts skips it there when the
 *    thread moved on); an archive still waiting after `FAR_ARCHIVE_MAX_MS` is taken back quietly (`check`).
 *  - Undo (`undo`): an archive that never left is taken back; one that landed is undone; one skipped there is left.
 * Every write is this Inbox's own in the outbox (`auto`): never the person's waiting writes or notices.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_UPLOAD_MAX_BYTES, isInboxId } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import type { InboxCombineFar, InboxCombineFarThread } from "./inbox-combine-far";
import { FAR_READ_REFUSALS } from "./inbox-machine-agent-read";
import type { OutboxEntry } from "./inbox-outbox";

/** A held archive this long after the new thread arrived is taken back: the same day the toast's Undo follows. */
export const FAR_ARCHIVE_MAX_MS = 24 * 60 * 60_000;
/** A hold from another computer lasts at most this long: as long as a Combine can wait (24 h undelivered, then 2 h). */
export const HOLD_MS = 26 * 60 * 60_000;
/** How long the start waits for the other computer to take the hold (the forward's own wait for a write). */
const HOLD_WAIT_MS = 4_000;
/** At most this many of the other computer's files are copied into one Combine. */
export const FILES_MAX = 64;
const HOLDS_FILE = "combine-holds.json";
const PICKED_MAX = 50;

/** A far picked thread as the Combine keeps it. */
export interface FarPick {
  machine: string;
  /** Archived again with a new archive line (written in since its archive). */
  reopened?: true;
  /** The archive's guard: the last message the read saw, and every question it saw (the open ones the wake carried). */
  seen: string;
  questions: string[];
}

/** A file of the other computer's picked threads, copied in at the start: its upload here, or why it was left out. */
export interface CombineFile {
  from: string;
  file: string;
  name: string;
  upload?: string;
  attached?: true;
  missed?: string;
}

/** What of a Combine record this half reads and writes. */
export interface AcrossRecord {
  id: string;
  state: string;
  at: string;
  settled_at?: string;
  threads: { id: string; archived?: true }[];
  thread?: { id: string };
  far?: Record<string, FarPick>;
  files?: CombineFile[];
}

/** A thread of this Inbox busy in another computer's waiting Combine. */
interface Hold {
  thread: string;
  combine: string;
  machine: string;
  at: string;
}

export interface CombineAcrossDeps {
  store: InboxStore;
  far: () => InboxCombineFar | null;
  now: () => number;
  /** Writes the Combine records (combines.json). */
  save: () => void;
  /** A linked machine's name, for the words of a refusal. */
  nameOf: (machine: string) => string;
}

const resolveRoute = (thread: string) => `messages/${encodeURIComponent(thread)}/resolve`;
const pending = (entry: OutboxEntry | null) => entry?.state === "queued" || entry?.state === "sending";
const skippedThere = (entry: OutboxEntry | null) => !!entry && entry.state === "delivered" && typeof (entry.answer as { skipped?: unknown } | null)?.skipped === "string";

export function createCombineAcross(deps: CombineAcrossDeps) {
  const { store, now } = deps;
  const key = (record: AcrossRecord, step: "reopen" | "archive" | "undo", thread: string) => `${record.id}-${step}-${thread}`;
  /** The far picks still to archive or bring back: archived there before the Combine, they are left as they were. */
  const picks = (record: AcrossRecord) => record.threads.flatMap((t) => (record.far?.[t.id] && !t.archived ? [{ id: t.id, pick: record.far[t.id]! }] : []));
  const machinesOf = (record: AcrossRecord) => [...new Set(Object.values(record.far ?? {}).map((p) => p.machine))];

  // ── This computer's threads held by another computer's waiting Combine ──
  const holdsPath = () => join(store.dir, HOLDS_FILE);
  const readHolds = (): Hold[] => {
    try {
      const value = JSON.parse(readFileSync(holdsPath(), "utf8")) as { holds?: unknown };
      return Array.isArray(value.holds) ? (value.holds as Hold[]).filter((h) => h && typeof h.thread === "string" && isInboxId("cmb", h.combine)) : [];
    } catch {
      return [];
    }
  };
  let holds = readHolds();
  const saveHolds = () => {
    holds = holds.filter((h) => now() - Date.parse(h.at) < HOLD_MS);
    mkdirSync(store.dir, { recursive: true, mode: 0o700 });
    const temp = `${holdsPath()}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, holds })}\n`, { mode: 0o600 });
    renameSync(temp, holdsPath());
  };
  /** The other computer's Combine that holds this thread now, if any (`except`: that one's own hold does not count). */
  const held = (thread: string, except?: string) => holds.some((h) => h.thread === thread && h.combine !== except && now() - Date.parse(h.at) < HOLD_MS);

  /**
   * `POST combine/hold` from a linked machine's door: `{ combine, threads, hold }`. Holding refuses a thread in one of
   * this Inbox's waiting Combines (`busyHere`) or held by another Combine, with this Inbox's busy words; letting go
   * drops that Combine's holds.
   */
  const holdRoute = (body: Record<string, unknown>, machine: string, busyHere: (thread: string) => boolean): { held: string[] } => {
    const combine = typeof body.combine === "string" ? body.combine : "";
    const threads = Array.isArray(body.threads) ? body.threads : null;
    if (!isInboxId("cmb", combine) || !threads || threads.length === 0 || threads.length > PICKED_MAX || threads.some((t) => typeof t !== "string" || !isInboxId("msg", t))) {
      throw new InboxError("validation_error", "combine: a cmb_ id; threads: this Inbox's thread ids.", { field: "threads" });
    }
    const ids = [...new Set(threads as string[])];
    if (body.hold === false) {
      holds = holds.filter((h) => !(h.combine === combine && h.machine === machine));
      saveHolds();
      return { held: [] };
    }
    for (const id of ids) {
      const root = store.message(id);
      if (!root || root.thread_id !== id) throw new InboxError("thread_not_found", `No thread ${id} on this machine.`, { field: "threads" });
    }
    const busy = ids.find((id) => busyHere(id) || held(id, combine));
    if (busy) throw new InboxError("already_combining", `${store.threadSubject(busy) ?? busy} is already being combined.`, { field: "thread_ids" });
    const at = new Date(now()).toISOString();
    holds = [...holds.filter((h) => !(h.combine === combine && ids.includes(h.thread))), ...ids.map((thread) => ({ thread, combine, machine, at }))];
    saveHolds();
    return { held: ids };
  };

  // ── The other computer's picks of this Inbox's Combine ──

  /** Busy there before anything is written here. Throws, with that computer's words or why it could not be asked. */
  const acquire = async (id: string, machine: string, threads: readonly string[]): Promise<void> => {
    const far = deps.far();
    if (!far) throw new InboxError("machine_offline", FAR_READ_REFUSALS.away(deps.nameOf(machine)), { machine });
    const holdKey = `${id}-hold`;
    const entry = await far.write(machine, "combine/hold", { idempotency_key: holdKey, combine: id, threads: [...threads], hold: true }, null, HOLD_WAIT_MS);
    if (entry?.state === "delivered") return;
    if (entry?.state === "refused") {
      const answer = (entry.answer ?? {}) as { code?: unknown; error?: unknown };
      if (answer.code === "already_combining" && typeof answer.error === "string") throw new InboxError("already_combining", answer.error, { field: "thread_ids" });
      if (answer.code === "thread_not_found") throw new InboxError("thread_not_found", FAR_READ_REFUSALS.notHere(threads[0] ?? ""), { field: "thread_ids", machine });
      throw new InboxError("machine_needs_update", FAR_READ_REFUSALS.older(deps.nameOf(machine)), { machine });
    }
    // Not answered in time: taken back when it never left; let go there when it did.
    if (far.cancel(holdKey)?.state !== "cancelled") void far.write(machine, "combine/hold", { idempotency_key: `${id}-hold-release`, combine: id, threads: [...threads], hold: false }, null, 0);
    throw new InboxError("machine_offline", FAR_READ_REFUSALS.away(deps.nameOf(machine)), { machine });
  };

  /** Let go of the holds there (done, failed or stopped). The same key again sends nothing new. */
  const release = (record: AcrossRecord) => {
    const far = deps.far();
    if (!far || !record.far) return;
    for (const machine of machinesOf(record)) {
      const threads = Object.entries(record.far).flatMap(([thread, pick]) => (pick.machine === machine ? [thread] : []));
      void far.write(machine, "combine/hold", { idempotency_key: `${record.id}-release`, combine: record.id, threads, hold: false }, null, 0).catch(() => {});
    }
  };

  /** The new thread arrived: each far pick archived there under its guard (one written in since its archive, first brought back). */
  const archive = (record: AcrossRecord) => {
    const far = deps.far();
    if (!far || !record.far) return;
    for (const { id, pick } of picks(record)) {
      const guard = { seen_through_message: pick.seen, seen_questions: pick.questions };
      if (pick.reopened) void far.write(pick.machine, resolveRoute(id), { resolved: false, idempotency_key: key(record, "reopen", id), ...guard }, id, 0).catch(() => {});
      void far.write(pick.machine, resolveRoute(id), { resolved: true, idempotency_key: key(record, "archive", id), ...guard }, id, 0).catch(() => {});
    }
    release(record);
  };

  /** Undo: an archive that never left is taken back; one that landed (or may have) is undone there, after it; one skipped there is left. */
  const undo = async (record: AcrossRecord, waitMs: number): Promise<void> => {
    const far = deps.far();
    if (!far || !record.far) return;
    const sent: Promise<unknown>[] = [];
    for (const { id, pick } of picks(record)) {
      const archived = far.entry(key(record, "archive", id));
      if (!archived) continue;
      if (archived.state === "queued") {
        far.cancel(key(record, "reopen", id));
        if (far.cancel(key(record, "archive", id))?.state === "cancelled") continue;
      }
      const current = far.entry(key(record, "archive", id));
      if (skippedThere(current) || (current?.state !== "delivered" && current?.state !== "sending" && current?.state !== "queued")) continue;
      // Under the same guard: an archive still on its way may yet be skipped there, and then this undoes nothing.
      sent.push(far.write(pick.machine, resolveRoute(id), { resolved: false, idempotency_key: key(record, "undo", id), seen_through_message: pick.seen, seen_questions: pick.questions }, id, waitMs).catch(() => {}));
    }
    await Promise.all(sent);
  };

  /** The computers whose archive or Undo for this Combine still waits to land. */
  const waitingOn = (record: AcrossRecord): string[] => {
    const far = deps.far();
    if (!far || !record.far) return [];
    const steps = record.state === "undone" ? (["undo"] as const) : (["reopen", "archive"] as const);
    return [...new Set(picks(record).flatMap(({ id, pick }) => (steps.some((step) => pending(far.entry(key(record, step, id)))) ? [pick.machine] : [])))];
  };

  /**
   * Every check: an archive still waiting past its day is taken back. Once a run, with the machines up: the writes of
   * Combines settled within that day, in case this Inbox stopped before they were held (the same keys send nothing twice).
   */
  let replayed = false;
  const check = (records: readonly AcrossRecord[]) => {
    const far = deps.far();
    if (!far) return;
    for (const record of records) {
      if (!record.far || record.state !== "done" || now() - Date.parse(record.settled_at ?? record.at) <= FAR_ARCHIVE_MAX_MS) continue;
      for (const { id } of picks(record)) for (const step of ["reopen", "archive"] as const) far.cancel(key(record, step, id));
    }
    if (replayed) return;
    replayed = true;
    for (const record of records) {
      if (!record.far || record.state === "asked" || now() - Date.parse(record.settled_at ?? record.at) > FAR_ARCHIVE_MAX_MS) continue;
      if (record.state === "done") archive(record);
      else if (record.state === "undone") void undo(record, 0);
      else release(record);
    }
  };

  // ── Files ──
  const attaching = new Map<string, Promise<void>>();
  /** The copied files, on the new thread's first message once it is here; one at a time per Combine. */
  const attach = (record: AcrossRecord): Promise<void> => {
    const run = (attaching.get(record.id) ?? Promise.resolve()).then(async () => {
      if (record.state !== "done" || !record.thread || !record.files) return;
      let changed = false;
      for (const file of record.files) {
        if (!file.upload || file.attached || file.missed) continue;
        try {
          const [attachment] = await inboxUploadAttachments(store.dir, [file.upload], new Date(now()).toISOString());
          store.attachReferencedFile(record.thread.id, attachment!);
          removeInboxUploads(store.dir, [file.upload]);
          file.attached = true;
        } catch (error) {
          file.missed = error instanceof InboxError ? error.code : "not_attached";
        }
        changed = true;
      }
      if (changed) deps.save();
    });
    attaching.set(record.id, run.catch(() => {}));
    return run;
  };

  /** The other computer's files, copied here one at a time while it is on: each kept as an upload until the thread comes. */
  const copyFiles = async (record: AcrossRecord, threads: readonly InboxCombineFarThread[]): Promise<void> => {
    const far = deps.far();
    const all = threads.flatMap((t) => t.files);
    if (!far || all.length === 0) return;
    record.files = all.map((f, i) => ({ from: f.message, file: f.file, name: f.name, ...(i >= FILES_MAX ? { missed: "too_many" } : {}) }));
    deps.save();
    for (const [i, file] of record.files.entries()) {
      if (file.missed) continue;
      if (all[i]!.size > INBOX_UPLOAD_MAX_BYTES) file.missed = "file_too_large";
      else {
        try {
          const response = await far.fetchFile({ message_id: file.from, file: file.file });
          // Its name as that computer gave it, checked as an upload's (no path, no dotenv name): never a path from there.
          file.upload = (await receiveInboxUpload(store.dir, file.name, response.body, { at: new Date(now()).toISOString() })).upload_id;
        } catch (error) {
          file.missed = error instanceof InboxError ? error.code : "not_copied";
        }
      }
      deps.save();
    }
    await attach(record);
  };

  /** Uploads a Combine copied in and has not attached yet: the upload sweep keeps them. */
  const uploads = (records: readonly AcrossRecord[]): string[] => records.flatMap((r) => (r.files ?? []).flatMap((f) => (f.upload && !f.attached && !f.missed ? [f.upload] : [])));

  return { holdRoute, held, acquire, release, archive, undo, waitingOn, check, copyFiles, attach, uploads };
}
