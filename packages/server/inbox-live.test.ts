/**
 * Live sites in the Plannotator Inbox (packages/server/inbox-live.ts): a
 * running local site an agent attaches (`send_message` `live_sites`) or the
 * person opens from a thread, shown through the loopback live proxy.
 *
 * Proved through the real doors: a running Inbox on loopback in a temp data
 * dir, the MCP SDK client for the agent, real `fetch` for the window, and a
 * scratch dev app (Bun.serve on a free loopback port). The tailnet's refusal
 * is in inbox-tailscale.test.ts; the window side (open, pin on two pages, a
 * forged bridge message, Send) in tests/e2e/inbox-live-sites.spec.ts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_LIVE_SITES_MAX, type InboxAnnotationRecord, type InboxThread } from "@plannotator/core/inbox-types";
import { PLANNOTATOR_SERVER_HEADER } from "@plannotator/shared/plannotator-server-marker";
import { attachmentFeedback, liveSiteFeedback } from "../inbox/attachments";
import { INBOX_WINDOW_CSP, LOCAL_WINDOW_CSP, startInboxServer, type InboxServer } from "./inbox";
import { checkInboxLiveUrl, inboxLiveSiteId } from "./inbox-live";
import { createInboxDevices } from "./inbox-devices";

const BRIDGE = { bridgeScript: "/* bridge */", bridgeBootstrap: "/* bootstrap */", annotationCss: "" };

const roots: string[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];
const apps: { stop: (force?: boolean) => unknown }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  for (const app of apps.splice(0)) app.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-live-")));
  roots.push(root);
  const project = join(root, "shop");
  mkdirSync(project, { recursive: true });
  return { root, project, dataDir: join(root, "data") };
}

/** A scratch dev app: two pages, refusing to be framed (the proxy strips that), on a free loopback port. */
function devApp(headers: Record<string, string> = {}): { url: string; port: number } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      const page = path === "/settings" ? '<button id="cancel">Cancel plan</button>' : '<p id="price">$240</p><button id="pay">Pay</button>';
      return new Response(`<!doctype html><html><head><title>Shop</title></head><body>${page}</body></html>`, {
        headers: { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", ...headers },
      });
    },
  });
  apps.push(server);
  return { url: `http://localhost:${server.port}/`, port: server.port as number };
}

/** A loopback port nothing listens on. */
function closedPort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = server.port as number;
  server.stop(true);
  return port;
}

async function start(dataDir: string, extra: Partial<Parameters<typeof startInboxServer>[0]> = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, liveBridge: BRIDGE, ...extra });
  servers.push(server);
  return server;
}

async function agent(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "inbox-live-test", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

type ToolAnswer = { isError?: boolean; text: string; structured: Record<string, any> };
async function tool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolAnswer> {
  const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };
  return { isError: result.isError, text: result.content.map((c) => c.text).join("\n"), structured: result.structuredContent };
}

async function send(client: Client, project: string, extra: Record<string, unknown> = {}): Promise<ToolAnswer> {
  return tool(client, "send_message", {
    project_path: project,
    body: "The checkout and settings pages are done; try them.",
    agent_session: "ses_shop",
    agent_name: "Claude Code",
    agent_host: "claude-code",
    ...extra,
  });
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

function post(server: InboxServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${base(server)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

async function threads(server: InboxServer): Promise<unknown[]> {
  return server.store.listRows();
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

async function pending(server: InboxServer, threadId: string): Promise<InboxAnnotationRecord[]> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}/attachments`)).json()) as { annotations: InboxAnnotationRecord[] }).annotations;
}

async function openSite(server: InboxServer, threadId: string, siteId: string) {
  const response = await fetch(`${base(server)}/api/inbox/threads/${threadId}/live/${siteId}`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { site: { id: string; url: string; app_url: string; proxy_origin: string; token: string; opened_by: string } }).site;
}

/** A pin on an element, as the live bridge makes it. */
function pin(id: string, text: string, pageUrl: string | undefined, selector: string, label = "Cancel plan") {
  return {
    id,
    blockId: "html-element",
    startOffset: 0,
    endOffset: 0,
    type: "COMMENT",
    text,
    originalText: label,
    createdA: 1,
    ...(pageUrl ? { pageUrl } : {}),
    htmlAnchor: { selector },
    elementContext: { tag: "button", path: `body > ${selector}`, role: "button", text: label },
  };
}

describe("checkInboxLiveUrl", () => {
  test("takes http on a loopback host, and drops the fragment", () => {
    expect(checkInboxLiveUrl("http://localhost:5173/checkout?step=2#total", []).href).toBe("http://localhost:5173/checkout?step=2");
    expect(checkInboxLiveUrl("http://127.0.0.2:8080/", []).host).toBe("127.0.0.2:8080");
    expect(checkInboxLiveUrl("http://[::1]:3000/", []).hostname).toBe("[::1]");
  });

  test("refuses another computer, other schemes, credentials and Plannotator's ports, naming the field", () => {
    const refusal = (raw: unknown, reserved: number[] = []) => {
      try {
        checkInboxLiveUrl(raw, reserved);
        return null;
      } catch (error) {
        return error as { code: string; field?: string; message: string };
      }
    };
    for (const raw of ["https://localhost:5173/", "file:///etc/passwd", "ws://localhost:5173/", "http://example.com/", "http://192.168.1.20:5173/", "http://user:pw@localhost:5173/", "", "nonsense", 42]) {
      expect(refusal(raw)?.code).toBe("validation_error");
    }
    expect(refusal("http://localhost:59812/", [59812])?.message).toContain("Plannotator's own");
    expect(refusal(`http://localhost:5173/${"a".repeat(2100)}`)?.message).toContain("at most");
  });

  test("one id per site in every thread: the URL's identity, not the spelling of its host", () => {
    expect(inboxLiveSiteId("http://localhost:5173/")).toMatch(/^liv_[0-9a-f]{16}$/);
    expect(inboxLiveSiteId("http://localhost:5173/settings")).not.toBe(inboxLiveSiteId("http://localhost:5173/"));
  });
});

describe("an agent attaches a live site", () => {
  test("send_message checks and records it; the window opens it through a proxy with its own token, and the proxy strips the frame refusal", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir);
    const client = await agent(server);
    const app = devApp();

    const sent = await send(client, project, { live_sites: [app.url] });
    expect(sent.isError).toBeFalsy();
    const id = inboxLiveSiteId(app.url);
    expect(sent.structured.live_sites).toEqual([{ id, url: app.url }]);
    expect(sent.text).toContain("with 1 live site");
    // Nothing runs until the person opens it.
    expect(server.liveSites.running()).toEqual([]);

    const shown = await thread(server, sent.structured.thread_id);
    expect(shown.messages[0]!.live_sites).toEqual([{ id, url: app.url, opened_by: "agent", opened_at: expect.any(String) }]);
    const listed = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.structured.thread_id}/live`)).json()) as { sites: { id: string }[] };
    expect(listed.sites.map((s) => s.id)).toEqual([id]);

    const site = await openSite(server, sent.structured.thread_id, id);
    expect(site.token).toMatch(/^[0-9a-f]{32}$/);
    expect(site.app_url).toBe(`${site.proxy_origin}/`);
    expect(site.proxy_origin).toMatch(/^http:\/\/localhost:\d+$/);
    expect(server.liveSites.running()).toEqual([{ origin: `http://localhost:${app.port}`, port: Number(new URL(site.proxy_origin).port) }]);

    const page = await fetch(site.app_url);
    expect(page.status).toBe(200);
    expect(page.headers.get("x-frame-options")).toBeNull();
    expect(page.headers.get("content-security-policy") ?? "").toContain(`frame-ancestors http://localhost:${server.port} http://127.0.0.1:${server.port}`);
    expect(await page.text()).toContain("$240");
    // The bridge carries this proxy's token, and only the editor's origins may fetch it.
    const bridge = await fetch(`${site.proxy_origin}/__plannotator__/bridge.js`, { headers: { "Sec-Fetch-Site": "same-origin" } });
    expect(await bridge.text()).toContain(site.token);
  });

  test("refused before anything is written, naming the site: another computer, an Inbox port, a registry's port, a Plannotator server, one not answering, too many", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir);
    const client = await agent(server);
    const app = devApp();

    // A live session's port in the data dir's registry (this process: alive).
    const registered = devApp();
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    writeFileSync(join(dataDir, "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, port: registered.port }));
    // A Plannotator server no registry names (another data dir), known by its header.
    const marked = devApp({ [PLANNOTATOR_SERVER_HEADER]: "inbox" });
    const dead = `http://localhost:${closedPort()}/`;

    const cases: [string[], string][] = [
      [["http://example.com/"], "is not this computer"],
      [[`http://localhost:${server.port}/`], "Plannotator's own"],
      [[registered.url], "Plannotator"],
      [[marked.url], "Plannotator"],
      [[dead], dead],
      [[app.url, "https://localhost:1234/"], "https://localhost:1234/"],
      [Array.from({ length: INBOX_LIVE_SITES_MAX + 1 }, (_, i) => `${app.url}p${i}`), `at most ${INBOX_LIVE_SITES_MAX}`],
    ];
    for (const [urls, words] of cases) {
      const refused = await send(client, project, { live_sites: urls });
      expect([urls, refused.isError]).toEqual([urls, true]);
      expect(refused.text).toContain("live_sites");
      expect(refused.text).toContain(words);
    }
    expect(await threads(server)).toEqual([]);
    expect(server.liveSites.running()).toEqual([]);
  });

  test("one proxy per site origin, each with its own token; an idle proxy stops, and reopening gets a new port and token", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir, { liveIdleMs: 60_000 });
    const client = await agent(server);
    const a = devApp();
    const b = devApp();
    const sent = await send(client, project, { live_sites: [a.url, `${a.url}settings`, b.url] });
    const threadId = sent.structured.thread_id;
    const [home, settings, other] = await Promise.all([
      openSite(server, threadId, inboxLiveSiteId(a.url)),
      openSite(server, threadId, inboxLiveSiteId(`${a.url}settings`)),
      openSite(server, threadId, inboxLiveSiteId(b.url)),
    ]);
    // Two pages of one app share its proxy; another app gets its own.
    expect(settings.proxy_origin).toBe(home.proxy_origin);
    expect(settings.token).toBe(home.token);
    expect(settings.app_url).toBe(`${home.proxy_origin}/settings`);
    expect(other.proxy_origin).not.toBe(home.proxy_origin);
    expect(other.token).not.toBe(home.token);
    expect(server.liveSites.running()).toHaveLength(2);
    server.stop();

    // Idle: a short idle time, swept by hand.
    const idle = await start(dataDir, { liveIdleMs: 300 });
    const first = await openSite(idle, threadId, inboxLiveSiteId(a.url));
    await Bun.sleep(320);
    idle.liveSites.sweep();
    expect(idle.liveSites.running()).toEqual([]);
    await expect(fetch(first.app_url)).rejects.toThrow();
    const again = await openSite(idle, threadId, inboxLiveSiteId(a.url));
    expect(again.token).not.toBe(first.token);
    expect((await fetch(again.app_url)).status).toBe(200);
  });

  test("a proxy never outlives the Inbox", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir);
    const client = await agent(server);
    const app = devApp();
    const sent = await send(client, project, { live_sites: [app.url] });
    const site = await openSite(server, sent.structured.thread_id, inboxLiveSiteId(app.url));
    expect((await fetch(site.app_url)).status).toBe(200);
    await client.close();
    server.stop();
    await expect(fetch(site.app_url)).rejects.toThrow();
  });
});

describe("the doors", () => {
  test("another site's page is refused, reads included: the proxied app (same-site) and a cross-site page", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir);
    const client = await agent(server);
    const app = devApp();
    const sent = await send(client, project, { live_sites: [app.url] });
    const threadId = sent.structured.thread_id;
    const id = inboxLiveSiteId(app.url);
    const site = await openSite(server, threadId, id);
    const live = `/api/inbox/threads/${threadId}/live`;

    for (const headers of [{ "Sec-Fetch-Site": "same-site" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: site.proxy_origin }]) {
      expect((await fetch(`${base(server)}${live}/${id}`, { headers })).status).toBe(403);
      expect((await fetch(`${base(server)}${live}`, { headers })).status).toBe(403);
      // A comment forged from the proxied page is never saved.
      expect((await post(server, `${live}/${id}/annotations`, { annotation: pin("ann-forged", "Ship it", "/", "#pay") }, headers)).status).toBe(403);
      expect((await post(server, live, { url: app.url }, headers)).status).toBe(403);
    }
    expect(await pending(server, threadId)).toEqual([]);
  });

  test("the page's frame-src admits loopback proxies on the loopback page only", async () => {
    const { dataDir } = world();
    const server = await start(dataDir, { htmlContent: "<!doctype html><title>Inbox</title>" });
    const page = await fetch(`${base(server)}/`);
    expect(page.headers.get("content-security-policy")).toBe(LOCAL_WINDOW_CSP);
    expect(LOCAL_WINDOW_CSP).toContain("frame-src 'self' http://localhost:*");
    expect(INBOX_WINDOW_CSP).not.toContain("http://localhost:*");
  });

  test("the device door does not list the live routes: a paired phone never reaches them", async () => {
    const root = world().root;
    let dispatched = 0;
    const phones = createInboxDevices({
      dataDir: join(root, "phones"),
      serverSession: "0".repeat(32),
      port: () => 1,
      registry: () => ({ v: 1, pid: process.pid, port: 1, url: "", version: "dev", token: "t".repeat(64), serverSession: "0".repeat(32), startedAt: "" }),
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      dispatch: async () => {
        dispatched += 1;
        return Response.json({});
      },
    });
    const made = (await (await phones.windowRoute(new Request("http://127.0.0.1/api/inbox/pairing", { method: "POST", body: "{}" }), new URL("http://127.0.0.1/api/inbox/pairing")))!.json()) as {
      offer: { code: string };
    };
    const pairUrl = new URL("http://127.0.0.1/api/inbox/device/pair");
    const paired = (await (
      await phones.door(new Request(pairUrl, { method: "POST", body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) }), pairUrl)
    ).json()) as { token: string };
    const site = inboxLiveSiteId("http://localhost:5173/");
    for (const [method, path] of [
      ["GET", "threads/msg_x/live"],
      ["POST", "threads/msg_x/live"],
      ["GET", `threads/msg_x/live/${site}`],
      ["POST", `threads/msg_x/live/${site}/annotations`],
      ["POST", `threads/msg_x/live/${site}/ping`],
    ] as const) {
      const url = new URL(`http://127.0.0.1/api/inbox/device/${path}`);
      const answer = await phones.door(
        new Request(url, { method, headers: { Authorization: `Bearer ${paired.token}` }, ...(method === "POST" ? { body: JSON.stringify({ url: "http://localhost:5173/", idempotency_key: "k" }) } : {}) }),
        url,
      );
      expect([path, answer.status]).toEqual([path, 404]);
    }
    expect(dispatched).toBe(0);
  });
});

describe("the person opens a site and comments on it", () => {
  test("opening is checked like an agent's, and kept on the thread's root across a restart", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir);
    const client = await agent(server);
    const app = devApp();
    const sent = await send(client, project);
    const threadId = sent.structured.thread_id;
    const live = `/api/inbox/threads/${threadId}/live`;

    expect((await post(server, live, { url: `http://localhost:${server.port}/`, serverSession: server.serverSession })).status).toBe(422);
    expect((await post(server, live, { url: "http://10.0.0.5:5173/", serverSession: server.serverSession })).status).toBe(422);
    expect((await post(server, live, { url: app.url, serverSession: "stale" })).status).toBe(409);

    const opened = await post(server, live, { url: `${app.url}settings`, serverSession: server.serverSession });
    expect(opened.status).toBe(200);
    const site = ((await opened.json()) as { site: { id: string; opened_by: string; app_url: string } }).site;
    expect(site.opened_by).toBe("person");
    expect(site.app_url).toEndWith("/settings");
    // Opening it again writes nothing new.
    await post(server, live, { url: `${app.url}settings`, serverSession: server.serverSession });
    await client.close();
    server.stop();

    const after = await start(dataDir);
    const listed = (await (await fetch(`${base(after)}${live}`)).json()) as { sites: { id: string; opened_by: string }[] };
    expect(listed.sites).toEqual([expect.objectContaining({ id: site.id, opened_by: "person" })]);
    expect((await thread(after, threadId)).messages[0]!.opened_live_sites).toHaveLength(1);
  });

  test("comments are comment-only, on a site the thread shows, with the page a path on that site", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir);
    const client = await agent(server);
    const app = devApp();
    const sent = await send(client, project, { live_sites: [app.url] });
    const threadId = sent.structured.thread_id;
    const id = inboxLiveSiteId(app.url);
    const route = `/api/inbox/threads/${threadId}/live/${id}/annotations`;
    const save = (annotation: unknown) => post(server, route, { annotation });

    for (const pageUrl of ["//evil.example/x", "http://localhost:1/", "/\\evil", "settings", "/a\nb"]) {
      expect([pageUrl, (await save(pin("ann-p", "x", pageUrl, "#pay"))).status]).toEqual([pageUrl, 422]);
    }
    expect((await save({ ...pin("ann-d", "x", "/", "#pay"), type: "DELETION" })).status).toBe(422);
    expect((await save(pin("ann-e", "", "/", "#pay"))).status).toBe(422);
    expect((await post(server, `/api/inbox/threads/${threadId}/live/${inboxLiveSiteId("http://localhost:9/")}/annotations`, { annotation: pin("ann-n", "x", "/", "#pay") })).status).toBe(404);

    const saved = await save(pin("ann-ok", "Price should say per month", "/", "#price"));
    expect(saved.status).toBe(200);
    const record = ((await saved.json()) as { annotation: InboxAnnotationRecord }).annotation;
    expect(record.live).toEqual({ site_id: id, url: app.url, page_url: "/" });
    expect(record.message_id).toBe(sent.structured.message_id);
    expect(record.sent_reply_id).toBeNull();
  });

  test("Send carries the comments by page with each element's context; the agent reads them in wait_for_reply", async () => {
    const { project, dataDir } = world();
    const server = await start(dataDir);
    const client = await agent(server);
    const app = devApp();
    const sent = await send(client, project, { live_sites: [app.url] });
    const threadId = sent.structured.thread_id;
    const route = `/api/inbox/threads/${threadId}/live/${inboxLiveSiteId(app.url)}/annotations`;
    expect((await post(server, route, { annotation: pin("ann-home", "Say per month next to the price.", "/", "#price", "$240") })).status).toBe(200);
    await Bun.sleep(5);
    expect((await post(server, route, { annotation: pin("ann-cancel", "Ask before cancelling.", "/settings", "#cancel") })).status).toBe(200);

    const records = await pending(server, threadId);
    expect(records).toHaveLength(2);
    // The window builds the feedback exactly as on Send (packages/inbox/attachments.ts).
    const feedback = attachmentFeedback(records, [], new Map(), project);
    expect(feedback).toBe(liveSiteFeedback(records));
    const reply = await post(server, `/api/inbox/messages/${sent.structured.message_id}/reply`, {
      serverSession: server.serverSession,
      idempotency_key: "send-live",
      words: "Two things on the running app.",
      feedback,
      annotation_ids: records.map((r) => r.id),
    });
    expect(reply.status).toBe(200);
    expect(await pending(server, threadId)).toEqual([]);

    const answer = await tool(client, "wait_for_reply", { thread_id: threadId, agent_session: "ses_shop", timeout_seconds: 5 });
    const body = answer.text;
    const at = (part: string) => body.indexOf(part);
    for (const part of [
      "Two things on the running app.",
      "# Feedback on your running app",
      `## ${app.url} (live site)`,
      "I've reviewed this site and have 2 pieces of feedback:",
      "Page: /",
      "Page: /settings",
      'Feedback on: "$240"',
      "#price",
      "#cancel",
      "Say per month next to the price.",
      "Ask before cancelling.",
    ]) {
      expect([part, at(part) >= 0]).toEqual([part, true]);
    }
    expect(at("Page: /settings")).toBeGreaterThan(at("Say per month next to the price."));
    expect(at("Ask before cancelling.")).toBeGreaterThan(at("Page: /settings"));
  });
});
