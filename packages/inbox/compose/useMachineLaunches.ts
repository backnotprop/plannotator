import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi, type ComposeTrustPick, type MachineView } from '../api';
import { COMPOSE_SESSIONS_REFRESH_MS } from './useComposeSessions';
import type { MachineLaunchRead } from './model';

/**
 * Each linked machine's last good sessions read (its launch block and home): an asleep machine's projects still show
 * in the folder menu, and a Send to it waits in the outbox. A machine not read live here (asleep, or not read yet)
 * takes the read the server kept (`launch_reads` on the machines answer), so a window opened while that machine
 * sleeps lists it too, and one that read it earlier gets what another window read since.
 */
const kept = new Map<string, MachineLaunchRead>();

/** Tests only: forget every machine's read. */
export function resetMachineLaunchesForTests(): void {
  kept.clear();
}

/** A linked machine whose sessions are worth reading now: online, and launch not off or unknown there. */
const readable = (m: MachineView) => !m.self && m.state === 'online' && m.launch === true;

/**
 * Remote launch: every machine (`GET /api/inbox/machines`) and, for each linked one that is online with launch on,
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
      const answer = await inboxApi.machines(true);
      list = Array.isArray(answer?.machines) ? answer.machines : [];
      // The server's copy is the newest read any window made through it, this page's own included. A machine read live
      // here keeps this page's read (its next read lands in a moment); any other takes the server's.
      const serverReads = answer?.launch_reads ?? {};
      let learned = false;
      for (const m of list) {
        const read = m.self || (readable(m) && kept.has(m.id)) ? undefined : serverReads[m.id];
        if (!read?.launch) continue;
        const next: MachineLaunchRead = { launch: read.launch, home: typeof read.home === 'string' ? read.home : null };
        const had = kept.get(m.id);
        if (had && JSON.stringify(had) === JSON.stringify(next)) continue;
        kept.set(m.id, next);
        learned = true;
      }
      if (learned) setReads(new Map(kept));
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
