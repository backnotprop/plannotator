/**
 * The plan card's rows and words (swarm/SwarmPlanCard.tsx), pure, from the thread read's `swarm` (its `plan` and its
 * `members`, the same members the status view reads). A plan line names its agent as `swarm status` shows it: the
 * member of that name, joined or not yet, answers it; no member answering yet is an agent being brought in.
 */
import type { InboxSwarmMemberWire, InboxSwarmPlan, InboxSwarmPlanPart, InboxThreadSwarm } from '@plannotator/core/inbox-swarm-types';
import { INBOX_HOST_NAMES } from '@plannotator/core/inbox-types';

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export interface SwarmPlanRow {
  part: InboxSwarmPlanPart;
  /** 1: a sub-agent under the line of the agent it works for. */
  depth: 0 | 1;
  /** The member that answers to the line's name, joined or not yet; null: an agent being brought in. */
  member: InboxSwarmMemberWire | null;
  /** Whose mark it shows: its member's host, else the host its name starts with, else its parent's (a sub-agent). */
  host: string | null;
  joined: boolean;
  /** A sub-agent's line (it was indented): it shows "sub-agent" until it joins, and is never counted as joining. */
  sub: boolean;
}

/** The host a name starts with ("Codex 2" is Codex), for a line no member answers to yet. */
export function hostOfName(name: string): string | null {
  const lower = name.trim().toLowerCase();
  let best: { host: string; length: number } | null = null;
  for (const [host, label] of Object.entries(INBOX_HOST_NAMES)) {
    const l = label.toLowerCase();
    if ((lower === l || lower.startsWith(`${l} `)) && (!best || l.length > best.length)) best = { host, length: l.length };
  }
  return best?.host ?? null;
}

/** The rows in the card's order: each agent's line, then the lines of its sub-agents under it. */
export function swarmPlanRows(plan: Pick<InboxSwarmPlan, 'parts'>, members: readonly InboxSwarmMemberWire[]): SwarmPlanRow[] {
  const parts = plan.parts;
  const parentOf = (p: InboxSwarmPlanPart) => (p.for ? (parts.find((o) => o !== p && same(o.who, p.for!)) ?? null) : null);
  const row = (part: InboxSwarmPlanPart, depth: 0 | 1, parentHost: string | null): SwarmPlanRow => {
    const member = members.find((m) => same(m.name, part.who)) ?? null;
    return { part, depth, member, host: member?.host ?? hostOfName(part.who) ?? (part.for ? parentHost : null), joined: member?.joined === true, sub: !!part.for };
  };
  const out: SwarmPlanRow[] = [];
  for (const top of parts.filter((p) => parentOf(p) === null)) {
    const first = row(top, 0, null);
    out.push(first);
    for (const sub of parts.filter((p) => parentOf(p) === top)) out.push(row(sub, 1, first.host));
  }
  // A sub-agent under another sub-agent: under its own line, still indented.
  for (const part of parts) if (!out.some((r) => r.part === part)) out.push(row(part, 1, null));
  return out;
}

/** The band's one calm line: "Started 2:05 PM · Pi is joining on Mini", "… · everyone joined". */
export function swarmPlanStatusWords(plan: Pick<InboxSwarmPlan, 'at'>, rows: readonly SwarmPlanRow[], swarm: Pick<InboxThreadSwarm, 'on'>, time: (iso: string) => string): string {
  const started = `Started ${time(plan.at)}`;
  if (!swarm.on) return `${started} · turned off`;
  if (rows.length === 0) return started;
  const joining = rows.filter((r) => !r.joined && !r.sub);
  if (joining.length === 0) return `${started} · everyone joined`;
  if (joining.length > 1) return `${started} · ${joining.length} agents are joining`;
  const one = joining[0]!;
  return `${started} · ${one.part.who} is joining${one.member?.machine_name ? ` on ${one.member.machine_name}` : ''}`;
}

/** "3 parts". */
export const swarmPlanCountWords = (plan: Pick<InboxSwarmPlan, 'parts'>) => `${plan.parts.length} ${plan.parts.length === 1 ? 'part' : 'parts'}`;

/** A long team folds: past FOLD_AFTER rows, the card shows FOLD_SHOWN and a "Show N more". */
export const SWARM_PLAN_FOLD_AFTER = 8;
export const SWARM_PLAN_FOLD_SHOWN = 6;
