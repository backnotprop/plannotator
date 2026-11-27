/**
 * Decision mode's answers on their way to the Inbox, saved by the thread's own machinery: typed words wait for their
 * pause (typedAnswers.ts), one save runs at a time with each question's newest answer waiting (pickQueue.ts), and
 * another window's answer landing first is saved over quietly (pickConflict.ts).
 *
 * The rule, as the thread's: the moment the person types or picks, it is a draft, and it is never lost. An answer not
 * saved stays on its card (`pending`) and is owed a save: the next wait (Send, a reload, closing) saves it again, and
 * a Send that still cannot save it sends nothing. Words inside their pause go with a keepalive request as the page
 * hides or goes (`leave`).
 */
import type { HeldThread } from '../data/apply/record';
import type { InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError, InboxHeldError } from '../api';
import { createPickQueue } from '../pickQueue';
import { saveOverConflicts } from '../pickConflict';
import { createTypedSaves, isTypedChange, type TypedSavesTimers } from '../typedAnswers';

export interface DecisionPick {
  messageId: string;
  key: string;
  revision: number;
  answer: QuestionAnswer | null;
  keepalive?: boolean;
}

export interface DecisionSavesDeps {
  /** The picks route (through the data layer, which puts the saved questions in the held thread). */
  pick: (save: DecisionPick) => Promise<{ questions: InboxQuestion[] }>;
  /** The newest revision the window holds for question `<message id>/<key>` (the held thread, the projection). */
  known: (id: string) => number;
  /** The answers given and not saved yet, each time they change (drawn over the saved ones). */
  onPending: (pending: ReadonlyMap<string, QuestionAnswer | null>) => void;
  /** A save landed: its message's questions as the Inbox holds them. */
  onSaved: (id: string, questions: readonly InboxQuestion[]) => void;
  /** Not saved, or held for another computer: the words stay on the card, and this says why. */
  onFailed: (id: string, error: string) => void;
  /** The Inbox's answer stands instead (replaced, already sent, another window's): read again. */
  onChanged: () => void;
  delayMs?: number;
  timers?: TypedSavesTimers;
}

export interface DecisionSaves {
  /** The answers not saved yet (typed, on their way, or refused), by `<message id>/<key>`. */
  pending(): ReadonlyMap<string, QuestionAnswer | null>;
  /**
   * The person changed an answer: drawn at once, saved after the typing pause when only words changed, else at once.
   * `base`: the answer drawn from the thread when none waits here. Answers the answer it replaced, and whether it waits
   * as typing.
   */
  change(id: string, answer: QuestionAnswer | null, base: QuestionAnswer | null, suggested?: string | null): { before: QuestionAnswer | null; typed: boolean };
  /** Save this answer now (an Undo puts the one before back). */
  put(id: string, answer: QuestionAnswer | null): void;
  /** Words waiting for their pause are saved now. */
  flush(): void;
  /** Saves what is owed and waits for every save: true when each answer was saved. */
  settled(): Promise<boolean>;
  /** For a Send (pickQueue.ts `forSend`): null when an answer could not be saved, and nothing may go. */
  forSend(): Promise<(() => void) | null>;
  /** The page hides or goes: the words in their pause go now with a keepalive request. */
  leave(): void;
}

function split(id: string): [string, string] {
  const slash = id.indexOf('/');
  return [id.slice(0, slash), id.slice(slash + 1)];
}

export function createDecisionSaves(deps: DecisionSavesDeps): DecisionSaves {
  const typed = createTypedSaves(deps.delayMs, deps.timers);
  const queue = createPickQueue(undefined, { flush: () => typed.flushAll(), waiting: () => typed.size() > 0, has: (id) => typed.has(id) });
  /** Each answer as the person last left it here, saved or not: what the next change is compared with. */
  const last = new Map<string, QuestionAnswer | null>();
  /** The newest revision each question's saves (or a refusal) said the Inbox holds. */
  const revisions = new Map<string, number>();
  let pending: ReadonlyMap<string, QuestionAnswer | null> = new Map();
  const setPending = (next: ReadonlyMap<string, QuestionAnswer | null>) => {
    if (next === pending) return;
    pending = next;
    deps.onPending(pending);
  };
  const revisionOf = (id: string) => Math.max(revisions.get(id) ?? 0, deps.known(id));
  const newer = (id: string) => queue.hasNewer(id) || typed.has(id);

  const save =
    (id: string, answer: QuestionAnswer | null, options: { keepalive?: boolean } = {}) =>
    async (): Promise<boolean> => {
      const [messageId, key] = split(id);
      // Read when the save starts, never when the answer changed: the save running before it raises the revision.
      let revision = revisionOf(id);
      /** The words stay on the card: not saved (owed), or held for another computer. */
      let kept = false;
      try {
        const outcome = await saveOverConflicts((at, tries) => deps.pick({ messageId, key, revision: at, answer, keepalive: options.keepalive && tries === 0 }), revision, {
          landed: (now) => {
            revision = now;
            revisions.set(id, Math.max(revisions.get(id) ?? 0, now));
          },
          newer: () => newer(id),
        });
        if ('stood' in outcome) {
          if (outcome.stood === 'adopted') {
            last.delete(id);
            deps.onChanged();
          }
          return true;
        }
        for (const q of outcome.saved.questions) revisions.set(`${q.message_id}/${q.key}`, Math.max(revisions.get(`${q.message_id}/${q.key}`) ?? 0, q.revision));
        deps.onSaved(id, outcome.saved.questions);
        return true;
      } catch (cause) {
        if (cause instanceof InboxHeldError) {
          // Held for the computer the thread lives on: it applies there, and the next answer goes on top of it.
          kept = true;
          revisions.set(id, revision + 1);
          deps.onFailed(id, cause.message);
          return true;
        }
        const code = cause instanceof InboxApiError ? cause.code : null;
        // Replaced (the dialog's banner and swap say so) or already sent: the Inbox's answer stands.
        if (code === 'question_superseded' || code === 'question_already_sent') {
          if (code === 'question_already_sent' && !newer(id)) deps.onFailed(id, (cause as InboxApiError).message);
          deps.onChanged();
          return true;
        }
        kept = true;
        if (!newer(id)) deps.onFailed(id, cause instanceof InboxApiError ? cause.message : 'The pick was not saved.');
        deps.onChanged();
        return false;
      } finally {
        if (!kept && pending.has(id) && pending.get(id) === answer) {
          const next = new Map(pending);
          next.delete(id);
          setPending(next);
        }
      }
    };

  const draw = (id: string, answer: QuestionAnswer | null) => {
    last.set(id, answer);
    setPending(new Map(pending).set(id, answer));
  };

  return {
    pending: () => pending,
    change(id, answer, base, suggested) {
      const before = pending.has(id) ? (pending.get(id) ?? null) : base;
      draw(id, answer);
      const run = save(id, answer);
      if (isTypedChange(before, answer, suggested ?? null)) {
        typed.type(id, () => queue.put(id, run));
        return { before, typed: true };
      }
      // A click: this answer carries the words typed in it, and any words waiting in another answer go now too.
      typed.drop(id);
      typed.flushAll();
      queue.put(id, run);
      return { before, typed: false };
    },
    put(id, answer) {
      draw(id, answer);
      typed.drop(id);
      typed.flushAll();
      queue.put(id, save(id, answer));
    },
    flush: () => typed.flushAll(),
    settled: () => queue.settled(),
    forSend: () => queue.forSend(),
    leave() {
      for (const { id } of typed.take()) {
        const answer = last.get(id) ?? null;
        // No save out for it: this one goes at once, with the keepalive.
        if (!queue.busy(id)) {
          queue.put(id, save(id, answer, { keepalive: true }));
          continue;
        }
        // A save still out cannot be waited for: the words also go on their own, at the revision that save makes.
        const [messageId, key] = split(id);
        const revision = revisionOf(id) + 1;
        queue.put(id, save(id, answer));
        void deps.pick({ messageId, key, revision, answer, keepalive: true }).catch(() => {});
      }
    },
  };
}

/**
 * The held thread with the answers not saved yet put on their cards: the dialog closing (or tucking into its pill)
 * with a save still out, the thread card shows the dialog's latest words at once, so typing there builds on them.
 */
export function withPendingAnswers(held: HeldThread, pending: ReadonlyMap<string, QuestionAnswer | null>): HeldThread {
  if (pending.size === 0) return held;
  let changed = false;
  const messages = held.thread.messages.map((m) => {
    if (!m.questions?.some((q) => pending.has(`${m.id}/${q.key}`))) return m;
    changed = true;
    const questions = m.questions.map((q) => {
      const id = `${m.id}/${q.key}`;
      if (!pending.has(id) || (q.state !== 'open' && q.state !== 'picked')) return q;
      const answer = pending.get(id) ?? null;
      return { ...q, answer, state: answer ? ('picked' as const) : ('open' as const) };
    });
    return { ...m, questions };
  });
  return changed ? { ...held, thread: { ...held.thread, messages } } : held;
}
