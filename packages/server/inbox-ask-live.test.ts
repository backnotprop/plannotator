/**
 * Ask AI's live answers through a running Inbox on a temp data dir. The person
 * is requests shaped as the window's. The agent is a fake modeled on what the
 * Claude Code mod does (inbox-bridge.test.ts is the model for the connection):
 * it long-polls the connection route saying it can answer, starts the pull
 * client when told a question waits, and posts the client's real events.
 *
 * Guards the moments the plan names: first question to a busy agent, no poll in
 * time, agent gone, taken over, older plugin, browser drops and comes back,
 * and that words are neither lost nor sent twice in any of them.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { SESSION_ASK_HEADER } from "@plannotator/ai/session-bridge";
import { SESSION_BRIDGE_EVENT_PATH, SESSION_BRIDGE_POLL_PATH } from "@plannotator/ai/session-bridge-pull";
import { INBOX_ASK_TEXT_MAX, type InboxAskConversation, type InboxAskTurn } from "@plannotator/shared/inbox/ask";
import { INBOX_ASK_POLL_FIELD, INBOX_ASK_WAITS_FIELD, INBOX_BRIDGE_POLL_PATH, inboxAskBridgeBase, parseInboxAskWaits } from "@plannotator/shared/inbox/connection";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { startInboxServer, type InboxServer } from "./inbox";
import type { InboxAskTimes } from "./inbox-ask-live";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const agents: FakeAgent[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.stop();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(times: InboxAskTimes = {}, askAi = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-ask-live-")));
  roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, askAi, binaryPath: null, askTimes: { connectWaitMs: 1_500, ...times } });
  servers.push(server);
  const client = new Client({ name: "inbox-ask-live-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, dataDir };
}

async function agentSends(client: Client, project: string, session: string, body: string, reply_to?: string): Promise<{ message_id: string; thread_id: string }> {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...(reply_to ? { reply_to } : {}) },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

interface AskCommand {
  type: "ask";
  askId: string;
  text: string;
  mode: string;
}

/** What a connection with the Ask AI client does, with the parts a test wants to go wrong. */
interface FakeAgent {
  session: string;
  /** Questions that reached the session. */
  asks: AskCommand[];
  /** Cancels that reached the session. */
  cancels: string[];
  clientRuns: () => number;
  /** How the last client ended: "closing", an HTTP status, or null while it runs. */
  clientEnd: () => string | number | null;
  setStatus(status: "ready" | "busy"): Promise<void>;
  event(body: Record<string, unknown>): Promise<Response>;
  answer(askId: string, words: string[]): Promise<void>;
  /** The client process dies with its poll open. */
  dropClient(): void;
  stop(): void;
}

async function fakeAgent(
  server: InboxServer,
  project: string,
  session: string,
  options: { status?: "ready" | "busy"; olderPlugin?: boolean; noClient?: boolean; clientDelayMs?: number; clientPollMs?: number } = {},
): Promise<FakeAgent> {
  const stopped = new AbortController();
  let clientStop = new AbortController();
  let status = options.status ?? "ready";
  let runs = 0;
  let running = false;
  let end: string | number | null = null;
  const asks: AskCommand[] = [];
  const cancels: string[] = [];
  const post = (path: string, body: unknown, signal: AbortSignal) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
      body: JSON.stringify(body),
      signal,
    });
  const base = inboxAskBridgeBase(session);
  const event = (body: Record<string, unknown>) => post(`${base}${SESSION_BRIDGE_EVENT_PATH}`, body, stopped.signal);

  const runClient = async () => {
    if (running) return;
    running = true;
    runs += 1;
    end = null;
    clientStop = new AbortController();
    const signal = clientStop.signal;
    if (options.clientDelayMs) await Bun.sleep(options.clientDelayMs);
    try {
      while (!signal.aborted && !stopped.signal.aborted) {
        const response = await post(`${base}${SESSION_BRIDGE_POLL_PATH}`, { status, modes: { turn: true, transient: false }, waitMs: options.clientPollMs ?? 400 }, signal);
        if (response.status !== 200) {
          end = response.status;
          return;
        }
        const body = (await response.json()) as { commands: (AskCommand | { type: "cancel"; askId: string } | { type: "interrupt"; interruptId: string })[]; closing?: true };
        for (const command of body.commands) {
          if (command.type === "ask" && !asks.some((ask) => ask.askId === command.askId)) {
            asks.push(command);
            await event({ type: "started", askId: command.askId });
          }
          if (command.type === "cancel") cancels.push(command.askId);
          if (command.type === "interrupt") {
            status = "ready";
            await event({ type: "interrupted", interruptId: command.interruptId, ok: true });
          }
        }
        if (body.closing) {
          end = "closing";
          return;
        }
      }
    } catch {
      // Dropped by the test, or the Inbox went away.
    } finally {
      running = false;
    }
  };

  const fields = { session, host: "claude-code", project_path: project, ...(options.olderPlugin ? {} : { [INBOX_ASK_POLL_FIELD]: true }) };
  await (await post(INBOX_BRIDGE_POLL_PATH, { ...fields, waitMs: 0 }, stopped.signal)).text();
  void (async () => {
    try {
      while (!stopped.signal.aborted) {
        const text = await (await post(INBOX_BRIDGE_POLL_PATH, { ...fields, waitMs: 400 }, stopped.signal)).text();
        if (parseInboxAskWaits(text) && !options.noClient) void runClient();
        await Bun.sleep(10);
      }
    } catch {
      // Stopped by the test.
    }
  })();

  const agent: FakeAgent = {
    session,
    asks,
    cancels,
    clientRuns: () => runs,
    clientEnd: () => end,
    async setStatus(next) {
      status = next;
      await event({ type: "status", status: next });
    },
    event,
    async answer(askId, words) {
      for (const word of words) await event({ type: "delta", askId, text: word });
      await event({ type: "done", askId, answer: words.join("") });
    },
    dropClient: () => clientStop.abort(),
    stop() {
      stopped.abort();
      clientStop.abort();
    },
  };
  agents.push(agent);
  return agent;
}

const windowHeaders = (server: InboxServer) => ({ "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json", Origin: `http://127.0.0.1:${server.port}` });

function fromWindow(server: InboxServer, path: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: body ? "POST" : "GET",
    headers: windowHeaders(server),
    ...(body ? { body: JSON.stringify({ serverSession: server.serverSession, ...body }) } : {}),
    ...(signal ? { signal } : {}),
  });
}

interface AskAnswer {
  turn: InboxAskTurn;
  conversation: InboxAskConversation;
  provider_id: string | null;
  reason?: string;
  running?: boolean;
}

async function ask(server: InboxServer, threadId: string, turnId: string, question = "Why?"): Promise<AskAnswer> {
  const response = await fromWindow(server, `/api/inbox/threads/${threadId}/ask`, { turn_id: turnId, question });
  expect(response.status).toBe(200);
  return (await response.json()) as AskAnswer;
}

async function refused(server: InboxServer, threadId: string, turnId: string): Promise<{ status: number; code: string }> {
  const response = await fromWindow(server, `/api/inbox/threads/${threadId}/ask`, { turn_id: turnId, question: "Why?" });
  return { status: response.status, code: ((await response.json()) as { code: string }).code };
}

async function read(server: InboxServer, threadId: string): Promise<{ conversation: InboxAskConversation | null; running: string | null }> {
  return (await (await fromWindow(server, `/api/inbox/threads/${threadId}/ask`)).json()) as { conversation: InboxAskConversation | null; running: string | null };
}

const turnsOf = async (server: InboxServer, threadId: string) => (await read(server, threadId)).conversation?.turns ?? [];

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(10);
  }
}

/** What the window does after POST /ask: a fresh AI session on the named provider, then the query. */
async function query(server: InboxServer, providerId: string, threadId: string, question = "Why?", busyPolicy?: "wait" | "interrupt") {
  const created = await fromWindow(server, "/api/ai/session", { providerId, context: { mode: "annotate", annotate: { filePath: `Inbox thread "Ship it?" (${threadId})`, content: "" } } });
  expect(created.status).toBe(200);
  const { sessionId } = (await created.json()) as { sessionId: string };
  const browser = new AbortController();
  const messages: { type: string; code?: string; delta?: string }[] = [];
  const decoder = new TextDecoder();
  // Not awaited: the headers go out with the first word, and the agent answers only after this returns.
  const finished = (async () => {
    let text = "";
    try {
      const response = await fromWindow(server, "/api/ai/query", { sessionId, prompt: question, ...(busyPolicy ? { busyPolicy } : {}) }, browser.signal);
      const reader = response.body!.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        text += decoder.decode(value, { stream: true });
        const lines = text.split("\n");
        text = lines.pop()!;
        for (const line of lines) if (line.startsWith("data: {")) messages.push(JSON.parse(line.slice(6)));
      }
    } catch {
      // The browser dropped.
    }
  })();
  return { sessionId, messages, finished, drop: () => browser.abort() };
}

describe("off, the default", () => {
  test("no question can wait, and the agent's routes and /api/ai are the unknown route", async () => {
    const { server, client, project } = await setup({}, false);
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const unknown = await fromWindow(server, "/api/no-such-route");
    const answer = await unknown.json();
    const bearer = { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" };
    const base = `http://127.0.0.1:${server.port}`;
    for (const response of [
      await fromWindow(server, "/api/ai/capabilities"),
      await fromWindow(server, "/api/ai/session", { context: { mode: "annotate" } }),
      await fromWindow(server, "/api/ai/query", { sessionId: "x", prompt: "y" }),
      await fetch(`${base}${inboxAskBridgeBase("session-a")}${SESSION_BRIDGE_POLL_PATH}`, { method: "POST", headers: bearer, body: "{}" }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(answer);
    }
    expect((await fromWindow(server, `/api/inbox/threads/${thread_id}/ask`, { turn_id: "turn-0001", question: "Why?" })).status).toBe(404);
    const poll = await fetch(`${base}${INBOX_BRIDGE_POLL_PATH}`, { method: "POST", headers: bearer, body: JSON.stringify({ session: "session-a", host: "claude-code", waitMs: 0, [INBOX_ASK_POLL_FIELD]: true }) });
    expect(await poll.json()).toEqual({ commands: [] });
  });
});

describe("a question and its answer", () => {
  test("reaches the running session, comes back as it streams, and is saved when it ends", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");

    const posted = await ask(server, thread_id, "turn-0001", "Why this region?");
    expect(posted.provider_id).toBeString();
    expect(posted.turn.session).toBe("session-a");
    const answering = await query(server, posted.provider_id!, thread_id, "Why this region?");
    await waitFor(() => agent.asks.length === 1);
    expect(agent.asks[0]!.mode).toBe("turn");
    expect(agent.asks[0]!.text).toStartWith(SESSION_ASK_HEADER);
    expect(agent.asks[0]!.text).toContain(`Surface: annotating Inbox thread "Ship it?" (${thread_id})`);
    expect(agent.asks[0]!.text).toContain("Why this region?");
    expect((await read(server, thread_id)).running).toBe("turn-0001");

    await agent.answer(agent.asks[0]!.askId, ["It is ", "closest."]);
    await answering.finished;
    expect(answering.messages.filter((message) => message.type === "text_delta").map((message) => message.delta)).toEqual(["It is ", "closest."]);
    const after = await read(server, thread_id);
    expect(after.running).toBeNull();
    expect(after.conversation!.turns[0]).toMatchObject({ id: "turn-0001", answer: "It is closest." });
    expect(Date.parse(after.conversation!.turns[0]!.answered_at!)).toBeGreaterThan(0);
  });

  test("a held poll ends the moment a question waits, and every answer says so until the client connects", async () => {
    const { server, client, project } = await setup({ connectWaitMs: 800 });
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const poll = (waitMs: number) =>
      fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ session: "session-a", host: "claude-code", project_path: project, waitMs, [INBOX_ASK_POLL_FIELD]: true }),
      }).then((response) => response.json() as Promise<Record<string, unknown>>);
    expect(await poll(0)).toEqual({ commands: [] });

    const started = Date.now();
    const held = poll(20_000);
    await Bun.sleep(50);
    const posted = ask(server, thread_id, "turn-0001");
    expect((await held)[INBOX_ASK_WAITS_FIELD]).toBe(true);
    expect(Date.now() - started).toBeLessThan(700);
    // A poll that ignored it (Claude Code's own delivery poll does) loses nothing: the next one says it, at once.
    expect((await poll(0))[INBOX_ASK_WAITS_FIELD]).toBe(true);
    expect((await poll(20_000))[INBOX_ASK_WAITS_FIELD]).toBe(true);
    await fetch(`http://127.0.0.1:${server.port}${inboxAskBridgeBase("session-a")}${SESSION_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${server.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "ready", waitMs: 0 }),
    });
    expect(await poll(0)).toEqual({ commands: [] });
    expect((await posted).provider_id).toBeString();
  });

  test("a saved answer is not asked again, and a doubled POST reaches the agent once", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");

    const [one, two] = await Promise.all([ask(server, thread_id, "turn-0001"), ask(server, thread_id, "turn-0001")]);
    expect(two.provider_id).toBe(one.provider_id);
    const first = await query(server, one.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    const second = await query(server, two.provider_id!, thread_id);
    await second.finished;
    expect(second.messages.map((message) => message.code)).toEqual(["ask_in_flight"]);
    const during = await ask(server, thread_id, "turn-0001");
    expect(during).toMatchObject({ provider_id: null, running: true });

    await agent.answer(agent.asks[0]!.askId, ["Because."]);
    await first.finished;
    const retry = await ask(server, thread_id, "turn-0001");
    expect(retry.provider_id).toBeNull();
    expect(retry.turn.answer).toBe("Because.");
    expect(agent.asks).toHaveLength(1);
    expect(await turnsOf(server, thread_id)).toHaveLength(1);
  });

  test("an answer past the limit is cut, and says so", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    const askId = agent.asks[0]!.askId;
    const chunk = "x".repeat(900_000);
    await agent.event({ type: "delta", askId, text: chunk });
    await agent.event({ type: "delta", askId, text: chunk });
    await agent.event({ type: "delta", askId, text: chunk });
    await agent.event({ type: "done", askId, answer: "" });
    await answering.finished;
    const answer = (await turnsOf(server, thread_id))[0]!.answer!;
    expect(answer.startsWith("x".repeat(INBOX_ASK_TEXT_MAX))).toBe(true);
    expect(answer.endsWith("the rest of the answer was cut)")).toBe(true);
  });
});

describe("the agent is not free", () => {
  test("a first question to a busy agent gets the busy choice, is never slipped into its work, and the retry is one turn", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    // The client takes a moment to start: a query before its first poll would read a new bridge's `ready`.
    const agent = await fakeAgent(server, project, "session-a", { status: "busy", clientDelayMs: 300 });

    const started = Date.now();
    const posted = await ask(server, thread_id, "turn-0001");
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
    const first = await query(server, posted.provider_id!, thread_id);
    await first.finished;
    expect(first.messages.map((message) => message.code)).toEqual(["agent_busy"]);
    expect(agent.asks).toEqual([]);
    expect((await read(server, thread_id)).running).toBeNull();

    // "Ask when it finishes": the same turn id, so the slot comes back and no second turn is written.
    const retry = await ask(server, thread_id, "turn-0001");
    const waiting = await query(server, retry.provider_id!, thread_id, "Why?", "wait");
    await Bun.sleep(100);
    expect(agent.asks).toEqual([]);
    await agent.setStatus("ready");
    await waitFor(() => agent.asks.length === 1);
    await agent.answer(agent.asks[0]!.askId, ["Done now."]);
    await waiting.finished;
    expect((await turnsOf(server, thread_id)).map((turn) => turn.answer)).toEqual(["Done now."]);
  });

  test("Interrupt and ask now stops the agent's work, then asks", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a", { status: "busy" });
    await (await query(server, (await ask(server, thread_id, "turn-0001")).provider_id!, thread_id)).finished;

    const retry = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, retry.provider_id!, thread_id, "Why?", "interrupt");
    await waitFor(() => agent.asks.length === 1);
    await agent.answer(agent.asks[0]!.askId, ["Now."]);
    await answering.finished;
    expect((await turnsOf(server, thread_id)).map((turn) => turn.answer)).toEqual(["Now."]);
  });

  test("a second question while the first runs is refused with nothing saved, and works once it is free", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "One?");
    const agent = await fakeAgent(server, project, "session-a");

    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    expect(await refused(server, thread_id, "turn-0002")).toEqual({ status: 409, code: "ask_busy" });
    expect(await turnsOf(server, thread_id)).toHaveLength(1);

    await agent.answer(agent.asks[0]!.askId, ["Answered."]);
    await answering.finished;
    expect((await ask(server, thread_id, "turn-0002")).provider_id).toBeString();
  });

  test("two threads of one session take turns, and an answer lands on its own thread", async () => {
    const { server, client, project, dataDir } = await setup();
    const one = await agentSends(client, project, "session-a", "One?");
    const two = await agentSends(client, project, "session-b", "Two?");
    // session-a takes the second thread over, so it owns both.
    await agentSends(client, project, "session-a", "I have this.", two.message_id);
    const agent = await fakeAgent(server, project, "session-a");

    const first = await ask(server, one.thread_id, "turn-0001");
    const answering = await query(server, first.provider_id!, one.thread_id);
    await waitFor(() => agent.asks.length === 1);
    expect(await refused(server, two.thread_id, "turn-0002")).toEqual({ status: 409, code: "ask_busy" });
    expect(existsSync(join(inboxDir(dataDir), "ask", `${two.thread_id}.json`))).toBe(false);

    await agent.answer(agent.asks[0]!.askId, ["About one."]);
    await answering.finished;
    const second = await ask(server, two.thread_id, "turn-0002");
    const next = await query(server, second.provider_id!, two.thread_id);
    await waitFor(() => agent.asks.length === 2);
    await agent.answer(agent.asks[1]!.askId, ["About two."]);
    await next.finished;
    expect((await turnsOf(server, one.thread_id)).map((turn) => turn.answer)).toEqual(["About one."]);
    expect((await turnsOf(server, two.thread_id)).map((turn) => turn.answer)).toEqual(["About two."]);
  });

  test("a slot no query takes frees by itself, and a query with no slot is refused", async () => {
    const { server, client, project } = await setup({ slotMs: 150 });
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    await waitFor(async () => (await read(server, thread_id)).running === null);
    const late = await query(server, posted.provider_id!, thread_id);
    await late.finished;
    expect(late.messages.map((message) => message.code)).toEqual(["ask_in_flight"]);
    expect(agent.asks).toEqual([]);
    expect((await ask(server, thread_id, "turn-0002")).provider_id).toBeString();
  });

  test("after a hand-off, a retry of the saved turn goes to the new owner", async () => {
    const { server, client, project } = await setup();
    const { thread_id, message_id } = await agentSends(client, project, "session-a", "Ship it?");
    const old = await fakeAgent(server, project, "session-a", { status: "busy" });
    const posted = await ask(server, thread_id, "turn-0001");
    await (await query(server, posted.provider_id!, thread_id)).finished;
    expect(old.asks).toEqual([]);

    await agentSends(client, project, "session-b", "I took this over.", message_id);
    const owner = await fakeAgent(server, project, "session-b");
    const retry = await ask(server, thread_id, "turn-0001");
    expect(retry.turn.session).toBe("session-b");
    expect(retry.provider_id).not.toBe(posted.provider_id);
    const answering = await query(server, retry.provider_id!, thread_id);
    await waitFor(() => owner.asks.length === 1);
    await owner.answer(owner.asks[0]!.askId, ["Mine now."]);
    await answering.finished;
    expect(await turnsOf(server, thread_id)).toMatchObject([{ id: "turn-0001", session: "session-b", answer: "Mine now." }]);
  });
});

describe("the agent cannot answer", () => {
  test("an older plugin has no live path: refused, nothing saved, and no question waits", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a", { olderPlugin: true });
    expect(await refused(server, thread_id, "turn-0001")).toEqual({ status: 409, code: "ask_no_live_path" });
    expect(await turnsOf(server, thread_id)).toEqual([]);
    expect(agent.clientRuns()).toBe(0);
  });

  test("a session with no connection at all has no live path either", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    expect(await refused(server, thread_id, "turn-0001")).toEqual({ status: 409, code: "ask_no_live_path" });
  });

  test("no poll in time: the question stays saved, the slot frees, and asking again is the same turn", async () => {
    const { server, client, project } = await setup({ connectWaitMs: 250 });
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    await fakeAgent(server, project, "session-a", { noClient: true });

    const started = Date.now();
    const posted = await ask(server, thread_id, "turn-0001", "Still there?");
    expect(Date.now() - started).toBeGreaterThanOrEqual(240);
    expect(posted).toMatchObject({ provider_id: null, reason: "no_connection" });
    expect(posted.turn.question).toBe("Still there?");
    expect((await read(server, thread_id)).running).toBeNull();

    const again = await ask(server, thread_id, "turn-0001", "Still there?");
    expect(again.provider_id).toBeNull();
    expect(await turnsOf(server, thread_id)).toHaveLength(1);
  });

  test("the default wait is five seconds, whatever the host does", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-ask-live-")));
    roots.push(root);
    const server = await startInboxServer({ dataDir: join(root, "data"), askAi: true, binaryPath: null });
    servers.push(server);
    const client = new Client({ name: "inbox-ask-live-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
    clients.push(client);
    const { thread_id } = await agentSends(client, root, "session-a", "Ship it?");
    await fakeAgent(server, root, "session-a", { noClient: true });
    const started = Date.now();
    expect((await ask(server, thread_id, "turn-0001")).reason).toBe("no_connection");
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(4_900);
    expect(waited).toBeLessThan(6_500);
  }, 10_000);

  test("the agent disappears mid-answer: the words so far stay, marked, and the next question gets a new bridge", async () => {
    const { server, client, project } = await setup({ goneAfterMs: 300 });
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a", { clientPollMs: 20_000 });
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    await agent.event({ type: "delta", askId: agent.asks[0]!.askId, text: "So far" });
    await Bun.sleep(50);

    // Its long poll is open when it dies, and an open poll counts as alive: the Inbox's
    // rewrite of the request must carry the abort, or this waits out the 20 seconds.
    agent.dropClient();
    await answering.finished;
    expect(answering.messages.at(-1)?.code).toBe("session_gone");
    expect(await turnsOf(server, thread_id)).toMatchObject([{ answer: "So far", failure: "gone" }]);
    expect((await read(server, thread_id)).running).toBeNull();

    const again = await ask(server, thread_id, "turn-0002");
    expect(again.provider_id).toBeString();
    expect(agent.clientRuns()).toBe(2);
    const next = await query(server, again.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 2);
    await agent.answer(agent.asks[1]!.askId, ["Back."]);
    await next.finished;
    expect((await turnsOf(server, thread_id)).map((turn) => turn.answer)).toEqual(["So far", "Back."]);
  });

  test("gone with no words writes nothing: the turn reads as no answer arrived, and can be asked again", async () => {
    const { server, client, project } = await setup({ goneAfterMs: 300 });
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    agent.dropClient();
    await answering.finished;
    const [turn] = await turnsOf(server, thread_id);
    expect(turn!.answer).toBeUndefined();
    expect(turn!.failure).toBeUndefined();
    expect((await ask(server, thread_id, "turn-0001")).provider_id).toBeString();
  });

  test("taken over: the partial answer stays, with why", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    const askId = agent.asks[0]!.askId;
    await agent.event({ type: "delta", askId, text: "Half an" });
    await agent.event({ type: "error", askId, code: "taken_over", message: "You typed into this session." });
    await answering.finished;
    expect(answering.messages.at(-1)?.code).toBe("session_taken_over");
    expect(await turnsOf(server, thread_id)).toMatchObject([{ answer: "Half an", failure: "taken_over" }]);
    // A retry gets what is saved, and the agent is not asked again.
    expect((await ask(server, thread_id, "turn-0001")).provider_id).toBeNull();
  });
});

describe("the browser goes away", () => {
  test("a dropped stream stops nothing: the answer is saved, and the window finds it when it comes back", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    const askId = agent.asks[0]!.askId;
    await agent.event({ type: "delta", askId, text: "One " });
    await waitFor(() => answering.messages.length > 0);

    answering.drop();
    await Bun.sleep(100);
    expect(agent.cancels).toEqual([]);
    expect((await read(server, thread_id)).running).toBe("turn-0001");

    const stream = await fetch(`http://127.0.0.1:${server.port}/api/inbox/events?window=window-one`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    const reader = stream.body!.getReader();
    await reader.read();
    await agent.event({ type: "delta", askId, text: "two" });
    await agent.event({ type: "done", askId, answer: "One two" });
    await waitFor(async () => (await turnsOf(server, thread_id))[0]?.answer === "One two");
    const decoder = new TextDecoder();
    let frames = "";
    while (!frames.includes("event: ask")) frames += decoder.decode((await reader.read()).value);
    await reader.cancel();
    expect((await read(server, thread_id)).running).toBeNull();
  });

  test("a browser that drops before the first word stops nothing either", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    answering.drop();
    await Bun.sleep(100);
    await agent.answer(agent.asks[0]!.askId, ["Whole ", "answer."]);
    await waitFor(async () => (await turnsOf(server, thread_id))[0]?.answer === "Whole answer.");
    expect(agent.cancels).toEqual([]);
  });

  test("Stop stops the question in the session, and keeps the words so far", async () => {
    const { server, client, project } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    await agent.event({ type: "delta", askId: agent.asks[0]!.askId, text: "Enough" });
    await waitFor(() => answering.messages.length > 0);

    expect((await fromWindow(server, "/api/ai/abort", { sessionId: answering.sessionId })).status).toBe(200);
    await waitFor(() => agent.cancels.length === 1);
    await waitFor(async () => (await read(server, thread_id)).running === null);
    expect(await turnsOf(server, thread_id)).toMatchObject([{ answer: "Enough", stopped: true }]);
  });
});

describe("the conversation goes away", () => {
  test("End stops a running answer, and a late answer does not bring the file back", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    await agent.event({ type: "delta", askId: agent.asks[0]!.askId, text: "Half" });

    expect((await fromWindow(server, `/api/inbox/threads/${thread_id}/ask/end`, {})).status).toBe(200);
    await waitFor(() => agent.cancels.length === 1);
    await agent.event({ type: "done", askId: agent.asks[0]!.askId, answer: "Half and more" });
    await answering.finished;
    await Bun.sleep(50);
    expect(existsSync(join(inboxDir(dataDir), "ask", `${thread_id}.json`))).toBe(false);
    expect(await read(server, thread_id)).toMatchObject({ conversation: null, running: null });
  });

  test("deleting the thread stops a running answer too", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);

    expect((await fromWindow(server, `/api/inbox/threads/${thread_id}/delete`, {})).status).toBe(200);
    await waitFor(() => agent.cancels.length === 1);
    await agent.event({ type: "done", askId: agent.asks[0]!.askId, answer: "Too late" });
    await answering.finished;
    await Bun.sleep(50);
    expect(existsSync(join(inboxDir(dataDir), "ask", `${thread_id}.json`))).toBe(false);
  });

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an answer that ends during a read failure is written once the file reads again", async () => {
    const { server, client, project, dataDir } = await setup({ writeRetryMs: 50 });
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    const file = join(inboxDir(dataDir), "ask", `${thread_id}.json`);

    chmodSync(file, 0o000);
    await agent.answer(agent.asks[0]!.askId, ["Kept."]);
    await answering.finished;
    await Bun.sleep(120);
    chmodSync(file, 0o600);
    await waitFor(async () => (await turnsOf(server, thread_id))[0]?.answer === "Kept.");
  });
});

describe("the bridge's life", () => {
  test("a client idle past the limit hears `closing`, and the next question brings it back", async () => {
    const { server, client, project } = await setup({ idleMs: 150 });
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    await agent.answer(agent.asks[0]!.askId, ["Done."]);
    await answering.finished;

    await waitFor(() => agent.clientEnd() === "closing");
    const again = await ask(server, thread_id, "turn-0002");
    expect(again.provider_id).toBeString();
    expect(agent.clientRuns()).toBe(2);
  });

  test("the Inbox stopping saves the words so far", async () => {
    const { server, client, project, dataDir } = await setup();
    const { thread_id } = await agentSends(client, project, "session-a", "Ship it?");
    const agent = await fakeAgent(server, project, "session-a");
    const posted = await ask(server, thread_id, "turn-0001");
    const answering = await query(server, posted.provider_id!, thread_id);
    await waitFor(() => agent.asks.length === 1);
    await agent.event({ type: "delta", askId: agent.asks[0]!.askId, text: "Partly" });
    await waitFor(() => answering.messages.length > 0);

    server.stop();
    servers.length = 0;
    const again = await startInboxServer({ dataDir, askAi: true, binaryPath: null });
    servers.push(again);
    expect(await turnsOf(again, thread_id)).toMatchObject([{ answer: "Partly", failure: "gone" }]);
    expect((await read(again, thread_id)).running).toBeNull();
  });
});

describe("the gates", () => {
  test("/api/ai answers only the owner's window, and the agent's routes only its token on this machine", async () => {
    const { server, client, project } = await setup();
    await agentSends(client, project, "session-a", "Ship it?");
    const base = `http://127.0.0.1:${server.port}`;
    for (const response of [
      await fetch(`${base}/api/ai/capabilities`),
      await fetch(`${base}/api/ai/sessions`),
      await fetch(`${base}/api/ai/session`, { method: "POST", body: JSON.stringify({ context: { mode: "annotate" } }) }),
      await fetch(`${base}/api/ai/query`, { method: "POST", body: JSON.stringify({ sessionId: "x", prompt: "y" }) }),
      await fetch(`${base}/api/ai/capabilities`, { headers: { "Sec-Fetch-Site": "cross-site" } }),
    ]) {
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("window_only");
    }

    const route = `${base}${inboxAskBridgeBase("session-a")}${SESSION_BRIDGE_POLL_PATH}`;
    expect((await fetch(route, { method: "POST", body: "{}" })).status).toBe(401);
    expect((await fetch(route, { method: "POST", headers: { Authorization: "Bearer wrong" }, body: "{}" })).status).toBe(401);
    expect((await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${server.token}`, Origin: base }, body: "{}" })).status).toBe(403);
    // The right token, and no question asked for this session: the client stops.
    const none = await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${server.token}` }, body: "{}" });
    expect(none.status).toBe(404);
    expect(((await none.json()) as { code: string }).code).toBe("ask_no_bridge");
    // /api/ai/bridge is the review servers': the Inbox's has its own path.
    expect((await fromWindow(server, "/api/ai/bridge/poll", {})).status).toBe(404);
  });
});
