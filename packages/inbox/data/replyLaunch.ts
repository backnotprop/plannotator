/**
 * What the thread's machine can start for the reply box's start row (thread/replyStart.ts): its launch block, New
 * message's read (`GET /api/inbox/sessions`'s `launch`), read while `active` (the session asked has ended) and every
 * 30 s after, never while the tab is hidden. A linked machine's comes through the forward; one that is away gives its
 * last read (New message keeps it), so a Send to it waits in the outbox. Undefined: not read, or starting agents is off.
 */
import { useEffect, useState } from 'react';
import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import { inboxApi, type MachineView } from '../api';
import { machineLaunchesKept } from '../compose/useMachineLaunches';

const REFRESH_MS = 30_000;

export function useReplyLaunchBlock(active: boolean, machine: MachineView | null): InboxComposeLaunch | undefined {
  const [read, setRead] = useState<{ key: string; block: InboxComposeLaunch | undefined } | null>(null);
  const key = machine?.id ?? '';
  const away = !!machine && machine.state !== 'online';
  useEffect(() => {
    if (!active) return;
    if (away) {
      setRead({ key, block: machineLaunchesKept().get(key)?.launch });
      return;
    }
    let live = true;
    const load = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      inboxApi.composeSessions(null, null, machine ? key : null).then(
        (model) => live && setRead({ key, block: model.launch }),
        () => {},
      );
    };
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, key, away]);
  return active && read?.key === key ? read.block : undefined;
}
