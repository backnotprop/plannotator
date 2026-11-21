/**
 * The status mark for every agent (owner, 2026-11-18, "steps 1 and 2 together"): the existing jelly marks (Rex's,
 * packages/inbox/agents/rexMark.tsx), drawn from what this Inbox already knows of an agent, for agents that run in no
 * Rex pane too. Pure: inbox-agents-list.ts calls it for each listed agent with what its session's connection said.
 *
 * In order, the first that holds:
 *  - ended: no mark (today's icon);
 *  - its connection said, in the last INBOX_BLOCKED_STALE_MS, that it waits on the person in its terminal (a
 *    permission prompt or a question; the Claude Code mod, the OpenCode 2 plugin, Pi): `blocked` with that kind,
 *    `where: "terminal"`. Not for a session the Inbox launched, whose prompts its own launch shows here instead;
 *  - a thread of it waits on the person (Stopped on you, Holding up work, Waiting on you): `blocked`, `where: "inbox"`,
 *    whatever its host reports;
 *  - a turn runs (its connection said busy, or its launch is starting or working): `working`;
 *  - otherwise no mark. At rest draws nothing (owner ruling, 2026-11-18: the approved marks are working, asking and
 *    done; no idle mark), the same as a host that reports nothing about turns. A live one of those says so
 *    (`turns_unknown`), so the window never calls it idle in words either.
 *
 * What it never claims: `done` (only a terminal knows the person has not looked yet: Rex's record says it), `ended`
 * from silence (an ended agent has no mark at all), anything from a title or screen text, any free text (a mark is a
 * state and a kind).
 */
import type { InboxAgent, InboxAgentMark } from "@plannotator/core/inbox-types";
import type { InboxBlockedKind } from "@plannotator/shared/inbox/connection";

/** What an agent's session's connection says now (`InboxAgentSession`); null when the Inbox holds no session for it. */
export interface InboxAgentTurnFacts {
  /** A turn runs now; null when its connection does not say. */
  busy: boolean | null;
  /** What it waits on in its terminal now (fresh); null when nothing. */
  blocked: InboxBlockedKind | null;
}

/** The agent with its status mark (and `turns_unknown`), or as it was when it gets neither. */
export function withAgentStatusMark(agent: InboxAgent, facts: InboxAgentTurnFacts | null): InboxAgent {
  const { status_mark: _mark, turns_unknown: _unknown, ...plain } = agent;
  const mark = agentStatusMark(plain, facts);
  if (mark) return { ...plain, status_mark: mark };
  const unknown = plain.live && plain.state === "idle" && !plain.launch && (facts?.busy ?? null) === null;
  return unknown ? { ...plain, turns_unknown: true } : plain;
}

function agentStatusMark(agent: InboxAgent, facts: InboxAgentTurnFacts | null): InboxAgentMark | null {
  if (agent.state === "ended") return null;
  if (agent.live && !agent.launch && facts?.blocked) return { state: "blocked", kind: facts.blocked, where: "terminal" };
  if (agent.waiting > 0) return { state: "blocked", where: "inbox" };
  if (agent.state === "working") return { state: "working" };
  return null;
}
