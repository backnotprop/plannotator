/**
 * "Over your tailnet" (packages/server/inbox-tailscale.ts) against a real
 * Inbox server on loopback, with Tailscale's serve config kept by a scripted
 * `tailscale` CLI through the runner seam the Inbox runs the real CLI with.
 * A request "through serve" is a request to the tailnet-only listener the
 * mapping points at, carrying what serve sends: the browser's Host (the
 * MagicDNS name and port) and the peer's `Tailscale-User-Login`.
 * Temp PLANNOTATOR_DATA_DIR only; the real `tailscale` never runs.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { describeTailscaleFailure, type TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { takeDownInboxTailscale } from "./inbox-tailscale";

type Json = Record<string, any>;

const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "ramos@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const restore of restoreEnv.splice(0)) restore();
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

/** A temp data dir that loadConfig() reads too, with config.json as given. */
function world(config: Json = {}): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-tailscale-")));
  roots.push(dataDir);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  return dataDir;
}

/** Tailscale as a scripted CLI: `status --json` (who owns this machine), `serve status --json`, serve on and off. */
function fakeTailscale(options: { tagged?: boolean } = {}) {
  const serve = new Map<number, string>();
  const down = { status: false, serve: false };
  const calls: string[][] = [];
  const self = { tagged: options.tagged === true };
  const run: TailscaleRunner = (args) => {
    calls.push(args);
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    const fail = { status: 1, stdout: "", stderr: "Tailscale is stopped." };
    if (args[0] === "status") {
      if (down.status) return fail;
      return ok(
        JSON.stringify({
          Self: { DNSName: `${MAGIC}.`, UserID: 42, ...(self.tagged ? { Tags: ["tag:server"] } : {}) },
          User: { "42": { ID: 42, LoginName: self.tagged ? "tagged-devices" : OWNER, DisplayName: "Ramos" } },
        }),
      );
    }
    if (args[1] === "status") {
      if (down.status) return fail;
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    if (down.serve) return fail;
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://${MAGIC}:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
  return { serve, down, calls, self, run };
}

async function start(dataDir: string, run: TailscaleRunner, extra: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, tailscale: run, ...extra });
  servers.push(server);
  return server;
}

const registryOf = (dataDir: string) => JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8"));

/** A request as `tailscale serve` hands it to the listener its mapping points at. */
function throughServe(inbox: InboxServer, path: string, init: { method?: string; login?: string | null; host?: string; headers?: Record<string, string>; body?: string } = {}) {
  const listener = inbox.tailscale.listenerPort();
  if (listener === null) throw new Error("not published");
  const headers: Record<string, string> = { Host: init.host ?? `${MAGIC}:${inbox.port}`, ...(init.headers ?? {}) };
  const login = init.login === undefined ? OWNER : init.login;
  if (login !== null) headers["Tailscale-User-Login"] = login;
  return fetch(`http://127.0.0.1:${listener}${path}`, { method: init.method ?? "GET", headers, body: init.body });
}

const codeOf = async (response: Response) => [response.status, ((await response.json()) as Json).code];

describe("Inbox over your tailnet", () => {
  test("published at start: the mapping is the Inbox's own port, pointed at a tailnet-only listener; the owner gets in, anyone else is refused", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run);
    const state = inbox.tailscale.state();
    expect(state).toMatchObject({ on: true, source: "config", url: `https://${MAGIC}:${inbox.port}/`, error: null, owner: OWNER, allowed: [OWNER] });

    // The HTTPS port is the Inbox's port; serve proxies to the second listener, never the window's port.
    const listener = inbox.tailscale.listenerPort()!;
    expect(ts.serve.get(inbox.port)).toBe(`http://127.0.0.1:${listener}`);
    expect(listener).not.toBe(inbox.port);
    expect(ts.calls.some((args) => args.includes("funnel"))).toBe(false);
    expect(registryOf(dataDir).tailscale).toEqual({ url: `https://${MAGIC}:${inbox.port}/`, error: null, https_port: inbox.port, proxy_port: listener });

    // The owner, through serve: the window and its data.
    expect((await throughServe(inbox, "/")).status).toBe(200);
    expect((await throughServe(inbox, "/api/inbox/threads")).status).toBe(200);
    // Logins compare case-insensitively; a non-ASCII login arrives Q-encoded.
    expect((await throughServe(inbox, "/api/inbox/threads", { login: "Ramos@Example.com" })).status).toBe(200);

    // Anyone else on the tailnet, a tagged device (no login), a funnel request.
    expect(await codeOf(await throughServe(inbox, "/api/inbox/threads", { login: "someone@example.com" }))).toEqual([403, "tailnet_identity_refused"]);
    expect(await codeOf(await throughServe(inbox, "/api/inbox/threads", { login: null }))).toEqual([403, "tailnet_identity_required"]);
    expect(await codeOf(await throughServe(inbox, "/api/inbox/threads", { login: "=?utf-8?q?not-valid" }))).toEqual([403, "tailnet_identity_required"]);
    expect(await codeOf(await throughServe(inbox, "/api/inbox/threads", { headers: { "Tailscale-Funnel-Request": "?1" } }))).toEqual([403, "tailnet_funnel_refused"]);
    const page = await throughServe(inbox, "/", { login: "someone@example.com" });
    expect(page.status).toBe(403);
    expect(await page.text()).toContain("only its owner's Tailscale login");

    // Host is the client's own through serve: only the served name and port pass, never a loopback claim.
    for (const host of [`127.0.0.1:${inbox.port}`, `localhost:${inbox.port}`, MAGIC, `${MAGIC}:443`, `evil.example:${inbox.port}`]) {
      expect([host, ...(await codeOf(await throughServe(inbox, "/api/inbox/threads", { host })))]).toEqual([host, 403, "forbidden_host"]);
    }

    // The window's own port is unchanged: loopback works, the tailnet name does not.
    expect((await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/threads`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/threads`, { headers: { Host: `${MAGIC}:${inbox.port}` } })).status).toBe(403);
  });

  test("the window page (#2032): compressed through the tailnet (br and gzip, Vary, a weak ETag and 304, private no-cache), unchanged on loopback, and the listener's checks still run first", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const page = `<!doctype html><title>Inbox</title>${"<p>the window, a large single-file page</p>\n".repeat(20000)}`;
    const inbox = await start(dataDir, ts.run, { htmlContent: page });
    const listener = inbox.tailscale.listenerPort()!;
    // Bun's fetch decodes bodies by itself; read the bytes as sent.
    const raw = (path: string, headers: Record<string, string>, method = "GET", login: string | null = OWNER) =>
      fetch(`http://127.0.0.1:${listener}${path}`, {
        method,
        headers: { Host: `${MAGIC}:${inbox.port}`, ...(login ? { "Tailscale-User-Login": login } : {}), ...headers },
        decompress: false,
      } as RequestInit);
    const sent = Buffer.byteLength(page);

    const br = await raw("/", { "Accept-Encoding": "gzip, deflate, br" });
    expect(br.status).toBe(200);
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(br.headers.get("cache-control")).toBe("private, no-cache");
    expect(br.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(br.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(br.headers.get("x-frame-options")).toBe("DENY");
    const brBytes = Buffer.from(await br.arrayBuffer());
    expect(brBytes.length).toBeLessThan(sent / 10);
    expect(brotliDecompressSync(brBytes).toString("utf8")).toBe(page);
    const etag = br.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"/);

    const gz = await raw("/", { "Accept-Encoding": "gzip, deflate" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gz.headers.get("vary")).toBe("Accept-Encoding");
    expect(gz.headers.get("etag")).toBe(etag);
    expect(gunzipSync(Buffer.from(await gz.arrayBuffer())).toString("utf8")).toBe(page);

    const plain = await raw("/", {});
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toBe("Accept-Encoding");
    expect(await plain.text()).toBe(page);

    // A repeat open revalidates: 304, no body, the same headers that matter.
    const again = await raw("/", { "Accept-Encoding": "br", "If-None-Match": etag });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("private, no-cache");
    expect((await raw("/", { "Accept-Encoding": "br", "If-None-Match": 'W/"other"' })).status).toBe(200);

    const head = await raw("/", { "Accept-Encoding": "br" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers.get("content-encoding")).toBe("br");
    expect((await head.arrayBuffer()).byteLength).toBe(0);

    // The listener's checks still come first: another login, another Host, another site's fetch.
    expect((await raw("/", { "Accept-Encoding": "br" }, "GET", "someone@example.com")).status).toBe(403);
    expect((await raw("/", { "Accept-Encoding": "br", Host: `127.0.0.1:${inbox.port}` })).status).toBe(403);
    expect((await raw("/", { "Accept-Encoding": "br", "If-None-Match": etag }, "GET", null)).status).toBe(403);
    expect((await raw("/", { "Accept-Encoding": "br", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", "Sec-Fetch-Dest": "empty" })).status).toBe(403);

    // The data routes stay no-store and uncompressed.
    const threads = await raw("/api/inbox/threads", { "Accept-Encoding": "br" });
    expect(threads.headers.get("cache-control")).toBe("no-store");
    expect(threads.headers.get("content-encoding")).toBeNull();

    // The window's own loopback port: exactly as before.
    const local = await fetch(`http://127.0.0.1:${inbox.port}/`, { headers: { "Accept-Encoding": "gzip, deflate, br" }, decompress: false } as RequestInit);
    expect(local.status).toBe(200);
    expect(local.headers.get("content-encoding")).toBeNull();
    expect(local.headers.get("vary")).toBeNull();
    expect(local.headers.get("etag")).toBeNull();
    expect(local.headers.get("cache-control")).toBe("no-store");
    expect(await local.text()).toBe(page);
  });

  test("through the tailnet the connection surface is unreachable, even with the token and a loopback Host claim, and the window's guards still apply", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run);
    const bearer = { Authorization: `Bearer ${inbox.token}`, "Content-Type": "application/json" };
    for (const path of ["/mcp", "/api/inbox/bridge/poll", "/api/inbox/bridge/event", "/api/inbox/control/stop", "/api/inbox/control/tailscale", "/api/inbox/device/threads"]) {
      const response = await throughServe(inbox, path, { method: "POST", headers: bearer, body: JSON.stringify({ session: "ses_x" }) });
      expect([path, ...(await codeOf(response))]).toEqual([path, 403, "local_only"]);
    }
    // The Inbox is still running: the stop route never ran.
    expect((await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/health`)).status).toBe(200);

    // Same origin: the page's own origin passes the origin check (then the serverSession nonce), another site does not.
    const own = { Origin: `https://${MAGIC}:${inbox.port}`, "Content-Type": "application/json" };
    const stale = await throughServe(inbox, "/api/inbox/restart", { method: "POST", headers: own, body: JSON.stringify({ serverSession: "0".repeat(32) }) });
    expect(stale.status).toBe(409);
    const cross = await throughServe(inbox, "/api/inbox/settings", { method: "POST", headers: { ...own, Origin: "https://evil.example" }, body: JSON.stringify({ notifications: { enabled: false } }) });
    expect(await codeOf(cross)).toEqual([403, "cross_origin"]);
    const saved = await throughServe(inbox, "/api/inbox/settings", { method: "POST", headers: own, body: JSON.stringify({ notifications: { enabled: false } }) });
    expect(saved.status).toBe(200);

    // The identity is ambient, so a page on another site (or another tailnet machine) cannot read or write through it.
    expect(await codeOf(await throughServe(inbox, "/api/inbox/threads", { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" } }))).toEqual([403, "cross_site"]);
    expect(await codeOf(await throughServe(inbox, "/api/inbox/threads", { headers: { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors" } }))).toEqual([403, "cross_site"]);
    // A link that opens the Inbox still works.
    expect((await throughServe(inbox, "/", { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate" } })).status).toBe(200);

    // The tailnet cannot widen the exposure: the switch cannot be turned on from there, nor a phone paired.
    const settings = (await (await throughServe(inbox, "/api/inbox/settings")).json()) as Json;
    expect(settings.via).toBe("tailnet");
    expect(settings.tailscale.url).toBe(`https://${MAGIC}:${inbox.port}/`);
    const on = await throughServe(inbox, "/api/inbox/settings", { method: "POST", headers: own, body: JSON.stringify({ tailscale: { on: true } }) });
    expect(await codeOf(on)).toEqual([403, "local_only"]);
    expect(await codeOf(await throughServe(inbox, "/api/inbox/pairing", { method: "POST", headers: own, body: "{}" }))).toEqual([403, "local_only"]);
    expect(((await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`)).json()) as Json).via).toBe("local");

    // The agents on this computer (their files, their switches, the card): this computer only, read or write.
    expect(await codeOf(await throughServe(inbox, "/api/inbox/agents"))).toEqual([403, "local_only"]);
    for (const [path, body] of [
      ["/api/inbox/agents", { agent: "codex", reach: true }],
      ["/api/inbox/agents/notes", { add: ["codex"] }],
      ["/api/inbox/agents/seen", {}],
    ] as const) {
      const response = await throughServe(inbox, path, { method: "POST", headers: own, body: JSON.stringify({ ...body, serverSession: inbox.serverSession }) });
      expect([path, ...(await codeOf(response))]).toEqual([path, 403, "local_only"]);
    }
  });

  test("a message's image (#1813) reads through the tailnet for the owner like the other read routes; a wrong login, no login and another site are refused", async () => {
    const dataDir = world({ inboxTailscale: true });
    const project = join(dataDir, "api");
    mkdirSync(join(project, "shots"), { recursive: true });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 3, 8, 6, 0, 0, 0, 0, 0, 0, 0]);
    writeFileSync(join(project, "shots", "after.png"), png);
    const inbox = await start(dataDir, fakeTailscale().run);
    const projectRecord = inbox.store.ensureProject({ name: "api", root: project });
    const { message } = inbox.store.sendMessage({
      project_id: projectRecord.id,
      author: { kind: "agent", host: "test", session: "ses_tailnet", name: null },
      body: "The page after the fix:\n\n![after](shots/after.png)",
    });
    const messageId = message.id;
    const path = `/api/inbox/messages/${messageId}/image?path=${encodeURIComponent("shots/after.png")}`;

    // The owner's page through the tailnet: its <img> is same-origin.
    const ok = await throughServe(inbox, path, { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "image" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("image/png");
    expect(ok.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(png);

    expect(await codeOf(await throughServe(inbox, path, { login: "someone@example.com" }))).toEqual([403, "tailnet_identity_refused"]);
    expect(await codeOf(await throughServe(inbox, path, { login: null }))).toEqual([403, "tailnet_identity_required"]);
    expect(await codeOf(await throughServe(inbox, path, { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "image" } }))).toEqual([403, "cross_site"]);
    // The route's own Sec-Fetch-Site refusal is intact on the window's port.
    const local = await fetch(`http://127.0.0.1:${inbox.port}${path}`, { headers: { "Sec-Fetch-Site": "cross-site" } });
    expect(await codeOf(local)).toEqual([403, "cross_origin"]);
    expect((await fetch(`http://127.0.0.1:${inbox.port}${path}`)).status).toBe(200);
  });

  test("search answers the owner through the tailnet like the other read routes; recent searches take the owner's same-origin write; a wrong login and another site are refused", async () => {
    const dataDir = world({ inboxTailscale: true });
    const inbox = await start(dataDir, fakeTailscale().run);
    const project = inbox.store.ensureProject({ name: "api", root: join(dataDir, "api") });
    const { message } = inbox.store.sendMessage({
      project_id: project.id,
      author: { kind: "agent", host: "test", session: "ses_tailnet", name: null },
      subject: "Relay rate limit",
      body: "The relay allows 20 mailbox creates a minute.",
    });
    const path = "/api/inbox/search?q=rate%20limit";
    let answer: Json = {};
    for (let i = 0; i < 40; i++) {
      const ok = await throughServe(inbox, path, { headers: { "Sec-Fetch-Site": "same-origin" } });
      expect(ok.status).toBe(200);
      answer = (await ok.json()) as Json;
      if (!answer.indexing) break;
    }
    expect((answer.groups as { threads: { id: string }[] }).threads.map((t) => t.id)).toEqual([message.id]);
    expect(await codeOf(await throughServe(inbox, path, { login: "someone@example.com" }))).toEqual([403, "tailnet_identity_refused"]);
    expect(await codeOf(await throughServe(inbox, path, { headers: { "Sec-Fetch-Site": "cross-site" } }))).toEqual([403, "cross_site"]);
    // Another machine of the tailnet is the same site: refused too.
    expect(await codeOf(await throughServe(inbox, path, { headers: { "Sec-Fetch-Site": "same-site" } }))).toEqual([403, "cross_site"]);
    const origin = `https://${MAGIC}:${inbox.port}`;
    const saved = await throughServe(inbox, "/api/inbox/search/recent", {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ q: "rate limit", serverSession: inbox.serverSession }),
    });
    expect(saved.status).toBe(200);
    expect(((await saved.json()) as Json).recent_searches).toEqual(["rate limit"]);
    const foreign = await throughServe(inbox, "/api/inbox/search/recent", {
      method: "POST",
      headers: { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site", "Content-Type": "application/json" },
      body: JSON.stringify({ q: "x" }),
    });
    expect(foreign.status).toBe(403);
  });

  test("/mcp answers only a loopback Host, even when PLANNOTATOR_ALLOWED_HOSTS widens the window", async () => {
    const dataDir = world();
    setEnv("PLANNOTATOR_ALLOWED_HOSTS", "*");
    const inbox = await start(dataDir, fakeTailscale().run);
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const far = await fetch(`http://127.0.0.1:${inbox.port}/mcp`, { method: "POST", headers: { ...headers, Host: `${MAGIC}:${inbox.port}` }, body });
    expect(await codeOf(far)).toEqual([403, "forbidden_host"]);
    const near = await fetch(`http://127.0.0.1:${inbox.port}/mcp`, { method: "POST", headers, body });
    expect(near.status).toBe(200);
  });

  test("the Settings switch saves config.json and applies at once; a clean stop takes the mapping down and the next start publishes again", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run);
    const main = `http://127.0.0.1:${inbox.port}`;
    expect(inbox.tailscale.state()).toMatchObject({ on: false, source: "default", url: null });
    expect(ts.calls).toEqual([]);
    expect(registryOf(dataDir).tailscale).toBeUndefined();

    const set = (on: boolean) => fetch(`${main}/api/inbox/settings`, { method: "POST", body: JSON.stringify({ tailscale: { on } }) });
    const turnedOn = (await (await set(true)).json()) as Json;
    expect(turnedOn.tailscale).toMatchObject({ on: true, source: "config", url: `https://${MAGIC}:${inbox.port}/` });
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxTailscale).toBe(true);
    const listener = inbox.tailscale.listenerPort()!;
    expect(ts.serve.get(inbox.port)).toBe(`http://127.0.0.1:${listener}`);

    const turnedOff = (await (await set(false)).json()) as Json;
    expect(turnedOff.tailscale).toMatchObject({ on: false, url: null });
    expect(ts.serve.size).toBe(0);
    expect(await fetch(`http://127.0.0.1:${listener}/`).then(() => "answered", () => "closed")).toBe("closed");
    expect(registryOf(dataDir).tailscale).toBeUndefined();

    // Off while Tailscale cannot answer: nothing changes and the window is told.
    await set(true);
    ts.down.status = true;
    expect(await codeOf(await set(false))).toEqual([409, "tailscale_unavailable"]);
    expect(ts.serve.has(inbox.port)).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxTailscale).toBe(true);
    ts.down.status = false;

    // A clean stop: the mapping goes, the switch stays on, the next start (same port) publishes again.
    const port = inbox.port;
    inbox.stop();
    servers.splice(servers.indexOf(inbox), 1);
    expect(ts.serve.size).toBe(0);
    expect(registryOf(dataDir).tailscale).toBeUndefined();
    const next = await start(dataDir, ts.run);
    expect(next.port).toBe(port);
    expect(ts.serve.get(port)).toBe(`http://127.0.0.1:${next.tailscale.listenerPort()}`);

    // The env var decides: the switch is locked.
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", "0");
    const locked = await fetch(`http://127.0.0.1:${next.port}/api/inbox/settings`, { method: "POST", body: JSON.stringify({ tailscale: { on: false } }) });
    expect(await codeOf(locked)).toEqual([409, "tailscale_env_decides"]);
    expect(next.tailscale.state()).toMatchObject({ env: false, source: "env" });
  });

  test("restart to update takes the mapping down before the new run starts", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    let atRestart: string | undefined = "not called";
    const inbox = await start(dataDir, ts.run, { onRestartRequested: () => (atRestart = ts.serve.get(inbox.port)) });
    expect(ts.serve.has(inbox.port)).toBe(true);
    expect((await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/restart`, { method: "POST", body: "{}" })).status).toBe(200);
    await Bun.sleep(150);
    expect(atRestart).toBeUndefined();
  });

  test("the stop route says whether the run was published by the flag alone, so `plannotator inbox restart` publishes the next run again", async () => {
    const stopAnswer = async (inbox: InboxServer) =>
      (await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/control/stop`, { method: "POST", headers: { Authorization: `Bearer ${inbox.token}` } })).json()) as Json;
    const ts = fakeTailscale();
    const flagged = await start(world(), ts.run, { publishTailnet: true, onStopRequested: () => {} });
    expect(await stopAnswer(flagged)).toMatchObject({ stopping: true, tailscale_run_only: true });
    // Kept on in config.json: the next start publishes by itself, so the restart adds no flag.
    const kept = await start(world({ inboxTailscale: true }), ts.run, { onStopRequested: () => {} });
    expect(await stopAnswer(kept)).toMatchObject({ stopping: true, tailscale_run_only: false });
  });

  test("the run's flag and the control route publish for this run only, and say so", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const flagged = await start(dataDir, ts.run, { publishTailnet: true });
    expect(flagged.tailscale.state()).toMatchObject({ on: true, source: "flag" });
    expect(flagged.tailscale.runOnly()).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxTailscale).toBeUndefined();
    flagged.stop();
    servers.splice(0);

    // `plannotator inbox --tailscale` against a running Inbox: its token-guarded control route.
    const inbox = await start(dataDir, ts.run);
    expect(ts.serve.size).toBe(0);
    const route = `http://127.0.0.1:${inbox.port}/api/inbox/control/tailscale`;
    expect((await fetch(route, { method: "POST" })).status).toBe(401);
    expect((await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${inbox.token}`, Origin: "http://localhost" } })).status).toBe(403);
    const answer = (await (await fetch(route, { method: "POST", headers: { Authorization: `Bearer ${inbox.token}` } })).json()) as Json;
    expect(answer.tailscale).toMatchObject({ on: true, source: "flag", url: `https://${MAGIC}:${inbox.port}/` });
    expect(ts.serve.has(inbox.port)).toBe(true);
    expect(inbox.tailscale.runOnly()).toBe(true);
    // Settings' "Keep it on at every start": the saved switch decides from now on.
    const kept = (await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`, { method: "POST", body: JSON.stringify({ tailscale: { on: true } }) })).json()) as Json;
    expect(kept.tailscale).toMatchObject({ on: true, source: "config" });
    expect(inbox.tailscale.runOnly()).toBe(false);
  });

  test("Tailscale missing, stopped or signed out never stops the Inbox: it runs locally and says why", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    ts.down.status = true;
    const inbox = await start(dataDir, ts.run);
    expect((await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/threads`)).status).toBe(200);
    const state = inbox.tailscale.state();
    expect(state.on).toBe(true);
    expect(state.url).toBeNull();
    // Tailscale's reason, as describeTailscaleFailure words it, reaches the window.
    expect(state.error).toContain(describeTailscaleFailure({ status: 1, stdout: "", stderr: "Tailscale is stopped." }));
    expect(inbox.tailscale.listenerPort()).toBeNull();
    expect(registryOf(dataDir).tailscale).toMatchObject({ url: null, error: state.error });
    const settings = (await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`)).json()) as Json;
    expect(settings.tailscale.error).toBe(state.error);
  });

  test("a mapping someone else made on the Inbox's port is never replaced", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const probe = await start(dataDir, ts.run);
    const port = probe.port;
    probe.stop();
    servers.splice(0);
    ts.serve.set(port, "http://127.0.0.1:3000");
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true }));
    const inbox = await start(dataDir, ts.run);
    expect(inbox.port).toBe(port);
    expect(inbox.tailscale.state().error).toContain(`tailscale serve --https=${port} off`);
    expect(ts.serve.get(port)).toBe("http://127.0.0.1:3000");
    inbox.stop();
    servers.splice(0);
    expect(ts.serve.get(port)).toBe("http://127.0.0.1:3000");
  });

  test("a tagged machine has no owner: refused unless inboxTailscaleAllow names someone, who is then the only login let in", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale({ tagged: true });
    const refused = await start(dataDir, ts.run);
    expect(refused.tailscale.state().error).toContain("tagged Tailscale device");
    expect(ts.serve.size).toBe(0);
    refused.stop();
    servers.splice(0);

    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: true, inboxTailscaleAllow: [" Me@Example.com ", "me@example.com", "not a login", 7] }));
    const inbox = await start(dataDir, ts.run);
    expect(inbox.tailscale.state()).toMatchObject({ owner: null, allowed: ["me@example.com"] });
    expect((await throughServe(inbox, "/api/inbox/threads", { login: "me@example.com" })).status).toBe(200);
    expect(await codeOf(await throughServe(inbox, "/api/inbox/threads", { login: "tagged-devices" }))).toEqual([403, "tailnet_identity_refused"]);
  });

  test("after a crash the leftover mapping is re-pointed by the next start, or taken down when the switch is off, or by uninstall --purge", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const crashed = await start(dataDir, ts.run);
    const port = crashed.port;
    const deadTarget = ts.serve.get(port)!;
    const deadRegistry = registryOf(dataDir);
    crashed.stop();
    servers.splice(0);
    // kill -9: no clean stop, so the mapping and the registry's ports stay.
    ts.serve.set(port, deadTarget);
    writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify(deadRegistry));

    const repointed = await start(dataDir, ts.run);
    expect(ts.serve.get(port)).toBe(`http://127.0.0.1:${repointed.tailscale.listenerPort()}`);
    repointed.stop();
    servers.splice(0);

    ts.serve.set(port, deadTarget);
    writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify(deadRegistry));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: false }));
    const off = await start(dataDir, ts.run);
    expect(ts.serve.has(port)).toBe(false);
    expect(registryOf(dataDir).tailscale).toBeUndefined();
    off.stop();
    servers.splice(0);

    // uninstall --purge with the Inbox stopped: by the ports inbox.json kept.
    ts.serve.set(port, deadTarget);
    writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify(deadRegistry));
    expect(takeDownInboxTailscale(dataDir, ts.run)).toBe("removed");
    expect(ts.serve.has(port)).toBe(false);
    expect(takeDownInboxTailscale(dataDir, ts.run)).toBe("none");
    ts.serve.set(port, "http://127.0.0.1:3000");
    expect(takeDownInboxTailscale(dataDir, ts.run)).toBe("none");
    expect(ts.serve.get(port)).toBe("http://127.0.0.1:3000");
  });

  test("switch off, Tailscale down at start: a leftover mapping and its record are kept (never forgotten), then removed by the next start or uninstall --purge", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const crashed = await start(dataDir, ts.run);
    const port = crashed.port;
    const deadTarget = ts.serve.get(port)!;
    const deadRegistry = registryOf(dataDir);
    crashed.stop();
    servers.splice(0);
    // kill -9 left both; the person then turned the switch off; Tailscale is down at the next start.
    ts.serve.set(port, deadTarget);
    writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify(deadRegistry));
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTailscale: false }));
    ts.down.status = true;
    const down = await start(dataDir, ts.run);
    expect(ts.serve.get(port)).toBe(deadTarget);
    expect(registryOf(dataDir).tailscale).toMatchObject({ https_port: port, proxy_port: deadRegistry.tailscale.proxy_port });
    expect(down.tailscale.state().error).toContain(`tailscale serve --https=${port} off`);
    // A clean stop while it is still down keeps the record too.
    down.stop();
    servers.splice(0);
    expect(registryOf(dataDir).tailscale).toMatchObject({ https_port: port, proxy_port: deadRegistry.tailscale.proxy_port });
    // uninstall --purge finds it by the record.
    ts.down.status = false;
    expect(takeDownInboxTailscale(dataDir, ts.run)).toBe("removed");
    expect(ts.serve.has(port)).toBe(false);
    // And the next start (Tailscale up) removes a kept one and forgets the record.
    ts.serve.set(port, deadTarget);
    const up = await start(dataDir, ts.run);
    expect(ts.serve.has(port)).toBe(false);
    expect(registryOf(dataDir).tailscale).toBeUndefined();
    expect(up.tailscale.state().error).toBeNull();
  });

  test("the record is written before the mapping is made, and every start removes a recorded mapping whose proxy port is not this run's before it publishes", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const atServe: (number | undefined)[] = [];
    const order: string[] = [];
    const run: TailscaleRunner = (args, timeout) => {
      if (args.includes("--bg")) atServe.push(JSON.parse(readFileSync(join(dataDir, "inbox", "inbox.json"), "utf8")).tailscale?.proxy_port);
      if (args[0] === "serve" && args.includes("off")) order.push(`off ${ts.serve.get(Number(/--https=(\d+)/.exec(args.join(" "))![1]))}`);
      if (args.includes("--bg")) order.push(`bg ${args.at(-1)}`);
      return ts.run(args, timeout);
    };
    const first = await start(dataDir, run);
    expect(atServe).toEqual([first.tailscale.listenerPort()!]);
    const deadTarget = ts.serve.get(first.port)!;
    const deadRegistry = registryOf(dataDir);
    first.stop();
    servers.splice(0);
    ts.serve.set(first.port, deadTarget);
    writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify(deadRegistry));
    order.length = 0;
    const next = await start(dataDir, run);
    // The dead proxy port's mapping goes first, then the new one is made.
    expect(order).toEqual([`off ${deadTarget}`, `bg http://127.0.0.1:${next.tailscale.listenerPort()}`]);
    expect(ts.serve.get(next.port)).not.toBe(deadTarget);
  });

  test("a hand-made mapping onto the window's own port: every request through it is refused, Settings says it exposes the whole Inbox, and replacing it publishes the owner-only address", async () => {
    const dataDir = world();
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run);
    const main = `http://127.0.0.1:${inbox.port}`;
    // The user's workaround: `tailscale serve --https=<P> http://127.0.0.1:<P>`, and another mapping of theirs on 443.
    ts.serve.set(inbox.port, `http://127.0.0.1:${inbox.port}`);
    ts.serve.set(443, "http://127.0.0.1:5274");
    expect(inbox.tailscale.state().exposed).toEqual([]);

    // What serve always adds (a local client never sends it): refused on the window's port, /mcp included, whatever Host is claimed.
    for (const header of ["Tailscale-Headers-Info", "Tailscale-User-Login", "X-Forwarded-For"]) {
      for (const path of ["/api/inbox/threads", "/mcp", "/"]) {
        const response = await fetch(`${main}${path}`, { method: path === "/mcp" ? "POST" : "GET", headers: { [header]: "100.64.0.9", Host: `127.0.0.1:${inbox.port}` } });
        expect([header, path, response.status]).toEqual([header, path, 403]);
      }
    }

    // A purely local reverse proxy adding loopback X-Forwarded-For is allowed (#1867)
    for (const loopbackFwd of ["127.0.0.1", "127.0.0.1, 127.0.0.2", "::1", "localhost", "127.0.0.1:8080"]) {
      const resp = await fetch(`${main}/api/inbox/threads`, { headers: { "X-Forwarded-For": loopbackFwd, Host: `127.0.0.1:${inbox.port}` } });
      expect([loopbackFwd, resp.status]).toEqual([loopbackFwd, 200]);
    }

    expect((await fetch(`${main}/api/inbox/threads`)).status).toBe(200);
    const settings = (await (await fetch(`${main}/api/inbox/settings`)).json()) as Json;
    expect(settings.tailscale.exposed).toEqual([{ https_port: inbox.port, target: `http://127.0.0.1:${inbox.port}` }]);

    // Turning the switch on does not take it over silently.
    const set = (body: Json) => fetch(`${main}/api/inbox/settings`, { method: "POST", body: JSON.stringify({ tailscale: body }) });
    const plain = (await (await set({ on: true })).json()) as Json;
    expect(plain.tailscale.error).toContain("exposes the whole Inbox");
    expect(ts.serve.get(inbox.port)).toBe(`http://127.0.0.1:${inbox.port}`);

    // Replace: the exposing mapping goes, the owner-only one takes its port; the other mapping is untouched.
    const replaced = (await (await set({ on: true, replace_exposed: true })).json()) as Json;
    expect(replaced.tailscale).toMatchObject({ on: true, url: `https://${MAGIC}:${inbox.port}/`, error: null, exposed: [] });
    expect(ts.serve.get(inbox.port)).toBe(`http://127.0.0.1:${inbox.tailscale.listenerPort()}`);
    expect(ts.serve.get(443)).toBe("http://127.0.0.1:5274");
    expect((await throughServe(inbox, "/api/inbox/threads")).status).toBe(200);
    expect(await codeOf(await throughServe(inbox, "/mcp", { method: "POST", body: "{}" }))).toEqual([403, "local_only"]);
  });

  test("turning the switch off through the tailnet answers before the listener closes", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run);
    const listener = inbox.tailscale.listenerPort()!;
    const own = { Origin: `https://${MAGIC}:${inbox.port}`, "Content-Type": "application/json" };
    const off = await throughServe(inbox, "/api/inbox/settings", { method: "POST", headers: own, body: JSON.stringify({ tailscale: { on: false } }) });
    expect(off.status).toBe(200);
    expect(((await off.json()) as Json).tailscale).toMatchObject({ on: false, url: null });
    expect(ts.serve.size).toBe(0);
    await Bun.sleep(400);
    expect(await fetch(`http://127.0.0.1:${listener}/`).then(() => "answered", () => "closed")).toBe("closed");
  });

  test("a Settings change the Inbox refuses saves nothing else in the same request", async () => {
    const dataDir = world();
    const inbox = await start(dataDir, fakeTailscale().run);
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", "0");
    const response = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`, {
      method: "POST",
      body: JSON.stringify({ notifications: { enabled: false }, inbox_tool: { pi: true }, tailscale: { on: true } }),
    });
    expect(await codeOf(response)).toEqual([409, "tailscale_env_decides"]);
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    expect(config.inboxNotifications).toBeUndefined();
    expect(config.inboxTool).toBeUndefined();
    // A bad part is refused before the tailnet change runs.
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
    const bad = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`, { method: "POST", body: JSON.stringify({ notifications: { nope: 1 }, tailscale: { on: true } }) });
    expect(bad.status).toBe(422);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxTailscale).toBeUndefined();
  });

  test("PLANNOTATOR_INBOX_TAILSCALE=0 is a hard off: it beats --tailscale and the control route", async () => {
    const dataDir = world();
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", "0");
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run, { publishTailnet: true });
    expect(inbox.tailscale.state()).toMatchObject({ on: false, source: "env", env: false, url: null });
    const answer = (await (await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/control/tailscale`, { method: "POST", headers: { Authorization: `Bearer ${inbox.token}` } })).json()) as Json;
    expect(answer.tailscale).toMatchObject({ on: false, source: "env" });
    expect(ts.calls).toEqual([]);
    expect(ts.serve.size).toBe(0);
  });

  test("with Phones on, the two publications never meet: Phones on 8443 to its door, the window on its own port to its own listener", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run, { phones: true });
    const on = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/tailnet`, { method: "POST", body: JSON.stringify({ on: true }) });
    expect(on.status).toBe(200);
    expect(inbox.port).not.toBe(8443);
    expect([...ts.serve.keys()].sort()).toEqual([8443, inbox.port].sort());
    expect(ts.serve.get(8443)).not.toBe(ts.serve.get(inbox.port));
    // The window's listener never serves the device door.
    expect(await codeOf(await throughServe(inbox, "/api/inbox/device/health"))).toEqual([403, "local_only"]);
    inbox.stop();
    servers.splice(0);
    expect(ts.serve.size).toBe(0);
  });
});

describe("the update control never answers through the tailnet", () => {
  test("Update now, snooze, Check now, the facts, What's new and the update switches are local only; nothing is launched or written", async () => {
    const dataDir = world({ inboxTailscale: true });
    writeFileSync(join(dataDir, "update-state.json"), JSON.stringify({ latestRelease: { tag: "0.28.12", fetchedAt: Date.now() } }));
    const ts = fakeTailscale();
    const launches: unknown[] = [];
    const inbox = await start(dataDir, ts.run, {
      version: "0.28.10",
      updates: {
        fetchRelease: async () => ({ ok: true, release: { tag: "v0.28.12" } }),
        isManaged: () => true,
        listSessions: () => [],
        launchInstaller: (launch) => void launches.push(launch),
      },
    });
    const own = { Origin: `https://${MAGIC}:${inbox.port}`, "Content-Type": "application/json" };
    const calls: [string, string, Json | undefined][] = [
      ["POST", "/api/inbox/update", { serverSession: inbox.serverSession }],
      ["POST", "/api/inbox/update/snooze", { serverSession: inbox.serverSession }],
      ["POST", "/api/inbox/update/check", { serverSession: inbox.serverSession }],
      ["GET", "/api/inbox/update", undefined],
      ["GET", "/api/inbox/whats-new?version=0.28.12", undefined],
      ["GET", "/api/inbox/whats-new/image?version=0.28.12&src=https%3A%2F%2Fgithub.com%2Fuser-attachments%2Fassets%2Fa", undefined],
      ["POST", "/api/inbox/settings", { serverSession: inbox.serverSession, auto_update: true }],
      ["POST", "/api/inbox/settings", { serverSession: inbox.serverSession, update_check: false }],
      // The address this computer's browser opens (#2184).
      ["POST", "/api/inbox/settings", { serverSession: inbox.serverSession, cookie_host: true }],
    ];
    for (const [method, path, body] of calls) {
      const response = await throughServe(inbox, path, { method, headers: own, ...(body ? { body: JSON.stringify(body) } : {}) });
      expect([method, path, ...(await codeOf(response))]).toEqual([method, path, 403, "local_only"]);
    }
    expect(launches).toEqual([]);
    const config = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    expect(config.autoUpdate).toBeUndefined();
    expect(config.updateCheck).toBeUndefined();
    expect(config.urlHost).toBeUndefined();
    // A page through the tailnet is not shown the cookie switch at all.
    const shown = await throughServe(inbox, "/api/inbox/settings", { method: "GET", headers: own });
    expect(shown.status).toBe(200);
    expect((await shown.json()).cookie_host).toBeUndefined();
    // Nor in the answer to a save it may make.
    const saved = await throughServe(inbox, "/api/inbox/settings", {
      method: "POST",
      headers: own,
      body: JSON.stringify({ serverSession: inbox.serverSession, text_size: 14 }),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()).cookie_host).toBeUndefined();
    // The same Update now works on this computer.
    const local = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/update`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(local.status).toBe(200);
    expect(launches).toHaveLength(1);
  });

  test("the one-time sound dialog is never claimed through the tailnet; it waits for a page on this computer", async () => {
    const dataDir = world({ inboxTailscale: true });
    writeFileSync(join(dataDir, "update-state.json"), JSON.stringify({ inboxVersion: "0.28.9" }));
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run, {
      version: "0.28.10",
      updates: { fetchRelease: async () => ({ ok: false, error: "offline" }), isManaged: () => false, listSessions: () => [] },
    });
    const own = { Origin: `https://${MAGIC}:${inbox.port}`, "Content-Type": "application/json" };
    const remote = await throughServe(inbox, "/api/inbox/sound/dialog", { method: "POST", headers: own, body: JSON.stringify({ serverSession: inbox.serverSession }) });
    expect(remote.status).toBe(200);
    expect(((await remote.json()) as Json).show).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).inboxSound).toEqual({ dialogDueFor: "0.28.10" });
    const local = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/sound/dialog`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: inbox.serverSession }),
    });
    expect(((await local.json()) as Json).show).toBe(true);
  });

  // The Inbox reminder goes into every agent session on this computer: the
  // owner's page over the tailnet reads Settings → Prompts but cannot change it.
  test("Settings → Prompts is read-only through the tailnet", async () => {
    const dataDir = world({ inboxTailscale: true });
    const ts = fakeTailscale();
    const inbox = await start(dataDir, ts.run);
    const own = { Origin: `https://${MAGIC}:${inbox.port}`, "Content-Type": "application/json" };
    const read = await throughServe(inbox, "/api/inbox/settings", { headers: own });
    expect(read.status).toBe(200);
    expect((((await read.json()) as Json).prompts as { reminder: { editable: boolean } }).reminder.editable).toBe(false);
    const write = await throughServe(inbox, "/api/inbox/settings", {
      method: "POST",
      headers: own,
      body: JSON.stringify({ serverSession: inbox.serverSession, prompts: { inbox: { reminder: "Mine." } } }),
    });
    expect(await codeOf(write)).toEqual([403, "local_only"]);
    expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8")).prompts).toBeUndefined();
    const local = await fetch(`http://127.0.0.1:${inbox.port}/api/inbox/settings`);
    expect((((await local.json()) as Json).prompts as { reminder: { editable: boolean } }).reminder.editable).toBe(true);
  });
});
