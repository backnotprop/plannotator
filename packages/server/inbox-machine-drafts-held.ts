/**
 * Plannotator Inbox: a linked machine's reply draft held here while that machine cannot take it (inbox-machine-drafts.ts).
 *
 *   inbox/machine-drafts/<machine id>/<thread id>.json   one per thread, 0600, written whole (temp, then rename)
 *
 * As this Inbox's own drafts (reply-drafts.ts): each save overwrites the thread's one file, never appends to a log, so
 * any number of saves while that machine sleeps leave one small file. It goes once that machine took what it says.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxReplyDraft } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_MACHINE_DRAFTS_DIR = "machine-drafts";
const MACHINE = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;
const THREAD = /^[A-Za-z0-9_]+$/;

/** One write of a thread's draft for that machine: a Discard, then a save, either or both, each under its own key. */
export interface HeldDraftWrite {
  discard?: { idempotency_key: string };
  save?: Record<string, unknown>;
}

export interface HeldDraft {
  v: 1;
  machine: string;
  thread_id: string;
  /** The draft this Inbox shows for the thread until it lands there (null: discarded). */
  view: InboxReplyDraft | null;
  /** The write that left here and may have landed there: sent again under its keys until it is answered. */
  sent: HeldDraftWrite | null;
  /** The saves since, folded into one: sent once `sent` is answered, on the draft it left there. */
  next: HeldDraftWrite | null;
  /** That machine refused it for a reason no retry cures: its words stay the draft shown here, carried by the next write. */
  stopped?: true;
}

const dirOf = (dataDir: string, machine: string) => join(inboxDir(dataDir), INBOX_MACHINE_DRAFTS_DIR, machine);
const fileOf = (dataDir: string, machine: string, threadId: string) => join(dirOf(dataDir, machine), `${threadId}.json`);

/** Every held draft, of every machine (a file that does not read is skipped). */
export function readHeldDrafts(dataDir: string): HeldDraft[] {
  const root = join(inboxDir(dataDir), INBOX_MACHINE_DRAFTS_DIR);
  const out: HeldDraft[] = [];
  for (const machine of names(root)) {
    if (!MACHINE.test(machine)) continue;
    for (const name of names(join(root, machine))) {
      const threadId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!THREAD.test(threadId)) continue;
      try {
        const held = JSON.parse(readFileSync(join(root, machine, name), "utf8")) as HeldDraft;
        if (held?.v === 1 && held.machine === machine && held.thread_id === threadId) out.push(held);
      } catch {
        // Torn or not ours: nothing of it is shown.
      }
    }
  }
  return out;
}

/** Write one held draft whole (owner-only folder and file). */
export function writeHeldDraft(dataDir: string, held: HeldDraft): void {
  if (!MACHINE.test(held.machine) || !THREAD.test(held.thread_id)) throw new Error("A held draft names a machine and a thread.");
  mkdirSync(dirOf(dataDir, held.machine), { recursive: true, mode: 0o700 });
  const file = fileOf(dataDir, held.machine, held.thread_id);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(held)}\n`, { mode: 0o600 });
  chmodSync(temp, 0o600); // `mode` applies only on create: a left-over temp file keeps its old mode.
  renameSync(temp, file);
}

/** The thread's held draft is gone (it landed, or its machine is no longer linked). */
export function removeHeldDraft(dataDir: string, machine: string, threadId: string): void {
  try {
    unlinkSync(fileOf(dataDir, machine, threadId));
  } catch {
    // Already gone.
  }
}

function names(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
