import type { InboxQuestion } from '@plannotator/core/inbox-types';

const KEPT = 500;

interface Kept {
  revision: number;
  text: string;
  covered: boolean;
}

export interface OwnSaves {
  saved(questions: readonly InboxQuestion[]): void;
  explains(question: InboxQuestion | null | undefined): boolean;
  readsStarted(): void;
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
