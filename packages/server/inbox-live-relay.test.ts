/**
 * The prototype relay's own rules (inbox-live-relay.ts), without an Inbox: the
 * entry sets the key's cookie and redirects on this origin only; later
 * requests reach only the proxy a running key names; another site is refused;
 * the page may be framed only by the window's tailnet origin; the bridge names
 * that origin; a loopback redirect stays on the relay; the relay's cookie never
 * reaches the app. Through a running Inbox and the tailnet listener (owner,
 * guest, Host, the mapping): inbox-tailscale.test.ts.
 */
import { afterAll, expect, test } from "bun:test";
import { createLiveRelay, LIVE_RELAY_COOKIE, LIVE_RELAY_ENTER_PATH, liveRelayEnterUrl } from "./inbox-live-relay";

const WINDOW = "https://macbook-pro.tail0000.ts.net:60000";
const RELAY = "https://macbook-pro.tail0000.ts.net:61000";
const seen: { cookie: string | null; host: string | null }[] = [];

// Stands in for the app's live proxy (what inbox-live.ts starts per origin).
const proxy = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  websocket: { message: (ws, message) => ws.send(`echo ${message}`) },
  fetch(req, server) {
    if (req.headers.get("upgrade") === "websocket") return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
    seen.push({ cookie: req.headers.get("cookie"), host: req.headers.get("host") });
    const path = new URL(req.url).pathname;
    if (path === "/old") return new Response(null, { status: 302, headers: { Location: `http://127.0.0.1:${proxy.port}/checkout?v=b` } });
    return new Response("<!doctype html><title>App</title><p>Pay now</p>", {
      headers: { "Content-Type": "text/html", "Content-Security-Policy": "frame-ancestors http://localhost:60000" },
    });
  },
});
afterAll(() => proxy.stop(true));

const relay = createLiveRelay({
  siteByKey: (key) => (key === "k-good" ? { port: proxy.port, token: "tok-1" } : null),
  windowOrigin: () => WINDOW,
  bridge: { bridgeScript: "/* bridge */", bridgeBootstrap: "", annotationCss: "" },
});

const frameLoad = { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "iframe" };
const ask = async (path: string, headers: Record<string, string> = {}) => (await relay.fetch(new Request(`${RELAY}${path}`, { headers }), null))!;

test("the entry: a running key sets its cookie and redirects to the app's path on this origin; a key no proxy has, or another site, is refused", async () => {
  const entry = new URL(liveRelayEnterUrl(RELAY, "k-good", "http://localhost:5173/checkout?v=b#pay"));
  expect(entry.origin).toBe(RELAY);
  const entered = await ask(entry.pathname + entry.search, frameLoad);
  expect(entered.status).toBe(302);
  expect(entered.headers.get("location")).toBe("/checkout?v=b");
  expect(entered.headers.get("set-cookie")).toBe(`${LIVE_RELAY_COOKIE}=k-good; Path=/; Secure; HttpOnly; SameSite=Strict`);
  // Never off this origin.
  expect((await ask(`${LIVE_RELAY_ENTER_PATH}?k=k-good&to=${encodeURIComponent("//evil.example/x")}`, frameLoad)).headers.get("location")).toBe("/");
  expect((await ask(`${LIVE_RELAY_ENTER_PATH}?k=k-gone&to=%2F`, frameLoad)).status).toBe(403);
  expect((await ask(`${LIVE_RELAY_ENTER_PATH}?k=k-good&to=%2F`, { ...frameLoad, "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
});

test("the app through the relay: framed only by the window, the bridge naming the window, a loopback redirect kept here, the relay's cookie kept from the app", async () => {
  const cookie = `${LIVE_RELAY_COOKIE}=k-good; theirs=1`;
  seen.length = 0;
  const page = await ask("/checkout?v=b", { ...frameLoad, Cookie: cookie });
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe(`frame-ancestors ${WINDOW}`);
  expect(await page.text()).toContain("Pay now");
  expect(seen).toEqual([{ cookie: "theirs=1", host: `127.0.0.1:${proxy.port}` }]);
  expect((await ask("/old", { ...frameLoad, Cookie: cookie })).headers.get("location")).toBe("/checkout?v=b");
  const bridge = await (await ask("/__plannotator__/bridge.js", { "Sec-Fetch-Site": "same-origin", Cookie: cookie })).text();
  expect(bridge).toContain(`"editorOrigins":["${WINDOW}"]`);
  expect(bridge).toContain('"token":"tok-1"');
});

test("refused: no cookie, a key no running proxy has, another site, and a same-site request that is not a frame's navigation", async () => {
  seen.length = 0;
  expect((await ask("/checkout?v=b", frameLoad)).status).toBe(403);
  expect((await ask("/checkout?v=b", { ...frameLoad, Cookie: `${LIVE_RELAY_COOKIE}=k-gone` })).status).toBe(403);
  expect((await ask("/checkout?v=b", { ...frameLoad, "Sec-Fetch-Site": "cross-site", Cookie: `${LIVE_RELAY_COOKIE}=k-good` })).status).toBe(403);
  expect((await ask("/api/data", { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "cors", Cookie: `${LIVE_RELAY_COOKIE}=k-good` })).status).toBe(403);
  expect(seen).toEqual([]);
});

test("a WebSocket on the app's own origin (a dev server's hot reload) is relayed to the proxy", async () => {
  // The relay behind a listener, as inbox-tailscale.ts runs it (Host and owner checks aside).
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, server) => relay.fetch(req, server), websocket: relay.websocket as never });
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${listener.port}/hmr`, { headers: { Cookie: `${LIVE_RELAY_COOKIE}=k-good` } } as never);
    const reply = await new Promise<string>((resolve, reject) => {
      ws.addEventListener("open", () => ws.send("ping"));
      ws.addEventListener("message", (event) => resolve(String(event.data)));
      ws.addEventListener("error", () => reject(new Error("socket error")));
      setTimeout(() => reject(new Error("no reply")), 3000);
    });
    expect(reply).toBe("echo ping");
    ws.close();
  } finally {
    listener.stop(true);
  }
});
