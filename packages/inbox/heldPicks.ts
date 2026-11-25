/**
 * Picks held for the linked machine their thread lives on (linked machines, rule 12; inbox-machines.md): a pick that
 * machine's Inbox has not confirmed yet waits in this Inbox's outbox (`InboxHeldError`) and applies there in order.
 * One rule for the thread's own cards (components/Thread.tsx) and decision mode's (decisions/saves.ts):
 *
 * - Held, it is drawn as picked, and the next pick on that question goes with the revision the held one makes there.
 * - Once the outbox settles it: delivered, it is the thread's own; refused, or never sent, its revision is given back
 *   (the next pick goes with the one that machine still has), it is unpicked, and the person is told why.
 */
import type { MachineView, OutboxView } from '@plannotator/core/inbox-wire-models';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { outboxLine } from './machines';

/** One held pick: its question (`<message id>/<key>`), the answer, and the revision it was saved at. */
export interface HeldPick {
  id: string;
  answer: QuestionAnswer | null;
  revision: number;
}

export interface HeldPicks {
  /** A pick the outbox holds under `outboxKey`. */
  hold(outboxKey: string, pick: HeldPick): void;
  /** The held picks the outbox says are done, each once; `lost`: one that never applied there (its revision given back). */
  settle(entries: Iterable<OutboxView>): { delivered: HeldPick[]; lost: { pick: HeldPick; entry: OutboxView }[] };
  /** The picks still held, in the order they were made. */
  waiting(): HeldPick[];
}

/** `revisions`: the newest revision the window holds for each question, which a held pick raises and a lost one lowers again. */
export function createHeldPicks(revisions: Map<string, number>): HeldPicks {
  const held = new Map<string, HeldPick>();
  return {
    hold(outboxKey, pick) {
      held.set(outboxKey, pick);
      revisions.set(pick.id, pick.revision + 1);
    },
    settle(entries) {
      const delivered: HeldPick[] = [];
      const lost: { pick: HeldPick; entry: OutboxView }[] = [];
      for (const entry of entries) {
        const pick = held.get(entry.key);
        if (!pick || entry.state === 'queued' || entry.state === 'sending') continue;
        held.delete(entry.key);
        if (entry.state === 'delivered') {
          delivered.push(pick);
          continue;
        }
        if (revisions.get(pick.id) === pick.revision + 1) revisions.delete(pick.id);
        lost.push({ pick, entry });
      }
      return { delivered, lost };
    },
    waiting: () => [...held.values()],
  };
}

/** What the person is told of a held pick that never applied there. */
export function heldPickLostWords(entry: OutboxView, machine: Pick<MachineView, 'name' | 'state'> | null): string {
  return `Pick not saved. ${outboxLine(entry, machine)?.text ?? `Not delivered to ${machine?.name ?? 'the other machine'}.`}`;
}
