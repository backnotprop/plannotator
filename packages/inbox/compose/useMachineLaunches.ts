import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi, type ComposeTrustPick, type MachineView } from '../api';
import { COMPOSE_SESSIONS_REFRESH_MS } from './useComposeSessions';
import type { MachineLaunchRead } from './model';

/**
 * Each linked machine's last good sessions read (its launch block and home), kept for the page's life: an asleep
 * machine's projects still show in the folder menu, and a Send to it waits in the outbox.
 */
const kept = new Map<string, MachineLaunchRead>();

/** Tests only: forget every machine's read. */
/** Each linked machine's last launch read (New message reads them): for "+" on its project rows, without reading again. */
export function machineLaunchesKept(): ReadonlyMap<string, MachineLaunchRead> {
  return kept;
}

export function resetMachineLaunchesForTests(): void {
  kept.clear();
}

/**
 * A linked machine whose sessions are worth reading now: online, and its Inbox says whether launch is on there (not an
 * older one). Off there too: its switch may have been turned on since the link last connected, and the read says so.
 */
const readable = (m: MachineView) => !m.self && m.state === 'online' && (m.launch === true || m.launch === false);

/**
 * Remote launch: every machine (`GET /api/inbox/machines`) and, for each linked one that is online and says whether launch is on,
 * its sessions read through the forward (`/api/inbox/m/<id>/sessions`), while `active` and every few seconds after
 * (never while the tab is hidden). Each machine is read on its own, so a slow one holds up only its own rows, and
 * nothing waits on them: this computer's read is `useComposeSessions`, as always. `trust`: the folder To names on a
 * linked machine, whose files that machine's read looks at (Trust and start); a new one is read at once.
 */
export function useMachineLaunches(active: boolean, trust: (ComposeTrustPick & { machine: string }) | null) {
  const [machines, setMachines] = useState<MachineView[]>([]);
  const [reads, setReads] = useState<ReadonlyMap<string, MachineLaunchRead>>(() => new Map(kept));
  const trustNow = useRef(trust);
  trustNow.current = trust;

  const readOne = useCallback(async (machine: string) => {
    const asked = trustNow.current?.machine === machine ? trustNow.current : null;
    try {
      const got = await inboxApi.composeSessions(null, asked ? { agent: asked.agent, project: asked.project } : null, machine);
      const now = trustNow.current?.machine === machine ? trustNow.current : null;
      // Asked for another folder than the one To names now: a newer read is on its way.
      if (asked?.agent !== now?.agent || asked?.project !== now?.project) return;
      kept.set(machine, { launch: got.launch, home: typeof got.home === 'string' ? got.home : null });
      setReads(new Map(kept));
    } catch {
      // Unreachable or refused: its last good read stays.
    }
  }, []);

  const load = useCallback(async () => {
    let list: MachineView[];
    try {
      const answer = await inboxApi.machines();
      list = Array.isArray(answer?.machines) ? answer.machines : [];
    } catch {
      return;
    }
    setMachines(list);
    await Promise.all(list.filter(readable).map((m) => readOne(m.id)));
  }, [readOne]);

  useEffect(() => {
    if (!active) return;
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
    if (!hidden()) void load();
    const timer = setInterval(() => {
      if (!hidden()) void load();
    }, COMPOSE_SESSIONS_REFRESH_MS);
    const shown = () => {
      if (!hidden()) void load();
    };
    document.addEventListener('visibilitychange', shown);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', shown);
    };
  }, [active, load]);

  useEffect(() => {
    if (active && trust) void readOne(trust.machine);
  }, [active, readOne, trust?.machine, trust?.agent, trust?.project]);

  return { machines, reads, load, readOne };
}
