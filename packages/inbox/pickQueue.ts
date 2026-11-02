/**
 * The answers to a thread's question cards on their way to the server. A card
 * saves on every change (QuestionBlock's `commit`: each key, each step of a
 * phone's dictation), so answers change faster than they land; saved one by
 * one, the owner's dictated "Other" answer queued 81 saves and held a Send
 * back 7 seconds (2026-11-02).
 *
 * One save runs at a time, as ever: a save answers its message's questions
 * whole, so two at once could land out of order, and each save's revision
 * comes from the one before. While one runs, each question keeps only its
 * newest answer waiting; a newer one takes its place in the line, so another
 * question's answer is never pushed back, and every question saves.
 *
 * The rule: no answer the person typed is lost or sent stale. A newest answer
 * that was not saved stays owed, and the next wait saves it first.
 */
import type { InboxThread } from '@plannotator/core/inbox-types';

/** Saves one answer. False: it was not saved and the person was told (a held or replaced one is true). */
export type PickSave = () => Promise<boolean>;

/**
 * How many rounds a Send waits, each the saves running and waiting as it
 * starts. Answers that change during a round are saved by the next, so what
 * the field shows goes with the reply. Dictation that never stops cannot hold
 * the Send: as the last round starts the line closes, and what comes after it
 * waits for the reply to leave.
 */
export const SEND_ROUNDS = 3;

export interface PickQueue {
  /** Save this answer of question `id`, in place of any answer of it still waiting. */
  put(id: string, save: PickSave): void;
  /** A newer answer of question `id` will be saved next: it decides, not the save running now. */
  hasNewer(id: string): boolean;
  /** Questions whose newest answer was not saved, each owed a save. */
  unsaved(): number;
  /**
   * Saves what is owed, then resolves once the save running now and the
   * newest answers waiting have answered. True when each one was saved.
   */
  settled(): Promise<boolean>;
  /**
   * For a Send: the rounds above. Answers the release that opens the line
   * again, to call when the reply has left: no save runs beside a reply, or
   * one of them would be refused or go stale. Null: a newest answer was not
   * saved, and nothing may go.
   */
  forSend(): Promise<(() => void) | null>;
}

interface Job {
  id: string;
  save: PickSave;
  done: Promise<boolean>;
  finish: (saved: boolean) => void;
}

function jobOf(id: string, save: PickSave): Job {
  let finish!: (saved: boolean) => void;
  const done = new Promise<boolean>((resolve) => (finish = resolve));
  return { id, save, done, finish };
}

/** `onSaving`: the questions with an answer running or waiting, each time they change. */
export function createPickQueue(onSaving?: (ids: ReadonlySet<string>) => void): PickQueue {
  const waiting = new Map<string, Job>();
  /** The newest answers that were not saved. */
  const owed = new Map<string, PickSave>();
  /** Answers that came after a Send closed the line: saved once its reply has left. */
  const late = new Map<string, PickSave>();
  let running: Job | null = null;
  /** Sends past their last wait. */
  let closed = 0;

  const report = () => onSaving?.(new Set([...(running ? [running.id] : []), ...waiting.keys(), ...late.keys()]));

  const next = () => {
    const job = waiting.values().next().value;
    if (!job) {
      report();
      return;
    }
    waiting.delete(job.id);
    running = job;
    report();
    // A save that throws saved nothing; the line goes on either way.
    void job
      .save()
      .catch(() => false)
      .then((saved) => {
        running = null;
        const newer = waiting.get(job.id);
        if (saved) job.finish(true);
        // The newer answer decides for whoever waits on this one.
        else if (newer) void newer.done.then(job.finish);
        else {
          owed.set(job.id, job.save);
          job.finish(false);
        }
        next();
      });
  };

  const enqueue = (id: string, save: PickSave) => {
    const queued = waiting.get(id);
    if (queued) {
      // The place in the line and whoever waits on it stay: they get this answer.
      queued.save = save;
      return;
    }
    const idle = running === null;
    waiting.set(id, jobOf(id, save));
    if (idle) next();
    else report();
  };

  const put = (id: string, save: PickSave) => {
    owed.delete(id);
    if (closed === 0) {
      enqueue(id, save);
      return;
    }
    late.set(id, save);
    report();
  };

  const settled = async () => {
    // A press is the person asking again: what was refused goes once more, never on its own.
    for (const [id, save] of [...owed]) {
      owed.delete(id);
      enqueue(id, save);
    }
    const newest = new Map<string, Job>();
    if (running) newest.set(running.id, running);
    for (const job of waiting.values()) newest.set(job.id, job);
    const saved = await Promise.all([...newest.values()].map((job) => job.done));
    return saved.every(Boolean);
  };

  return {
    put,
    hasNewer: (id) => waiting.has(id),
    unsaved: () => owed.size,
    settled,
    async forSend() {
      for (let round = 1; round < SEND_ROUNDS; round += 1) {
        if (!(await settled())) return null;
        if (running === null && waiting.size === 0) break;
      }
      closed += 1;
      let open = true;
      const release = () => {
        if (!open) return;
        open = false;
        closed -= 1;
        if (closed > 0) return;
        const answers = [...late];
        late.clear();
        for (const [id, save] of answers) put(id, save);
      };
      if (await settled()) return release;
      release();
      return null;
    },
  };
}

const sameFields = <T extends object>(a: T, b: T, except?: keyof T): boolean => {
  const keys = Object.keys(a) as (keyof T)[];
  return keys.length === Object.keys(b).length && keys.every((key) => key === except || a[key] === b[key]);
};

/**
 * `after` is `before` with nothing but messages' `questions` replaced: a saved
 * pick (App's `patchQuestions`). A read of the thread never is, whatever it
 * brought: its objects are all new.
 */
export function onlyQuestionsChanged(before: InboxThread, after: InboxThread): boolean {
  if (before === after) return true;
  if (!sameFields(before, after, 'messages') || before.messages.length !== after.messages.length) return false;
  return before.messages.every((message, index) => sameFields(message, after.messages[index]!, 'questions'));
}
