import type { InboxParticipant } from '@plannotator/core/inbox-types';
import { HostMark } from '../icons';
import { agentName } from '../tags';
import { Tip } from './Tip';

/**
 * The agents in a list row, beside its project (approval "list-rows-mail-icons", 2026-10-30): one bare 16 px mark
 * per agent host, in the order they joined the thread. A host with two or more sessions is one mark and "×N". Past
 * three hosts, two marks and "+N", N counting the sessions not drawn. The marks are plain (no tiles) and carry no
 * words; the run is one image whose name lists every agent, the hidden ones too.
 */

/** A row draws up to three hosts' marks; past that two and "+N". */
export const ROW_AGENT_MARKS = 3;

/** One host in the row: its mark, and how many of its sessions are in the thread. */
export interface RowAgentGroup {
  host: string | null;
  name: string;
  sessions: number;
}

/**
 * The row's agents by host, first to join first. `participants` holds every session when the thread has two or
 * more (the server's `participants`); otherwise the row's one agent (`rowAgent`: the author, or the addressee of
 * a thread the person started). Hosts are told apart by their names, so two spellings of one host
 * (`claude`, `claude-code`) are one mark.
 */
export function rowAgentGroups(participants: readonly InboxParticipant[] | undefined, agent: { kind: string; host?: string | null }): RowAgentGroup[] {
  const sessions = participants && participants.length > 0 ? participants : [{ host: agent.kind === 'agent' ? (agent.host ?? null) : null }];
  const groups: RowAgentGroup[] = [];
  for (const session of sessions) {
    const name = agentName(session.host);
    const group = groups.find((g) => g.name === name);
    if (group) group.sessions++;
    else groups.push({ host: session.host, name, sessions: 1 });
  }
  return groups;
}

/** The groups drawn as marks, and how many sessions the "+N" stands for (0: none). */
export function shownAgentGroups(groups: readonly RowAgentGroup[]): { shown: readonly RowAgentGroup[]; more: number } {
  if (groups.length <= ROW_AGENT_MARKS) return { shown: groups, more: 0 };
  const shown = groups.slice(0, ROW_AGENT_MARKS - 1);
  return { shown, more: groups.slice(shown.length).reduce((n, g) => n + g.sessions, 0) };
}

/** Every agent in words: "Claude Code, OpenCode and Codex", "2 Claude Code sessions". */
export function rowAgentWords(groups: readonly RowAgentGroup[]): string {
  const words = groups.map((g) => (g.sessions < 2 ? g.name : g.host ? `${g.sessions} ${g.name} sessions` : `${g.sessions} agent sessions`));
  return words.length < 2 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/**
 * The marks, one image named by every agent. `tip`: the words in a tooltip too (not on a phone, where a hover is a
 * first tap).
 */
export function RowAgents({ participants, agent, tip = true }: { participants: readonly InboxParticipant[] | undefined; agent: { kind: string; host?: string | null }; tip?: boolean }) {
  const groups = rowAgentGroups(participants, agent);
  const { shown, more } = shownAgentGroups(groups);
  const words = rowAgentWords(groups);
  const marks = (
    <span className="ib-ags" role="img" aria-label={words} data-row-agents={groups.reduce((n, g) => n + g.sessions, 0)}>
      {shown.map((g) => (
        <span className="ib-ag" key={g.name} aria-hidden="true" data-agent-host={g.host ?? ''}>
          <HostMark host={g.host} />
          {g.sessions > 1 && <span className="ib-agx">×{g.sessions}</span>}
        </span>
      ))}
      {more > 0 && (
        <span className="ib-agplus" aria-hidden="true">
          +{more}
        </span>
      )}
    </span>
  );
  return tip ? <Tip content={words}>{marks}</Tip> : marks;
}
