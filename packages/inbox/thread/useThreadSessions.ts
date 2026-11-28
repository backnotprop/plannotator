import { useMemo } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import type { MachineView } from '../api';
import type { MachinesModel } from '../machines';
import { threadSessions, type ThreadSession } from '../agents/model';
import { useInboxAgentsWho } from '../agentsList';
import type { useSessionLabels } from '../sessionLabels';
import type { useAgentNames } from '../agents/agentNames';
import { givenName } from '../agents/agentNames';
import type { TagOption } from '../tags';

const NO_MACHINES: MachinesModel = { self: null, all: [], linked: [], names: new Map(), away: new Set() };
const NO_ROWS: readonly InboxListRow[] = [];
const NO_SESSIONS: readonly ThreadSession[] = [];

export function useThreadSessions(
  participants: Parameters<typeof threadSessions>[0],
  agentContext: { rows: readonly InboxListRow[]; machines: MachinesModel } | null,
  machine: MachineView | null,
  sessionLabels: ReturnType<typeof useSessionLabels>,
) {
  const several = participants.length > 1;
  const agentsWho = useInboxAgentsWho(several);
  const sessions = useMemo(
    () => (several ? threadSessions(participants, agentsWho, agentContext?.machines ?? NO_MACHINES, agentContext?.rows ?? NO_ROWS, machine?.id ?? null, sessionLabels) : NO_SESSIONS),
    [several, participants, agentsWho, agentContext, machine, sessionLabels],
  );
  const sessionNames = useMemo(() => new Map(sessions.length > 1 ? sessions.flatMap((s) => s.sessions.map((id) => [id, s.name] as const)) : []), [sessions]);
  return { sessions, sessionNames };
}

/**
 * The tag options with the names the person gave: a picker row leads with that name, its token's label after it in
 * the detail, so the person sees what the `@` token will say. The token itself keeps `label` (an agent never sees an
 * Inbox name).
 */
export function namedTagOptions(options: readonly TagOption[], agentNames: ReturnType<typeof useAgentNames>): TagOption[] {
  return options.map((option) => {
    const given = givenName(agentNames, option.id);
    if (!given) return option;
    const detail = given === option.label ? option.detail : option.detail ? `${option.label} · ${option.detail}` : option.label;
    return { ...option, name: given, detail };
  });
}
