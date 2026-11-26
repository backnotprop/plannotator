/**
 * Plannotator Inbox: a linked machine's reply draft held here while that machine cannot take it (inbox-machine-drafts.ts).
 *
 *   inbox/machine-drafts/<machine id>/<thread id>.json   one per thread, 0600, written whole (temp, then rename)
 *
 * As this Inbox's own drafts (reply-drafts.ts): each save overwrites the thread's one file, never appends to a log, so
 * any number of saves while that machine sleeps leave one small file. It goes once that machine took what it says.
 * A file that does not read (torn by a crash, or not ours) is moved aside beside it (`<thread>.json.corrupt-<time>`),
 * never deleted, and said once in the log: the thread then holds no draft here, and its next save starts a new file.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InboxDraftFile, InboxReplyDraft } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_MACHINE_DRAFTS_DIR = "machine-drafts";
const MACHINE = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;
const THREAD = /^[A-Za-z0-9_]+$/;

/** One write of a thread's draft for that machine: a Discard, then a save, either or both, each under its own key. */
export interface HeldDraftWrite {
  /** `base`: the version there the person threw away (undefined: the one the write before it leaves there). */
  discard?: { idempotency_key: string; base?: string | null; base_body?: string };
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
  /** That machine refused it for a reason no retry cures: its words stay the draft shown here, "Not saved", carried by the next write. */
  stopped?: true;
  /**
   * Words of the person's that did not land there because the draft there changed meanwhile (`view` is that draft):
   * offered in every window as a conflict is (Keep mine / Discard mine) until the person chooses.
   */
  conflict?: InboxReplyDraft;
  /**
   * More words of the person's that met a newer draft there while `conflict` was still offered (another window's held
   * save, oldest first): each is offered in turn once the one before it is settled, never written over.
   */
  more?: InboxReplyDraft[];
  /**
   * Files a held save added that the draft there did not take as it landed (that machine had swept the upload since: a
   * held draft does not keep it there). Shown on their tiles as not attached until the person writes again.
   */
  gone?: InboxDraftFile[];
  /**
   * A reply held for that machine carried this draft: `view` shows what it leaves, `before` what it held, until it is
   * delivered or refused. `offered`: words a conflict offered that the reply carried, offered again only if it is refused.
   */
  sending?: { key: string; before: InboxReplyDraft | null; after: string | null; clear_draft: string; words?: string; uploads: string[]; offered?: InboxReplyDraft[] };
}

const dirOf = (dataDir: string, machine: string) => join(inboxDir(dataDir), INBOX_MACHINE_DRAFTS_DIR, machine);
const fileOf = (dataDir: string, machine: string, threadId: string) => join(dirOf(dataDir, machine), `${threadId}.json`);

/** Every held draft, of every machine. A file that does not read is moved aside (`<name>.corrupt-<time>`) and said once. */
export function readHeldDrafts(dataDir: string, log: (line: string) => void = (line) => console.error(line)): HeldDraft[] {
  const root = join(inboxDir(dataDir), INBOX_MACHINE_DRAFTS_DIR);
  const out: HeldDraft[] = [];
  for (const machine of names(root)) {
    if (!MACHINE.test(machine)) continue;
    for (const name of names(join(root, machine))) {
      const threadId = name.endsWith(".json") ? name.slice(0, -5) : "";
      if (!THREAD.test(threadId)) continue;
      const file = join(root, machine, name);
      try {
        const held = JSON.parse(readFileSync(file, "utf8")) as HeldDraft;
        if (held?.v === 1 && held.machine === machine && held.thread_id === threadId) {
          out.push(held);
          continue;
        }
      } catch {
        // Torn (a crash mid-write) or not JSON: moved aside below.
      }
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        renameSync(file, aside);
        log(`Plannotator Inbox: a held reply draft for another computer did not read; kept aside as ${aside}.`);
      } catch {
        log(`Plannotator Inbox: a held reply draft for another computer did not read (${file}); left where it is.`);
      }
    }
  }
  return out;
}

/** Write one held draft whole (owner-only folder and file). Throws when it cannot (a full disk): the file before stays. */
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
