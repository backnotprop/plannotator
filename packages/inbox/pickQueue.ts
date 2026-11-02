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
 */

import type { InboxThread } from '@plannotator/core/inbox-types';

/** Saves one answer. False: it was not saved and the person was told (a held or replaced one is true). */
export type PickSave = () => Promise<boolean>;

export interface PickQueue {
  /** Save this answer of question `id`, in place of any answer of it still waiting. */
  put(id: string, save: PickSave): void;
  /** A newer answer of question `id` waits: what the save running now says about it does not stand. */
  hasNewer(id: string): boolean;
  /**
   * Resolves once the save running now and the newest answers waiting have
   * answered, never waiting for an answer that comes after this call finds
   * its own saved. True when each question's newest answer was saved.
   */
  settled(): Promise<boolean>;
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

/** `onSaving`: true as the first save starts, false once none runs or waits. */
export function createPickQueue(onSaving?: (saving: boolean) => void): PickQueue {
  const waiting = new Map<string, Job>();
  let running: Job | null = null;

  const next = () => {
    const job = waiting.values().next().value;
    if (!job) {
      onSaving?.(false);
      return;
    }
    waiting.delete(job.id);
    running = job;
    // A save that throws saved nothing; the line goes on either way.
    void job
      .save()
      .catch(() => false)
      .then((saved) => {
        running = null;
        job.finish(saved);
        next();
      });
  };

  return {
    put(id, save) {
      const queued = waiting.get(id);
      if (queued) {
        // The place in the line and whoever waits on it stay: they get this answer.
        queued.save = save;
        return;
      }
      const idle = running === null;
      waiting.set(id, jobOf(id, save));
      if (!idle) return;
      onSaving?.(true);
      next();
    },
    hasNewer: (id) => waiting.has(id),
    async settled() {
      const newest = new Map<string, Job>();
      if (running) newest.set(running.id, running);
      for (const job of waiting.values()) newest.set(job.id, job);
      const saved = await Promise.all([...newest.values()].map((job) => job.done));
      return saved.every(Boolean);
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
