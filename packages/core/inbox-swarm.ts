/**
 * Swarm mode (docs/agent-guides/inbox-compose.md, "Swarm"): the view of who in a swarm thread is doing what, worked out
 * the same way by the window and by the `swarm` action. Nothing here is stored: each member's state comes from its live
 * connection (`InboxAgent`), its line (`doing`) is its own claim from the thread's record (`InboxSwarm`), and its file
 * from the agent activity source (`InboxAgent.activity`: tool, file path, time; filled by the agent activity work, a
 * separate change; until it lands no agent has one and the view shows no file and no "also"). The three stay separate
 * fields, so a reader can drop one (a shared space drops `file`: a local path names a computer's folders).
 */

import type { InboxAgent, InboxSwarm } from "./inbox-types";

/** The longest `doing` line kept, in characters. */
export const INBOX_SWARM_DOING_MAX = 200;
const oneLine = (value: string, max: number) => value.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();

/** An agent's `doing` as kept: one line, at most INBOX_SWARM_DOING_MAX; null for nothing to keep. */
export function inboxSwarmDoingClean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = oneLine(value, INBOX_SWARM_DOING_MAX);
  return text || null;
}

/**
 * One agent of a swarm thread as the view shows it. `person` and `machine` say whose agent it is and where it runs
 * (locally always the one person, "owner"; `machine` null: the thread's own computer).
 */
export interface InboxSwarmMember {
  person: string;
  machine: string | null;
  host: string | null;
  session: string;
  name: string;
  /** Where it works (its project's name, and the computer's for another computer's agent). */
  where: string | null;
  /** From its live connection; null when the Inbox lists no agents for its computer. */
  state: InboxAgent["state"] | null;
  live: boolean;
  /** Its host reports nothing about turns: neither working nor idle is known. */
  turns_unknown: boolean;
  /** It waits on the person in its own terminal, as its connection said (`status_mark` blocked there): on what. */
  blocked: "permission" | "question" | null;
  last_seen_at: string | null;
  /** Its own line (a claim). */
  doing: { text: string; at: string } | null;
  /** Its last file, from its plugin. */
  file: { path: string; tool: string; at: string } | null;
  /** The names of the other members whose last file is the same. */
  also: string[];
}

export interface InboxSwarmMemberInput {
  person?: string;
  machine: string | null;
  host: string | null;
  session: string;
  name: string;
  where: string | null;
  /** The listed agent this session is, or null when no list names it. */
  agent: Pick<InboxAgent, "state" | "live" | "last_seen_at" | "turns_unknown" | "status_mark" | "activity"> | null;
  /** Whether its computer lists agents at all (an unlisted session there has ended). */
  listed: boolean;
}

/** The members of a swarm, in the thread's order, with each one's line and the files two of them share. */
export function inboxSwarmMembers(inputs: readonly InboxSwarmMemberInput[], swarm: Pick<InboxSwarm, "doing"> | null): InboxSwarmMember[] {
  const members: InboxSwarmMember[] = inputs.map((input) => {
    const agent = input.agent;
    const said = swarm?.doing.find((d) => d.session === input.session) ?? null;
    const activity = agent?.live ? agent.activity : undefined;
    return {
      person: input.person ?? "owner",
      machine: input.machine,
      host: input.host,
      session: input.session,
      name: input.name,
      where: input.where,
      state: agent ? agent.state : input.listed ? "ended" : null,
      live: agent?.live ?? false,
      turns_unknown: agent?.turns_unknown === true,
      blocked: agent?.live && agent.status_mark?.state === "blocked" && agent.status_mark.where === "terminal" ? (agent.status_mark.kind ?? null) : null,
      last_seen_at: agent?.last_seen_at ?? said?.at ?? null,
      doing: said ? { text: said.text, at: said.at } : null,
      file: activity?.file ? { path: activity.file, tool: activity.tool, at: activity.at } : null,
      also: [],
    };
  });
  for (const member of members) {
    if (!member.file) continue;
    member.also = members.filter((other) => other !== member && other.file?.path === member.file!.path).map((other) => other.name);
  }
  return members;
}

/** What a member's state reads as. `quiet`: no live connection ("no word since"). */
export type InboxSwarmStateKind = "working" | "idle" | "waiting" | "quiet" | "unknown";

export function inboxSwarmStateKind(member: Pick<InboxSwarmMember, "state" | "live" | "turns_unknown"> & { blocked?: InboxSwarmMember["blocked"] }): InboxSwarmStateKind {
  if (member.state === "waiting" || member.blocked) return "waiting";
  if (!member.live || member.state === "ended" || member.state === null) return "quiet";
  if (member.state === "working") return "working";
  return member.turns_unknown ? "unknown" : "idle";
}

/**
 * A member's state in words. `waiting`: the person's words ("waiting on you") or the agent's ("waiting on the
 * person"); `time` writes a time ("2:16 PM" for the person, an ISO time for an agent). Empty: no word (a live agent
 * whose host reports no turns).
 */
export function inboxSwarmStateWords(member: InboxSwarmMember, time: (iso: string) => string, waiting = "waiting on you"): string {
  const kind = inboxSwarmStateKind(member);
  // Waiting in its own terminal on a permission prompt: said, so the person knows where to look.
  if (kind === "waiting" && member.blocked === "permission") return `${waiting} · permission prompt`;
  if (kind === "waiting") return waiting;
  if (kind === "working") return "working";
  if (kind === "idle") return "idle";
  if (kind === "quiet") return member.last_seen_at ? `no word since ${time(member.last_seen_at)}` : "no word yet";
  return "";
}

/** "also Claude Code", "also Claude Code and Pi"; empty for none. */
export function inboxSwarmAlsoWords(names: readonly string[]): string {
  if (names.length === 0) return "";
  if (names.length === 1) return `also ${names[0]}`;
  return `also ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The thread line's summary: "3 agents · 1 waiting on you", else "· 2 working", else the count alone. */
export function inboxSwarmSummary(members: readonly InboxSwarmMember[]): { count: string; more: string | null } {
  const count = `${members.length} agent${members.length === 1 ? "" : "s"}`;
  const waiting = members.filter((m) => inboxSwarmStateKind(m) === "waiting").length;
  if (waiting > 0) return { count, more: `${waiting} waiting on you` };
  const working = members.filter((m) => inboxSwarmStateKind(m) === "working").length;
  return { count, more: working > 0 ? `${working} working` : null };
}
