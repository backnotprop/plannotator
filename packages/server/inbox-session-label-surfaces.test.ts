/**
 * Session labels past the To picker (issue #2450, after #2467): the `@` picker's
 * taggable route, Send to another session's live sessions, and the list's
 * `session_labels` (the rows' agents and a message's author) carry the label a
 * session's own poll sent. The failures this catches: a route that drops it; an
 * unnamed session that reads any differently; a label that sticks after the
 * session cleared it, or vanishes from a finished thread the moment the session
 * ends; a label written into a message record, where every reader (an agent's
 * read_thread, a linked machine, an export) would carry it; a window never told
 * a label changed; and, above all, a tailnet guest who now sees what it never
 * saw, or an owner over the tailnet who is shut out.
 *
 * A real Inbox under a temp data dir; connections are plain HTTP with the
 * registry's token, agents the MCP client, the tailnet a scripted `tailscale`.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_BRIDGE_POLL_PATH, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "ramos@example.com";
const GUEST = "guest@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setEnv(name: string, value: string | undefined): void {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

/** `tailscale` as the owner's machine answers it: the owner's login, and `serve` kept in memory. */
function fakeTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") return ok(JSON.stringify({ Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER } } }));
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      return ok(
        JSON.stringify({
          TCP: Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }])),
          Web: Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }])),
        }),
      );
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n`);
  };
}

/** A real Inbox on the tailnet (a guest allowed), one project, and the MCP client agents write through. */
async function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-label-surfaces-")));
  roots.push(root);
  const project = join(root, "ai-collab");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  for (const name of ["PLANNOTATOR_INBOX_TAILSCALE", "PLANNOTATOR_URL_HOST"]) setEnv(name, undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxTailscaleAllow: [GUEST], updateCheck: false }));
  const server = await startInboxServer({ dataDir, binaryPath: null, tailscale: fakeTailscale() });
  servers.push(server);
  const client = new Client({ name: "inbox-label-surfaces-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return { server, client, project };
}

type Caller = "local" | "owner" | "guest";

/** A read as this computer's window, the owner's phone over the tailnet, or a guest's. */
async function read(server: InboxServer, caller: Caller, path: string): Promise<Json> {
  if (caller === "local") {
    const origin = `http://127.0.0.1:${server.port}`;
    const response = await fetch(`${origin}${path}`, { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    return (await response.json()) as Json;
  }
  const listener = server.tailscale.listenerPort();
  if (listener === null) throw new Error("not published");
  const response = await fetch(`http://127.0.0.1:${listener}${path}`, {
    headers: {
      Host: `${MAGIC}:${server.port}`,
      Origin: `https://${MAGIC}:${server.port}`,
      "Sec-Fetch-Site": "same-origin",
      "X-Forwarded-Proto": "https",
      "Tailscale-User-Login": caller === "owner" ? OWNER : GUEST,
    },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Json;
}

/** One poll from a Claude Code session's connection; `label` absent is an older connection. */
async function poll(server: InboxServer, session: string, project: string, label?: string) {
  const response = await fetch(`http://127.0.0.1:${server.port}${INBOX_BRIDGE_POLL_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
    body: JSON.stringify({ session, host: "claude-code", waitMs: 0, project_path: project, started_at: Date.now(), busy: false, tags: true, ...(label === undefined ? {} : { label }) }),
  });
  expect(response.status).toBe(200);
}

/** A Claude Code session's send through its waking connection, as the mod makes it: host and name from the host. */
async function sends(client: Client, project: string, session: string, body: string, replyTo?: string) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: session, agent_host: "claude-code", agent_name: "Claude Code", ...(replyTo ? { reply_to: replyTo } : {}) },
    _meta: { [INBOX_WAKES_META_KEY]: true },
  });
  return result.structuredContent as { message_id: string; thread_id: string };
}

/** Three named Claude Code sessions and an unnamed one, the first three writing in one thread. */
async function threeNamed() {
  const s = await setup();
  await poll(s.server, "ses-login", s.project, "Fix login redirect");
  await poll(s.server, "ses-docs", s.project, "Docs pass");
  await poll(s.server, "ses-billing", s.project, "Billing cleanup");
  await poll(s.server, "ses-plain", s.project, "");
  const root = await sends(s.client, s.project, "ses-login", "The redirect loops after SSO.");
  await sends(s.client, s.project, "ses-docs", "The README says the opposite.", root.message_id);
  await sends(s.client, s.project, "ses-billing", "Billing reads the same cookie.", root.message_id);
  return { ...s, threadId: root.thread_id, rootId: root.message_id };
}

const liveLabels = (model: Json) => Object.fromEntries((model.sessions as Json[]).filter((row) => row.kind === "live").map((row) => [row.session, row.label]));

describe("the routes carry each session's own label", () => {
  test("taggable, the thread's live sessions and the list say the label; an unnamed session has no label key at all", async () => {
    const { server, threadId } = await threeNamed();
    const taggable = await read(server, "local", `/api/inbox/threads/${threadId}/taggable`);
    expect(liveLabels(taggable)).toEqual({ "ses-login": "Fix login redirect", "ses-docs": "Docs pass", "ses-billing": "Billing cleanup", "ses-plain": undefined });
    // `name` stays an MCP agent's own name: the label does not take its place.
    expect((taggable.sessions as Json[]).every((row) => row.kind !== "live" || row.name === null)).toBe(true);
    expect("label" in (taggable.sessions as Json[]).find((row) => row.session === "ses-plain")!).toBe(false);

    const live = await read(server, "local", `/api/inbox/threads/${threadId}/sessions`);
    expect(Object.fromEntries((live.sessions as Json[]).map((row) => [row.session, row.label]))).toMatchObject({ "ses-login": "Fix login redirect", "ses-plain": undefined });
    expect("label" in (live.sessions as Json[]).find((row) => row.session === "ses-plain")!).toBe(false);

    const list = await read(server, "local", "/api/inbox/threads");
    expect(list.session_labels).toEqual({ "ses-login": "Fix login redirect", "ses-docs": "Docs pass", "ses-billing": "Billing cleanup" });
  });

  test("a rename follows on the next poll, an empty label or an older connection clears it, and the label is the cleaned one", async () => {
    const { server, project, threadId } = await threeNamed();
    await poll(server, "ses-login", project, "Login, take two");
    await poll(server, "ses-docs", project, "");
    await poll(server, "ses-billing", project);
    await poll(server, "ses-plain", project, `‮Evil‬ ${"x".repeat(200)}`);
    const list = await read(server, "local", "/api/inbox/threads");
    expect(Object.keys(list.session_labels).sort()).toEqual(["ses-login", "ses-plain"]);
    expect(list.session_labels["ses-login"]).toBe("Login, take two");
    expect(list.session_labels["ses-plain"]).toBe(`Evil ${"x".repeat(55)}`);
    expect(liveLabels(await read(server, "local", `/api/inbox/threads/${threadId}/taggable`))["ses-docs"]).toBeUndefined();
  });

  test("the label is never written into a message, and no agent's read carries it", async () => {
    const { server, client, threadId, rootId } = await threeNamed();
    const thread = (await read(server, "local", `/api/inbox/threads/${threadId}`)).thread as Json;
    expect(JSON.stringify(thread)).not.toContain("Fix login redirect");
    expect(server.store.message(rootId)!.author).toEqual({ kind: "agent", host: "claude-code", session: "ses-login", name: "Claude Code" });
    for (const args of [{ thread_id: threadId }, { thread_id: threadId, format: "full" }]) {
      const result = await client.callTool({ name: "read_thread", arguments: { ...args, agent_session: "ses-docs" } });
      expect(JSON.stringify(result)).not.toMatch(/Fix login redirect|Docs pass|Billing cleanup/);
    }
  });

  test("a session that ended keeps its label in the list while the Inbox runs, so a finished thread keeps its names", async () => {
    const { server } = await threeNamed();
    // Long past the live window: no poll since.
    const realNow = Date.now;
    Date.now = () => realNow() + 10 * 60_000;
    try {
      const list = await read(server, "local", "/api/inbox/threads");
      expect(list.session_labels["ses-login"]).toBe("Fix login redirect");
    } finally {
      Date.now = realNow;
    }
  });
});

describe("who sees them", () => {
  test("the owner over the tailnet reads what this computer reads; a guest reads every route as before", async () => {
    const { server, threadId } = await threeNamed();
    const routes = ["/api/inbox/threads", `/api/inbox/threads/${threadId}/taggable`, `/api/inbox/threads/${threadId}/sessions`];
    for (const path of routes) {
      const local = await read(server, "local", path);
      const owner = await read(server, "owner", path);
      const guest = await read(server, "guest", path);
      expect(JSON.stringify(owner)).toContain("Fix login redirect");
      expect(owner.session_labels).toEqual(local.session_labels);
      expect(JSON.stringify(guest)).not.toMatch(/Fix login redirect|Docs pass|Billing cleanup/);
      expect(guest.session_labels).toBeUndefined();
      // The rest of the guest's answer is the owner's, labels aside.
      const strip = (model: Json) => JSON.parse(JSON.stringify(model, (key, value) => (key === "label" || key === "session_labels" ? undefined : value)));
      expect(Object.keys(strip(guest)).sort()).toEqual(Object.keys(strip(owner)).sort());
    }
  });
});

describe("the windows are told", () => {
  test("a poll that changes a label says `labels` on the deliveries frame, to the owner's window only", async () => {
    const { server, project } = await threeNamed();
    const frames = async (caller: "local" | "guest") => {
      const controller = new AbortController();
      const origin = `http://127.0.0.1:${server.port}`;
      const listener = server.tailscale.listenerPort()!;
      const response =
        caller === "local"
          ? await fetch(`${origin}/api/inbox/events?window=window-local-1&permission=default&origin=${encodeURIComponent(origin)}`, { headers: { Origin: origin }, signal: controller.signal })
          : await fetch(`http://127.0.0.1:${listener}/api/inbox/events?window=window-guest-1&permission=default&origin=${encodeURIComponent(`https://${MAGIC}:${server.port}`)}`, {
              headers: { Host: `${MAGIC}:${server.port}`, Origin: `https://${MAGIC}:${server.port}`, "Sec-Fetch-Site": "same-origin", "X-Forwarded-Proto": "https", "Tailscale-User-Login": GUEST },
              signal: controller.signal,
            });
      const reader = response.body!.getReader();
      let text = "";
      const until = async (pattern: RegExp, ms: number) => {
        const deadline = Date.now() + ms;
        while (!pattern.test(text) && Date.now() < deadline) {
          const chunk = await Promise.race([reader.read(), new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now()))]);
          if (!chunk || chunk.done) break;
          text += new TextDecoder().decode(chunk.value);
        }
        return pattern.test(text);
      };
      return { until, text: () => text, close: () => controller.abort() };
    };
    const local = await frames("local");
    const guest = await frames("guest");
    expect(await local.until(/event: hello/, 3_000)).toBe(true);
    expect(await guest.until(/event: hello/, 3_000)).toBe(true);
    // The first compare after a window opens may say the sessions moved, to every window: let it pass.
    await local.until(/event: deliveries/, 2_500);
    await guest.until(/event: deliveries/, 500);
    const guestBefore = guest.text().length;
    await poll(server, "ses-login", project, "Renamed now");
    expect(await local.until(/event: deliveries\ndata: \{"labels":true\}/, 5_000)).toBe(true);
    // Only a label changed: the guest's window gets no frame at all, not even an empty one.
    await guest.until(/event: deliveries[\s\S]*event: deliveries/, 2_500);
    expect(guest.text().slice(guestBefore)).not.toContain("event: deliveries");
    local.close();
    guest.close();
  }, 20_000);
});

describe("a label never reads as someone else", () => {
  test('"You" or an agent\'s name, in any case or spacing, is no label; a label that only contains one is kept', async () => {
    const { server, project } = await threeNamed();
    const refused = ["You", "you", " YOU ", "Claude Code", "claude  code", "claude-code", "PI", "Codex", "opencode", "T3 Code"];
    for (const label of refused) {
      await poll(server, "ses-login", project, label);
      const list = await read(server, "local", "/api/inbox/threads");
      expect(list.session_labels["ses-login"], label).toBeUndefined();
    }
    await poll(server, "ses-login", project, "Pi config cleanup");
    expect((await read(server, "local", "/api/inbox/threads")).session_labels["ses-login"]).toBe("Pi config cleanup");
  });
});

describe("session ids that are Object's own names", () => {
  test('"constructor" and "__proto__" are plain keys: labelled when they say one, absent when they do not', async () => {
    const { server, project } = await threeNamed();
    await poll(server, "constructor", project);
    await poll(server, "toString", project, "Named toString");
    await poll(server, "__proto__", project, "Named proto");
    const list = await read(server, "local", "/api/inbox/threads");
    expect(Object.keys(list.session_labels).sort()).toEqual(["__proto__", "ses-billing", "ses-docs", "ses-login", "toString"]);
    expect(Object.hasOwn(list.session_labels, "constructor")).toBe(false);
    expect(list.session_labels.toString).toBe("Named toString");
    expect(list.session_labels["__proto__"]).toBe("Named proto");
  });
});
