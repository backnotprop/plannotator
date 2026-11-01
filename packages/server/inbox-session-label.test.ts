/**
 * Session labels (approval "inbox-session-label", issue #2450): a poll's
 * optional `label` is the only way a session's name in the To picker changes.
 * The failures this catches: a raw title reaching the window (control or bidi
 * characters, past the cap), a stale label after a title cleared or a session
 * ended, an older connection refused or given someone else's label, and,
 * above all, a door the MODEL can reach: the label is the host's, so no MCP
 * tool and no message route may set it, whatever arguments they are handed.
 *
 * A real Inbox under a temp data dir; the connections are plain HTTP with the
 * registry's token and the MCP client, never a real agent.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { InboxComposeProject, InboxComposeSession } from "@plannotator/core/inbox-types";
import { InboxAgentConnection, InboxWake, type InboxWakeTarget } from "@plannotator/shared/inbox/agent-link";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, inboxToolCall, type InboxToolInfo } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";
import { startInboxServer, type InboxServer } from "./inbox";
import { cleanInboxSessionLabel, createInboxLiveSessions, INBOX_SESSION_LABEL_MAX } from "./inbox-sessions";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-label-")));
  roots.push(root);
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const client = new Client({ name: "inbox-label-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project, dataDir };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

function bridge(server: InboxServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${base(server)}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify(body),
  });
}

/** One poll from a connection: `fields` is what it says about itself; no `label` key is an older connection. */
async function poll(server: InboxServer, session: string, project: string, fields: Record<string, unknown> = {}) {
  const response = await bridge(server, INBOX_BRIDGE_POLL_PATH, { session, host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false, ...fields });
  expect(response.status).toBe(200);
}

async function listed(server: InboxServer, session: string): Promise<InboxComposeSession | undefined> {
  const { projects } = (await (await fetch(`${base(server)}/api/inbox/sessions`)).json()) as { projects: InboxComposeProject[] };
  return projects.flatMap((group) => group.sessions).find((entry) => entry.session === session);
}

describe("cleanInboxSessionLabel", () => {
  test.each([
    ["trimmed", "  Fix login redirect\n ", "Fix login redirect"],
    ["control characters stripped", "Fix\u0000 login\u0007\u001b[31m", "Fix login[31m"],
    ["C1 controls stripped", "Fix\u0085\u009b login", "Fix login"],
    ["bidi overrides and isolates stripped", "‮gnp.exe‬ ⁦safe⁩‏", "gnp.exe safe"],
    ["line separators stripped", "one two three", "onetwothree"],
    ["a joined emoji stays whole", "Ship \u{1F468}‍\u{1F469}‍\u{1F467}", "Ship \u{1F468}‍\u{1F469}‍\u{1F467}"],
    ["markup stays text", "<b>bold</b>", "<b>bold</b>"],
  ])("%s", (_name, given, want) => {
    expect(cleanInboxSessionLabel(given)).toBe(want);
  });

  test.each([
    ["empty", ""],
    ["only spaces", "   "],
    ["only controls", "\u0000\u0007\n"],
    ["only bidi controls", "‮⁦"],
    ["only invisible characters", "​‍﻿"],
    ["not a string", 42],
    ["null", null],
    ["an object", { title: "x" }],
    ["absent", undefined],
  ])("%s is no label", (_name, given) => {
    expect(cleanInboxSessionLabel(given)).toBeNull();
  });

  test("capped at 60 characters, counted as characters and not UTF-16 units", () => {
    expect(INBOX_SESSION_LABEL_MAX).toBe(60);
    expect(cleanInboxSessionLabel("a".repeat(60))).toBe("a".repeat(60));
    expect(cleanInboxSessionLabel("a".repeat(61))).toBe("a".repeat(60));
    expect(cleanInboxSessionLabel("圆".repeat(200))).toBe("圆".repeat(60));
    // 61 emoji are 122 UTF-16 units: a cut by units would leave half a pair, or 30 of them.
    const cut = cleanInboxSessionLabel("\u{1F600}".repeat(61))!;
    expect(Array.from(cut)).toHaveLength(60);
    expect(cut.isWellFormed()).toBe(true);
  });

  test("the cap counts what is left after cleaning, and a cut never ends on a space", () => {
    expect(cleanInboxSessionLabel(`${"‮".repeat(30)}${"a".repeat(60)}`)).toBe("a".repeat(60));
    expect(cleanInboxSessionLabel(`${"a".repeat(59)} tail`)).toBe("a".repeat(59));
  });
});

describe("a poll's label", () => {
  test("is kept on the live session, cleaned and capped, and a later poll replaces it", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-a", project, { label: "  ‮Fix login redirect\u0007  " });
    expect((await listed(server, "ses-a"))?.label).toBe("Fix login redirect");

    await poll(server, "ses-a", project, { label: "Migrate auth tokens" });
    expect((await listed(server, "ses-a"))?.label).toBe("Migrate auth tokens");

    await poll(server, "ses-a", project, { label: "x".repeat(500) });
    expect((await listed(server, "ses-a"))?.label).toBe("x".repeat(60));
  });

  test("empty clears it, and a label of nothing visible does too", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-a", project, { label: "Release notes" });
    await poll(server, "ses-a", project, { label: "" });
    const entry = await listed(server, "ses-a");
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty("label");

    await poll(server, "ses-a", project, { label: "Release notes" });
    await poll(server, "ses-a", project, { label: "​ ‮" });
    expect(await listed(server, "ses-a")).not.toHaveProperty("label");
  });

  test("one session's label is its own", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-a", project, { label: "Alpha" });
    await poll(server, "ses-b", project, { label: "Beta" });
    await poll(server, "ses-c", project);
    expect((await listed(server, "ses-a"))?.label).toBe("Alpha");
    expect((await listed(server, "ses-b"))?.label).toBe("Beta");
    expect(await listed(server, "ses-c")).not.toHaveProperty("label");
  });

  test("an older connection, which sends none, is listed as before with no label field", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-old", project);
    const entry = await listed(server, "ses-old");
    expect(entry).toMatchObject({ session: "ses-old", host: "claude-code", busy: false, last_thread: null });
    expect(entry).not.toHaveProperty("label");
  });

  test("a label that is not a string does not refuse the poll: the session stays reachable", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-odd", project, { label: { title: "x" } });
    const entry = await listed(server, "ses-odd");
    expect(entry?.session).toBe("ses-odd");
    expect(entry).not.toHaveProperty("label");
  });

  test("routing takes no notice of it: a Send names the session, never the label", async () => {
    const { server, project } = await setup();
    await poll(server, "ses-a", project, { label: "ses-b" });
    await poll(server, "ses-b", project, { label: "ses-a" });
    const sent = await fetch(`${base(server)}/api/inbox/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, to: { host: "claude-code", session: "ses-a" }, body: "For the session named ses-a.", idempotency_key: "k1" }),
    });
    expect(sent.status).toBe(200);
    const { message } = (await sent.json()) as { message: { to: { session: string } } };
    expect(message.to.session).toBe("ses-a");
  });
});

describe("a session that ended", () => {
  const live = (root: string, now: () => number) =>
    createInboxLiveSessions({ store: InboxStore.open(join(root, "data")), serverSession: "srv", resolveRoot: async (path) => path, now });

  test("is gone from the list with its label, and coming back does not bring an old label back", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-label-end-")));
    roots.push(root);
    let t = 1_000_000;
    const sessions = live(root, () => t);
    const answered = await sessions.pollStarted("ses-a", "claude-code", { project_path: root, label: "Fix login redirect" });
    answered();
    expect(sessions.allLive().map((entry) => entry.label)).toEqual(["Fix login redirect"]);

    t += 31_000; // Past INBOX_SESSION_LIVE_MS.
    expect(sessions.allLive()).toEqual([]);

    // The same id again, from a connection that sends no label (a downgrade, an older process on the session).
    (await sessions.pollStarted("ses-a", "claude-code", { project_path: root }))();
    expect(sessions.allLive().map((entry) => entry.label)).toEqual([null]);
  });
});

/** Every property name anywhere in a JSON Schema. */
function schemaFields(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  if (Array.isArray(schema)) return schema.flatMap(schemaFields);
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (key === "properties" && value && typeof value === "object") out.push(...Object.keys(value));
    out.push(...schemaFields(value));
  }
  return out;
}

describe("the model cannot set the label", () => {
  test("no tool the Inbox offers, nor the list bundled with the mod, has such a field at any depth", async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(3);
    for (const tool of [...tools, ...INBOX_DEFAULT_TOOLS]) {
      const fields = schemaFields(tool.inputSchema);
      expect(fields.filter((field) => /label|title/i.test(field)), tool.name).toEqual([]);
    }
  });

  test("the agent tool refuses a `label` before anything reaches the Inbox", async () => {
    const { client } = await setup();
    const tools = (await client.listTools()).tools as unknown as InboxToolInfo[];
    const call = inboxToolCall({ action: "send_message", body: "Done.", label: "Chosen by the model" }, tools, {
      project_path: "/tmp/p",
      agent_session: "ses-a",
      agent_host: "pi",
      agent_name: "Pi",
    });
    expect(call).toEqual({ error: expect.stringContaining('takes no "label"') });
  });

  test("every tool, a message and every window route, handed a label, change nothing on the session", async () => {
    const { server, client, project } = await setup();
    await poll(server, "ses-a", project, { label: "Set by the host" });
    const carried = { label: "Chosen by the model", session_title: "Chosen by the model", title: "Chosen by the model" };
    const tool = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: { ...args, ...carried } }).catch(() => null);

    const sent = await tool("send_message", { body: "Done.", project_path: project, agent_session: "ses-a", agent_host: "claude-code" });
    // Whether a tool refuses the extra field or ignores it, the session's label stands; call every tool there is.
    for (const { name } of (await client.listTools()).tools) {
      await tool(name, { project_path: project, agent_session: "ses-a", agent_host: "claude-code", agent_name: "Chosen by the model" });
    }
    await bridge(server, INBOX_BRIDGE_EVENT_PATH, { session: "ses-a", host: "claude-code", type: "state", busy: true, idle_since: null, ...carried });
    await fetch(`${base(server)}/api/inbox/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, to: { host: "claude-code", session: "ses-a" }, body: "From the person.", idempotency_key: "k2", ...carried }),
    });
    expect((await listed(server, "ses-a"))?.label).toBe("Set by the host");

    // Nor does a session that never polled a label get one by writing.
    const other = await tool("send_message", { body: "Hello.", project_path: project, agent_session: "ses-mcp", agent_host: "codex" });
    expect(other).not.toBeNull();
    expect(await listed(server, "ses-mcp")).toBeUndefined();
    expect(sent).not.toBeNull();
  });

  test("nothing stores it: the message the model sent carries no label", async () => {
    const { server, client, project, dataDir } = await setup();
    await poll(server, "ses-a", project, { label: "Set by the host" });
    await client.callTool({ name: "send_message", arguments: { body: "Done.", project_path: project, agent_session: "ses-a", agent_host: "claude-code" } });
    server.stop();
    servers.splice(0);
    const store = InboxStore.open(dataDir);
    const [row] = store.threadsOf(store.projectByRoot(project)!.id);
    const message = store.thread(row!.thread_id)!.messages[0]!;
    expect(JSON.stringify(message)).not.toContain("Set by the host");
  });
});

describe("the shared wake (Pi, OpenCode 2)", () => {
  /** A wake whose polls are recorded; `pendingNow` is what each tick's poll and the check before delivery both call. */
  function wakeOver(dataDir: string, target: Partial<InboxWakeTarget>) {
    const bodies: Record<string, unknown>[] = [];
    class Recorded extends InboxAgentConnection {
      override bridge(path: string, session: string, body: Record<string, unknown>, signal?: AbortSignal) {
        if (path === INBOX_BRIDGE_POLL_PATH) bodies.push(body);
        return super.bridge(path, session, body, signal);
      }
    }
    const wake = new InboxWake(new Recorded({ dataDir, host: "pi", agentName: "Pi", tools: [] }), "ses-pi", { isBusy: () => false, deliver: async () => {}, notify: () => {}, ...target });
    return { bodies, poll: () => (wake as unknown as { pendingNow(waitMs: number): Promise<unknown> }).pendingNow(0) };
  }

  test('every poll asks the host again: a new title replaces the old, and "" clears it', async () => {
    const { server, project, dataDir } = await setup();
    let title = "First name";
    const { poll: pollNow, bodies } = wakeOver(dataDir, { projectPath: () => project, label: () => title });

    await pollNow();
    expect((await listed(server, "ses-pi"))?.label).toBe("First name");
    title = "Second name";
    await pollNow();
    expect((await listed(server, "ses-pi"))?.label).toBe("Second name");
    title = "";
    await pollNow();
    expect(await listed(server, "ses-pi")).not.toHaveProperty("label");
    expect(bodies.map((body) => body.label)).toEqual(["First name", "Second name", ""]);
  });

  // None and unknown differ here, because the server cannot tell them apart: a host that fails to
  // read its title for one poll must not blank a named row for up to 20 s.
  test.each([
    ["throws", (): string => { throw new Error("the session is gone"); }],
    ["rejects", (): Promise<string> => Promise.reject(new Error("the session is gone"))],
    ["answers null", (): null => null],
    ["answers undefined", (): undefined => undefined],
  ] as const)("a host that %s cannot tell, so the label stands and the session stays reachable", async (_how, cannotTell) => {
    const { server, project, dataDir } = await setup();
    let read: () => string | null | undefined | Promise<string> = () => "Named";
    const { poll: pollNow, bodies } = wakeOver(dataDir, { projectPath: () => project, label: () => read() });
    await pollNow();
    read = cannotTell;
    await pollNow();
    await pollNow();
    expect((await listed(server, "ses-pi"))?.label).toBe("Named");
    expect(bodies.map((body) => body.label)).toEqual(["Named", "Named", "Named"]);
    // And it can still clear once it can tell again.
    read = () => "";
    await pollNow();
    expect(await listed(server, "ses-pi")).not.toHaveProperty("label");
  });

  test("a host that never could tell sends empty, not a name it never had", async () => {
    const { server, project, dataDir } = await setup();
    const { poll: pollNow, bodies } = wakeOver(dataDir, { projectPath: () => project, label: () => null });
    await pollNow();
    expect(bodies[0]?.label).toBe("");
    const entry = await listed(server, "ses-pi");
    expect(entry?.session).toBe("ses-pi");
    expect(entry).not.toHaveProperty("label");
  });

  test("a host with no title to give (Codex's connection has none) sends no field at all", async () => {
    const { project, dataDir } = await setup();
    const { poll: pollNow, bodies } = wakeOver(dataDir, { projectPath: () => project });
    await pollNow();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("label");
  });
});
