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
 */
import type { InboxQuestion } from '@plannotator/core/inbox-types';

/** Questions kept per window: the newest saved ones (an Inbox window answers a few hundred at most in a day). */
const KEPT = 500;

interface Kept {
  revision: number;
  /** The question as the save answered it, as JSON. */
  text: string;
}

export interface OwnSaves {
  /** A save of this window answered with these questions. */
  saved(questions: readonly InboxQuestion[]): void;
  /** Whether a question record says nothing newer than this window's own saves brought back. */
  explains(question: InboxQuestion | null | undefined): boolean;
}

const idOf = (question: Pick<InboxQuestion, 'message_id' | 'key'>) => `${question.message_id}/${question.key}`;

export function createOwnSaves(): OwnSaves {
  const kept = new Map<string, Kept>();
  return {
    saved(questions) {
      for (const question of questions) {
        if (typeof question?.revision !== 'number') continue;
        const id = idOf(question);
        const held = kept.get(id);
        // A slow answer of an earlier save never takes the place of a newer one.
        if (held && held.revision > question.revision) continue;
        kept.delete(id);
        kept.set(id, { revision: question.revision, text: JSON.stringify(question) });
      }
      while (kept.size > KEPT) kept.delete(kept.keys().next().value!);
    },
    explains(question) {
      if (!question || typeof question.revision !== 'number') return false;
      const held = kept.get(idOf(question));
      if (!held) return false;
      return question.revision < held.revision || (question.revision === held.revision && JSON.stringify(question) === held.text);
    },
  };
}
