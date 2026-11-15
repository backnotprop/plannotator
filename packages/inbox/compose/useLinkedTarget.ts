import { useMemo } from 'react';
import type { ComposeSessionsModel } from '../api';
import { useAgentNames } from '../agents/agentNames';
import { composeTargets, findTarget, type LaunchMachine, type MachineLaunchRead } from './model';
import { withGivenSessionNames } from './useComposeSessions';

export function useLinkedTarget(otherMachines: boolean, there: { machines: readonly LaunchMachine[]; reads: ReadonlyMap<string, MachineLaunchRead> }, projects: ComposeSessionsModel['projects'], chosen: string | null) {
  const agentNames = useAgentNames();
  const linkedSessions = useMemo(() => {
    const out = new Map<string, ComposeSessionsModel['projects']>();
    if (!otherMachines) return out;
    for (const [id, read] of there.reads) out.set(id, withGivenSessionNames({ serverSession: '', home: read.home ?? '', projects: read.projects ?? [] }, agentNames)?.projects ?? []);
    return out;
  }, [otherMachines, there.reads, agentNames]);
  const hereTarget = findTarget(projects, chosen);
  const linkedTarget = useMemo(() => {
    if (hereTarget || !chosen) return null;
    for (const m of there.machines) {
      const found = !m.self && m.state !== 'revoked' ? findTarget(linkedSessions.get(m.id) ?? [], chosen) : null;
      if (found) return { target: found, machine: m };
    }
    return null;
  }, [hereTarget, chosen, linkedSessions, there.machines]);
  const target = hereTarget ?? linkedTarget?.target ?? null;
  const anyLive = composeTargets(projects).length > 0 || [...linkedSessions.values()].some((p) => composeTargets(p).length > 0);
  return { linkedSessions, target, targetOn: linkedTarget?.machine.id ?? null, targetMachineName: linkedTarget?.machine.name ?? null, anyLive };
}
