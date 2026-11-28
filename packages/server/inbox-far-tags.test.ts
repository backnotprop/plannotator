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
      const { body, reply_to, idempotency_key } = input.args as { body: string; reply_to: string; idempotency_key: string };
      const sent = store.sendMessage({ project_id: project.id, author: { kind: "agent", host: input.host, session: input.session, name: null, machine: input.machine, machine_name: input.machine_name ?? undefined }, body, reply_to, idempotency_key, wakes: true });
      return { text: "Sent.", structured: { message_id: sent.message.id, thread_id: sent.message.thread_id } };
    },
    ownSession: (session) => session === "ses_live_here",
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

  test("the live signature (what the delivery watch tells the windows by) moves when a far agent goes or starts working, not on the same list read again", async () => {
    let sessions: Record<string, unknown>[] = [laptopAgent, { ...laptopAgent, session: "ses_far_pi", host: "pi" }];
    const laptop = peer(LAPTOP, () => Response.json({ sessions }));
    const { far, asked } = studio([laptop.link]);
    const readAgain = async () => {
      clock.at += 10_000;
      await far.rows(asked.thread_id, null, new Set());
      return far.liveSignature();
    };
    const first = await readAgain();
    expect(await readAgain()).toBe(first);
    // Laptop restarted without its Pi: a swarm member there is no longer idle.
    sessions = [laptopAgent];
    const gone = await readAgain();
    expect(gone).not.toBe(first);
    sessions = [{ ...laptopAgent, busy: true }];
    expect(await readAgain()).not.toBe(gone);
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
    // Delivered: no longer handed, kept across a restart.
    expect(laptopWakes.delivered(FAR, reply.id)?.delivered_at).toBeTruthy();
    expect(laptopWakes.pendingFor(FAR)).toEqual([]);
  });

  test("a wake keeps the fields a reply's wake words, Send now and the details line included; never a Tidy or a far link", () => {
    const ids = { reply_id: "msg_01JZ0000000000000000000001", thread_id: "msg_01JZ0000000000000000000000" };
    const context = { messages: 4, open_questions: 1, open_actions: 0, last_agent_at: "2026-11-24T09:00:00.000Z", replying_to: { id: MSG(3), at: "2026-11-24T08:00:00.000Z", quote: "Should the retry queue", questions: 1, evil: "x" }, hostile: "\u001b[31m" };
    const cmd = farWakeCommand({ type: "reply", id: ids.reply_id, thread_id: ids.thread_id, reply_to: null, subject: "S", body: "B", url: "http://far/", now: true, tidy: true, added: true, tagged: { owner: "Pi" }, context }, ids, "http://here/#thread");
    expect(cmd).toEqual({
      type: "reply",
      id: ids.reply_id,
      thread_id: ids.thread_id,
      reply_to: null,
      subject: "S",
      body: "B",
      url: "http://here/#thread",
      tagged: { owner: "Pi" },
      added: true,
      now: true,
      context: { messages: 4, open_questions: 1, open_actions: 0, last_agent_at: "2026-11-24T09:00:00.000Z", replying_to: { id: MSG(3), at: "2026-11-24T08:00:00.000Z", quote: "Should the retry queue", questions: 1 } },
    });
    // A details line that does not count is left out, the wake kept.
    expect(farWakeCommand({ type: "reply", id: ids.reply_id, thread_id: ids.thread_id, body: "B", context: { messages: -1 } }, ids, "u")?.context).toBeUndefined();
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
  test("any session of the sending computer writes, tagged or not; never as this computer's own or another computer's; a reply to it is sent there", async () => {
    const laptop = peer(LAPTOP, agentsAnswer([laptopAgent]));
    const { far, store, asked, held, sentAs } = studio([laptop.link]);
    await far.rows(asked.thread_id, null, new Set());
    const tag = far.targets([{ session: FAR, machine: LAPTOP }], () => [])[0]!;
    const reply = store.sendReply(asked.id, { idempotency_key: "k3", words: "Laptop agent: check.", tags: [tag] }).reply;
    const args = (more: Record<string, unknown>) => ({ body: "x", idempotency_key: "a", reply_to: reply.id, ...more });
    // Another computer cannot write as the Laptop's session; the Laptop cannot write as this computer's own.
    await expect(far.agentReply(OTHER, { session: FAR, args: args({}) })).rejects.toMatchObject({ code: "not_your_session" });
    await expect(far.agentReply(LAPTOP, { session: OWNER.session, args: args({}) })).rejects.toMatchObject({ code: "not_your_session" });
    await expect(far.agentReply(LAPTOP, { session: "ses_live_here", args: args({}) })).rejects.toMatchObject({ code: "not_your_session" });
    await expect(far.agentReply(LAPTOP, { session: FAR, args: args({ reply_to: MSG(99) }) })).rejects.toMatchObject({ code: "message_not_found" });
    // A Laptop session nobody tagged writes in the thread as a local agent may, its thread id as reply_to.
    const untagged = await far.agentReply(LAPTOP, { session: "ses_laptop_other", host: "pi", args: args({ reply_to: asked.thread_id, body: "Seen it.", idempotency_key: "u1" }) });
    expect(store.message(String(untagged.structured.message_id))!.author).toMatchObject({ session: "ses_laptop_other", machine: LAPTOP });
    // Every send_message field goes to the tool; the other computer's paths do not.
    const answer = await far.agentReply(LAPTOP, { session: FAR, name: "Claude Code", args: args({ body: "The order holds.", idempotency_key: "a1", steps: [{ title: "Ship" }], pulls: ["acme/api#4"], priority: true, thread: "Queue", attachments: ["upl_1"], branch: { name: "fix", head: "abc" }, project_path: "/laptop/web" }) });
    expect(sentAs.at(-1)).toMatchObject({ machine: LAPTOP, machine_name: "Laptop", session: FAR, host: "claude-code", name: "Claude Code" });
    expect(sentAs.at(-1)!.args).toEqual({ body: "The order holds.", idempotency_key: "a1", reply_to: reply.id, steps: [{ title: "Ship" }], pulls: ["acme/api#4"], priority: true, thread: "Queue", attachments: ["upl_1"], branch: { name: "fix", head: "abc" } });
    // Now the Laptop's session it is: another computer still cannot write as it.
    await expect(far.agentReply(OTHER, { session: "ses_laptop_other", args: args({}) })).rejects.toMatchObject({ code: "not_your_session" });
    const written = store.message(String(answer.structured.message_id))!;
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
    const ids = { machine: STUDIO, thread_id: MSG(0) };
    const sent: Record<string, unknown>[] = [];
    const held: { name: string; sha: string }[][] = [];
    let state: OutboxEntry["state"] = "delivered";
    const folder = temp("laptop-work");
    await Bun.write(join(folder, "notes.md"), "# Notes\n");
    await Bun.write(join(folder, "shot.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const deps = {
      placeOf: async (id: string) => (id === MSG(1) || id === MSG(0) ? ids : null),
      nameOf: () => "Studio",
      takes: () => true,
      heldWrite: () => null,
      dismissHeld: () => {},
      holdWrite: (_m: string, route: string, body: Record<string, unknown>, _thread: string | null, _wait: number, own: { files?: readonly { upload: string; name: string }[] } = {}) => {
        sent.push({ route, ...body, files: own.files ?? [] });
        return Promise.resolve({ state, answer: { text: "Sent to the Plannotator Inbox (thread X).", structured: { message_id: MSG(2), thread_id: ids.thread_id } } } as unknown as OutboxEntry);
      },
      readFiles: async (paths: string[], base: string | undefined) => paths.map((path) => ({ name: path.split("/").at(-1)!, sent_sha256: `sha-${path}`, base }) as never),
      holdFiles: async (files: readonly { attachment: { sent_sha256: string }; name: string }[]) => {
        held.push(files.map((file) => ({ name: file.name, sha: file.attachment.sent_sha256 })));
        return files.map((file, i) => ({ upload: `upl_${held.length}_${i}`, name: file.name }));
      },
    };
    const next = async () => "NEXT";
    // Any session here, tagged or not: that computer's own answer comes back as it is, with the computer.
    const done = await farAgentReply(deps, { body: "The order holds.", reply_to: MSG(1), agent_session: "ses_any", agent_host: "pi", project_path: "/laptop/web", steps: [{ title: "Ship" }] }, next, undefined);
    expect(sent[0]).toMatchObject({ route: FAR_AGENT_REPLY_ROUTE, session: "ses_any", host: "pi", args: { body: "The order holds.", reply_to: MSG(1), steps: [{ title: "Ship" }] } });
    expect((sent[0]!.args as Record<string, unknown>).project_path).toBeUndefined();
    expect(done).toEqual({ text: "Sent to the Plannotator Inbox (thread X).", structured: { message_id: MSG(2), thread_id: ids.thread_id, machine: { id: STUDIO, name: "Studio" } } });
    // Files and the pictures the body shows from this disk: read here, kept here with the answer under the names the
    // body gives them, never as this disk's paths in the words sent on.
    await farAgentReply(deps, { body: "See ![shot](shot.png).", reply_to: MSG(1), agent_session: FAR, attachments: ["notes.md"] }, next, folder);
    expect(held.at(-1)!.map((file) => file.name)).toEqual(["notes.md", "shot.png"]);
    expect(sent.at(-1)!.files).toEqual([
      { upload: "upl_1_0", name: "notes.md" },
      { upload: "upl_1_1", name: "shot.png" },
    ]);
    expect((sent.at(-1)!.args as Record<string, unknown>).attachments).toBeUndefined();
    // The thread's computer away: words wait for it, and so do words with files, with the same line.
    state = "queued";
    const waiting = await farAgentReply(deps, { body: "x", reply_to: MSG(1), agent_session: FAR }, next, undefined);
    expect(waiting!.structured).toMatchObject({ held: true });
    expect(waiting!.text).toStartWith("Waiting for Studio:");
    const withFiles = await farAgentReply(deps, { body: "x", reply_to: MSG(1), agent_session: FAR, attachments: ["notes.md"] }, next, folder);
    expect(withFiles!.structured).toMatchObject({ held: true });
    expect(withFiles!.text).toBe(waiting!.text);
    expect(sent.at(-1)!.files).toEqual([{ upload: "upl_2_0", name: "notes.md" }]);
    // Its refusal there is the agent's refusal here.
    state = "refused";
    deps.holdWrite = (_m, route, body) => (sent.push({ route, ...body }), Promise.resolve({ state, answer: { code: "steps_off", error: "Steps are off." } } as unknown as OutboxEntry));
    await expect(farAgentReply(deps, { body: "x", reply_to: MSG(1), agent_session: FAR }, next, undefined)).rejects.toMatchObject({ code: "steps_off", message: "Steps are off." });
    // Not a far thread: the send goes on here.
    expect(await farAgentReply(deps, { body: "x", reply_to: MSG(7), agent_session: FAR }, next, undefined)).toBeNull();
  });

  test("Take back and Send now on the thread's computer reach the wake on the agent's", async () => {
    const laptop = peer(LAPTOP, agentsAnswer([laptopAgent]));
    const { far, store, asked, held } = studio([laptop.link]);
    await far.rows(asked.thread_id, null, new Set());
    const tag = far.targets([{ session: FAR, machine: LAPTOP }], () => [])[0]!;
    const url = () => "u";
    const laptopWakes = createInboxFarWakes({ dataDir: temp("laptop-change") });
    // Send now: the wake there is replaced with one that goes into the running turn.
    const first = store.sendReply(asked.id, { idempotency_key: "n1", words: "Now please.", tags: [tag] }).reply;
    far.onPersonMessage(first);
    laptopWakes.receive(STUDIO, held.at(-1)!.body, url);
    const now = store.requestDeliverNow(first.id, FAR);
    far.onPersonMessage(now);
    expect(held.at(-1)!.body).toMatchObject({ reply_id: first.id, replaces: true });
    laptopWakes.receive(STUDIO, held.at(-1)!.body, url);
    expect(laptopWakes.pendingFor(FAR)).toHaveLength(1);
    // Take back before the agent took it: the wake there is not handed.
    const second = store.sendReply(asked.id, { idempotency_key: "t1", words: "Never mind.", tags: [tag] }).reply;
    far.onPersonMessage(second);
    laptopWakes.receive(STUDIO, held.at(-1)!.body, url);
    expect(laptopWakes.pendingFor(FAR).map((w) => w.reply_id)).toEqual([first.id, second.id]);
    far.onPersonMessage(store.takeBack(second.id));
    expect(held.at(-1)!.body).toMatchObject({ reply_id: second.id, withdrawn: true });
    laptopWakes.receive(STUDIO, held.at(-1)!.body, url);
    expect(laptopWakes.pendingFor(FAR).map((w) => w.reply_id)).toEqual([first.id]);
  });
});
