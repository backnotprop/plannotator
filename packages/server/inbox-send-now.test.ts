import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxListRow, InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_EVENT_PATH,
  INBOX_BRIDGE_POLL_PATH,
  INBOX_SEND_NOW_POLL_FIELD,
  INBOX_WAKES_META_KEY,
  inboxSentNowFollowUpText,
  parseInboxBridgeCommands,
} from "@plannotator/shared/inbox/connection";
import { InboxAgentConnection, InboxWake, type InboxWakeTarget } from "@plannotator/shared/inbox/agent-link";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-send-now-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const client = new Client({ name: "inbox-send-now-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function agentSends(client: Client, project: string, session: string, body: string, options: { wakes?: boolean; host?: string } = {}) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: options.host ?? "claude-code" },
    ...(options.wakes === false ? {} : { _meta: { [INBOX_WAKES_META_KEY]: true } }),
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

async function poll(server: InboxServer, session: string, project: string, extra: Record<string, unknown> = {}) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host: "claude-code", project_path: project, waitMs: 0, ...extra });
  expect(response.status).toBe(200);
  return parseInboxBridgeCommands(await response.text());
}

async function reply(server: InboxServer, messageId: string, words: string) {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${messageId}`, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string; body: string } }).reply;
}

function sendNow(server: InboxServer, messageId: string, init: { body?: Record<string, unknown>; headers?: Record<string, string> } = {}) {
  return fetch(`${base(server)}/api/inbox/messages/${messageId}/send-now`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: JSON.stringify(init.body ?? { serverSession: server.serverSession }),
  });
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function asker(server: InboxServer, threadId: string, session: string) {
  const body = (await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/sessions?asker=${session}`)).json()) as {
    asker: { session: string; live: boolean; connection: { busy: boolean | null; idle_since: string | null; send_now: boolean } | null };
    sessions: { session: string; send_now: boolean }[];
  };
  return body;
}

async function row(server: InboxServer, threadId: string): Promise<InboxListRow> {
  const model = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: InboxListRow[] }[] };
  return model.sections.flatMap((section) => section.threads).find((r) => r.thread_id === threadId)!;
}

describe("Send now through the server", () => {
  test("a reply to a busy waking session reads as queued with Send now offered; Send now marks it, the poll hands it with `now`, once", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-a", "Shipped the migration. Anything else?");
    await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    const sent = await reply(server, asked.message_id, "Yes: also bump the version.");

    expect((await row(server, asked.thread_id)).sent).toMatchObject({ wakes: true, checked_at: null });
    const known = await asker(server, asked.thread_id, "ses-a");
    expect(known.asker).toMatchObject({ session: "ses-a", live: true, connection: { busy: true, send_now: true } });
    expect(known.sessions.find((s) => s.session === "ses-a")?.send_now).toBe(true);

    const before = await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    expect(before).toHaveLength(1);
    expect(before[0]!.now).toBeUndefined();

    const pressed = await sendNow(server, sent.id);
    expect(pressed.status).toBe(200);
    const marked = ((await pressed.json()) as { message: { deliver_now_at: string } }).message;
    expect(typeof marked.deliver_now_at).toBe("string");
    expect((await thread(server, asked.thread_id)).messages.at(-1)).toMatchObject({ id: sent.id, deliver_now_at: marked.deliver_now_at });

    const again = (await (await sendNow(server, sent.id)).json()) as { message: { deliver_now_at: string } };
    expect(again.message.deliver_now_at).toBe(marked.deliver_now_at);

    const after = await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: sent.id, now: true });

    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "delivered", id: sent.id })).status).toBe(200);
    expect(await poll(server, "ses-a", project)).toEqual([]);
    const late = await sendNow(server, sent.id);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { code: string }).code).toBe("already_delivered");
  });

  test("`now` goes only to a connection that said it can; one that cannot take it mid-turn says so and the mark goes (the line reads queued again)", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-a", "Done.");
    await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    const sent = await reply(server, asked.message_id, "Next.");
    expect((await sendNow(server, sent.id)).status).toBe(200);
    const plain = await poll(server, "ses-a", project, { busy: true });
    expect(plain[0]!.now).toBeUndefined();
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-other", host: "claude-code", type: "send_now_failed", id: sent.id })).status).toBe(422);
    expect((await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "send_now_failed", id: sent.id })).status).toBe(200);
    expect((await thread(server, asked.thread_id)).messages.at(-1)!.deliver_now_at).toBeNull();
    const after = await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    expect(after[0]!.now).toBeUndefined();
  });

  test("a held poll answers at once when the person presses Send now", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-a", "Done with the export.");
    await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    const sent = await reply(server, asked.message_id, "Thanks, now the docs.");
    expect((await sendNow(server, sent.id)).status).toBe(200);
    const started = Date.now();
    const commands = await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true, waitMs: 20_000 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(commands[0]).toMatchObject({ id: sent.id, now: true });
  });

  test("Send now is refused when the session's connection cannot take it mid-turn, or does not poll now; nothing is written", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-old", "Done.");
    await poll(server, "ses-old", project, { busy: true });
    const sent = await reply(server, asked.message_id, "Next, the tests.");
    expect((await asker(server, asked.thread_id, "ses-old")).asker.connection).toMatchObject({ busy: true, send_now: false });
    const refused = await sendNow(server, sent.id);
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code: string }).code).toBe("send_now_unavailable");
    expect((await thread(server, asked.thread_id)).messages.at(-1)!.deliver_now_at).toBeUndefined();

    const other = await agentSends(client, project, "ses-gone", "Also done.");
    const sentOther = await reply(server, other.message_id, "Good.");
    expect((await asker(server, other.thread_id, "ses-gone")).asker.connection).toBeNull();
    expect((await sendNow(server, sentOther.id)).status).toBe(409);
  });

  test("a reply to an agent that only reads the thread (no wake) is not queued for a turn: the row says so, and Send now has no session to reach", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-mcp", "From an MCP-only agent.", { wakes: false });
    const sent = await reply(server, asked.message_id, "Fine.");
    expect((await row(server, asked.thread_id)).sent).toMatchObject({ wakes: false });
    expect((await sendNow(server, sent.id)).status).toBe(409);
  });

  test("the guards: another site, a stale tab, a message that goes to no session", async () => {
    const { server, client, project } = await setup();
    const asked = await agentSends(client, project, "ses-a", "Done.");
    await poll(server, "ses-a", project, { busy: true, [INBOX_SEND_NOW_POLL_FIELD]: true });
    const sent = await reply(server, asked.message_id, "Next.");
    expect((await sendNow(server, sent.id, { headers: { Origin: "https://evil.example" } })).status).toBe(403);
    const stale = await sendNow(server, sent.id, { body: { serverSession: "not-this-one" } });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("session_mismatch");
    const notAddressed = await sendNow(server, asked.message_id);
    expect(notAddressed.status).toBe(422);
    expect(((await notAddressed.json()) as { code: string }).code).toBe("not_addressed");
    expect((await sendNow(server, "msg_nope")).status).toBe(404);
    expect((await thread(server, asked.thread_id)).messages.at(-1)!.deliver_now_at).toBeUndefined();
  });

  test("the follow-up text points at the reply by id", () => {
    expect(inboxSentNowFollowUpText({ id: "msg_1", subject: "Export  done", type: "reply" })).toBe(
      "Plannotator Inbox: Export done (msg_1)\nThe person's reply above (msg_1) arrived as your last turn was ending. If you have not answered it yet, answer it now.",
    );
  });
});

describe("the Pi and OpenCode wake (agent-link) with Send now", () => {
  async function wakeWorld(target: Partial<InboxWakeTarget> & Pick<InboxWakeTarget, "isBusy">) {
    const world = await setup();
    const asked = await agentSends(world.client, world.project, "ses-pi", "Built the release notes.", { host: "pi" });
    const connection = new InboxAgentConnection({ dataDir: world.dataDir, host: "pi", agentName: "Pi", tools: [] });
    const delivered: { how: "deliver" | "steer"; id: string; text: string }[] = [];
    const wake = new InboxWake(
      connection,
      "ses-pi",
      {
        deliver: async (text, command) => void delivered.push({ how: "deliver", id: command.id, text }),
        notify: () => {},
        projectPath: () => world.project,
        ...target,
      },
      50,
    );
    wake.start();
    for (let i = 0; i < 100 && (await asker(world.server, asked.thread_id, "ses-pi")).asker.connection === null; i++) await Bun.sleep(50);
    return { ...world, asked, wake, delivered };
  }

  async function deliveredTo(server: InboxServer, threadId: string, id: string) {
    for (let i = 0; i < 200; i++) {
      const delivery = (await thread(server, threadId)).messages.find((m) => m.id === id)?.delivery;
      if (delivery) return delivery;
      await Bun.sleep(25);
    }
    return null;
  }

  test("a busy session with steer says it can, waits without Send now, and steers once Send now is pressed; acknowledged once", async () => {
    const steered: string[] = [];
    const { server, asked, wake, delivered } = await wakeWorld({
      isBusy: () => true,
      steer: async (_text, command) => void steered.push(command.id),
    });
    try {
      expect((await asker(server, asked.thread_id, "ses-pi")).asker.connection).toMatchObject({ send_now: true });
      const sent = await reply(server, asked.message_id, "Ship them.");
      await Bun.sleep(400);
      expect(steered).toEqual([]);
      expect(delivered).toEqual([]);
      expect((await sendNow(server, sent.id)).status).toBe(200);
      for (let i = 0; i < 200 && steered.length === 0; i++) await Bun.sleep(25);
      expect(steered).toEqual([sent.id]);
      expect(delivered).toEqual([]);
      expect(await deliveredTo(server, asked.thread_id, sent.id)).toMatchObject({ host: "pi", session: "ses-pi" });
      await Bun.sleep(300);
      expect(steered).toEqual([sent.id]);
    } finally {
      wake.dispose();
    }
  });

  test("an idle session gets a Send now reply at once as a turn (no steer)", async () => {
    const steered: string[] = [];
    let busy = true;
    const { server, asked, wake, delivered } = await wakeWorld({
      isBusy: () => busy,
      steer: async (_text, command) => void steered.push(command.id),
    });
    try {
      const sent = await reply(server, asked.message_id, "Ship them.");
      await Bun.sleep(200);
      busy = false;
      expect((await sendNow(server, sent.id)).status).toBe(200);
      for (let i = 0; i < 200 && delivered.length === 0; i++) await Bun.sleep(25);
      expect(delivered.map((d) => d.id)).toEqual([sent.id]);
      expect(steered).toEqual([]);
    } finally {
      wake.dispose();
    }
  });

  test("a host without steer never says it can, and Send now is refused for its session", async () => {
    const { server, asked, wake } = await wakeWorld({ isBusy: () => true });
    try {
      expect((await asker(server, asked.thread_id, "ses-pi")).asker.connection).toMatchObject({ send_now: false });
      const sent = await reply(server, asked.message_id, "Ship them.");
      expect((await sendNow(server, sent.id)).status).toBe(409);
    } finally {
      wake.dispose();
    }
  });
});
