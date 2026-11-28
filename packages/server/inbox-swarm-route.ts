/**
 * Swarm on the Inbox's side (docs/agent-guides/inbox-swarm.md), behind the experimental switch `swarm`:
 *
 * - `POST /api/inbox/swarm`: `plannotator inbox swarm` (apps/hook/server/inbox-swarm-command.ts), a thin client over
 *   it, as `inbox capability` is over `/api/inbox/capability`. This computer's agents only: a device door's request
 *   (a phone, a linked computer's window) is not found here, and another site's page is refused. A paired cloud agent
 *   reaches it through the agent door's `route` (inbox-agent-routes.ts). A thread on a linked computer is asked
 *   there, through that computer's door (`POST swarm`, a machine's token only), as that computer's own agents are.
 * - `GET|POST /api/inbox/threads/:id/swarm`: the window's (and the phone's, through the door's allowlist): the swarm,
 *   the ghost thread's words, the person's words to the agents, Turn off, and "looked at" for the Ghost button.
 * - `POST /api/inbox/threads/:id/swarm/add`: Add an agent (the status view's): one more agent, here or on a linked
 *   computer, is handed the `/swarm` skill in the swarm's thread (`addSwarmAgent`), as the first agents were.
 *
 * Nothing here is an action of the agent tool (the owner, 2026-11-24: "don't bloat or change the tool").
 */

import type { InboxMessage, InboxTag } from "@plannotator/core/inbox-types";
import type { InboxThreadSwarm } from "@plannotator/core/inbox-swarm-types";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import {
  SWARM_WORDS,
  callerSwarmThread,
  joinSwarm,
  leaveSwarm,
  markGhostSeen,
  proposeSwarm,
  saySwarm,
  setSwarmDoing,
  setSwarmOn,
  swarmJoinText,
  swarmStatusText,
  swarmThreadOf,
  swarmWire,
  type SwarmCaller,
  type SwarmLiveState,
} from "@plannotator/shared/inbox/swarm";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { FAR_REPLY_WORDS } from "./inbox-mcp-far-reply";
import { inboxSkillsBlockFor } from "./inbox-skills";
import type { SwarmFarJoins, SwarmFarPlace, SwarmHeldSay } from "./inbox-swarm-far";

export const INBOX_SWARM_ROUTE = "/api/inbox/swarm";
/** The door route a linked computer's agent's swarm command arrives by (inbox-devices.ts `DOOR_OWN_ROUTES`). */
export const FAR_SWARM_ROUTE = "swarm";

export const SWARM_ACTIONS = ["join", "propose", "say", "doing", "status", "leave"] as const;
export type SwarmAction = (typeof SWARM_ACTIONS)[number];

/** What the command sends. `by`: the agent, as its shell names it (the agent door says it for a paired agent). */
export interface SwarmAsk {
  action: SwarmAction;
  thread?: string;
  as?: string;
  for?: string;
  text?: string;
  to?: string;
  by?: { host?: string; session?: string; name?: string };
}

export interface SwarmRouteContext {
  store: InboxStore;
  /** The experimental switch. */
  on: () => boolean;
  live: SwarmLiveState;
  /** A linked computer holding a thread this Inbox does not have, and the way to ask it; absent without links. */
  far?: {
    placeOf: (ref: string) => Promise<{ machine: string; thread_id: string } | null>;
    nameOf: (machine: string) => string | null;
    ask: (machine: string, body: Record<string, unknown>) => Promise<{ status: number; json: Record<string, unknown> | null }>;
    /** Which swarm each session here joined there, kept across restarts (inbox-swarm-far.ts). Absent: in memory. */
    joins?: SwarmFarJoins;
    /** A `say` held while that computer is away, sent once when it is back (inbox-swarm-far.ts). Absent: asked now. */
    holdSay?: (machine: string, thread: string, body: Record<string, unknown>) => Promise<SwarmHeldSay | null>;
  };
  /** Whether `session` is one of this computer's own (a linked computer may not speak for it). */
  ownSession?: (session: string) => boolean;
  /** Whether this computer's connection of `session` wakes it with the person's reply (the plan card's `wakes`). */
  wakes?: (session: string) => boolean;
  /**
   * Add an agent: the agent picked, resolved as a reply's tag is (inbox.ts: the far tags' `targets` over `tagTargets`,
   * so one on a linked computer is a far tag and its wake goes there through the outbox), refusals unchanged. Absent:
   * nobody can be added.
   */
  tagOf?: (value: unknown) => Promise<InboxTag[]>;
  /** The Inbox's server session: a window write from a page of an earlier run is refused (409), as every window write is. */
  serverSession?: string;
}

const ASK_FIELDS = ["action", "thread", "as", "for", "text", "to", "by"];
const STATUS: Record<string, number> = { validation_error: 422, thread_not_found: 404, not_a_swarm: 409, swarm_off: 409, not_in_swarm: 409, several_swarms: 409, name_taken: 409, member_not_found: 404, not_your_session: 403, removed_from_swarm: 409, session_not_live: 409, tag_needs_update: 409 };

/** The command's ask, checked: an unknown field or action is refused. */
export function swarmAskOf(body: Record<string, unknown>): SwarmAsk {
  const extra = Object.keys(body).find((field) => !ASK_FIELDS.includes(field));
  if (extra) throw new InboxError("validation_error", `${extra}: not taken here.`);
  if (!(SWARM_ACTIONS as readonly unknown[]).includes(body.action)) throw new InboxError("validation_error", `action: one of ${SWARM_ACTIONS.join(", ")}.`);
  const out: SwarmAsk = { action: body.action as SwarmAction };
  for (const field of ["thread", "as", "for", "text", "to"] as const) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new InboxError("validation_error", `${field}: a string.`);
    out[field] = value;
  }
  const by = body.by && typeof body.by === "object" && !Array.isArray(body.by) ? (body.by as Record<string, unknown>) : null;
  if (by) out.by = { host: typeof by.host === "string" ? by.host : undefined, session: typeof by.session === "string" ? by.session : undefined, name: typeof by.name === "string" ? by.name : undefined };
  return out;
}

const callerOf = (ask: SwarmAsk): SwarmCaller => {
  const session = ask.by?.session?.trim();
  if (!session) throw new InboxError("validation_error", "by.session: the agent's session (run it from an agent session, or pass --session).");
  return { session, host: ask.by?.host?.trim() || null, name: ask.by?.name?.trim() || null };
};

/** The answer for an agent: `text` and the swarm. `caller.machine` set: the ask came from that linked computer. */
export function swarmAgentAnswer(ctx: SwarmRouteContext, ask: SwarmAsk, caller: SwarmCaller, key: string | null = null): { text: string; swarm?: InboxThreadSwarm; thread_id?: string } {
  const { store } = ctx;
  const wire = (threadId: string) => swarmWire(store, threadId, ctx.live, ctx.far?.nameOf)!;
  switch (ask.action) {
    case "propose": {
      const threadId = callerSwarmThread(store, caller, ask.thread);
      const proposed = proposeSwarm(store, threadId, caller, ask.text ?? "", !caller.machine && (ctx.wakes?.(caller.session) ?? false));
      return { text: SWARM_WORDS.proposed(threadId, proposed.lines, proposed.first), swarm: wire(threadId), thread_id: threadId };
    }
    case "join": {
      if (!ask.thread) throw new InboxError("validation_error", "thread: the thread's id (plannotator inbox swarm join <thread>).");
      const threadId = swarmThreadOf(store, ask.thread);
      const joined = joinSwarm(store, threadId, caller, { as: ask.as, for: ask.for });
      const swarm = wire(threadId);
      return { text: swarmJoinText(store, threadId, swarm, joined.member.name, joined.again), swarm, thread_id: threadId };
    }
    case "say": {
      const threadId = callerSwarmThread(store, caller, ask.thread);
      const said = saySwarm(store, threadId, caller, ask.text ?? "", ask.to, key);
      return { text: said.alone ? SWARM_WORDS.saidAlone : SWARM_WORDS.said(said.to ?? "everyone"), thread_id: threadId };
    }
    case "doing": {
      const threadId = callerSwarmThread(store, caller, ask.thread);
      return { text: SWARM_WORDS.doing(setSwarmDoing(store, threadId, caller.session, ask.text ?? "")), thread_id: threadId };
    }
    case "status": {
      const threadId = callerSwarmThread(store, caller, ask.thread);
      if (!store.swarmOf(threadId)) throw new InboxError("not_a_swarm", SWARM_WORDS.notSwarm(threadId));
      const swarm = wire(threadId);
      return { text: swarmStatusText(threadId, swarm), swarm, thread_id: threadId };
    }
    case "leave": {
      const threadId = callerSwarmThread(store, caller, ask.thread);
      return { text: leaveSwarm(store, threadId, caller.session) ? SWARM_WORDS.left(threadId) : SWARM_WORDS.notIn(threadId), thread_id: threadId };
    }
  }
}

const refusal = (error: unknown): Response => {
  if (error instanceof InboxError) return Response.json({ code: error.code, error: error.message }, { status: STATUS[error.code] ?? 422 });
  return Response.json({ code: "internal_error", error: error instanceof Error ? error.message : String(error) }, { status: 500 });
};

/** The swarms a session here joined on a linked computer, when the context keeps none (a test's): in memory. */
const farJoinedHere = new Map<string, SwarmFarPlace>();
const farJoinsOf = (ctx: SwarmRouteContext): SwarmFarJoins =>
  ctx.far?.joins ?? { get: (s) => farJoinedHere.get(s) ?? null, set: (s, p) => void farJoinedHere.set(s, p), drop: (s) => void farJoinedHere.delete(s) };

/** Where an ask goes: this Inbox, or the linked computer holding its thread. */
async function farPlace(ctx: SwarmRouteContext, ask: SwarmAsk, session: string): Promise<{ machine: string; thread: string } | null> {
  if (!ctx.far) return null;
  if (ask.thread) {
    if (ctx.store.message(ask.thread.trim())) return null;
    const place = await ctx.far.placeOf(ask.thread.trim());
    return place ? { machine: place.machine, thread: place.thread_id } : null;
  }
  const here = ctx.store.allSwarms().some((swarm) => swarm.on && swarm.members.some((m) => m.session === session));
  return here ? null : farJoinsOf(ctx).get(session);
}

/** `POST /api/inbox/swarm`, or null for any other path. */
export async function swarmRoute(req: Request, url: URL, ctx: SwarmRouteContext, readBody: (req: Request) => Promise<Record<string, unknown>>, fromDeviceDoor = false): Promise<Response | null> {
  if (url.pathname !== INBOX_SWARM_ROUTE) return null;
  if (fromDeviceDoor) return Response.json({ error: "Not found", code: "not_found" }, { status: 404 });
  if (!isSameOriginOrNoOrigin(req.headers.get("origin"), req.headers.get("host") ?? "", req.headers.get("sec-fetch-site"))) {
    return Response.json({ error: "Cross-origin requests are not accepted.", code: "cross_origin" }, { status: 403 });
  }
  if (req.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  if (!ctx.on()) return Response.json({ code: "swarm_off", error: SWARM_WORDS.off }, { status: 409 });
  try {
    const ask = swarmAskOf(await readBody(req));
    const caller = callerOf(ask);
    const far = await farPlace(ctx, ask, caller.session);
    if (far && ctx.far) {
      const body = { ask: { ...ask, thread: ask.thread ?? far.thread, by: undefined }, session: caller.session, host: caller.host, name: caller.name };
      // `say` waits for an away computer, as a far reply does, and goes once when it is back.
      const held = ask.action === "say" && ctx.far.holdSay ? await ctx.far.holdSay(far.machine, far.thread, body) : null;
      if (held?.kind === "waiting") return Response.json({ text: FAR_REPLY_WORDS.held(far.thread, ctx.far.nameOf(far.machine) ?? "the other computer"), held: true, thread_id: far.thread });
      const answer = held ?? (await ctx.far.ask(far.machine, body));
      // The swarm's own thread, as that computer answered it (a ghost thread's or a message's id names its thread).
      const thread = typeof answer.json?.thread_id === "string" && /^msg_[A-Za-z0-9_-]{1,80}$/.test(answer.json.thread_id) ? answer.json.thread_id : far.thread;
      if (answer.status === 200 && ask.action === "join") farJoinsOf(ctx).set(caller.session, { machine: far.machine, thread });
      if (answer.status === 200 && ask.action === "leave") farJoinsOf(ctx).drop(caller.session);
      return Response.json(answer.json ?? { code: "machine_refused", error: `${ctx.far.nameOf(far.machine) ?? "The other computer"} did not answer.` }, { status: answer.status });
    }
    return Response.json(swarmAgentAnswer(ctx, ask, caller));
  } catch (error) {
    return refusal(error);
  }
}

/** `POST swarm` at the door, from linked computer `machine`: its session's command, run here as that session. */
export function farSwarmAnswer(ctx: SwarmRouteContext, machine: string, body: Record<string, unknown>): Record<string, unknown> {
  if (!ctx.on()) throw new InboxError("swarm_off", SWARM_WORDS.off);
  const raw = body.ask && typeof body.ask === "object" && !Array.isArray(body.ask) ? (body.ask as Record<string, unknown>) : null;
  if (!raw) throw new InboxError("validation_error", "ask: the swarm command.");
  const session = typeof body.session === "string" ? body.session.trim() : "";
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(session)) throw new InboxError("validation_error", "session: a session id.");
  // As the far tags' `asSession` (inbox-far-tags.ts): the session must be the calling computer's. Not one of this
  // computer's own (live, a member without a machine, written here, or one a thread here is addressed to with no
  // machine), nor one a member or message puts elsewhere.
  const elsewhere = ctx.store.sessionMachine(session, { rootsHere: true });
  const otherMember = ctx.store.allSwarms().some((swarm) => swarm.members.some((m) => m.session === session && m.machine !== machine));
  if (ctx.ownSession?.(session) || otherMember || (elsewhere !== null && elsewhere !== machine)) {
    throw new InboxError("not_your_session", "That session is not one of your computer's: nothing was written.");
  }
  const { by: _by, ...rest } = raw;
  const short = (value: unknown, max: number) => (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);
  const caller: SwarmCaller = { session, host: short(body.host, 64), name: short(body.name, 80), machine, machine_name: ctx.far?.nameOf(machine) ?? null };
  // A held say's key (inbox-swarm-far.ts): sent again after a lost answer, it is written once.
  const key = typeof body.idempotency_key === "string" && /^swarm-say:[0-9a-f-]{36}$/.test(body.idempotency_key) ? body.idempotency_key : null;
  return swarmAgentAnswer(ctx, swarmAskOf(rest), caller, key) as unknown as Record<string, unknown>;
}

/** What Add an agent hands the agent: `/swarm` and the approved skill text, as a Send pastes it (never a skill of the person's own). */
export function swarmAddBody(): string {
  const block = inboxSkillsBlockFor(["swarm"], { codeReview: false, routines: false, diagrams: false, swarm: true }, { discovered: () => [], read: () => null });
  return ["/swarm", block].filter((part) => part !== "").join("\n\n");
}

/**
 * Add an agent (`POST threads/:id/swarm/add`, `{ session, host?, machine?, label?, idempotency_key }`): the agent picked
 * is handed the `/swarm` skill in the swarm's thread, the person's message to it alone (`store.writeSwarmAdd`), so it
 * reads the thread and joins as the first agents did (its wake carries the join line, inbox-swarm-wake.ts). It is a
 * member that has not joined until it runs join. A live agent is added to the thread ("Add instead"); one that reads
 * the Inbox only is tagged. One the person removed is back. A joined member still in writes nothing. Written once per
 * key: the outbox sends it again to a linked computer that was away.
 */
export async function addSwarmAgent(ctx: SwarmRouteContext, threadId: string, body: Record<string, unknown>): Promise<void> {
  const { store } = ctx;
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  if (!key || key.length > 200) throw new InboxError("validation_error", "idempotency_key: required.");
  const session = typeof body.session === "string" ? body.session.trim() : "";
  if (!session) throw new InboxError("validation_error", "session: the agent to add.");
  for (const field of ["host", "machine", "label"] as const) {
    if (body[field] !== undefined && body[field] !== null && typeof body[field] !== "string") throw new InboxError("validation_error", `${field}: a string.`);
  }
  const swarm = store.swarmOf(threadId);
  if (!swarm) throw new InboxError("not_a_swarm", SWARM_WORDS.notSwarm(threadId));
  if (store.replyByKey(threadId, key)) return;
  if (!swarm.on) throw new InboxError("swarm_off", SWARM_WORDS.turnedOff(threadId));
  if (!ctx.tagOf) throw new InboxError("session_not_live", "Agents cannot be added here.");
  const item = { session, ...(body.host ? { host: body.host } : {}), ...(body.machine ? { machine: body.machine } : {}), ...(body.label ? { label: body.label } : {}) };
  const tag = (await ctx.tagOf([item]))[0];
  if (!tag) throw new InboxError("session_not_live", "That agent is not live any more: nothing was sent.");
  if (swarm.members.some((m) => m.session === tag.session) && !store.swarmRemoved(threadId).has(tag.session)) return;
  store.writeSwarmAdd(threadId, { ...tag, ...(tag.wakes && tag.host ? { joined: true } : {}) }, swarmAddBody(), key);
}

/** The window's read of a ghost thread: its words, oldest first. */
export interface SwarmGhostRead {
  swarm: InboxThreadSwarm | null;
  ghost: InboxMessage[];
}

/**
 * `GET|POST /api/inbox/threads/:id/swarm` (the window, the phone): GET reads the swarm and the ghost thread; POST
 * takes `{ say: { text, to? } }` (the person's words to the agents), `{ on: boolean }` (Turn off) or `{ seen: true }`.
 * Null for any other path, and while the switch is off.
 */
export async function swarmWindowRoute(req: Request, url: URL, ctx: SwarmRouteContext, readBody: (req: Request) => Promise<Record<string, unknown>>): Promise<Response | null> {
  const match = /^\/api\/inbox\/threads\/([A-Za-z0-9_-]{1,80})\/swarm(\/add)?$/.exec(url.pathname);
  if (!match) return null;
  if (!ctx.on()) return Response.json({ error: "Not found", code: "not_found" }, { status: 404 });
  const { store } = ctx;
  try {
    const threadId = swarmThreadOf(store, match[1]!);
    const read = (): SwarmGhostRead => {
      const swarm = swarmWire(store, threadId, ctx.live, ctx.far?.nameOf) ?? null;
      return { swarm, ghost: swarm?.ghost_id ? store.ghostMessages(swarm.ghost_id) : [] };
    };
    if (match[2]) {
      if (req.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
      const raw = await readBody(req);
      if (ctx.serverSession !== undefined && checkServerSession(raw, ctx.serverSession) === "mismatch") {
        return Response.json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), { status: 409 });
      }
      await addSwarmAgent(ctx, threadId, raw);
      return Response.json(read());
    }
    if (req.method === "GET") return Response.json(read());
    if (req.method !== "POST") return Response.json({ error: "Use GET or POST." }, { status: 405 });
    // The door's writes carry an idempotency key in the body; these are answered now, never held, so it is not kept. The
    // window's every write carries its page's `serverSession` (api.ts `post`): checked as every window write is (a tab
    // from before a restart is told to reload), then not one of this route's fields.
    const raw = await readBody(req);
    if (ctx.serverSession !== undefined && checkServerSession(raw, ctx.serverSession) === "mismatch") {
      return Response.json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), { status: 409 });
    }
    const { idempotency_key: _key, serverSession: _session, ...body } = raw;
    const keys = Object.keys(body);
    if (keys.length !== 1 || !["say", "on", "seen"].includes(keys[0]!)) throw new InboxError("validation_error", "One of say, on or seen.");
    if (body.say !== undefined) {
      const say = body.say && typeof body.say === "object" ? (body.say as Record<string, unknown>) : {};
      if (typeof say.text !== "string" || (say.to !== undefined && say.to !== null && typeof say.to !== "string")) throw new InboxError("validation_error", "say: { text, to? }.");
      saySwarm(store, threadId, null, say.text, (say.to as string | null | undefined) ?? null);
      markGhostSeen(store, threadId);
    } else if (body.on !== undefined) {
      if (typeof body.on !== "boolean") throw new InboxError("validation_error", "on: true or false.");
      // Turn on is for a swarm turned off: a swarm starts from the person's message that names /swarm (swarm-start.ts).
      if (!store.swarmOf(threadId)) throw new InboxError("not_a_swarm", SWARM_WORDS.notSwarm(threadId));
      setSwarmOn(store, threadId, body.on);
    } else if (body.seen === true) markGhostSeen(store, threadId);
    else throw new InboxError("validation_error", "seen: true.");
    return Response.json(read());
  } catch (error) {
    return refusal(error);
  }
}
