import { useCallback, useEffect, useState } from 'react';
import type { InboxListSection } from '@plannotator/core/inbox-types';
import { settledHeldRead } from '../listFilter';
import { shownRowOf } from '../rowActions';

export function useHeldRead(thread: string | null | undefined, routeRef: { readonly current: { thread?: string | null } }, shownRef: { readonly current: InboxListSection[] | null }) {
  const [heldRead, setHeldRead] = useState<ReadonlySet<string>>(() => new Set());
  const settleHeldRead = useCallback(() => setHeldRead((current) => settledHeldRead(current, routeRef.current.thread ?? null)), [routeRef]);
  useEffect(() => {
    if (!thread || !shownRowOf(shownRef.current, thread)?.unread) return;
    setHeldRead((current) => (current.has(thread) ? current : new Set(current).add(thread)));
  }, [thread, shownRef]);
  return { heldRead, settleHeldRead };
}
