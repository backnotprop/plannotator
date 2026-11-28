import type { InboxComposeLaunch } from '@plannotator/core/inbox-types';
import type { ComposeSessionsModel } from '../api';
import { composeGroups, machineLaunchNotice, scratchProject, type LaunchMachine, type MachineLaunchProject, type MachineLaunchRead } from './model';
import type { ToMachine } from './toMachines';

function withScratch(block: InboxComposeLaunch | undefined, machine: { id: string; name: string } | null): ToMachine['launch'] {
  if (!block || block.agents.length === 0) return null;
  const on = (p: MachineLaunchProject): MachineLaunchProject => (machine ? { ...p, machine: machine.id, machine_name: machine.name } : p);
  const projects = block.projects.length === 0 && block.scratch ? [scratchProject(block.scratch.root)] : block.projects;
  return projects.length ? { agents: block.agents, projects: projects.map(on) } : null;
}

export function linkedToMachines(
  here: ToMachine,
  machines: readonly LaunchMachine[],
  reads: ReadonlyMap<string, MachineLaunchRead>,
  linkedSessions: ReadonlyMap<string, ComposeSessionsModel['projects']>,
  lastSent: Parameters<typeof composeGroups>[2],
  launch: InboxComposeLaunch | undefined,
): ToMachine[] {
  const linked = machines
    .filter((m) => !m.self && m.state !== 'revoked')
    .map((m): ToMachine => {
      const read = reads.get(m.id);
      const notice = machineLaunchNotice(m, read);
      return {
        key: m.id,
        machine: m.id,
        name: m.name,
        self: false,
        asleep: m.state === 'offline',
        since: m.since,
        home: read?.home ?? null,
        groups: composeGroups(linkedSessions.get(m.id) ?? [], null, lastSent),
        launch: notice ? null : withScratch(read?.launch, m),
        notice,
      };
    });
  return [{ ...here, launch: withScratch(launch, null) }, ...linked];
}
