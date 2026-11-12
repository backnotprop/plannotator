import type { InboxParticipant } from '@plannotator/core/inbox-types';
import { HostMark } from '../icons';
import { labelOf, shortLabel, useSessionLabels, type SessionLabels } from '../sessionLabels';
import { agentName } from '../tags';
import { RowTip } from './RowTip';

export const ROW_AGENT_MARKS = 3;

export const ROW_LABEL_MAX = 32;

export interface RowAgentGroup {
  host: string | null;
  name: string;
  sessions: number;
  session?: string | null;
  labels?: string[];
}

export function rowAgentGroups(
  participants: readonly InboxParticipant[] | undefined,
  agent: { kind: string; host?: string | null; session?: string | null },
  labels: SessionLabels = {},
): RowAgentGroup[] {
  const sessions: readonly { host: string | null; session?: string | null }[] =
    participants && participants.length > 0 ? participants : [{ host: agent.kind === 'agent' ? (agent.host ?? null) : null, session: agent.kind === 'agent' ? (agent.session ?? null) : null }];
  const groups: RowAgentGroup[] = [];
  for (const session of sessions) {
    const name = agentName(session.host);
    const label = labelOf(labels, session.session);
    const group = groups.find((g) => g.name === name);
    if (group) {
      group.sessions++;
      if (label) group.labels = [...(group.labels ?? []), label];
    } else groups.push({ host: session.host, name, sessions: 1, ...(session.session ? { session: session.session } : {}), ...(label ? { labels: [label] } : {}) });
  }
  return groups;
}

export function shownAgentGroups(groups: readonly RowAgentGroup[]): { shown: readonly RowAgentGroup[]; more: number } {
  const shown = groups.length <= ROW_AGENT_MARKS ? groups : groups.slice(0, ROW_AGENT_MARKS - 1);
  return { shown, more: groups.reduce((n, g) => n + g.sessions, 0) - shown.length };
}

export function rowAgentWords(groups: readonly RowAgentGroup[]): string {
  const words = groups.map((g) => {
    const named = (g.labels ?? []).map((label) => shortLabel(label, ROW_LABEL_MAX));
    const plain = g.sessions < 2 ? g.name : g.host ? `${g.sessions} ${g.name} sessions` : `${g.sessions} agent sessions`;
    if (named.length === 0) return plain;
    if (g.sessions < 2) return `${named[0]} (${g.name})`;
    const unnamed = g.sessions - named.length;
    return `${plain} (${[...named, ...(unnamed > 0 ? [`${unnamed} unnamed`] : [])].join(', ')})`;
  });
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function RowAgents({ participants, agent, tip = true }: { participants: readonly InboxParticipant[] | undefined; agent: { kind: string; host?: string | null; session?: string | null }; tip?: boolean }) {
  const groups = rowAgentGroups(participants, agent, useSessionLabels());
  const { shown, more } = shownAgentGroups(groups);
  const words = rowAgentWords(groups);
  const marks = (
    <span className="ib-ags" role="img" aria-label={words} data-row-agents={groups.reduce((n, g) => n + g.sessions, 0)}>
      <span className="ib-atiles" aria-hidden="true">
        {shown.map((g) => (
          <span className="ib-atile" key={g.name} data-agent-host={g.host ?? ''}>
            <HostMark host={g.host} agent={g.session} />
          </span>
        ))}
      </span>
      {more > 0 && (
        <span className="ib-agplus" aria-hidden="true">
          +{more}
        </span>
      )}
    </span>
  );
  return tip ? <RowTip content={words}>{marks}</RowTip> : marks;
}

export const ROW_AGENT_TILES = 2;

export function rowAgentTiles(groups: readonly RowAgentGroup[]): { shown: readonly RowAgentGroup[]; more: number } {
  const shown = groups.slice(0, ROW_AGENT_TILES);
  return { shown, more: groups.length - shown.length };
}

export function RowAgentTiles({ participants, agent, tip = true }: { participants: readonly InboxParticipant[] | undefined; agent: { kind: string; host?: string | null; session?: string | null }; tip?: boolean }) {
  const groups = rowAgentGroups(participants, agent, useSessionLabels());
  const words = rowAgentWords(groups);
  const { shown, more } = rowAgentTiles(groups);
  const tiles = (
    <span className="ib-atiles" role="img" aria-label={words} data-row-agents={groups.reduce((n, g) => n + g.sessions, 0)}>
      {shown.map((g) => (
        <span className="ib-atile" key={g.name} aria-hidden="true" data-agent-host={g.host ?? ''}>
          <HostMark host={g.host} agent={g.session} />
        </span>
      ))}
      {more > 0 && (
        <span className="ib-atile ib-atmore" aria-hidden="true">
          +{more}
        </span>
      )}
    </span>
  );
  return tip ? <RowTip content={words}>{tiles}</RowTip> : tiles;
}
