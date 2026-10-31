import type { InboxParticipant } from '@plannotator/core/inbox-types';
import { HostMark } from '../icons';
import { agentName } from '../tags';
import { Tip } from './Tip';

/**
 * The agents in a list row. A wide row draws them before its project (`RowAgents`, approval "list-rows-mail-icons",
 * 2026-10-30; before the project since the owner's call of 2026-10-31): one bare 16 px mark per agent host,
 * overlapping, in the order they joined the thread; where a mark sits on the one before it, a thin ring in the row's
 * own ground parts them. At most three marks; past three hosts, two. Then "+N", N counting every session not drawn
 * as a mark, a drawn host's second session too (the owner, 2026-10-31: "always show multiple agents before multiple
 * of the same"): three Claude Code sessions and a Pi are Claude, Pi, "+2"; two Claude Code sessions are Claude,
 * "+1". The project hugs its own row's marks, 6 px after them (the owner, 2026-10-31: no column that reserves
 * width). A three-line or phone row draws them before its project too
 * (`RowAgentTiles`, approval "inbox-list-row-v2", 2026-10-30): the thread header's overlapping tiles, one per agent,
 * at most two and a "+N" tile counting the other agents. Either run is one image whose name lists every agent, the
 * hidden ones too.
 */

/** A row draws up to three hosts' marks; past that two. */
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

/**
 * The groups drawn as marks, one per host, and how many sessions the "+N" stands for (0: none): every session but
 * the one each mark stands for, so a drawn host's second session is in the "+N".
 */
export function shownAgentGroups(groups: readonly RowAgentGroup[]): { shown: readonly RowAgentGroup[]; more: number } {
  const shown = groups.length <= ROW_AGENT_MARKS ? groups : groups.slice(0, ROW_AGENT_MARKS - 1);
  return { shown, more: groups.reduce((n, g) => n + g.sessions, 0) - shown.length };
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
      <span className="ib-agmarks" aria-hidden="true">
        {shown.map((g) => (
          <span className="ib-ag" key={g.name} data-agent-host={g.host ?? ''}>
            <HostMark host={g.host} />
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
  return tip ? <Tip content={words}>{marks}</Tip> : marks;
}

/** A three-line or phone row draws at most two tiles; past that, a "+N" tile for the rest. */
export const ROW_AGENT_TILES = 2;

/**
 * The agents drawn as tiles, one per agent (`rowAgentGroups`: two sessions of one host, or two spellings of it,
 * are one tile), first to join first, and how many other agents the "+N" tile stands for (0: none). The run is
 * bounded, so many agents never push the project off its line, and a repeated host never hides a different one.
 */
export function rowAgentTiles(groups: readonly RowAgentGroup[]): { shown: readonly RowAgentGroup[]; more: number } {
  const shown = groups.slice(0, ROW_AGENT_TILES);
  return { shown, more: groups.length - shown.length };
}

/**
 * The three-line and phone rows' agents, drawn before the project (approval "inbox-list-row-v2", 2026-10-30): the
 * thread header's overlapping tiles, at most two, then a "+N" tile; one image named by every agent. `tip`: the words
 * in a tooltip too (not on a phone, where a hover is a first tap).
 */
export function RowAgentTiles({ participants, agent, tip = true }: { participants: readonly InboxParticipant[] | undefined; agent: { kind: string; host?: string | null }; tip?: boolean }) {
  const groups = rowAgentGroups(participants, agent);
  const words = rowAgentWords(groups);
  const { shown, more } = rowAgentTiles(groups);
  const tiles = (
    <span className="ib-atiles" role="img" aria-label={words} data-row-agents={groups.reduce((n, g) => n + g.sessions, 0)}>
      {shown.map((g) => (
        <span className="ib-atile" key={g.name} aria-hidden="true" data-agent-host={g.host ?? ''}>
          <HostMark host={g.host} />
        </span>
      ))}
      {more > 0 && (
        <span className="ib-atile ib-atmore" aria-hidden="true">
          +{more}
        </span>
      )}
    </span>
  );
  return tip ? <Tip content={words}>{tiles}</Tip> : tiles;
}
