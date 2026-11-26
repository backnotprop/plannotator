/**
 * Swarm (docs/agent-guides/inbox-swarm.md): a thread whose agents work as one team. Behind the experimental switch
 * `swarm` (PLANNOTATOR_EXPERIMENTAL=swarm, config `experimental.swarm`), off by default.
 *
 * - One quiet record per thread in the event log (kind `swarm`, the project's swarm.jsonl, like `steps` and
 *   `thread_pull`): on or off, its ghost thread, and the agents that joined with `plannotator inbox swarm join`.
 * - The ghost thread: a real thread whose root, written by the Inbox, carries `ghost_of: <thread id>`. It lives on the
 *   thread's computer and is reached only through its parent thread (`isInboxGhostRoot`): never in the list, search,
 *   unread counts, notifications, the Board, Tidy, routing by thread name or the sidebar.
 */

/** An agent that joined the swarm (`swarm join`). */
export interface InboxSwarmMember {
  session: string;
  /** The connection's host (`claude-code`, `codex`, `pi`), null when it named none. */
  host: string | null;
  /** The name the others use (`--as`), else the agent's own (its host's label). Unique in the swarm. */
  name: string;
  /** A linked computer's Inbox id when the agent runs there; absent here. */
  machine?: string | null;
  /** That computer's name as this Inbox shows it. */
  machine_name?: string | null;
  /** The member it works for (`--for`): a sub-agent's parent. */
  for?: string | null;
  joined_at: string;
  /** `swarm doing`: one line, at most INBOX_SWARM_DOING_MAX characters, no control characters. */
  doing?: { text: string; at: string } | null;
}

/** One line of a swarm's plan (`swarm propose`): who does a part, and what. */
export interface InboxSwarmPlanPart {
  /** Who: an agent's name in the swarm (as `swarm status` shows it, `--as` when it joins), or one an agent brings in. */
  who: string;
  /** What it will do: one line, at most INBOX_SWARM_DOING_MAX characters. */
  does: string;
  /** A sub-agent: the agent it works for (its line was indented under that one). */
  for?: string | null;
  /** The member that wrote this line (its name). */
  by: string;
  at: string;
}

/**
 * The swarm's plan (approval "inbox-swarm-thread-ui", the plan card): the proposal the first agent writes with `swarm
 * propose`, and the lines the others add. The window draws it as a card in place of the words of `message_id`.
 */
export interface InboxSwarmPlan {
  /** The plan in one line, when a proposal gave one (the latest that did). */
  summary?: string | null;
  parts: InboxSwarmPlanPart[];
  /** The card's message: the agent reply the first proposal wrote in the thread (`InboxMessage.swarm_plan`). */
  message_id: string;
  /** The first proposal: the swarm started working then. */
  at: string;
}

/** The most lines a plan keeps. */
export const INBOX_SWARM_PLAN_MAX = 60;

/** One thread's swarm (record kind `swarm`, its id the thread's). */
export interface InboxSwarmRecord {
  /** The thread's id (one record per thread). */
  id: string;
  thread_id: string;
  project_id: string;
  on: boolean;
  /** The ghost thread's root id; null until it is written. */
  ghost_id: string | null;
  members: InboxSwarmMember[];
  /** The person last looked at the ghost thread (its agents' messages after it are the Ghost button's count). */
  person_seen_at?: string | null;
  /** The store's seq when it was last turned on (started, or turned back on): ghost words written before it wait for nobody. */
  on_seq?: number | null;
  /** The plan (`swarm propose`); absent until an agent proposes one. */
  plan?: InboxSwarmPlan | null;
  started_at: string;
  updated_at: string;
}

/** A member as the window shows it: a joined agent, or one the thread names that has not joined yet. */
export interface InboxSwarmMemberWire {
  session: string;
  host: string | null;
  name: string;
  /** The linked computer it runs on; null: a linked computer whose name is not known; absent: the thread's computer. */
  machine_name?: string | null;
  for?: string | null;
  joined: boolean;
  /** From the live connection: working, idle or waiting on the person; null when not known. */
  state?: "working" | "idle" | "waiting" | null;
  doing?: { text: string; at: string } | null;
}

/** `InboxThread.swarm` (additive; only while the experimental switch is on). */
export interface InboxThreadSwarm {
  on: boolean;
  ghost_id: string | null;
  members: InboxSwarmMemberWire[];
  /** Ghost messages the person has not looked at (the Ghost button's count). */
  ghost_unread?: number;
  /** The plan the plan card draws; absent until an agent proposed one. */
  plan?: InboxSwarmPlan | null;
}

/** The longest `swarm doing` line. */
export const INBOX_SWARM_DOING_MAX = 200;

/** A ghost thread's root (it carries `ghost_of`). */
export function isInboxGhostRoot(message: { ghost_of?: string | null } | null | undefined): boolean {
  return typeof message?.ghost_of === "string" && message.ghost_of !== "";
}

/** Control characters, and the two line separators JavaScript reads as line ends. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+", "g");

/** A `swarm doing` line: control characters out, spaces folded, at most INBOX_SWARM_DOING_MAX characters. */
export function sanitizeSwarmDoing(text: string): string {
  const clean = text.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  return [...clean].slice(0, INBOX_SWARM_DOING_MAX).join("");
}
