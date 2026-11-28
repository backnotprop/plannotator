/** The list's tags for App (approval "inbox-thread-tags"), the same array while what the window draws of them stays. */
import { useMemo } from 'react';
import type { ListModel } from '../api';

/** With the Board off, the list's tags: a new array only when an id, a name, a machine's id or a colour changes. */
export function useListTags(latest: ListModel | null) {
  const key = (latest?.tags ?? [])
    .map((i) => `${i.id}\u0000${i.name}\u0000${JSON.stringify(i.machines ?? null)}\u0000${JSON.stringify(i.look ?? null)}`)
    .join('\u0001');
  const keeps = latest?.tags !== undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what is drawn, on purpose
  return useMemo(() => latest?.tags ?? null, [key, keeps]);
}
