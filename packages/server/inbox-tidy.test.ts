/**
 * Tidy (owner-approved design, 2026-10-28) through the server's real doors:
 * the window's routes, a connection's poll and delivery, an MCP-only agent's
 * next tool call. Each test runs its own Inbox in a temp data dir, with
 * the store's clock set back (`storeNow`) while a test writes, so it reads as
 * hours or days old.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxQuestion, InboxThread, InboxTidyPlan, InboxTidyRun } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { inboxTidyRun } from "@plannotator/shared/inbox/tidy";
import { INBOX_TIDY_INSTRUCTION } from "@plannotator/core/inbox-types";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxWakeText, parseInboxBridgeCommands } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const HOUR = 60 * 60_000;
const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-tidy-")));
  roots.push(root);
  const billing = join(root, "billing");
  const docs = join(root, "docs");
  mkdirSync(billing, { recursive: true });
  mkdirSync(docs, { recursive: true });
  // What a test writes while `behind` is set reads as that much older.
  const clock = { behind: 0 };
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, binaryPath: null, board: true, storeNow: () => new Date(Date.now() - clock.behind) });
  servers.push(server);
  const client = new Client({ name: "inbox-tidy-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, billing, docs, clock, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;
const block = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError ? JSON.stringify(result.content) : "").toBe("");
  return result as { structuredContent: Record<string, unknown>; content: { type: string; text: string }[] };
}
const send = async (client: Client, project: string, session: string, args: Record<string, unknown>, host = "claude-code") =>
  (await call(client, "send_message", { project_path: project, agent_session: session, agent_host: host, ...args })).structuredContent as { message_id: string; thread_id: string };

const post = (server: InboxServer, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
const bridge = (server: InboxServer, path: string, body: unknown) =>
  fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });

/** Hands `session` its pending commands and says each was delivered. */
async function deliver(server: InboxServer, session: string, project: string) {
  const commands = await poll(server, session, project);
  for (const command of commands) await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host: "claude-code", type: "delivered", id: command.id });
  return commands;
}
const stateOf = async (server: InboxServer, session: string) => (await plan(server)).run!.agents.find((a) => a.session === session)!.state;

/** One poll of a session's connection (live for the next 30 s); the commands it was handed. */
async function poll(server: InboxServer, session: string, project: string, state: { busy?: boolean; idle_since?: number } = {}) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host: "claude-code", project_path: project, waitMs: 0, busy: state.busy ?? false, idle_since: state.idle_since ?? Date.now() - HOUR });
  return parseInboxBridgeCommands(await response.text());
}

async function plan(server: InboxServer, query = ""): Promise<InboxTidyPlan> {
  const response = await fetch(`${base(server)}/api/inbox/tidy${query}`);
  expect(response.status).toBe(200);
  return (await response.json()) as InboxTidyPlan;
}
const tidy = (server: InboxServer, body: Record<string, unknown>) => post(server, "/api/inbox/tidy", body);
async function thread(server: InboxServer, id: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
}
async function rows(server: InboxServer): Promise<InboxListRow[]> {
  const list = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return list.sections.flatMap((s) => s.threads);
}
const projectOf = async (server: InboxServer, name: string) =>
  ((await (await fetch(`${base(server)}/api/inbox/projects`)).json()) as { projects: { id: string; name: string }[] }).projects.find((p) => p.name === name)!.id;

describe("Tidy: who gets asked", () => {
  test("lists a live session's old open question and the reply it never answered; an ended session's thread goes apart; nothing young", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-live", billing);
    const asked = await send(client, billing, "ses-live", { subject: "Backfill", thread: "Backfill", body: `Before I cut over.\n\n${block("Backfill the ledger first?")}` });
    const update = await send(client, billing, "ses-live", { subject: "Webhooks", thread: "Webhooks", body: "Webhooks are done; screenshots next." });
    expect((await post(server, `/api/inbox/messages/${update.message_id}/reply`, { words: "Still waiting on those screenshots.", idempotency_key: "r1" })).status).toBe(200);
    await poll(server, "ses-live", billing).then(async (commands) => {
      for (const command of commands) await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-live", host: "claude-code", type: "delivered", id: command.id });
    });
    // An agent that named no session: nothing can ask it again.
    const gone = (await call(client, "send_message", { project_path: billing, subject: "Old lane", thread: "Old lane", body: block("Keep the old lane?") })).structuredContent as { thread_id: string };

    clock.behind = 0;
    // Just asked: not old enough to list.
    await send(client, billing, "ses-live", { subject: "Fresh", thread: "Fresh", body: block("Rename the flag?") });
    await poll(server, "ses-live", billing);
    const later = await plan(server);
    expect(later.agents.map((a) => a.session)).toEqual(["ses-live"]);
    const threads = later.agents[0]!.items.map((i) => i.thread_id).sort();
    expect(threads).toEqual([asked.thread_id, update.thread_id].sort());
    // The session that ended is not offered, nor its thread listed anywhere.
    expect(later.agents.flatMap((a) => a.items.map((i) => i.thread_id))).not.toContain(gone.thread_id);
    expect("ended" in later).toBe(false);
  });

  test("scope follows the project filter", async () => {
    const { server, client, billing, docs, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", docs);
    const inBilling = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    await send(client, docs, "ses-b", { subject: "Docs", thread: "Docs", body: block("Ship docs?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", docs);
    expect((await plan(server)).agents.map((a) => a.session).sort()).toEqual(["ses-a", "ses-b"]);
    const scoped = await plan(server, `?project=${await projectOf(server, "billing")}`);
    expect(scoped.agents.map((a) => a.session)).toEqual(["ses-a"]);
    expect(scoped.agents[0]!.items.map((i) => i.thread_id)).toEqual([inBilling.thread_id]);
  });

  test("the Board's Tidy asks only the agents owning cards in view, with their stale cards", async () => {
    const { server, client, billing, docs, clock } = await setup();
    clock.behind = 3 * 24 * HOUR;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", docs);
    await poll(server, "ses-c", billing);
    const lane = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: "Starting the ledger lane." });
    await call(client, "card", { op: "create", title: "Ledger lane", column: "building", say: "lane started", thread_id: lane.thread_id, project_path: billing, agent_session: "ses-a", agent_host: "claude-code" });
    await send(client, docs, "ses-b", { subject: "Docs", thread: "Docs", body: "Docs lane." });
    await call(client, "card", { op: "create", title: "Docs lane", column: "designing", project_path: docs, agent_session: "ses-b", agent_host: "claude-code" });
    // A session with an old open question but no card: the list asks it, the Board does not.
    await send(client, billing, "ses-c", { subject: "Refunds", thread: "Refunds", body: block("Move refunds now?") });
    clock.behind = 0;
    for (const [s, p] of [["ses-a", billing], ["ses-b", docs], ["ses-c", billing]] as const) await poll(server, s, p);

    const board = await plan(server, `?surface=board&project=${await projectOf(server, "billing")}`);
    expect(board.agents.map((a) => a.session)).toEqual(["ses-a"]);
    expect(board.agents[0]!.items).toEqual([expect.objectContaining({ thread_id: lane.thread_id, reasons: [expect.stringContaining("card idle")] })]);
    expect((await plan(server, `?project=${await projectOf(server, "billing")}`)).agents.map((a) => a.session).sort()).toEqual(["ses-a", "ses-c"]);
  });
});

describe("Tidy: asking", () => {
  test("one wake per session, a quiet note in each thread that never moves its row, the unsent pick left alone, then the cool-down", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const one = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    const two = await send(client, billing, "ses-a", { subject: "Refunds", thread: "Refunds", body: `${block("Move refunds now?")}\n\n${block("Keep the old webhook?")}` });
    // The person picked an answer in Refunds and did not send it.
    const picked = (await thread(server, two.thread_id)).messages[0]!.questions![0]! as InboxQuestion;
    const answer = { v: 1, key: picked.key, kind: picked.kind, prompt: picked.prompt, selected: ["Yes"] };
    expect((await post(server, `/api/inbox/messages/${two.message_id}/picks`, { questions: [{ key: picked.key, revision: 0, answer }] })).status).toBe(200);
    clock.behind = 0;
    await poll(server, "ses-a", billing, { busy: true });
    const before = (await rows(server)).map((r) => [r.thread_id, r.section, r.last_at]);

    const response = await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" });
    expect(response.status).toBe(200);
    expect((await rows(server)).map((r) => [r.thread_id, r.section, r.last_at])).toEqual(before);

    // A note in each listed thread; only one wake, held while the session is busy, handed out once it is idle.
    for (const id of [one.thread_id, two.thread_id]) expect((await thread(server, id)).messages.filter((m) => m.tidy)).toHaveLength(1);
    const commands = await deliver(server, "ses-a", billing);
    expect(commands).toHaveLength(1);
    const wake = inboxWakeText(commands[0]!).split("\n");
    expect(wake[0]).toBe(`Plannotator Inbox: Tidy (${commands[0]!.id})`);
    expect(wake[1]).toBe(INBOX_TIDY_INSTRUCTION);
    // The open question is listed; the one the person picked is not, and stays an unsent pick.
    expect(commands[0]!.body).toContain("Keep the old webhook?");
    expect(commands[0]!.body).not.toContain("Move refunds now?");
    const after = (await thread(server, two.thread_id)).messages[0]!.questions!.find((q) => q.key === picked.key)!;
    expect(after.state).toBe("picked");
    expect(after.sent_reply_id).toBeNull();

    // Asked a moment ago: not again, until the person writes to it.
    expect((await plan(server)).agents).toHaveLength(0);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t2" })).status).toBe(409);
    expect((await post(server, `/api/inbox/messages/${one.message_id}/reply`, { words: "Any news?", idempotency_key: "r2" })).status).toBe(200);
    expect((await plan(server)).agents.map((a) => a.session)).toEqual(["ses-a"]);
  });

  test("progress: an agent that writes reads tidied; one that goes idle with nothing written reads Nothing to change", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", billing);
    const a = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    await send(client, billing, "ses-b", { subject: "Docs", thread: "Docs", body: block("Ship docs?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    await poll(server, "ses-b", billing);
    const started = (await (await tidy(server, { sessions: ["ses-a", "ses-b"], idempotency_key: "t1" })).json()) as { run: InboxTidyRun };
    expect(started.run.agents.map((x) => x.state)).toEqual(["waiting", "waiting"]);
    for (const session of ["ses-a", "ses-b"]) {
      const [command] = await poll(server, session, billing);
      await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session, host: "claude-code", type: "delivered", id: command!.id });
    }
    // ses-a answers in its thread; ses-b's turn ends with nothing written.
    await send(client, billing, "ses-a", { reply_to: a.message_id, body: "That one no longer applies.", supersedes: [`${a.message_id}/${(await thread(server, a.thread_id)).messages[0]!.questions![0]!.key}`] });
    await poll(server, "ses-b", billing, { busy: true });
    await poll(server, "ses-b", billing, { idle_since: Date.now() + 5 });
    const run = (await plan(server)).run!;
    const state = Object.fromEntries(run.agents.map((x) => [x.session, x.state]));
    expect(state).toEqual({ "ses-a": "tidied", "ses-b": "nothing" });
    expect(run.done).toBe(2);
    expect(run.updated).toBe(1);
  });

  test("Nothing to change is set by a turn ending after delivery, not by a poll, and holds through the next turn", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    expect(await deliver(server, "ses-a", billing)).toHaveLength(1);
    // Still in the idle spell it was in before delivery (a later poll, on a later clock tick): no turn has ended since.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await poll(server, "ses-a", billing);
    expect(await stateOf(server, "ses-a")).toBe("delivered");
    await poll(server, "ses-a", billing, { busy: true });
    await poll(server, "ses-a", billing, { idle_since: Date.now() + 5 });
    expect(await stateOf(server, "ses-a")).toBe("nothing");
    // Its next turn (on other work) does not take that back.
    await poll(server, "ses-a", billing, { busy: true });
    expect(await stateOf(server, "ses-a")).toBe("nothing");
    expect((await plan(server)).run!.done).toBe(1);
  });

  test("N threads updated counts only the threads the run asked about", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const a = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    await deliver(server, "ses-a", billing);
    // A write counts once it is after the delivery (a later clock tick).
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Other work, in a thread the run never named: tidied, with no thread counted.
    await send(client, billing, "ses-a", { subject: "Elsewhere", thread: "Elsewhere", body: "Started the cache work." });
    let run = (await plan(server)).run!;
    expect(run.agents[0]!.state).toBe("tidied");
    expect([run.agents[0]!.updated, run.updated]).toEqual([0, 0]);
    await send(client, billing, "ses-a", { reply_to: a.message_id, body: "Ledger is done; closing this." });
    run = (await plan(server)).run!;
    expect([run.agents[0]!.updated, run.updated]).toEqual([1, 1]);
  });

  test("an undelivered wake is not sent again, even after the person writes to that session", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    const a = await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    // Busy: the wake waits for its turn to end.
    await poll(server, "ses-a", billing, { busy: true });
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    expect((await post(server, `/api/inbox/messages/${a.message_id}/reply`, { words: "Any news?", idempotency_key: "r1" })).status).toBe(200);
    expect((await plan(server)).agents).toHaveLength(0);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t2" })).status).toBe(409);
    // Once it is delivered, the person's writing since lets it be asked again.
    const handed = await deliver(server, "ses-a", billing);
    expect(handed.filter((c) => inboxWakeText(c).startsWith("Plannotator Inbox: Tidy"))).toHaveLength(1);
    expect((await plan(server)).agents.map((x) => x.session)).toEqual(["ses-a"]);
  });

  test("a session that ended before its wake was delivered reads Session ended, and counts as done", async () => {
    const { server, client, billing, clock, dataDir } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing, { busy: true });
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    expect((await plan(server)).run!.agents.map((x) => x.state)).toEqual(["waiting"]);
    // The session ends (no connection, no Inbox call) before its turn did: read the same store as gone.
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const store = InboxStore.open(dataDir);
    const run = inboxTidyRun(store, { now: Date.now(), idleSince: () => null, reachOf: () => null })!;
    expect(run.agents.map((x) => x.state)).toEqual(["ended"]);
    expect(run.done).toBe(1);
  });

  test("a session that got its wake and ended without writing reads Session ended, not Delivered all day", async () => {
    const { server, client, billing, clock, dataDir } = await setup();
    clock.behind = 3 * HOUR;
    await poll(server, "ses-a", billing);
    await send(client, billing, "ses-a", { subject: "Ledger", thread: "Ledger", body: block("Ledger first?") });
    clock.behind = 0;
    await poll(server, "ses-a", billing);
    expect((await tidy(server, { sessions: ["ses-a"], idempotency_key: "t1" })).status).toBe(200);
    await deliver(server, "ses-a", billing);
    expect(await stateOf(server, "ses-a")).toBe("delivered");
    // Closed mid-turn (or the Inbox restarted, its idle times gone): no connection, no idle time, no write.
    server.stop();
    servers.splice(servers.indexOf(server), 1);
    const run = inboxTidyRun(InboxStore.open(dataDir), { now: Date.now(), idleSince: () => null, reachOf: () => null })!;
    expect(run.agents.map((x) => x.state)).toEqual(["ended"]);
    expect(run.done).toBe(1);
  });

  test("an MCP-only agent gets the text once, at the end of its next Inbox tool result", async () => {
    const { server, client, billing, clock } = await setup();
    clock.behind = 3 * HOUR;
    const asked = await send(client, billing, "ses-cursor", { subject: "Keys", thread: "Keys", body: block("Rebind keys?") }, "cursor");
    clock.behind = 0;
    const found = await plan(server);
    expect(found.agents).toEqual([expect.objectContaining({ session: "ses-cursor", reach: "next_call" })]);
    expect((await tidy(server, { sessions: ["ses-cursor"], idempotency_key: "t1" })).status).toBe(200);
    const read = async () =>
      (await call(client, "read_thread", { thread_id: asked.thread_id, agent_session: "ses-cursor", project_path: billing })).content.map((c) => c.text).join("\n");
    const first = await read();
    expect(first).toContain(INBOX_TIDY_INSTRUCTION);
    expect(await read()).not.toContain(INBOX_TIDY_INSTRUCTION);
  });

  test("guards: another site's read and write, a stale tab", async () => {
    const { server } = await setup();
    expect((await fetch(`${base(server)}/api/inbox/tidy`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await post(server, "/api/inbox/tidy", { sessions: ["x"], idempotency_key: "k" }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(`${base(server)}/api/inbox/tidy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: "stale", sessions: ["x"], idempotency_key: "k" }) })).status).toBe(409);
  });
});
