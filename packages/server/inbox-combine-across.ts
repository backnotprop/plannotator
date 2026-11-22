/**
 * The cross-computer half of a Combine (approval "inbox-combine-across-computers"; inbox-combine.ts runs the Combine,
 * inbox-combine-far.ts reaches the other computer). For each picked thread on the other computer:
 *
 *  - Busy there while the Combine waits: `POST combine/hold` there (`acquire`) before anything is written, refused
 *    with that computer's own "… is already being combined." when it is in one of its own waiting Combines or held by
 *    another; let go (`release`) once the Combine is done, failed or stopped. That computer keeps the hold for at most
 *    `HOLD_MS` (`holdRoute`, `held`), so a link that went never leaves a thread busy for good.
 *  - Its files and pictures copied in from the start while that computer is on (`copyFiles`), and attached to the new
 *    thread's first message once it arrives (`finish`): a restart picks up where it stopped. Copying stops once the
 *    Combine is stopped, failed or undone. A file that cannot be copied (too large, gone, refused, past `FILES_MAX` or
 *    past `FILES_MAX_BYTES` in all) is left out; the Combine goes on. The copies are kept from the upload sweep only
 *    while the Combine may still use them (`uploads`).
 *  - Archived there on arrival with what the read saw (`archive`; inbox-combine-guard.ts skips it there when the
 *    thread moved on); an archive still waiting after `FAR_ARCHIVE_MAX_MS` is taken back quietly (`check`).
 *  - One left open there (skipped, taken back, refused) is named on the new thread's first message (`combine_left`,
 *    one quiet line in the window), with every file that was not copied in (`noteLeft`).
 *  - Undo (`undo`): an archive that never left is taken back; one that landed is undone there (whatever was written in
 *    since: what it undoes did land); one skipped there is left; one still on its way is undone once it lands (`check`).
 * Every write is this Inbox's own in the outbox (`auto`): never the person's waiting writes or notices.
 *
 * This computer's picks' files and pictures go on the new thread too ("All the picked threads' files, from both
 * computers"): attached as they are (the same blob), nothing copied, so every pick's files open from the new thread.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxAttachmentId, INBOX_UPLOAD_MAX_BYTES, isInboxId, type InboxCombineLeft } from "@plannotator/core/inbox-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxUploadAttachments, receiveInboxUpload, removeInboxUploads } from "@plannotator/shared/inbox/uploads";
import type { InboxCombineFar, InboxCombineFarFile } from "./inbox-combine-far";
import { FAR_READ_REFUSALS } from "./inbox-machine-agent-read";
import type { OutboxEntry } from "./inbox-outbox";

/** How long the archive there is waited for before the new thread says what stayed open (`check` looks again later). */
const ARCHIVE_WAIT_MS = 4_000;
/** What stayed open there is looked at this long after the new thread arrived: past the day an archive may wait. */
const LEFT_WATCH_MS = 2 * 24 * 60 * 60_000;
/** A held archive this long after the new thread arrived is taken back: the same day the toast's Undo follows. */
export const FAR_ARCHIVE_MAX_MS = 24 * 60 * 60_000;
/** A hold from another computer lasts at most this long: as long as a Combine can wait (24 h undelivered, then 2 h). */
export const HOLD_MS = 26 * 60 * 60_000;
/** How long the start waits for the other computer to take the hold (the forward's own wait for a write). */
const HOLD_WAIT_MS = 4_000;
/** At most this many of the other computer's files are copied into one Combine. */
export const FILES_MAX = 64;
/** At most this many bytes of them in all (each at most INBOX_UPLOAD_MAX_BYTES): the rest is left out. */
export const FILES_MAX_BYTES = 500 * 1024 * 1024;
/** A failed Combine's copies are kept this long after it settled, in case its thread still comes (the window reads it a day). */
const FILES_KEPT_MS = 24 * 60 * 60_000;
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

/** A file of a picked thread: one of this computer's (`local`, attached as it is), or the other computer's, copied in at the start: its upload here, or why it was left out. */
export interface CombineFile {
  local?: true;
  from: string;
  file: string;
  name: string;
  /** Its size as that computer listed it; once copied, the copy's. */
  size?: number;
  upload?: string;
  /** The copy's SHA-256: an attach replayed after a restart finds it on the thread already. */
  sha256?: string;
  attached?: true;
  missed?: string;
}

/** What of a Combine record this half reads and writes. */
export interface AcrossRecord {
  id: string;
  state: string;
  at: string;
  settled_at?: string;
  threads: { id: string; subject?: string; archived?: true }[];
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
  /** The files' total (`FILES_MAX_BYTES` unless set). */
  filesMaxBytes?: number;
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
      // Deleted there since the read: that computer's own words, as a Combine here says of a thread it does not hold.
      if (answer.code === "thread_not_found") throw new InboxError("thread_not_found", typeof answer.error === "string" ? answer.error : `No thread ${threads[0] ?? ""} on this machine.`, { field: "thread_ids" });
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
    const sent: Promise<unknown>[] = [];
    for (const { id, pick } of picks(record)) {
      const guard = { seen_through_message: pick.seen, seen_questions: pick.questions };
      if (pick.reopened) void far.write(pick.machine, resolveRoute(id), { resolved: false, idempotency_key: key(record, "reopen", id), ...guard }, id, 0).catch(() => {});
      sent.push(far.write(pick.machine, resolveRoute(id), { resolved: true, idempotency_key: key(record, "archive", id), ...guard }, id, ARCHIVE_WAIT_MS).catch(() => null));
    }
    release(record);
    // Answered there (or not yet: `check` looks again): the new thread says which stayed open.
    if (sent.length > 0) void Promise.all(sent).then(() => noteLeft(record));
  };

  /** An archive that landed there (or may have, given up after 5xx): its Undo is due. One skipped there, or never sent, has nothing to undo. */
  const landed = (entry: OutboxEntry | null) => !!entry && (entry.state === "parked" || (entry.state === "delivered" && !skippedThere(entry)));
  /** The Undo there of an archive that landed: no guard, as the person's own unarchive, since what it undoes did land. */
  const sendUndo = (far: InboxCombineFar, record: AcrossRecord, id: string, pick: FarPick, waitMs: number) =>
    far.write(pick.machine, resolveRoute(id), { resolved: false, idempotency_key: key(record, "undo", id) }, id, waitMs).catch(() => null);

  /** Undo: an archive that never left is taken back; one that landed is undone; one skipped there is left; one still on its way is undone once it lands (`check`). */
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
      if (landed(far.entry(key(record, "archive", id)))) sent.push(sendUndo(far, record, id, pick, waitMs));
    }
    await Promise.all(sent);
  };

  /** The computers whose archive or Undo for this Combine still waits to land. */
  const waitingOn = (record: AcrossRecord): string[] => {
    const far = deps.far();
    if (!far || !record.far) return [];
    const waits = (id: string) => {
      if (record.state !== "undone") return pending(far.entry(key(record, "reopen", id))) || pending(far.entry(key(record, "archive", id)));
      const archived = far.entry(key(record, "archive", id));
      const undone = far.entry(key(record, "undo", id));
      // Its archive still on its way (the Undo follows it), or landed with its Undo not yet sent or not yet landed.
      return pending(archived) || pending(undone) || (landed(archived) && !undone);
    };
    return [...new Set(picks(record).flatMap(({ id, pick }) => (waits(id) ? [pick.machine] : [])))];
  };

  /**
   * Every check: an archive still waiting past its day is taken back; an Undo whose archive has landed since is sent;
   * the other computer's files are copied and attached where a restart left them. Once a run, with the machines up: the
   * writes of Combines settled within that day, in case this Inbox stopped before they were held (the same keys send
   * nothing twice).
   */
  let replayed = false;
  const check = (records: readonly AcrossRecord[]) => {
    for (const record of records) if (record.files && unfinished(record)) void finish(record);
    const far = deps.far();
    if (!far) return;
    for (const record of records) {
      if (!record.far) continue;
      const late = now() - Date.parse(record.settled_at ?? record.at) > FAR_ARCHIVE_MAX_MS;
      if (record.state === "done" && late) for (const { id } of picks(record)) for (const step of ["reopen", "archive"] as const) far.cancel(key(record, step, id));
      if (record.state === "done" && now() - Date.parse(record.settled_at ?? record.at) <= LEFT_WATCH_MS) noteLeft(record);
      if (record.state === "undone" && !late) {
        for (const { id, pick } of picks(record)) if (landed(far.entry(key(record, "archive", id))) && !far.entry(key(record, "undo", id))) void sendUndo(far, record, id, pick, 0);
      }
    }
    if (replayed) return;
    replayed = true;
    for (const record of records) {
      if (!record.far || record.state === "asked" || record.state === "undone" || now() - Date.parse(record.settled_at ?? record.at) > FAR_ARCHIVE_MAX_MS) continue;
      if (record.state === "done") archive(record);
      else release(record);
    }
  };

  // ── Files ──
  const filesMax = deps.filesMaxBytes ?? FILES_MAX_BYTES;
  /** The Combine may still use its files: it waits, or its thread is here (they go on it). Stopped, failed or undone: no more is copied. */
  const inUse = (record: AcrossRecord) => record.state === "asked" || record.state === "done";
  const reached = (file: CombineFile) => !!(file.local || file.upload || file.missed || file.attached);
  /** Ready for the new thread and not on it yet: a copy, or one of this computer's files. */
  const toAttach = (file: CombineFile) => !!(file.local || file.upload) && !file.attached && !file.missed;
  /** Something left to do: a file not reached while the Combine may still use it, or a file its thread has not got yet. */
  const unfinished = (record: AcrossRecord) =>
    inUse(record) && now() - Date.parse(record.settled_at ?? record.at) <= FILES_KEPT_MS && (record.files ?? []).some((f) => !reached(f) || (record.state === "done" && toAttach(f)));

  /** The files not reached yet, one at a time, while the Combine may use them and that computer is on; past the total, left out. */
  const copy = async (record: AcrossRecord) => {
    const far = deps.far();
    const machine = Object.values(record.far ?? {})[0]?.machine;
    if (!far || !machine || !record.files) return;
    for (const file of record.files) {
      // Stopped, failed or undone meanwhile; or that computer went: the rest waits for the next check (a restart too).
      if (!inUse(record) || !far.online(machine)) return;
      if (reached(file)) continue;
      // This computer's own files cost nothing: only copies count toward the total.
      const room = filesMax - record.files.reduce((sum, f) => sum + (!f.local && (f.upload || f.attached) ? (f.size ?? 0) : 0), 0);
      if ((file.size ?? 0) > INBOX_UPLOAD_MAX_BYTES) file.missed = "file_too_large";
      else if ((file.size ?? 0) > room) file.missed = "files_too_large";
      else {
        try {
          const response = await far.fetchFile({ message_id: file.from, file: file.file });
          // Its name as that computer gave it, checked as an upload's (no path, no dotenv name): never a path from there.
          const upload = await receiveInboxUpload(store.dir, file.name, response.body, { at: new Date(now()).toISOString(), maxBytes: Math.max(0, Math.min(INBOX_UPLOAD_MAX_BYTES, room)) });
          Object.assign(file, { upload: upload.upload_id, size: upload.size, sha256: upload.sha256 });
        } catch (error) {
          const code = error instanceof InboxError ? error.code : "not_copied";
          // Cut off by what was left of the total, not by the one file's own bound.
          const pastTotal = code === "upload_too_large" && INBOX_UPLOAD_MAX_BYTES > room;
          file.missed = pastTotal ? "files_too_large" : code;
        }
      }
      deps.save();
    }
  };

  /** The copies, on the new thread's first message once it is here: each once, a replay after a restart included. */
  const attach = async (record: AcrossRecord) => {
    if (record.state !== "done" || !record.thread || !record.files) return;
    for (const file of record.files) {
      if (!toAttach(file)) continue;
      try {
        if (file.local) {
          attachLocal(record.thread.id, file);
        } else {
          // Attached before a restart that came before it was written down: not again.
          const on = store.message(record.thread.id)?.attachments ?? [];
          if (!on.some((a) => a.sent_sha256 === file.sha256 && a.name === file.name)) {
            const [attachment] = await inboxUploadAttachments(store.dir, [file.upload!], new Date(now()).toISOString());
            store.attachReferencedFile(record.thread.id, attachment!);
          }
        }
        file.attached = true;
        deps.save();
        if (file.upload) removeInboxUploads(store.dir, [file.upload]);
      } catch (error) {
        file.missed = error instanceof InboxError ? error.code : "not_attached";
        deps.save();
      }
    }
    noteLeft(record);
  };

  /** One of this computer's files on the new thread: the same record (its blob, its path) under a new id; gone since, left out. */
  const attachLocal = (threadId: string, file: CombineFile) => {
    const message = store.message(file.from);
    const found = message?.attachments?.find((a) => a.id === file.file) ?? message?.inline_images?.find((a) => a.id === file.file);
    if (!found) throw new InboxError("attachment_not_found", `No file ${file.file}.`);
    const { ref: _ref, captured: _captured, captured_at: _at, ...attachment } = found as typeof found & { ref?: string; captured?: string; captured_at?: string };
    // Already on it (the agent attached it itself, or a restart replays this): not twice.
    const on = store.message(threadId)?.attachments ?? [];
    if (on.some((a) => a.sent_sha256 === attachment.sent_sha256 && a.name === attachment.name)) return;
    store.attachReferencedFile(threadId, { ...attachment, id: inboxAttachmentId(now()) });
  };

  // ── What stayed where it was ──

  /** A far pick left open there: its archive skipped there, taken back after its day, or refused (one gone there is not open). */
  const leftOpen = (far: InboxCombineFar, record: AcrossRecord, id: string) => {
    const entry = far.entry(key(record, "archive", id));
    if (!entry) return false;
    const code = (entry.answer as { code?: unknown } | null)?.code;
    return skippedThere(entry) || entry.state === "cancelled" || (entry.state === "refused" && code !== "thread_not_found" && code !== "message_not_found");
  };

  /** What of the picks the new thread does not hold: one quiet line on its first message, written when it changes. */
  const noteLeft = (record: AcrossRecord) => {
    if (record.state !== "done" || !record.thread) return;
    const far = deps.far();
    const subjects = new Map(record.threads.map((t) => [t.id, t.subject ?? "(no subject)"]));
    const open = far ? picks(record).flatMap(({ id, pick }) => (leftOpen(far, record, id) ? [{ machine: deps.nameOf(pick.machine), subject: subjects.get(id)! }] : [])) : [];
    const files = (record.files ?? []).flatMap((f) => (f.missed ? [f.name] : []));
    const left: InboxCombineLeft | null = open.length > 0 || files.length > 0 ? { ...(open.length > 0 ? { open } : {}), ...(files.length > 0 ? { files } : {}) } : null;
    const message = store.message(record.thread.id);
    if (!message || JSON.stringify(message.combine_left ?? null) === JSON.stringify(left)) return;
    try {
      store.setCombineLeft(record.thread.id, left);
    } catch {
      // The thread went meanwhile: nothing to say it on.
    }
  };

  /** Copy what is left, then attach once the thread is here: one run per Combine; a call while it runs makes it look again. */
  const runs = new Map<string, Promise<void>>();
  const again = new Set<string>();
  const finish = (record: AcrossRecord): Promise<void> => {
    const running = runs.get(record.id);
    if (running) {
      again.add(record.id);
      return running;
    }
    const run = (async () => {
      try {
        do {
          again.delete(record.id);
          await copy(record);
          await attach(record);
        } while (again.has(record.id));
      } finally {
        runs.delete(record.id);
      }
    })();
    runs.set(record.id, run);
    return run;
  };

  /**
   * Every pick's files listed at the start, in pick order: this computer's (`local`) attached as they are once the new
   * thread is here, the other computer's copied in while it is on (`finish`). One file twice (the same bytes and name) is listed once.
   */
  const copyFiles = (record: AcrossRecord, threads: readonly { files: readonly InboxCombineFarFile[]; local?: boolean }[]): Promise<void> => {
    const seen = new Set<string>();
    const all = threads.flatMap((t) => t.files.map((f) => ({ ...f, local: t.local === true }))).filter((f) => {
      const id = f.local ? `local:${f.file}` : `${f.message}/${f.file}`;
      return !seen.has(id) && !!seen.add(id);
    });
    if (all.length === 0) return Promise.resolve();
    record.files = all.map((f, i) => ({ ...(f.local ? { local: true as const } : {}), from: f.message, file: f.file, name: f.name, size: f.size, ...(i >= FILES_MAX ? { missed: "too_many" } : {}) }));
    deps.save();
    return finish(record);
  };

  /**
   * Uploads a Combine copied in and has not attached yet, kept from the upload sweep while it may still use them: it
   * waits, or failed or got its thread within the day. Stopped, undone or past its day: the sweep takes them.
   */
  const uploads = (records: readonly AcrossRecord[]): string[] =>
    records.flatMap((r) => {
      const kept = r.state === "asked" || ((r.state === "failed" || r.state === "done") && now() - Date.parse(r.settled_at ?? r.at) <= FILES_KEPT_MS);
      return kept ? (r.files ?? []).flatMap((f) => (f.upload && !f.attached && !f.missed ? [f.upload] : [])) : [];
    });

  return { holdRoute, held, acquire, release, archive, undo, waitingOn, check, copyFiles, finish, uploads };
}
