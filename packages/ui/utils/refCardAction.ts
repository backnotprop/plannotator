/**
 * A host's own link on an issue / PR / MR card (`components/RefHoverCard`), beside "Open on GitHub": the Plannotator
 * Inbox's "Open in Reviews" for a pull request its Reviews lists.
 *
 * A host seam in the `configurePlannotatorUI` style (`refCardAction`). Default none: the card shows only the forge's
 * link, as before. The host is asked each time a card draws, so its answer may change (a list read, a setting turned
 * off); answer null for a ref it has nothing for.
 */

import { useSyncExternalStore } from 'react';
import type { ForgeRef, ForgeRefCardResult } from '@plannotator/core/forge-ref-card';

export interface RefCardActionLink {
  /** A verb phrase like the forge's link ("Open in Reviews"). */
  label: string;
  /** Follows it; the card closes after. */
  open: () => void;
}

/** The host's link for a ref (`result`: the card's answer, undefined while it loads), or null for none. */
export type RefCardAction = (ref: ForgeRef, result: ForgeRefCardResult | null | undefined) => RefCardActionLink | null;

let action: RefCardAction | null = null;
let version = 0;
const listeners = new Set<() => void>();

export function setRefCardAction(next: RefCardAction | null): void {
  action = next;
  refreshRefCardAction();
}

/** What the host answers changed (its list was read again): an open card asks again, so its link comes or goes. */
export function refreshRefCardAction(): void {
  version++;
  for (const l of listeners) l();
}

/** Re-renders the caller when the host's answer may have changed (`refreshRefCardAction`). */
export function useRefCardActionVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
}

/** The host's link for this card, or null. A host that throws gives none. */
export function refCardActionFor(ref: ForgeRef, result: ForgeRefCardResult | null | undefined): RefCardActionLink | null {
  if (!action) return null;
  try {
    return action(ref, result);
  } catch {
    return null;
  }
}
