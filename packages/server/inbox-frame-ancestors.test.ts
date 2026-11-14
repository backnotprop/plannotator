/**
 * A trusted app on this computer framing the Inbox window (#3299, config.json
 * `inboxFrameAncestors`, inbox-framing.ts), against a real Inbox on loopback.
 * The rules for which origins are kept are in inbox-framing.test.ts. What
 * regresses if these fail:
 * - with a list, the window's port still says DENY / 'none' (the host shows
 *   a blank frame), or the documents the window frames itself stay 'self'
 *   only (attached pages, html fences and the tour go blank inside the host);
 * - with a list, the tailnet listener or the device door (phones, linked
 *   machines) answers anything other than what it answers without one;
 * - a list made only of refused entries changes anything at all;
 * - framing grants the host page the Inbox's API: its own writes and reads
 *   must still be refused as another site's.
 * Temp PLANNOTATOR_DATA_DIR only; the real `tailscale` never runs.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMBED_RESPONSE_CSP } from "@plannotator/core/html-embed";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { INBOX_WINDOW_CSP, startInboxServer, type InboxServer } from "./inbox";
import { INBOX_PAGE_CSP } from "./inbox-pages";
import { INBOX_TOUR_MOCK_CSP } from "./inbox-tour";

type Json = Record<string, any>;

const HOSTS = ["app://hermes", "http://localhost:5173"];
const PAGE = "<!doctype html><title>Inbox</title><p>the window</p>";
const MOCK = "/api/inbox/tour/assets/vscode-mockups.html";
const MAGIC = "macbook-pro.tail0000.ts.net";
const OWNER = "owner@example.com";

const roots: string[] = [];
const servers: InboxServer[] = [];
const restoreEnv: (() => void)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  // Newest first: a test that makes two worlds gets the env it started with back.
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

/** A temp data dir that loadConfig() reads too, with config.json as given. */
function world(config: Json = {}): string {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-frame-ancestors-")));
  roots.push(dataDir);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  setEnv("PLANNOTATOR_INBOX_PHONES", undefined);
  writeFileSync(join(dataDir, "config.json"), JSON.stringify(config));
  return dataDir;
}

async function start(dataDir: string, extra: Parameters<typeof startInboxServer>[0] = {}): Promise<InboxServer> {
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, htmlContent: PAGE, ...extra });
  servers.push(server);
  return server;
}

/** Tailscale as a scripted CLI: who owns this machine, and serve on and off. */
function fakeTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[0] === "status") {
      return ok(JSON.stringify({ BackendState: "Running", Self: { DNSName: `${MAGIC}.`, UserID: 42 }, User: { "42": { ID: 42, LoginName: OWNER, DisplayName: "Owner" } } }));
    }
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`${MAGIC}:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) serve.delete(httpsPort);
    else serve.set(httpsPort, args.at(-1)!);
    return ok();
  };
}

const base = (inbox: InboxServer) => `http://127.0.0.1:${inbox.port}`;
const directives = (csp: string) => new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));
const ancestorsOf = (res: Response) => directives(res.headers.get("content-security-policy") ?? "").get("frame-ancestors");

/** The window's own write: same origin, as the page sends it. */
async function keep(inbox: InboxServer, route: "pages" | "embeds", html: string, headers: Record<string, string> = { Origin: base(inbox), "Sec-Fetch-Site": "same-origin" }, at = base(inbox)): Promise<string> {
  const res = await fetch(`${at}/api/inbox/${route}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ html }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as Json).url;
}

test("with a list, the window's port: no X-Frame-Options and frame-ancestors exactly the kept origins, on the 200, HEAD and 304, every other directive as it was", async () => {
  const inbox = await start(world(), { frameAncestors: ["app://hermes", "*", "file://", "https://example.com", "http://localhost:5173"] });
  const page = await fetch(`${base(inbox)}/`, { headers: { "Sec-Fetch-Dest": "iframe" } });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe(PAGE);
  expect(page.headers.get("x-frame-options")).toBeNull();
  expect(ancestorsOf(page)).toEqual(HOSTS);
  const csp = directives(page.headers.get("content-security-policy")!);
  const before = directives(INBOX_WINDOW_CSP);
  expect([...csp.keys()]).toEqual([...before.keys()]);
  for (const [name, values] of before) if (name !== "frame-ancestors") expect([name, csp.get(name)]).toEqual([name, values]);
  expect(page.headers.get("x-content-type-options")).toBe("nosniff");
  expect(page.headers.get("referrer-policy")).toBe("no-referrer");

  const head = await fetch(`${base(inbox)}/`, { method: "HEAD" });
  expect(head.headers.get("x-frame-options")).toBeNull();
  expect(ancestorsOf(head)).toEqual(HOSTS);
  const again = await fetch(`${base(inbox)}/`, { headers: { "If-None-Match": page.headers.get("etag")! } });
  expect(again.status).toBe(304);
  expect(again.headers.get("x-frame-options")).toBeNull();
  expect(ancestorsOf(again)).toEqual(HOSTS);
});

test("a list of refused entries only, or none, changes nothing: DENY and the window's policy as it was, the documents' policies as they were", async () => {
  for (const frameAncestors of [["*", "'self'", "file://", "https://example.com", "http://localhost"], undefined]) {
    const inbox = await start(world(), frameAncestors ? { frameAncestors } : {});
    const page = await fetch(`${base(inbox)}/`);
    expect(page.headers.get("x-frame-options")).toBe("DENY");
    expect(page.headers.get("content-security-policy")).toBe(INBOX_WINDOW_CSP);
    expect((await fetch(`${base(inbox)}${await keep(inbox, "pages", "<p>a page</p>")}`)).headers.get("content-security-policy")).toBe(INBOX_PAGE_CSP);
    expect((await fetch(`${base(inbox)}${await keep(inbox, "embeds", "<p>a fence</p>")}`)).headers.get("content-security-policy")).toBe(EMBED_RESPONSE_CSP);
    expect((await fetch(`${base(inbox)}${MOCK}`)).headers.get("content-security-policy")).toBe(INBOX_TOUR_MOCK_CSP);
  }
});

test("with a list, the documents the window frames itself send 'self' plus the list: an attached page, the gone page, an html fence, the tour's mock", async () => {
  const inbox = await start(world(), { frameAncestors: HOSTS });
  // The frame's own navigation, from inside the window: same-origin, as a browser sends it inside the host too.
  const nav = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" };
  const page = await fetch(`${base(inbox)}${await keep(inbox, "pages", "<!doctype html><h1>Attached</h1>")}`, { headers: nav });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe("<!doctype html><h1>Attached</h1>");
  expect(ancestorsOf(page)).toEqual(["'self'", ...HOSTS]);
  const gone = await fetch(`${base(inbox)}/api/inbox/pages/0123456789abcdef0123456789abcdef`, { headers: nav });
  expect(gone.status).toBe(404);
  expect(ancestorsOf(gone)).toEqual(["'self'", ...HOSTS]);
  const fence = await fetch(`${base(inbox)}${await keep(inbox, "embeds", "<p>a fence</p>")}`, { headers: nav });
  expect(fence.status).toBe(200);
  expect(ancestorsOf(fence)).toEqual(["'self'", ...HOSTS]);
  const mock = await fetch(`${base(inbox)}${MOCK}`, { headers: nav });
  expect(mock.status).toBe(200);
  expect(ancestorsOf(mock)).toEqual(["'self'", ...HOSTS]);
});

test("framing grants the host page nothing: its own writes and reads are refused as another site's, a listed origin or not", async () => {
  const inbox = await start(world(), { frameAncestors: HOSTS });
  for (const [origin, site] of [["app://hermes", "cross-site"], ["http://localhost:5173", "same-site"], ["null", "cross-site"]] as const) {
    const write = await fetch(`${base(inbox)}/api/inbox/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, "Sec-Fetch-Site": site },
      body: JSON.stringify({ html: "<p>from the host</p>" }),
    });
    expect([origin, write.status, ((await write.json()) as Json).code]).toEqual([origin, 403, "cross_origin"]);
    const cards = await fetch(`${base(inbox)}/api/inbox/cards`, { headers: { Origin: origin, "Sec-Fetch-Site": site } });
    expect([origin, cards.status]).toEqual([origin, 403]);
    const tour = await fetch(`${base(inbox)}/api/inbox/tour/fixture.json`, { headers: { "Sec-Fetch-Site": site } });
    expect([origin, tour.status]).toEqual([origin, 403]);
  }
});

test("config.json's list frames the window's port; the tailnet listener answers DENY / 'none' and the documents 'self' only, as without it", async () => {
  const dataDir = world({ inboxTailscale: true, inboxFrameAncestors: HOSTS });
  const inbox = await start(dataDir, { tailscale: fakeTailscale() });
  const local = await fetch(`${base(inbox)}/`);
  expect(local.headers.get("x-frame-options")).toBeNull();
  expect(ancestorsOf(local)).toEqual(HOSTS);

  const listener = inbox.tailscale.listenerPort();
  expect(listener).not.toBeNull();
  const tailnet = `http://127.0.0.1:${listener}`;
  const served = { Host: `${MAGIC}:${inbox.port}`, "Tailscale-User-Login": OWNER };
  const page = await fetch(`${tailnet}/`, { headers: { ...served, "Sec-Fetch-Site": "none" } });
  expect(page.status).toBe(200);
  expect(page.headers.get("x-frame-options")).toBe("DENY");
  expect(page.headers.get("content-security-policy")).toBe(INBOX_WINDOW_CSP);
  // An iframe load is a navigation, which the tailnet lets through cross-site: DENY is what refuses it there.
  const framedThere = await fetch(`${tailnet}/`, { headers: { ...served, "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Mode": "navigate" } });
  expect(framedThere.headers.get("x-frame-options")).toBe("DENY");
  expect(framedThere.headers.get("content-security-policy")).toBe(INBOX_WINDOW_CSP);

  const sameOrigin = { ...served, Origin: `https://${MAGIC}:${inbox.port}`, "Sec-Fetch-Site": "same-origin" };
  const attached = await fetch(`${tailnet}${await keep(inbox, "pages", "<p>a page</p>", sameOrigin, tailnet)}`, { headers: { ...served, "Sec-Fetch-Site": "same-origin" } });
  expect(attached.status).toBe(200);
  expect(attached.headers.get("content-security-policy")).toBe(INBOX_PAGE_CSP);
  const fence = await fetch(`${tailnet}${await keep(inbox, "embeds", "<p>a fence</p>", sameOrigin, tailnet)}`, { headers: { ...served, "Sec-Fetch-Site": "same-origin" } });
  expect(fence.headers.get("content-security-policy")).toBe(EMBED_RESPONSE_CSP);
  const mock = await fetch(`${tailnet}${MOCK}`, { headers: { ...served, "Sec-Fetch-Site": "same-origin" } });
  expect(mock.headers.get("content-security-policy")).toBe(INBOX_TOUR_MOCK_CSP);
});

test("the device door (phones, linked machines) answers the same with a list: no answer names a listed origin, and the window's documents are not on it", async () => {
  const answers = async (frameAncestors: string[] | undefined) => {
    const inbox = await start(world(), { phones: true, ...(frameAncestors ? { frameAncestors } : {}) });
    const made = (await (await fetch(`${base(inbox)}/api/inbox/pairing`, { method: "POST", body: "{}" })).json()) as Json;
    const pair = await fetch(`${base(inbox)}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: made.offer.code, name: "iPhone", platform: "ios" }) });
    const token = ((await pair.json()) as Json).token as string;
    const pageUrl = await keep(inbox, "pages", "<p>a page</p>");
    const out: [string, number, Record<string, string>][] = [];
    for (const route of ["threads", "health", pageUrl.replace("/api/inbox/", ""), "tour/assets/vscode-mockups.html", ""]) {
      const res = await fetch(`${base(inbox)}/api/inbox/device/${route}`, { headers: { Authorization: `Bearer ${token}` } });
      await res.arrayBuffer();
      const headers = Object.fromEntries([...res.headers].filter(([name]) => !["date", "content-length", "etag"].includes(name)));
      out.push([route.startsWith("pages/") ? "pages/<id>" : route, res.status, headers]);
    }
    return out;
  };
  const framed = await answers(HOSTS);
  expect(JSON.stringify(framed)).not.toContain("app://hermes");
  expect(JSON.stringify(framed)).not.toContain("localhost:5173");
  expect(framed.find(([route]) => route === "threads")![1]).toBe(200);
  expect(framed.map(([route, status, headers]) => [route, status, headers["content-security-policy"] ?? null, headers["x-frame-options"] ?? null])).toEqual(
    (await answers(undefined)).map(([route, status, headers]) => [route, status, headers["content-security-policy"] ?? null, headers["x-frame-options"] ?? null]),
  );
});
