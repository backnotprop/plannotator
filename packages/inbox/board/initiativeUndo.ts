/**
 * Undo of deleted initiatives, the same in the Initiatives dialog's toast and the window's: every restore is
 * tried, so one refused or failed never strands the others. A name taken since refuses for good, and only that
 * says why (the server's words); anything else, a network failure too, is the one line and can be tried again.
 */
import { InboxApiError, inboxApi } from '../api';
import type { InboxInitiative } from '@plannotator/core/inbox-types';

export const INITIATIVE_SAVE_FAILED = 'That did not save. Try again.';

/** A refusal the person can read: the server's own words stand. */
export function initiativeRefusal(cause: unknown): string | null {
  return cause instanceof InboxApiError && cause.code === 'initiative_exists' ? cause.message : null;
}

export interface InitiativesRestored {
  restored: readonly InboxInitiative[];
  /** What Undo still offers: what is not back, while a save failed (a retry then also says why a refused one stays out). */
  left: readonly InboxInitiative[];
  /** The line to show; null when all came back. */
  line: string | null;
}

export async function restoreInitiatives(deleted: readonly InboxInitiative[]): Promise<InitiativesRestored> {
  const restored: InboxInitiative[] = [];
  const refusals: string[] = [];
  let failed = false;
  for (const initiative of deleted) {
    try {
      restored.push((await inboxApi.changeInitiative(initiative.id, { op: 'restore' })).initiative);
    } catch (cause) {
      const refusal = initiativeRefusal(cause);
      if (refusal === null) failed = true;
      else refusals.push(refusal);
    }
  }
  const back = new Set(restored.map((i) => i.id));
  return {
    restored,
    left: failed ? deleted.filter((i) => !back.has(i.id)) : [],
    line: failed ? INITIATIVE_SAVE_FAILED : refusals.length > 0 ? refusals.join(' ') : null,
  };
}
