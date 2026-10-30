/**
 * The documents behind live HTML embeds (approval "inbox-inline-html";
 * inbox-embeds.ts) through a running Inbox (temp data dir, loopback). What
 * regresses if these fail:
 * - the page is served without its own sandboxing policy (it would run on
 *   the Inbox's origin when its URL is opened), or as something other than
 *   the built document (no bootstrap: no theme, no height);
 * - another site, or the sandboxed page itself (`Origin: null`), can store a
 *   page on the Inbox;
 * - over the tailnet, a page's own request (cross-site, carrying the owner's
 *   tailnet identity) reaches an embed or any other route;
 * - the store grows without bound.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBED_BOOTSTRAP, EMBED_MAX_BYTES, EMBED_RESPONSE_CSP } from "@plannotator/core/html-embed";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { startInboxServer, type InboxServer } from "./inbox";
import { createInboxEmbeds, embedIdOf } from "./inbox-embeds";

type Json = Record<string, any>;

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

async function start(extra: Partial<Parameters<typeof startInboxServer>[0]> = {}, config?: Json) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-embeds-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (config) {
    setEnv("PLANNOTATOR_DATA_DIR", dataDir);
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  }
  const server = await startInboxServer({ dataDir, binaryPath: null, setAsideDelayMs: 60_000, ...extra });
  servers.push(server);
  return server;
}

const at = (server: InboxServer, path: string) => `http://127.0.0.1:${server.port}${path}`;
const keep = (server: InboxServer, html: unknown, headers: Record<string, string> = {}) =>
  fetch(at(server, "/api/inbox/embeds"), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ html }) });

const CHART = '<svg width="80" height="40"><rect width="80" height="40" fill="var(--chart-1)"/></svg>';

describe("the Inbox's embed documents", () => {
  test("the window keeps a page and gets it back under its own sandboxing policy", async () => {
    const server = await start();
    const kept = await keep(server, CHART);
    expect(kept.status).toBe(200);
    const { id, url } = (await kept.json()) as Json;
    expect(id).toBe(embedIdOf(CHART));
    expect(url).toBe(`/api/inbox/embeds/${id}`);

    const page = await fetch(at(server, url));
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toBe(EMBED_RESPONSE_CSP);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const doc = await page.text();
    expect(doc).toContain(EMBED_BOOTSTRAP);
    expect(doc.endsWith(CHART)).toBe(true);
  });

  test("another site and a sandboxed page cannot store a page", async () => {
    const server = await start();
    expect((await keep(server, CHART, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await keep(server, CHART, { Origin: "null" })).status).toBe(403);
    expect((await keep(server, CHART, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await fetch(at(server, `/api/inbox/embeds/${embedIdOf(CHART)}`))).status).toBe(404);
  });

  test("refusals: an empty or oversized page, an unknown or malformed id, other methods", async () => {
    const server = await start();
    expect((await keep(server, "   ")).status).toBe(400);
    expect((await keep(server, 42)).status).toBe(400);
    expect((await keep(server, "x".repeat(EMBED_MAX_BYTES + 1))).status).toBe(413);
    expect((await fetch(at(server, `/api/inbox/embeds/${"0".repeat(32)}`))).status).toBe(404);
    expect((await fetch(at(server, "/api/inbox/embeds/..%2Finbox.json"))).status).toBe(404);
    expect((await fetch(at(server, "/api/inbox/embeds"))).status).toBe(405);
    const { url } = (await (await keep(server, CHART)).json()) as Json;
    expect((await fetch(at(server, url), { method: "DELETE" })).status).toBe(405);
  });

  test("over the tailnet the owner's window keeps and frames a page; the page's own cross-site request is refused", async () => {
    const MAGIC = "macbook-pro.tail0000.ts.net";
    const OWNER = "ramos@example.com";
    setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
    const serve = new Map<number, string>();
    const run: TailscaleRunner = (args) => {
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
      return ok(`https://${MAGIC}:${httpsPort}/\n`);
    };
    const server = await start({ phones: false, tailscale: run }, { inboxTailscale: true });
    const listener = server.tailscale.listenerPort()!;
    const origin = `https://${MAGIC}:${server.port}`;
    const through = (path: string, init: RequestInit & { headers: Record<string, string> }) =>
      fetch(`http://127.0.0.1:${listener}${path}`, { ...init, headers: { Host: `${MAGIC}:${server.port}`, "Tailscale-User-Login": OWNER, ...init.headers } });

    // The owner's window stores the page (a same-origin write) and frames it (a same-origin navigation).
    const kept = await through("/api/inbox/embeds", {
      method: "POST",
      headers: { Origin: origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json" },
      body: JSON.stringify({ html: CHART }),
    });
    expect(kept.status).toBe(200);
    const { url } = (await kept.json()) as Json;
    const framed = await through(url, { headers: { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" } });
    expect(framed.status).toBe(200);
    expect(framed.headers.get("content-security-policy")).toBe(EMBED_RESPONSE_CSP);

    // The page's own requests come from an opaque origin: the browser marks them cross-site.
    for (const path of [url, "/api/inbox/threads", "/api/inbox/health"]) {
      const answer = await through(path, { headers: { Origin: "null", "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors" } });
      expect(answer.status).toBe(403);
      expect(((await answer.json()) as Json).code).toBe("cross_site");
    }
  });
});

describe("the embed store", () => {
  const json = (body: unknown, status = 200) => Response.json(body, { status });
  const post = (html: string) =>
    new Request("http://127.0.0.1/api/inbox/embeds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html }) });
  const readBody = async (req: Request) => (await req.json()) as Record<string, unknown>;
  const route = (store: ReturnType<typeof createInboxEmbeds>, req: Request) => store.route(req, new URL(req.url));

  test("a page sent twice is kept once; past the limit the oldest goes first", async () => {
    const store = createInboxEmbeds({ readBody, json, maxEntries: 2 });
    await route(store, post("<p>one</p>"));
    await route(store, post("<p>one</p>"));
    expect(store.size()).toBe(1);
    await route(store, post("<p>two</p>"));
    // Asking for "one" again makes it the newest, so "two" is the oldest when "three" arrives.
    await route(store, post("<p>one</p>"));
    await route(store, post("<p>three</p>"));
    expect(store.size()).toBe(2);
    const status = async (html: string) => (await route(store, new Request(`http://127.0.0.1/api/inbox/embeds/${embedIdOf(html)}`)))!.status;
    expect(await status("<p>one</p>")).toBe(200);
    expect(await status("<p>three</p>")).toBe(200);
    expect(await status("<p>two</p>")).toBe(404);
  });

  test("the byte limit evicts too, but never the page just kept", async () => {
    const store = createInboxEmbeds({ readBody, json, maxBytes: 1 });
    await route(store, post("<p>one</p>"));
    await route(store, post("<p>two</p>"));
    expect(store.size()).toBe(1);
    expect((await route(store, new Request(`http://127.0.0.1/api/inbox/embeds/${embedIdOf("<p>two</p>")}`)))!.status).toBe(200);
  });
});
