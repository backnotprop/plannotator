import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxDraft, InboxMessage, InboxReplyDraft } from "@plannotator/core/inbox-types";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const stops: (() => void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function world(existing?: { root: string }) {
  const root = existing?.root ?? realpathSync(mkdtempSync(join(tmpdir(), "plannotator-take-back-")));
  if (!existing) roots.push(root);
  const project = join(root, "api");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, binaryPath: null });
  servers.push(server);
  const client = new Client({ name: "take-back", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  const base = `http://127.0.0.1:${server.port}/api/inbox`;
  const post = (path: string, body: Record<string, unknown>) =>
    fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const ask = async (session: string, body: string) =>
    (
      await client.callTool({
        name: "send_message",
        arguments: { body, project_path: project, agent_session: session, agent_host: "pi", agent_name: "Pi" },
        _meta: { [INBOX_WAKES_META_KEY]: true },
      })
    ).structuredContent as { message_id: string; thread_id: string };
  const reply = async (messageId: string, key: string, words: string, uploads: string[] = []) =>
    ((await (await post(`messages/${messageId}/reply`, { idempotency_key: key, words, uploads })).json()) as { reply: InboxMessage }).reply.id;
  const upload = async (name: string, text: string) =>
    ((await (await fetch(`${base}/uploads?name=${name}`, { method: "POST", body: text })).json()) as { upload: { upload_id: string } }).upload.upload_id;
  const takeBack = async (id: string) => {
    const response = await post(`messages/${id}/take-back`, {});
    const body = (await response.json()) as { message?: InboxMessage; draft?: InboxReplyDraft | null; compose?: InboxDraft | null; code?: string; by?: string };
    return { status: response.status, ...body };
  };
  const wake = (session: string, delivered: string[], probeMs = 0) => {
    const link = new InboxWake(
      new InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: [] }),
      session,
      {
        isBusy: async () => {
          if (probeMs > 0) await Bun.sleep(probeMs);
          return false;
        },
        deliver: async (_text, command) => {
          delivered.push(command.id);
          await Bun.sleep(40);
        },
        notify: () => {},
        projectPath: () => project,
      },
      5,
    );
    link.start();
    stops.push(() => link.dispose());
  };
  return { root, server, client, ask, reply, upload, takeBack, wake };
}

describe("take back", () => {
  test("puts the words above the box's draft with their files, and the agent never gets it; once it has one, it is refused", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", "Which runner?");
    w.server.store.saveReplyDraft(asked.thread_id, { body: "Also run it twice.", base: null });
    const file = await w.upload("plan.md", "# Plan");
    const id = await w.reply(asked.message_id, "k1", "Use the ARM runner.", [file]);
    const taken = await w.takeBack(id);
    expect(taken.status).toBe(200);
    expect(taken.draft?.body).toBe("Use the ARM runner.\n\nAlso run it twice.");
    expect(taken.draft?.files?.map((f) => f.name)).toEqual(["plan.md"]);
    const delivered: string[] = [];
    w.wake("ses-a", delivered);
    const next = await w.reply(asked.message_id, "k2", "Use the ARM runner, twice.");
    for (let i = 0; i < 200 && !delivered.includes(next); i++) await Bun.sleep(20);
    expect(delivered).toEqual([next]);
    for (let i = 0; i < 100 && !w.server.store.message(next)?.delivery; i++) await Bun.sleep(20);
    const late = await w.takeBack(next);
    expect(late).toMatchObject({ status: 409, code: "agent_has_it" });
    expect(w.server.store.message(next)?.taken_back_at ?? null).toBeNull();
  }, 30_000);

  test("a thread the person started with only that message comes back as a New message", async () => {
    const w = await world();
    await w.ask("ses-a", "Ready.");
    const project = w.server.store.listProjects()[0]!;
    const started = w.server.store.startPersonThread({ project_id: project.id, body: "Rename the ledger.", to: { host: "pi", session: "ses-a" }, idempotency_key: "k1" }).message;
    const taken = await w.takeBack(started.id);
    expect(taken.status).toBe(200);
    expect(taken.compose).toMatchObject({ body: "Rename the ledger.", to: { host: "pi", session: "ses-a" } });
  }, 30_000);

  test("another agent's read of the thread before the wake hands it over", async () => {
    const w = await world();
    const asked = await w.ask("ses-a", "Which runner?");
    const id = await w.reply(asked.message_id, "k1", "Use the ARM runner.");
    await w.client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-b" } });
    expect(await w.takeBack(id)).toMatchObject({ status: 409, code: "agent_has_it", by: "read" });
  }, 30_000);

  test("an agent's read still refuses a take-back after the Inbox restarts", async () => {
    const first = await world();
    const asked = await first.ask("ses-a", "Which runner?");
    const id = await first.reply(asked.message_id, "k1", "Use the ARM runner.");
    await first.client.callTool({ name: "read_thread", arguments: { thread_id: asked.thread_id, agent_session: "ses-b" } });
    await first.client.close();
    first.server.stop();
    const again = await world({ root: first.root });
    expect(await again.takeBack(id)).toMatchObject({ status: 409, code: "agent_has_it", by: "read" });
  }, 30_000);

  test("racing the shared connection's claim, a reply is never both taken back and delivered", async () => {
    const w = await world();
    const delivered: string[] = [];
    w.wake("ses-race", delivered, 30);
    const asked = await w.ask("ses-race", "Which runner?");
    let takenBack = 0;
    let both = 0;
    for (let i = 0; i < 30; i++) {
      const id = await w.reply(asked.message_id, `k${i}`, `Round ${i}: ARM.`);
      await Bun.sleep(Math.random() * 160);
      const taken = await w.takeBack(id);
      if (taken.status === 200) takenBack++;
      else for (let t = 0; t < 75 && !w.server.store.message(id)?.delivery; t++) await Bun.sleep(20);
      await Bun.sleep(taken.status === 200 ? 200 : 0);
      if (taken.status === 200 && delivered.includes(id)) both++;
    }
    expect(both).toBe(0);
    expect(takenBack).toBeGreaterThan(0);
    expect(takenBack).toBeLessThan(30);
  }, 120_000);
});
