import type { InboxParticipant } from '@plannotator/core/inbox-types';
import { HostMark } from '../icons';
import { labelOf, shortLabel, useSessionLabels, type SessionLabels } from '../sessionLabels';
import { agentName } from '../tags';
import { RowTip } from './RowTip';

/**
 * The agents in a list row, before its project, on the same grey tiles in every list row (the owner, 2026-10-31):
 * 20 px with a 13 px logo, overlapping with no cut, so every logo stays whole and the run reads as one grey shape.
 * A wide row (`RowAgents`, approval "list-rows-mail-icons", 2026-10-30): one tile per agent host, first to join first.
 * At most three tiles; past three hosts, two. Then "+N" as plain text, N counting every session not drawn as a tile,
 * a drawn host's second session too (the owner, 2026-10-31: "always show multiple agents before multiple of the
 * same"): three Claude Code sessions and a Pi are Claude, Pi, "+2"; two Claude Code sessions are Claude, "+1". The
 * project hugs its own row's tiles, 6 px after them (the owner, 2026-10-31: no column that reserves width). A
 * three-line or phone row (`RowAgentTiles`, approval "inbox-list-row-v2", 2026-10-30): one tile per agent, at most
 * two and a "+N" tile counting the other agents. Either run is one image whose name lists every agent, the hidden
 * ones too.
 */

/** A wide row draws up to three hosts' tiles; past that two. */
export const ROW_AGENT_MARKS = 3;

/** The longest session label the row's words carry, in characters; a longer one is cut in the middle. */
export const ROW_LABEL_MAX = 32;

/** One host in the row: its tile, and how many of its sessions are in the thread. */
export interface RowAgentGroup {
  host: string | null;
  name: string;
  sessions: number;
  /** The labels of its sessions that have one (issue #2450), first to join first; absent or empty: none named. */
  labels?: string[];
}

/**
 * The row's agents by host, first to join first. `participants` holds every session when the thread has two or
 * more (the server's `participants`); otherwise the row's one agent (`rowAgent`: the author, or the addressee of
 * a thread the person started). Hosts are told apart by their names, so two spellings of one host
 * (`claude`, `claude-code`) are one tile.
 */
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
    } else groups.push({ host: session.host, name, sessions: 1, ...(label ? { labels: [label] } : {}) });
  }
  return groups;
}

/**
 * The groups a wide row draws as tiles, one per host, and how many sessions the "+N" stands for (0: none): every
 * session but the one each tile stands for, so a drawn host's second session is in the "+N".
 */
export function shownAgentGroups(groups: readonly RowAgentGroup[]): { shown: readonly RowAgentGroup[]; more: number } {
  const shown = groups.length <= ROW_AGENT_MARKS ? groups : groups.slice(0, ROW_AGENT_MARKS - 1);
  return { shown, more: groups.reduce((n, g) => n + g.sessions, 0) - shown.length };
}

/**
 * Every agent in words: "Claude Code, OpenCode and Codex", "2 Claude Code sessions". A named session says its
 * label (issue #2450): "Fix login redirect (Claude Code)", "3 Claude Code sessions (Fix login redirect, Docs pass,
 * 1 unnamed)"; each label cut in the middle past ROW_LABEL_MAX. No label: the words as they were.
 */
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

/**
 * A wide row's tiles and "+N", one image named by every agent. `tip`: the words in a tooltip too (not on a phone,
 * where a hover is a first tap).
 */
export function RowAgents({ participants, agent, tip = true }: { participants: readonly InboxParticipant[] | undefined; agent: { kind: string; host?: string | null; session?: string | null }; tip?: boolean }) {
  const groups = rowAgentGroups(participants, agent, useSessionLabels());
  const { shown, more } = shownAgentGroups(groups);
  const words = rowAgentWords(groups);
  const marks = (
    <span className="ib-ags" role="img" aria-label={words} data-row-agents={groups.reduce((n, g) => n + g.sessions, 0)}>
      <span className="ib-atiles" aria-hidden="true">
        {shown.map((g) => (
          <span className="ib-atile" key={g.name} data-agent-host={g.host ?? ''}>
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
  return tip ? <RowTip content={words}>{marks}</RowTip> : marks;
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
 * The three-line and phone rows' agents, drawn before the project (approval "inbox-list-row-v2", 2026-10-30): at most
 * two tiles, then a "+N" tile; one image named by every agent. `tip`: the words in a tooltip too (not on a phone,
 * where a hover is a first tap).
 */
export function RowAgentTiles({ participants, agent, tip = true }: { participants: readonly InboxParticipant[] | undefined; agent: { kind: string; host?: string | null; session?: string | null }; tip?: boolean }) {
  const groups = rowAgentGroups(participants, agent, useSessionLabels());
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
  return tip ? <RowTip content={words}>{tiles}</RowTip> : tiles;
}
