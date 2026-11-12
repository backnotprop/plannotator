/**
 * The questions this window's own saves brought back, so the record each save
 * leaves on the event stream is known for what it is: an echo of what the
 * pane already drew from the save's answer (`onQuestions`), not news.
 *
 * Every pick save (a choice, each key typed in "Other…" or a free-text
 * answer, a note) writes the question and its record, and the record came
 * back to the window that typed it as a read of the list, the decisions, the
 * drafts, the open thread and its files: several reads and renders per key.
 * A question's `revision` only grows, and every save of it raises it; a few
 * writes keep it (a Send marks it sent, Mark read sets it aside). So a record
 * is an echo when it is older than the newest answer a save of this window
 * brought back, or is that very answer, word for word. Anything else (a newer
 * revision, or the same one changed: another window, a phone, the agent, a
 * Send) is news and is read as before.
 *
 * When a run of saves ends, the window reads what shows the pick besides the
 * pane (the list, the decisions, the drafts) at once (`readsStarted`). An echo
 * that comes after that read started owes nothing more (`covered`): the read
 * began after the save's answer, so after the record was written.
 */
import type { InboxQuestion } from '@plannotator/core/inbox-types';

/** Questions kept per window: the newest saved ones (an Inbox window answers a few hundred at most in a day). */
const KEPT = 500;

interface Kept {
  revision: number;
  /** The question as the save answered it, as JSON. */
  text: string;
  /** A read of the list, the decisions and the drafts started after this answer landed: its echo owes nothing. */
  covered: boolean;
}

export interface OwnSaves {
  /** A save of this window answered with these questions. */
  saved(questions: readonly InboxQuestion[]): void;
  /** Whether a question record says nothing newer than this window's own saves brought back. */
  explains(question: InboxQuestion | null | undefined): boolean;
  /** The reads an echo owes (the list, the decisions, the drafts) started now: every answer kept so far is covered. */
  readsStarted(): void;
  /** An echo whose reads already started after its save's answer: it owes nothing at all. */
  covered(question: InboxQuestion | null | undefined): boolean;
}

const idOf = (question: Pick<InboxQuestion, 'message_id' | 'key'>) => `${question.message_id}/${question.key}`;

export function createOwnSaves(): OwnSaves {
  const kept = new Map<string, Kept>();
  const own: OwnSaves = {
    saved(questions) {
      for (const question of questions) {
        if (typeof question?.revision !== 'number') continue;
        const id = idOf(question);
        const held = kept.get(id);
        // A slow answer of an earlier save never takes the place of a newer one.
        if (held && held.revision > question.revision) continue;
        kept.delete(id);
        kept.set(id, { revision: question.revision, text: JSON.stringify(question), covered: false });
      }
      while (kept.size > KEPT) kept.delete(kept.keys().next().value!);
    },
    explains(question) {
      if (!question || typeof question.revision !== 'number') return false;
      const held = kept.get(idOf(question));
      if (!held) return false;
      return question.revision < held.revision || (question.revision === held.revision && JSON.stringify(question) === held.text);
    },
    readsStarted() {
      for (const held of kept.values()) held.covered = true;
    },
    covered(question) {
      const held = question ? kept.get(idOf(question)) : undefined;
      return !!held && held.covered && own.explains(question);
    },
  };
  return own;
}
