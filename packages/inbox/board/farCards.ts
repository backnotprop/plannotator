import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxCardWire } from '@plannotator/core/inbox-types';
import { inboxApi, type ComposeSessionsModel } from '../api';
import { useComposeSessions } from '../compose/useComposeSessions';

export const NO_MACHINES: ReadonlyMap<string, string> = new Map();
export const NO_LOOKS: Readonly<Record<string, number | null>> = {};

/** The linked machine whose store holds the card (the merged Board's `machine`), or null for this Inbox's own. */
export function farMachine(card: Pick<InboxCardWire, 'machine'>): string | null {
  return card.machine ?? null;
}

/**
 * A linked machine's live sessions (`GET /api/inbox/m/<id>/sessions`), read as compose reads this computer's while
 * `machine` is set. Null until a read of that machine has landed.
 */
export function useMachineSessions(machine: string | null): { machine: string; model: ComposeSessionsModel | null } | null {
  const asked = useRef(machine);
  asked.current = machine;
  const [readFor, setReadFor] = useState<string | null>(null);
  const loader = useCallback(async () => {
    const on = asked.current;
    const got = await inboxApi.composeSessions(null, null, on);
    setReadFor(on);
    return got;
  }, []);
  const { model, load } = useComposeSessions(machine !== null, loader);
  useEffect(() => {
    if (machine) void load();
  }, [machine, load]);
  return machine && readFor === machine ? { machine, model } : null;
}
