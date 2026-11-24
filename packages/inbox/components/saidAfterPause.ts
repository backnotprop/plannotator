/**
 * The count a screen reader hears from a field that narrows as the person types: once typing pauses, not on every key.
 * Drawn in a polite live region (`.ib-sr`, `role="status"`, no visible words). Read by the filter menu's
 * find fields (ListFilterSections.tsx) and the list's Filter by typing (TitleFilter.tsx).
 */
import { useEffect, useState } from 'react';
import { formatCount } from '../format';

/** How long the count waits for typing to pause before a screen reader hears it. */
export const STATUS_WAIT_MS = 400;

/** "1 match", "12 matches". */
export const matchCount = (n: number) => (n === 1 ? '1 match' : `${formatCount(n)} matches`);

/** `words` once they have held for `STATUS_WAIT_MS`; nothing at once when there are none. */
export function useSaidAfterPause(words: string): string {
  const [said, setSaid] = useState('');
  useEffect(() => {
    if (words === '') {
      setSaid('');
      return;
    }
    const wait = setTimeout(() => setSaid(words), STATUS_WAIT_MS);
    return () => clearTimeout(wait);
  }, [words]);
  return said;
}
