/**
 * Typed answers on a question card ("Other…", a free-text answer, a note) save after a short pause in the typing,
 * the way the reply box's words do (REPLY_DRAFT_SAVE_MS), never on every key. The card draws each key at once from
 * the pane's own copy (`pending`), so nothing on screen waits for a save; only the save waits.
 *
 * Every key used to save a full copy of the question (the questions file grew to 212 MB for one person), and each
 * save's answer redrew the thread and read the list and drafts again: on a slower device that cost every key
 * 40-80 ms, and on a slow link it filled the line (questions-store and data-layer briefs, 2026-11-10).
 *
 * The rule, as the reply box's: the waiting words are saved at once when the person clicks or picks anything
 * (a choice, Skip, Accept recommended), on Send and Re-ask, when the field loses focus, when the thread closes or
 * changes, and when the page hides or goes (with a keepalive request). At most one pause of typing is ever at risk,
 * and only if the browser itself dies, which is the reply box's promise too.
 */
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { REPLY_DRAFT_SAVE_MS } from './replyDraft';

/** How long typing in an answer pauses before it is saved: the reply box's pause. */
export const TYPED_ANSWER_SAVE_MS = REPLY_DRAFT_SAVE_MS;

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/**
 * Whether `next` differs from `before` only in what the person types: the "Other…" words, a free-text answer or a
 * note. A choice, Skip, a cleared answer or the first words on an unanswered question are not typing: they change
 * the question's state, so they save at once, as a click does. Picking the agent's suggested answer (its own row)
 * writes its words as "Other…" in one go: a click too.
 */
export function isTypedChange(before: QuestionAnswer | null | undefined, next: QuestionAnswer | null, suggested?: string | null): boolean {
  if (!before || !next) return false;
  if (!sameList(before.selected, next.selected) || !!before.skipped !== !!next.skipped) return false;
  if (suggested && next.other === suggested && before.other !== suggested) return false;
  return (before.other ?? '') !== (next.other ?? '') || (before.text ?? '') !== (next.text ?? '') || (before.note ?? '') !== (next.note ?? '');
}

export interface TypedSaves {
  /** Words typed in question `id`: `save` runs once the typing pauses, in place of any save of it still waiting. */
  type(id: string, save: () => void): void;
  /** Question `id`'s waiting words are no longer to be saved on their own (a click on it saves the whole answer). */
  drop(id: string): void;
  /** Save every waiting answer now. */
  flushAll(): void;
  /** Whether question `id` has words waiting for their pause. */
  has(id: string): boolean;
  /** How many questions have words waiting. */
  size(): number;
  /** The questions with words waiting, each with its save, taken out of the wait (the page going: saved its own way). */
  take(): { id: string; save: () => void }[];
  /** Stop every timer, saving nothing (tests). */
  dispose(): void;
}

export interface TypedSavesTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: TypedSavesTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createTypedSaves(delayMs: number = TYPED_ANSWER_SAVE_MS, timers: TypedSavesTimers = realTimers): TypedSaves {
  const waiting = new Map<string, { save: () => void; timer: unknown }>();
  const run = (id: string) => {
    const entry = waiting.get(id);
    if (!entry) return;
    timers.clear(entry.timer);
    waiting.delete(id);
    entry.save();
  };
  return {
    type(id, save) {
      const held = waiting.get(id);
      if (held) timers.clear(held.timer);
      waiting.set(id, { save, timer: timers.set(() => run(id), delayMs) });
    },
    drop(id) {
      const held = waiting.get(id);
      if (!held) return;
      timers.clear(held.timer);
      waiting.delete(id);
    },
    flushAll() {
      for (const id of [...waiting.keys()]) run(id);
    },
    has: (id) => waiting.has(id),
    size: () => waiting.size,
    take() {
      const out = [...waiting].map(([id, entry]) => {
        timers.clear(entry.timer);
        return { id, save: entry.save };
      });
      waiting.clear();
      return out;
    },
    dispose() {
      for (const entry of waiting.values()) timers.clear(entry.timer);
      waiting.clear();
    },
  };
}
