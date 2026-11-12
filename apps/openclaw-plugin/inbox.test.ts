import "../../tests/setup/sandbox-data-dir";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxThread } from "../../packages/core/inbox-types";
import { parseInboxSessionRef } from "../../packages/core/inbox-tidy";
import { startInboxServer, type InboxServer } from "../../packages/server/inbox";
import { FakeOpenClaw } from "./fixtures/fake-openclaw";
import { registerPlannotator } from "./plugin";
import type { OpenClawInbox } from "./inbox";
import { inboxSessionOf, type OpenClawToolContext } from "./openclaw";

const roots: string[] = [];
const servers: InboxServer[] = [];
const hosts: FakeOpenClaw[] = [];

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stopServices();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const TICK = 40;
const ON = { PLANNOTATOR_INBOX_TOOL: "1" } as NodeJS.ProcessEnv;
const OWNER_DM = "agent:main:telegram:direct:4242";
const OWNER_ROUTE = { channel: "telegram", to: "4242" };

async function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-openclaw-inbox-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  mkdirSync(workspace, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return { workspace, dataDir, server };
}

async function gateway(w: Awaited<ReturnType<typeof world>>): Promise<{ host: FakeOpenClaw; inbox: OpenClawInbox }> {
  const host = new FakeOpenClaw();
  const inbox = registerPlannotator(host, { env: ON, dataDir: w.dataDir, tickMs: TICK, version: "9.9.9" });
  hosts.push(host);
  await host.startServices();
  return { host, inbox };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

async function reply(server: InboxServer, messageId: string, words: string): Promise<{ id: string }> {
  const response = await fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${messageId}-${words}`, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string } }).reply;
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function liveSessions(server: InboxServer): Promise<string[]> {
  const projects = ((await (await fetch(`${base(server)}/api/inbox/sessions`)).json()) as { projects: { sessions: { session: string; host: string }[] }[] }).projects;
  return projects.flatMap((group) => group.sessions.filter((s) => s.host === "openclaw").map((s) => s.session));
}

async function until(check: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (await check()) return true;
    await Bun.sleep(25);
  }
  return check();
}

function idsOf(text: string): { message_id: string; thread_id: string } {
  const message_id = /"message_id":"([^"]+)"/.exec(text)?.[1];
  const thread_id = /"thread_id":"([^"]+)"/.exec(text)?.[1];
  if (!message_id || !thread_id) throw new Error(`no ids in the send result: ${text}`);
  return { message_id, thread_id };
}

async function send(host: FakeOpenClaw, ctx: OpenClawToolContext, body: string) {
  const tool = host.toolsFor(ctx).find((t) => t.name === "plannotator_inbox");
  if (!tool) throw new Error("plannotator_inbox was not offered");
  const result = await tool.execute("call-1", { action: "send_message", body });
  return idsOf(result.content[0]!.text);
}

describe("OpenClaw: who gets the Inbox tool", () => {
  test("only the owner's own sessions: local and the owner's direct messages, never a group, a stranger, a cron run or a fork", async () => {
    const w = await world();
    const { host } = await gateway(w);
    const owner = { agentId: "main", senderIsOwner: true, workspaceDir: w.workspace } as const;
    const offered = (ctx: OpenClawToolContext) => host.toolsFor(ctx).map((tool) => tool.name);

    expect(offered({ ...owner, sessionKey: "agent:main:main" })).toEqual(["plannotator_inbox"]);
    expect(offered({ ...owner, sessionKey: OWNER_DM, deliveryContext: OWNER_ROUTE })).toEqual(["plannotator_inbox"]);

    const refused: OpenClawToolContext[] = [
      { agentId: "main", sessionKey: "agent:main:telegram:group:-100123", senderIsOwner: false, requesterSenderId: "999" },
      { agentId: "main", sessionKey: "agent:main:telegram:group:-100123", senderIsOwner: true },
      { agentId: "main", sessionKey: "agent:main:discord:channel:778899", senderIsOwner: true },
      { agentId: "main", sessionKey: "agent:main:discord:guild-1:channel-2", senderIsOwner: true },
      { agentId: "main", sessionKey: "agent:main:whatsapp:120363@g.us", senderIsOwner: true },
      { agentId: "main", sessionKey: "agent:main:telegram:direct:999", senderIsOwner: false, requesterSenderId: "999" },
      { agentId: "main", sessionKey: "agent:main:main", senderIsOwner: false, inputProvenance: { kind: "external_user" } },
      { agentId: "main", sessionKey: "agent:main:main" },
      { agentId: "main", sessionKey: "agent:main:cron:nightly", senderIsOwner: true },
      { agentId: "main", sessionKey: "agent:main:subagent:abc", senderIsOwner: true },
      { agentId: "main", sessionKey: "agent:main:main", senderIsOwner: true, backgroundRun: { sourceSessionKey: "agent:main:main" } },
      { agentId: "main", sessionKey: "agent:main:telegram:direct:555", inputProvenance: { kind: "internal_system", sourceTool: "plugin" } },
    ];
    for (const ctx of refused) expect({ sessionKey: ctx.sessionKey, tools: offered(ctx) }).toEqual({ sessionKey: ctx.sessionKey, tools: [] });

    expect(offered({ agentId: "main", sessionKey: OWNER_DM, inputProvenance: { kind: "internal_system", sourceTool: "plugin" } })).toEqual(["plannotator_inbox"]);

    const listed = [inboxSessionOf({ agentId: "main", sessionKey: "agent:main:main" }), inboxSessionOf({ agentId: "main", sessionKey: OWNER_DM })].sort();
    expect(await until(async () => (await liveSessions(w.server)).sort().join() === listed.join())).toBe(true);
    await Bun.sleep(TICK * 6);
    expect((await liveSessions(w.server)).sort()).toEqual(listed);
  });

  test("an OpenClaw session key becomes a session a command line can name", () => {
    const plain = inboxSessionOf({ agentId: "main", sessionKey: OWNER_DM });
    expect(plain).toBe("agent.main.telegram.direct.4242");
    const odd = inboxSessionOf({ agentId: "main", sessionKey: "agent:main:email:direct:me@example.com" });
    expect(odd).toMatch(/^openclaw-[0-9a-f]{32}$/);
    for (const id of [plain, odd]) expect(parseInboxSessionRef(`openclaw:${id}`)).toEqual({ host: "openclaw", session: id });
  });
});

describe("OpenClaw: the person's reply comes back into the same chat", () => {
  test("a reply waits for the running turn, then starts one turn in that session on the owner's route, once", async () => {
    const w = await world();
    const { host } = await gateway(w);
    const ctx = { agentId: "main", sessionKey: OWNER_DM, senderIsOwner: true, workspaceDir: w.workspace, deliveryContext: OWNER_ROUTE };
    const session = inboxSessionOf(ctx);
    const run = host.run(OWNER_DM, true);
    const sent = await send(host, ctx, "Drafted the release notes. Ship today?");
    const asked = (await thread(w.server, sent.thread_id)).messages[0]!;
    expect(asked.author).toMatchObject({ kind: "agent", host: "openclaw", session, name: "OpenClaw" });
    expect(asked.wakes).toBe(true);

    const answer = await reply(w.server, sent.message_id, "Yes, ship it.");
    await Bun.sleep(TICK * 10);
    expect(host.turns).toEqual([]);
    host.run(OWNER_DM, false, run);
    expect(await until(() => host.turns.length > 0)).toBe(true);
    expect(host.turns[0]).toMatchObject({ agentId: "main", sessionKey: OWNER_DM, route: OWNER_ROUTE });
    expect(host.turns[0]!.text).toStartWith("Plannotator Inbox: ");
    expect(host.turns[0]!.text).toContain("Yes, ship it.");
    expect(
      await until(async () => (await thread(w.server, sent.thread_id)).messages.find((m) => m.id === answer.id)?.delivery?.session === session),
    ).toBe(true);
    await Bun.sleep(TICK * 10);
    expect(host.turns).toHaveLength(1);
  });

  test("after the Gateway restarts, the owner's session is still reached: a new reply wakes it once and nothing is sent twice", async () => {
    const w = await world();
    const first = await gateway(w);
    const ctx = { agentId: "main", sessionKey: "agent:main:main", senderIsOwner: true, workspaceDir: w.workspace };
    const sent = await send(first.host, ctx, "Migration plan is in the thread.");
    await reply(w.server, sent.message_id, "Looks right.");
    expect(await until(() => first.host.turns.length === 1)).toBe(true);
    await first.host.stopServices();

    const second = await gateway(w);
    second.host.openSession("main", "agent:main:main");
    await Bun.sleep(TICK * 10);
    expect(second.host.turns).toEqual([]);
    await reply(w.server, sent.message_id, "One more: keep the old column for a week.");
    expect(await until(() => second.host.turns.length === 1)).toBe(true);
    expect(second.host.turns[0]!.text).toContain("keep the old column");
    await Bun.sleep(TICK * 10);
    expect(second.host.turns).toHaveLength(1);
    expect(first.host.turns).toHaveLength(1);
  });
});
