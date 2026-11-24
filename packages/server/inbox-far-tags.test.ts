/**
 * Tag an agent on another linked computer (inbox-far-tags.ts, inbox-far-wakes.ts, inbox-mcp-far-reply.ts). Two
 * real stores in temp folders stand for the two computers: Studio holds the thread, Laptop runs the tagged agent.
 * The link between them is played by hand: each held write is handed to the other side's door handler, as the
 * outbox would carry it. What regresses: a far agent not offered, a far tag refused as "not live", the tag not
 * recorded on the thread's computer, no wake on the agent's computer, a wake with fields its computer does not word,
 * a second wake for the same reply, an answer written as a session of another computer, a later reply to the far
 * agent that never reaches it, an older or asleep computer breaking the list.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor, InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxFarTags, FAR_AGENT_REPLY_ROUTE, FAR_TAGGABLE_ROUTE, FAR_WAKE_ROUTE, TAG_ACROSS_MARK, type FarReplyInput } from "./inbox-far-tags";
import { createInboxFarWakes, farWakeCommand } from "./inbox-far-wakes";
import { farAgentReply } from "./inbox-mcp-far-reply";
import type { OutboxEntry } from "./inbox-outbox";
import type { PeerLink } from "./inbox-peer-link";

const id = (kind: string, last: string) => `${kind}_01JZ${"0".repeat(20)}${last}`;
const STUDIO = id("ibx", "S1");
const LAPTOP = id("ibx", "A1");
const OTHER = id("ibx", "B1");
const MSG = (n: number) => id("msg", String(n).padStart(2, "0"));
const OWNER: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_owner", name: null };
const FAR = "ses_far_agent";

const temp = (name: string) => mkdtempSync(join(tmpdir(), `plannotator-far-tags-${name}-`));

/** A linked computer's line as far as the far tags read it. */
function peer(id: string, answer: () => Response | Promise<Response>, marks = [TAG_ACROSS_MARK], state = "online") {
  const asked: string[] = [];
  const link = {
    id,
    state,
    list: { marks },
    request: async (route: string) => {
      asked.push(route);
      return answer();
    },
  };
  return { link: link as unknown as PeerLink, asked };
}

const agentsAnswer = (sessions: Record<string, unknown>[]) => () => Response.json({ sessions });
const laptopAgent = { session: FAR, host: "claude-code", kind: "live", name: null, project: { id: null, name: "web", root: null }, started_at: "2026-11-24T09:00:00.000Z", last_at: "2026-11-24T09:10:00.000Z", busy: false, idle_since: null, taggable: true };

/** The far tags' own clock (how old a computer's agents list is). */
const clock = { at: Date.parse("2026-11-24T09:00:00.000Z") };

function studio(peers: PeerLink[]) {
  let tick = Date.parse("2026-11-24T09:00:00.000Z");
  const store = InboxStore.open(temp("studio"), { now: () => new Date((tick += 1000)) });
  const project = store.ensureProject({ name: "api", root: "/work/api" });
  const asked = store.sendMessage({ project_id: project.id, author: OWNER, body: "Should the retry queue keep its order?", wakes: true }).message;
  const held: { machine: string; route: string; body: Record<string, unknown> }[] = [];
  const keys = new Set<string>();
  const sentAs: FarReplyInput[] = [];
  const far = createInboxFarTags({
    store,
    now: () => clock.at,
    selfId: () => STUDIO,
    selfName: () => "Studio",
    peers: () => peers,
    nameOf: (id) => (id === LAPTOP ? "Laptop" : null),
    holdWrite: (machine, route, body) => {
      held.push({ machine, route, body });
      keys.add(String(body.idempotency_key));
      return Promise.resolve(null);
    },
    heldWrite: (key) => (keys.has(key) ? ({ key } as OutboxEntry) : null),
    commandFor: (reply: InboxMessage, session: string): InboxReplyCommand => ({
      type: "reply",
      id: reply.id,
      thread_id: reply.thread_id,
      reply_to: reply.reply_to,
      subject: "Retry queue",
      body: reply.body,
      url: "http://studio/#thread",
      ...(reply.tags?.some((t) => t.session === session) ? { tagged: { owner: "Claude Code" } } : {}),
    }),
    sendAs: async (input) => {
      sentAs.push(input);
      const sent = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: input.host, session: input.session, name: null, machine: input.machine, machine_name: input.machine_name ?? undefined }, body: input.body, reply_to: input.reply_to, idempotency_key: input.idempotency_key, wakes: true });
      return { message_id: sent.message.id, thread_id: sent.message.thread_id, replayed: false };
    },
  });
  return { store, project, asked, far, held, sentAs };
}

describe("the @ list on the thread's computer", () => {
  test("offers each linked computer's agents with that computer, read through its door", async () => {
    const laptop = peer(LAPTOP, agentsAnswer([laptopAgent]));
    const { far, asked } = studio([laptop.link]);
    const rows = await far.rows(asked.thread_id, OWNER.session, new Set([OWNER.session!]));
    expect(laptop.asked).toEqual([FAR_TAGGABLE_ROUTE]);
    expect(rows).toEqual([expect.objectContaining({ session: FAR, host: "claude-code", taggable: true, machine: LAPTOP, machine_name: "Laptop", project: { id: null, name: "web", root: null } })]);
    expect(far.self()).toEqual({ id: STUDIO, name: "Studio" });
  });

  test("an older computer (no mark) is never asked and none of its agents is offered; nothing linked offers nothing", async () => {
    const older = peer(LAPTOP, agentsAnswer([laptopAgent]), ["agent-read"]);
    const { far, asked } = studio([older.link]);
    expect(await far.rows(asked.thread_id, null, new Set())).toEqual([]);
    expect(older.asked).toEqual([]);
    expect(far.self()).toBeNull();
    const none = studio([]);
    expect(await none.far.rows(none.asked.thread_id, null, new Set())).toEqual([]);
  });

  test("an asleep computer keeps the agents it last listed; a door without the route lists none", async () => {
    let up = true;
    const laptop = peer(LAPTOP, () => (up ? Response.json({ sessions: [laptopAgent] }) : Response.json({ code: "device_route_not_found" }, { status: 404 })));
    const { far, asked } = studio([laptop.link]);
    expect((await far.rows(asked.thread_id, null, new Set())).map((r) => r.session)).toEqual([FAR]);
    (laptop.link as { state: string }).state = "offline";
    expect((await far.rows(asked.thread_id, null, new Set())).map((r) => r.session)).toEqual([FAR]);
    expect(far.lists(FAR)).toBe(true);
    // Online again with a door that no longer knows the route (read again once the list is old): nobody offered.
    (laptop.link as { state: string }).state = "online";
    up = false;
    clock.at += 10_000;
    expect(await far.rows(asked.thread_id, null, new Set())).toEqual([]);
  });
});

describe("the tag, recorded on the thread's computer", () => {
  test("a far tag resolves against that computer's agents, is stored with its computer, and keeps the order typed", async () => {
    const laptop = peer(LAPTOP, agentsAnswer([laptopAgent]));
    const { far, store, asked } = studio([laptop.link]);
    await far.rows(asked.thread_id, null, new Set());
    const local = (value: unknown) => (value as { session: string }[]).map((t) => ({ host: "pi", session: t.session, wakes: true }));
    const tags = far.targets([{ session: FAR, host: "claude-code", label: "Claude Code (Laptop)", machine: LAPTOP }, { session: "ses_pi" }], local);
    expect(tags.map((t) => t.session)).toEqual([FAR, "ses_pi"]);
    expect(tags[0]).toEqual({ host: "claude-code", session: FAR, label: "Claude Code (Laptop)", wakes: true, machine: LAPTOP });
    const reply = store.sendReply(asked.id, { idempotency_key: "k1", words: "@Claude Code (Laptop) check the order", tags: [tags[0]!] }).reply;
    expect(store.message(reply.id)!.tags).toEqual([expect.objectContaining({ session: FAR, machine: LAPTOP, wakes: true })]);
    expect(store.farSessions(asked.thread_id).get(FAR)).toEqual({ machine: LAPTOP, host: "claude-code" });
  });

  test("a session that computer does not list is not live, an older one there needs an update, and this computer's own tags go as before", async () => {
    const laptop = peer(LAPTOP, agentsAnswer([{ ...laptopAgent, session: "ses_old", taggable: false }]));
    const { far, asked } = studio([laptop.link]);
    await far.rows(asked.thread_id, null, new Set());
    const local = () => [];
    expect(() => far.targets([{ session: "ses_gone", machine: LAPTOP }], local)).toThrow(expect.objectContaining({ code: "session_not_live" }));
    expect(() => far.targets([{ session: "ses_old", machine: LAPTOP }], local)).toThrow(expect.objectContaining({ code: "tag_needs_update" }));
    // A tag naming this computer itself is this computer's.
    const seen: unknown[] = [];
    far.targets([{ session: "ses_here", machine: STUDIO }], (value) => (seen.push(value), []));
    expect(seen).toEqual([[{ session: "ses_here", machine: STUDIO }]]);
    expect(() => far.targets([{ session: 1 }], () => { throw new InboxError("validation_error", "x"); })).toThrow();
  });
});

describe("the wake, on the agent's own computer", () => {
  test("the thread's computer sends one wake per reply and session, with the tagged command; the agent's computer keeps it once and hands it on", async () => {
    const laptop = peer(LAPTOP, agentsAnswer([laptopAgent]));
    const { far, store, asked, held } = studio([laptop.link]);
    await far.rows(asked.thread_id, null, new Set());
    const tag = far.targets([{ session: FAR, machine: LAPTOP }], () => [])[0]!;
    const reply = store.sendReply(asked.id, { idempotency_key: "k2", words: "Laptop agent: check the order.", tags: [tag] }).reply;
    far.onPersonMessage(reply);
    far.onPersonMessage(reply);
    const wakes = held.filter((h) => h.route === FAR_WAKE_ROUTE);
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.machine).toBe(LAPTOP);
    expect(wakes[0]!.body).toMatchObject({ reply_id: reply.id, thread_id: asked.thread_id, session: FAR, command: { tagged: { owner: "Claude Code" } } });

    const laptopWakes = createInboxFarWakes({ dataDir: temp("laptop") });
    const url = (id: string) => `http://laptop/#thread=${id}`;
    expect(laptopWakes.receive(STUDIO, wakes[0]!.body, url)).toEqual({ kept: true });
    expect(laptopWakes.receive(STUDIO, wakes[0]!.body, url)).toEqual({ kept: false });
    const pending = laptopWakes.pendingFor(FAR);
    expect(pending.map((w) => w.command)).toEqual([expect.objectContaining({ id: reply.id, tagged: { owner: "Claude Code" }, url: url(asked.thread_id) })]);
    expect(laptopWakes.pendingFor("ses_someone_else")).toEqual([]);
    expect(laptopWakes.placeOf(reply.id)).toEqual({ machine: STUDIO, thread_id: asked.thread_id });
    expect(laptopWakes.wasHanded(STUDIO, asked.thread_id, FAR)).toBe(true);
    expect(laptopWakes.wasHanded(STUDIO, asked.thread_id, "ses_someone_else")).toBe(false);
    // Delivered: no longer handed, kept across a restart.
    expect(laptopWakes.delivered(FAR, reply.id)?.delivered_at).toBeTruthy();
    expect(laptopWakes.pendingFor(FAR)).toEqual([]);
  });

  test("a wake keeps only the fields a tag's wake words: never Send now, a Tidy or a far link", () => {
    const ids = { reply_id: "msg_01JZ0000000000000000000001", thread_id: "msg_01JZ0000000000000000000000" };
    const cmd = farWakeCommand({ type: "reply", id: ids.reply_id, thread_id: ids.thread_id, reply_to: null, subject: "S", body: "B", url: "http://far/", now: true, tidy: true, added: true, tagged: { owner: "Pi" } }, ids, "http://here/#thread");
    expect(cmd).toEqual({ type: "reply", id: ids.reply_id, thread_id: ids.thread_id, reply_to: null, subject: "S", body: "B", url: "http://here/#thread", tagged: { owner: "Pi" }, added: true });
    expect(farWakeCommand({ type: "reply", id: "msg_01JZ0000000000000000000009", thread_id: ids.thread_id, body: "B" }, ids, "u")).toBeNull();
    expect(farWakeCommand({ type: "tidy", id: ids.reply_id, thread_id: ids.thread_id, body: "B" }, ids, "u")).toBeNull();
  });

  test("a restart keeps what waits", () => {
    const dir = temp("laptop-restart");
    const ids = { reply_id: "msg_01JZ0000000000000000000001", thread_id: "msg_01JZ0000000000000000000000" };
    const first = createInboxFarWakes({ dataDir: dir });
    first.receive(STUDIO, { ...ids, session: FAR, host: "claude-code", command: { type: "reply", ...{ id: ids.reply_id, thread_id: ids.thread_id }, reply_to: null, subject: null, body: "B" } }, () => "u");
    expect(createInboxFarWakes({ dataDir: dir }).pendingFor(FAR)).toHaveLength(1);
  });
});

describe("the tagged agent's answer, written on the thread's computer", () => {
  test("only as a session the thread names on the computer that sends it; then a reply to it is sent there too", async () => {
    const laptop = peer(LAPTOP, agentsAnswer([laptopAgent]));
    const { far, store, asked, held, sentAs } = studio([laptop.link]);
    await far.rows(asked.thread_id, null, new Set());
    const tag = far.targets([{ session: FAR, machine: LAPTOP }], () => [])[0]!;
    const reply = store.sendReply(asked.id, { idempotency_key: "k3", words: "Laptop agent: check.", tags: [tag] }).reply;
    // Another computer cannot write as it, nor can the Laptop write as a session the thread does not name there.
    await expect(far.agentReply(OTHER, { reply_to: reply.id, session: FAR, body: "x", idempotency_key: "a" })).rejects.toMatchObject({ code: "not_your_session" });
    await expect(far.agentReply(LAPTOP, { reply_to: reply.id, session: OWNER.session, body: "x", idempotency_key: "a" })).rejects.toMatchObject({ code: "not_your_session" });
    await expect(far.agentReply(LAPTOP, { reply_to: MSG(99), session: FAR, body: "x", idempotency_key: "a" })).rejects.toMatchObject({ code: "message_not_found" });
    const answer = await far.agentReply(LAPTOP, { reply_to: reply.id, session: FAR, body: "The order holds.", idempotency_key: "a1", name: "Claude Code" });
    expect(sentAs[0]).toMatchObject({ machine: LAPTOP, machine_name: "Laptop", session: FAR, host: "claude-code", reply_to: reply.id, body: "The order holds." });
    const written = store.message(answer.message_id)!;
    expect(written.author).toMatchObject({ kind: "agent", session: FAR, machine: LAPTOP, machine_name: "Laptop" });
    // The person answers the far agent's message: its wake goes to the Laptop.
    const later = store.sendReply(written.id, { idempotency_key: "k4", words: "Good, ship it." }).reply;
    far.onPersonMessage(later);
    expect(held.filter((h) => h.route === FAR_WAKE_ROUTE).map((h) => h.body.reply_id)).toContain(later.id);
    // Its delivery from there settles it here.
    far.delivered(LAPTOP, { reply_id: later.id, session: FAR });
    expect(store.pendingReplies(FAR, { tags: true }).map((m) => m.id)).not.toContain(later.id);
  });

  test("on the agent's computer: sent through the outbox, held while the thread's computer is away, other far threads untouched", async () => {
    const ids = { machine: STUDIO, thread_id: "msg_01JZ0000000000000000000000" };
    const sent: Record<string, unknown>[] = [];
    let state: OutboxEntry["state"] = "delivered";
    const deps = {
      placeOf: (id: string, session: string) => (id === "msg_01JZ0000000000000000000001" && session === FAR ? ids : null),
      nameOf: () => "Studio",
      holdWrite: (_m: string, route: string, body: Record<string, unknown>) => {
        sent.push({ route, ...body });
        return Promise.resolve({ state, answer: { message_id: "msg_01JZ0000000000000000000002", thread_id: ids.thread_id } } as unknown as OutboxEntry);
      },
    };
    const next = async () => "NEXT";
    const done = await farAgentReply(deps, { body: "The order holds.", reply_to: "msg_01JZ0000000000000000000001", agent_session: FAR }, next);
    expect(sent[0]).toMatchObject({ route: FAR_AGENT_REPLY_ROUTE, reply_to: "msg_01JZ0000000000000000000001", session: FAR, body: "The order holds." });
    expect(done!.text).toBe(`Sent to the Plannotator Inbox (thread ${ids.thread_id}, on Studio). NEXT`);
    state = "queued";
    const waiting = await farAgentReply(deps, { body: "x", reply_to: "msg_01JZ0000000000000000000001", agent_session: FAR }, next);
    expect(waiting!.structured).toMatchObject({ held: true });
    expect(waiting!.text).toStartWith("Waiting for Studio:");
    // Not a thread that handed this session a wake: the send goes on as before (refused there in its own words).
    expect(await farAgentReply(deps, { body: "x", reply_to: "msg_01JZ0000000000000000000001", agent_session: "ses_other" }, next)).toBeNull();
    // Files cannot go yet: refused with words, nothing sent.
    const before = sent.length;
    await expect(farAgentReply(deps, { body: "x", reply_to: "msg_01JZ0000000000000000000001", agent_session: FAR, attachments: ["a.png"] }, next)).rejects.toMatchObject({ code: "not_across_computers" });
    expect(sent.length).toBe(before);
  });
});
