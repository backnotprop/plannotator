/**
 * The agent's line (approval "inbox-agent-profile-card"): what the card atop a list filtered to one agent, the
 * agent's row in the Agents view and its profile's Activity say it is doing now. Pure, from what the Inbox already
 * knows of the agent (`InboxAgent`): working (with how long, from `state_since`), asking the person in its terminal
 * (a permission prompt, a question, a sign-in: amber, a pause mark), idle since its turn ended, ended. One waiting on
 * the person here says what it does besides (`turn_state`); "Waiting on you" is said on its threads. An agent whose host says nothing about its turns (`turns_unknown`, no plugin) gets no line at all,
 * and nothing in its place.
 */
import type { InboxAgent } from '@plannotator/core/inbox-types';
import { shortTime, whenTime } from '../format';
import { REX_MARK_WORDS } from '../agents/rexMark';

/** What the line is read from: the listed agent's state, as the Agents view keeps it on its rows too. */
export interface AgentLineFacts {
  /** Null: the list cannot know (a machine whose agents it does not name). */
  state: InboxAgent['state'] | null;
  /**
   * What the line says it does: its state, or for one waiting on the person, what it does besides
   * (`InboxAgent.turn_state`; "Waiting on you" is said on its threads). Null: not known, no line.
   */
  run: Exclude<InboxAgent['state'], 'waiting'> | null;
  /** Live, on a host that never says when it works: no line. */
  turnsUnknown: boolean;
  /** When it was last heard, for an ended one ("Ended 4:10 PM"). */
  endedAt: string | null;
  /** It waits on the person in its own terminal (or its Rex pane): what for. */
  asking: 'permission' | 'question' | 'auth' | null;
  /** When its turn started (working) or ended (idle): `InboxAgent.state_since`. */
  since: string | null;
}

export type AgentLineTone = 'working' | 'asking' | 'idle' | 'ended';

export interface AgentLine {
  tone: AgentLineTone;
  words: string;
  /** A duration counts from here ("Working · 3m"); null: none shown. */
  from: string | null;
}

/** What it waits on in its terminal: its connection said so (`status_mark`), else its Rex pane did (`rex_status`). */
function askingOf(agent: InboxAgent): AgentLineFacts['asking'] {
  const mark = agent.status_mark;
  if (mark?.state === 'blocked' && mark.where === 'terminal' && mark.kind) return mark.kind;
  const rex = agent.rex_status;
  return rex?.state === 'blocked' && rex.kind ? rex.kind : null;
}

export function lineFactsOf(agent: InboxAgent): AgentLineFacts {
  const run = agent.state === 'waiting' ? (agent.turn_state ?? null) : agent.state;
  return {
    state: agent.state,
    run,
    turnsUnknown: agent.turns_unknown === true,
    endedAt: run === 'ended' ? agent.last_seen_at : null,
    asking: run === 'ended' ? null : askingOf(agent),
    since: agent.state_since ?? null,
  };
}

const ASKING: Record<NonNullable<AgentLineFacts['asking']>, string> = {
  permission: REX_MARK_WORDS.permission,
  question: REX_MARK_WORDS.question,
  auth: REX_MARK_WORDS.signin,
};

/** The line, or null: nothing is known that the line could say (no plugin, or a machine that names no agents). */
export function agentLineOf(facts: AgentLineFacts, now: Date = new Date()): AgentLine | null {
  if (facts.run === 'ended') return { tone: 'ended', words: facts.endedAt ? `Ended ${shortTime(facts.endedAt, now)}` : 'Ended', from: null };
  if (facts.asking) return { tone: 'asking', words: ASKING[facts.asking], from: null };
  if (facts.run === null) return null;
  if (facts.run === 'working') return { tone: 'working', words: 'Working', from: facts.since };
  if (facts.turnsUnknown) return null;
  return { tone: 'idle', words: facts.since ? `Idle since ${whenTime(facts.since, now)}` : 'Idle', from: null };
}

/** "12s", "3m", "1h 5m": how long, as the line and the profile's Activity say it. */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`;
}

/** Two facts that draw the same line (the Agents view's memoized row compares them). */
export const sameLineFacts = (a: AgentLineFacts, b: AgentLineFacts): boolean =>
  a === b || (a.state === b.state && a.run === b.run && a.turnsUnknown === b.turnsUnknown && a.endedAt === b.endedAt && a.asking === b.asking && a.since === b.since);
