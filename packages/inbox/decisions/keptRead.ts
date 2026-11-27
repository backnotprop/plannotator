/**
 * The window's decisions read (App's `refreshDecisions`): `GET /api/inbox/decisions` lists every open decision in the
 * store, and the window keeps only the watched threads' (`keepWatched`). True once a read landed; false when decision
 * mode is off or the read failed, so a sitting waiting on its thread's read can go again (`useDecideSitting`).
 */
import type { Dispatch, SetStateAction } from 'react';
import type { InboxDecision } from '@plannotator/core/inbox-types';
import { keepSame } from '../listSame';
import { keepWatched, type DecisionWatch } from './model';

export async function readKeptDecisions(read: () => Promise<{ decisions: InboxDecision[] }>, watch: DecisionWatch, setDecisions: Dispatch<SetStateAction<InboxDecision[] | null>>): Promise<boolean> {
  if (!watch.on) return false;
  try {
    const kept = keepWatched((await read()).decisions, watch);
    // A read that brought nothing new keeps the decisions drawn (listSame.ts `keepSame`): nothing is drawn again.
    if (watch.on) setDecisions((current) => keepSame(current, kept));
    return true;
  } catch {
    // Off on the server (another window turned it off: the next settings read says so), or the read failed.
    return false;
  }
}
