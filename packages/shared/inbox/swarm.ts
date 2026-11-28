/**
 * Swarm's rules (docs/agent-guides/inbox-swarm.md): who joins, who is told what, and what an agent reads back. The
 * store keeps the record and the ghost thread (store.ts, "Swarm"); the server's route calls these
 * (packages/server/inbox-swarm-route.ts), for `plannotator inbox swarm` and for the window.
 *
 * Every word an agent reads from the command is in SWARM_WORDS (DRAFT: the owner approves them before merge).
 */

import { inboxAgentName, type InboxMessage, type InboxTag } from "@plannotator/core/inbox-types";
import { INBOX_SWARM_PLAN_MAX, sanitizeSwarmDoing, type InboxSwarmMember, type InboxSwarmMemberWire, type InboxSwarmPlan, type InboxSwarmPlanPart, type InboxSwarmRecord, type InboxThreadSwarm } from "@plannotator/core/inbox-swarm-types";
import { InboxError } from "./schema";
import type { InboxStore } from "./store";
import { inboxMessageStartsSwarm } from "./swarm-start";

/** Who runs the command: its session, and, through a linked computer's door, that computer. */
export interface SwarmCaller {
  session: string;
  host: string | null;
  name: string | null;
  machine?: string | null;
  machine_name?: string | null;
}

/** A member's live state, as this Inbox knows it (null: not known). */
export type SwarmLiveState = (member: { session: string; machine?: string | null }, threadId: string) => "working" | "idle" | "waiting" | null;

/** The longest `swarm say`. */
export const SWARM_SAY_MAX = 20_000;
/** How many ghost messages `swarm join` prints, and how long each may be there. */
const JOIN_GHOST_LINES = 10;
const JOIN_GHOST_CHARS = 400;

/** Every line an agent reads from `plannotator inbox swarm` (DRAFT, awaiting the owner). */
export const SWARM_WORDS = {
  off: "Swarm is off in this Inbox (experimental: PLANNOTATOR_EXPERIMENTAL=swarm).",
  notSwarm: (thread: string) => `Thread ${thread} is not a swarm. The person starts a swarm from New message.`,
  turnedOff: (thread: string) => `The person turned off the swarm of thread ${thread}.`,
  notJoined: "You have not joined a swarm. Join first: plannotator inbox swarm join <thread>.",
  several: (threads: string[]) => `You are in ${threads.length} swarms: add --thread <id> (one of ${threads.join(", ")}).`,
  nameTaken: (name: string) => `${name} is taken in this swarm: pick another with --as.`,
  noSuchMember: (name: string, names: string[]) => `No member is named ${name}.${names.length ? ` Members: ${names.join(", ")}.` : ""}`,
  notYourself: "--to names another member, not you.",
  emptySay: "Write what to say.",
  tooLong: `Too long: at most ${SWARM_SAY_MAX} characters.`,
  emptyDoing: "Write one line of what you are doing.",
  joined: (name: string, thread: string, again: boolean) => `${again ? "Already in" : "Joined"} the swarm of thread ${thread} as ${name}.`,
  next: 'Next: `swarm propose "<plan>"` puts the plan, or your part of it, in the thread; `swarm doing "<one line>"` now and when it changes; `swarm status` shows every member; `swarm say "<text>" [--to <name>]` talks to them; `swarm leave` when you are done.',
  said: (to: string) => `Said to ${to} in the ghost thread.`,
  saidAlone: "Said in the ghost thread. No other agent has joined yet: they read it when they join.",
  doing: (line: string) => `Your status: ${line}`,
  left: (thread: string) => `You left the swarm of thread ${thread}.`,
  notIn: (thread: string) => `You were not in the swarm of thread ${thread}. Nothing changed.`,
  /** The refusal for an agent the person removed from the swarm's thread, on any swarm command there (approved as a CLI refusal line). */
  removed: "The person removed you from this swarm, so nothing was written. You are back in it only if the person adds you again.",
  ghostNone: "Ghost thread: no messages yet.",
  ghostLatest: (shown: number, all: number) => (shown === all ? `Ghost thread (${all}):` : `Ghost thread, the latest ${shown} of ${all}:`),
  /** The wake's first line for a ghost message (one line, at most 300 characters). */
  proposed: (thread: string, lines: number, first: boolean) =>
    first
      ? `Proposed: the plan is in thread ${thread} as your reply, ${lines} line${lines === 1 ? "" : "s"}. Work has started; the person changes it by replying there.`
      : `Added to the plan in thread ${thread}: ${lines} line${lines === 1 ? "" : "s"}. A line for a name already in it replaced that line.`,
  emptyPlan: 'Write the plan: one line per agent, "- <name>: <what it will do>", an indented line for a sub-agent.',
  planLine: (n: number) => `Line ${n}: write "- <name>: <what it will do>".`,
  planFull: (max: number) => `A plan holds at most ${max} lines.`,
  wake: (from: string, to: string = from) => `${from} wrote in the swarm's ghost thread. Answer only if it asks something or you have something they need: plannotator inbox swarm say "<text>" --to ${to}. Never reply only to acknowledge.`,
  wakePerson: "The person wrote to the swarm in the ghost thread. Answer with plannotator inbox swarm say; ask the person in the thread itself.",
};

const refuse = (code: string, message: string) => new InboxError(code, message);

/** The thread a thread, message or ghost thread id names (a ghost thread's is its parent's). */
export function swarmThreadOf(store: InboxStore, ref: string): string {
  const message = store.message(ref.trim());
  if (!message) throw refuse("thread_not_found", `No thread ${ref}.`);
  return store.ghostParentOf(message.thread_id) ?? message.thread_id;
}

/** The swarm a caller means: the thread it named, else the one swarm it is in. */
export function callerSwarmThread(store: InboxStore, caller: SwarmCaller, thread?: string | null): string {
  if (thread) return swarmThreadOf(store, thread);
  const mine = store.allSwarms().filter((swarm) => swarm.on && swarm.members.some((m) => m.session === caller.session) && !store.swarmRemoved(swarm.thread_id).has(caller.session));
  if (mine.length === 0) {
    const out = store.allSwarms().some((swarm) => swarm.on && swarm.members.some((m) => m.session === caller.session));
    throw out ? refuse("removed_from_swarm", SWARM_WORDS.removed) : refuse("not_in_swarm", SWARM_WORDS.notJoined);
  }
  if (mine.length > 1) throw refuse("several_swarms", SWARM_WORDS.several(mine.map((swarm) => swarm.thread_id)));
  return mine[0]!.thread_id;
}

/** A thread's swarm, on, or the refusal. */
function onSwarm(store: InboxStore, threadId: string): InboxSwarmRecord {
  const swarm = store.swarmOf(threadId);
  if (!swarm) throw refuse("not_a_swarm", SWARM_WORDS.notSwarm(threadId));
  if (!swarm.on) throw refuse("swarm_off", SWARM_WORDS.turnedOff(threadId));
  return swarm;
}

/** Start (or turn back on) the swarm of `threadId`, with its ghost thread. */
export function startSwarm(store: InboxStore, threadId: string): InboxSwarmRecord {
  const root = store.message(threadId);
  if (!root || root.thread_id !== threadId || store.ghostParentOf(threadId)) throw refuse("thread_not_found", `No thread ${threadId}.`);
  const was = store.swarmOf(threadId);
  if (was?.on && was.ghost_id && store.message(was.ghost_id)) return was;
  const ghost = store.ghostThreadFor(threadId);
  const at = new Date().toISOString();
  // Turned back on: the store stamps `on_seq`, so what was said before waits for nobody (no burst of old wakes).
  return store.writeSwarm({ id: threadId, thread_id: threadId, project_id: root.project_id, on: true, ghost_id: ghost.id, members: was?.members ?? [], person_seen_at: was?.person_seen_at ?? null, on_seq: was?.on_seq ?? null, started_at: was?.started_at ?? at, updated_at: at });
}

/** Turn a thread's swarm on or off (the person's Turn off). Off keeps its members and ghost thread. */
export function setSwarmOn(store: InboxStore, threadId: string, on: boolean): InboxSwarmRecord | null {
  if (on) return startSwarm(store, threadId);
  const swarm = store.swarmOf(threadId);
  return swarm && swarm.on ? store.writeSwarm({ ...swarm, on: false }) : swarm;
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The longest member name, `--as` or the host's own. */
export const SWARM_NAME_MAX = 60;

/** A member name: one clean line, at most `max` characters. */
const memberName = (text: string, max = SWARM_NAME_MAX) => [...sanitizeSwarmDoing(text)].slice(0, max).join("").trim();

/** `swarm join`: the caller is in, once (again: its name or parent updated). */
export function joinSwarm(store: InboxStore, threadId: string, caller: SwarmCaller, options: { as?: string | null; for?: string | null } = {}): { swarm: InboxSwarmRecord; member: InboxSwarmMember; again: boolean } {
  // The join line is handed from the root's own words (inbox-swarm-wake.ts), so a join can come before the Inbox has
  // written the record: a root that starts a swarm starts it here.
  const root = store.message(threadId);
  if (!store.swarmOf(threadId) && root && root.thread_id === threadId && inboxMessageStartsSwarm(root)) startSwarm(store, threadId);
  const swarm = onSwarm(store, threadId);
  // Removed by the person: out until the person adds it again (Add an agent, or any message of theirs to it).
  if (store.swarmRemoved(threadId).has(caller.session)) throw refuse("removed_from_swarm", SWARM_WORDS.removed);
  const others = swarm.members.filter((m) => m.session !== caller.session);
  const existing = swarm.members.find((m) => m.session === caller.session) ?? null;
  const asked = options.as ? memberName(options.as) : "";
  // The host's own name (a session's title can run long): one clean line of at most SWARM_NAME_MAX, its number too.
  const given = memberName(inboxAgentName({ kind: "agent", host: caller.host, name: caller.name })) || inboxAgentName({ kind: "agent", host: caller.host, name: null });
  let name = asked || existing?.name || given;
  if (asked && others.some((m) => sameName(m.name, asked))) throw refuse("name_taken", SWARM_WORDS.nameTaken(asked));
  if (!asked && !existing) for (let n = 2; others.some((m) => sameName(m.name, name)); n++) name = `${memberName(given, SWARM_NAME_MAX - String(n).length - 1)} ${n}`;
  let parent: string | null = existing?.for ?? null;
  if (options.for) {
    const of = others.find((m) => sameName(m.name, options.for!));
    if (!of) throw refuse("member_not_found", SWARM_WORDS.noSuchMember(options.for, others.map((m) => m.name)));
    parent = of.name;
  }
  const member: InboxSwarmMember = {
    session: caller.session,
    host: caller.host,
    name,
    ...(caller.machine ? { machine: caller.machine, machine_name: caller.machine_name ?? null } : {}),
    ...(parent ? { for: parent } : {}),
    joined_at: existing?.joined_at ?? new Date().toISOString(),
    doing: existing?.doing ?? null,
  };
  const changed = !existing || JSON.stringify(existing) !== JSON.stringify(member);
  const next = changed ? store.writeSwarm({ ...swarm, members: [...others, member].sort((a, b) => a.joined_at.localeCompare(b.joined_at)) }) : swarm;
  return { swarm: next, member, again: !!existing };
}

/** `swarm leave`. */
export function leaveSwarm(store: InboxStore, threadId: string, session: string): boolean {
  const swarm = store.swarmOf(threadId);
  if (!swarm || !swarm.members.some((m) => m.session === session)) return false;
  store.writeSwarm({ ...swarm, members: swarm.members.filter((m) => m.session !== session) });
  return true;
}

/** The caller as a member, or the refusal (one the person removed is refused as removed). */
function memberOf(store: InboxStore, swarm: InboxSwarmRecord, session: string): InboxSwarmMember {
  const member = swarm.members.find((m) => m.session === session);
  if (store.swarmRemoved(swarm.thread_id).has(session)) throw refuse("removed_from_swarm", SWARM_WORDS.removed);
  if (!member) throw refuse("not_in_swarm", SWARM_WORDS.notJoined);
  return member;
}

/** The members the person has not removed from the thread. */
function inSwarm(store: InboxStore, swarm: InboxSwarmRecord): InboxSwarmMember[] {
  const removed = store.swarmRemoved(swarm.thread_id);
  return removed.size === 0 ? swarm.members : swarm.members.filter((m) => !removed.has(m.session));
}

/** `swarm doing`: the caller's one line, cleaned. */
export function setSwarmDoing(store: InboxStore, threadId: string, session: string, text: string): string {
  const swarm = onSwarm(store, threadId);
  memberOf(store, swarm, session);
  const line = sanitizeSwarmDoing(text);
  if (!line) throw refuse("validation_error", SWARM_WORDS.emptyDoing);
  const at = new Date().toISOString();
  store.writeSwarm({ ...swarm, members: swarm.members.map((m) => (m.session === session ? { ...m, doing: { text: line, at } } : m)) });
  return line;
}

/** A proposal's lines: the lines that are not list items are its one-line summary; each item is one agent's part. */
export function parseSwarmPlan(text: string, proposer: string): { summary: string | null; parts: { who: string; does: string; for: string | null }[] } {
  const parts: { who: string; does: string; for: string | null }[] = [];
  const summary: string[] = [];
  let parent: string | null = null;
  text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((raw, i) => {
      if (raw.trim() === "") return;
      const item = /^(\s*)(?:[-*•]|\d+[.)])\s+(.*)$/.exec(raw);
      if (!item) return void summary.push(raw.trim());
      const colon = item[2]!.indexOf(":");
      // Markdown emphasis around the name ("**Codex**: …", "**Codex:** …") is not part of it.
      const who = colon > 0 ? memberName(item[2]!.slice(0, colon).replace(/[*_`]/g, "")) : "";
      const does = colon > 0 ? sanitizeSwarmDoing(item[2]!.slice(colon + 1).replace(/^[\s*_]+/, "")) : "";
      if (!who || !does) throw refuse("validation_error", SWARM_WORDS.planLine(i + 1));
      // Indented: a sub-agent of the line above it, else of the agent proposing.
      if (item[1]!.length > 0) return void parts.push({ who, does, for: parent ?? proposer });
      parts.push({ who, does, for: null });
      parent = who;
    });
  return { summary: sanitizeSwarmDoing(summary.join(" ")) || null, parts };
}

/** The plan as plain words: the card message's body, for any reader that does not draw the card. */
export function swarmPlanText(plan: Pick<InboxSwarmPlan, "summary" | "parts">): string {
  const top = plan.parts.filter((p) => !p.for || !plan.parts.some((o) => sameName(o.who, p.for!)));
  const lines: string[] = [];
  for (const part of top) {
    lines.push(`- ${part.who}: ${part.does}`);
    for (const sub of plan.parts.filter((p) => p !== part && p.for && sameName(p.for, part.who))) lines.push(`  - ${sub.who}: ${sub.does}`);
  }
  return [plan.summary ? `Swarm plan: ${plan.summary}` : "Swarm plan", lines.join("\n")].filter(Boolean).join("\n\n");
}

/**
 * `swarm propose`: the caller's plan lines go into the swarm's one plan. The first proposal writes the plan card in the
 * thread, as the caller's reply to the person's latest message (`swarm_plan`); later ones (another agent adding its
 * part, or one changing its line) change the plan the card draws, never a second card. A line for a name already in
 * the plan replaces that line; a summary given replaces the summary.
 */
export function proposeSwarm(store: InboxStore, threadId: string, caller: SwarmCaller, text: string, wakes = false): { plan: InboxSwarmPlan; lines: number; first: boolean } {
  const swarm = onSwarm(store, threadId);
  const me = memberOf(store, swarm, caller.session);
  const asked = parseSwarmPlan(text, me.name);
  if (asked.parts.length === 0 && !asked.summary) throw refuse("validation_error", SWARM_WORDS.emptyPlan);
  const at = new Date().toISOString();
  const was = swarm.plan && store.message(swarm.plan.message_id) ? swarm.plan : null;
  const parts: InboxSwarmPlanPart[] = [...(was?.parts ?? [])];
  for (const part of asked.parts) {
    const line: InboxSwarmPlanPart = { who: part.who, does: part.does, ...(part.for ? { for: part.for } : {}), by: me.name, at };
    const i = parts.findIndex((p) => sameName(p.who, part.who));
    if (i >= 0) parts[i] = line;
    else parts.push(line);
  }
  if (parts.length > INBOX_SWARM_PLAN_MAX) throw refuse("validation_error", SWARM_WORDS.planFull(INBOX_SWARM_PLAN_MAX));
  const summary = asked.summary ?? was?.summary ?? null;
  let messageId = was?.message_id ?? null;
  if (!messageId) {
    const root = store.message(threadId)!;
    const ids = store.threadMessageIds(threadId);
    // The reply to the person's latest words: the message the agents were handed.
    const answers = [...ids].reverse().find((id) => store.message(id)?.author.kind === "person") ?? threadId;
    const author: Extract<InboxMessage["author"], { kind: "agent" }> = { kind: "agent", host: caller.host, session: caller.session, name: me.name, ...(caller.machine ? { machine: caller.machine, ...(caller.machine_name ? { machine_name: caller.machine_name } : {}) } : {}) };
    messageId = store.sendMessage({ author, body: swarmPlanText({ summary, parts }), swarm_plan: true, project_id: root.project_id, reply_to: answers, ...(wakes ? { wakes: true } : {}) }).message.id;
  }
  const plan: InboxSwarmPlan = { ...(summary ? { summary } : {}), parts, message_id: messageId, at: was?.at ?? at };
  store.writeSwarm({ ...(store.swarmOf(threadId) ?? swarm), plan });
  return { plan, lines: asked.parts.length, first: !was };
}

const tagOfMember = (m: InboxSwarmMember): InboxTag => ({ host: m.host, session: m.session, name: m.name, wakes: true, ...(m.machine ? { machine: m.machine } : {}) });

/**
 * `swarm say` (an agent, `from` its session) or the ghost pane's box (the person, `from` null): words in the ghost
 * thread for every other member, or the one `to` names. Delivered only to members (store.ts `pendingFor`).
 */
export function saySwarm(store: InboxStore, threadId: string, from: SwarmCaller | null, text: string, to?: string | null, key: string | null = null): { message: InboxMessage; to: string | null; alone: boolean } {
  const swarm = onSwarm(store, threadId);
  const words = text.trim();
  if (!words) throw refuse("validation_error", SWARM_WORDS.emptySay);
  if (words.length > SWARM_SAY_MAX) throw refuse("validation_error", SWARM_WORDS.tooLong);
  const me = from ? memberOf(store, swarm, from.session) : null;
  // "To everyone" is the members the person has not removed.
  const others = inSwarm(store, swarm).filter((m) => m.session !== from?.session);
  let targets = others;
  if (to) {
    if (me && sameName(me.name, to)) throw refuse("validation_error", SWARM_WORDS.notYourself);
    const one = others.find((m) => sameName(m.name, to) || m.session === to);
    if (!one) throw refuse("member_not_found", SWARM_WORDS.noSuchMember(to, others.map((m) => m.name)));
    targets = [one];
  }
  const ghost = swarm.ghost_id && store.message(swarm.ghost_id) ? swarm.ghost_id : startSwarm(store, threadId).ghost_id!;
  const author: InboxMessage["author"] = from
    ? { kind: "agent", host: from.host, session: from.session, name: me!.name, ...(from.machine ? { machine: from.machine, ...(from.machine_name ? { machine_name: from.machine_name } : {}) } : {}) }
    : { kind: "person" };
  // `key`: a held say from a linked computer (inbox-swarm-far.ts), written once however often it is sent.
  const message = store.writeGhostMessage(ghost, author, words, targets.map(tagOfMember), from ? key : null);
  return { message, to: to ? targets[0]!.name : null, alone: targets.length === 0 };
}

/** The person looked at the ghost thread: its count goes to zero. */
export function markGhostSeen(store: InboxStore, threadId: string): void {
  const swarm = store.swarmOf(threadId);
  if (swarm) store.writeSwarm({ ...swarm, person_seen_at: new Date().toISOString() });
}

/** The sessions the thread is addressed to (New message's `to` and every tag the person gave), each once. */
function addressed(store: InboxStore, threadId: string): { session: string; host: string | null; name: string; machine: string | null }[] {
  const out = new Map<string, { session: string; host: string | null; name: string; machine: string | null }>();
  for (const id of store.threadMessageIds(threadId)) {
    const message = store.message(id);
    if (!message || message.author.kind !== "person") continue;
    // `machine`: an agent on a linked computer (its tag, or a hand-off's `to`); absent for this computer's.
    const add = (session: string, host: string | null, name: string | null | undefined, machine: string | undefined) => {
      if (!out.has(session)) out.set(session, { session, host, name: name || inboxAgentName({ kind: "agent", host, name: null }), machine: machine ?? null });
    };
    if (message.to) add(message.to.session, message.to.host, null, message.to.machine);
    for (const tag of message.tags ?? []) add(tag.session, tag.host, tag.label ?? tag.name, tag.machine);
  }
  return [...out.values()];
}

/**
 * `InboxThread.swarm`: the members (joined first, then the agents the thread names that have not joined), the count and
 * the plan. `nameOf`: a linked computer's name, so an agent there that has not joined says its own computer. A member on
 * a linked computer whose name is not known carries `machine_name: null` (absent: the thread's own computer), so the
 * window never names this computer for it.
 */
export function swarmWire(store: InboxStore, threadId: string, live: SwarmLiveState, nameOf?: (machine: string) => string | null): InboxThreadSwarm | undefined {
  const swarm = store.swarmOf(threadId);
  if (!swarm) return undefined;
  // One the person removed is in neither list until the person adds it again (its ghost words stay).
  const removed = store.swarmRemoved(threadId);
  const joined: InboxSwarmMemberWire[] = inSwarm(store, swarm).map((m) => ({
    session: m.session,
    host: m.host,
    name: m.name,
    ...(m.machine_name || m.machine ? { machine_name: m.machine_name || (nameOf?.(m.machine!) ?? null) } : {}),
    ...(m.for ? { for: m.for } : {}),
    joined: true,
    state: live(m, threadId),
    doing: m.doing ?? null,
  }));
  const waiting = addressed(store, threadId).filter((a) => !swarm.members.some((m) => m.session === a.session) && !removed.has(a.session));
  const seen = swarm.person_seen_at ?? "";
  const unread = swarm.ghost_id ? store.ghostMessages(swarm.ghost_id).filter((m) => m.author.kind === "agent" && m.created_at > seen).length : 0;
  return {
    on: swarm.on,
    ghost_id: swarm.ghost_id,
    members: [
      ...joined,
      ...waiting.map((a) => {
        return { session: a.session, host: a.host, name: a.name, ...(a.machine ? { machine_name: nameOf?.(a.machine) ?? null } : {}), joined: false, state: live(a, threadId), doing: null };
      }),
    ],
    ghost_unread: unread,
    ...(swarm.plan && store.message(swarm.plan.message_id) ? { plan: swarm.plan } : {}),
  };
}

/** A member's line in `swarm status` and `swarm join`: name, where, state, doing and when. */
function memberLine(m: InboxSwarmMemberWire, now: number): string {
  const where = m.machine_name ? `on ${m.machine_name}` : "on the thread's computer";
  const state = !m.joined ? "not joined yet" : (m.state ?? "state not known");
  const doing = m.doing ? `: ${m.doing.text} (${ago(m.doing.at, now)})` : "";
  return `- ${m.name}${m.for ? ` (for ${m.for})` : ""}, ${where}, ${state}${doing}`;
}

function ago(at: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(at)) / 1000));
  if (!Number.isFinite(s)) return at;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/** `swarm status`'s text. */
export function swarmStatusText(threadId: string, wire: InboxThreadSwarm, now = Date.now()): string {
  return [`Swarm of thread ${threadId}${wire.on ? "" : " (turned off)"}: ${wire.members.length} member${wire.members.length === 1 ? "" : "s"}.`, ...wire.members.map((m) => memberLine(m, now))].join("\n");
}

/** `swarm join`'s text: who is in, the ghost thread's latest words, and what to run next. */
export function swarmJoinText(store: InboxStore, threadId: string, wire: InboxThreadSwarm, name: string, again: boolean, now = Date.now()): string {
  const ghost = wire.ghost_id ? store.ghostMessages(wire.ghost_id) : [];
  const latest = ghost.slice(-JOIN_GHOST_LINES).map((m) => {
    const from = m.author.kind === "agent" ? (m.author.name ?? inboxAgentName(m.author)) : "The person";
    const to = (m.tags ?? []).length === 1 ? (m.tags![0]!.name ?? "one member") : "everyone";
    const body = m.body.length > JOIN_GHOST_CHARS ? `${m.body.slice(0, JOIN_GHOST_CHARS)}…` : m.body;
    return `- ${from} to ${to}, ${ago(m.created_at, now)}: ${body.replace(/\s*\n\s*/g, " ")}`;
  });
  return [
    SWARM_WORDS.joined(name, threadId, again),
    swarmStatusText(threadId, wire, now),
    ghost.length === 0 ? SWARM_WORDS.ghostNone : [SWARM_WORDS.ghostLatest(latest.length, ghost.length), ...latest].join("\n"),
    SWARM_WORDS.next,
  ].join("\n\n");
}
