/**
 * Another linked machine's attached HTML page through this Inbox's forward, in process: a loopback door stands in
 * for the far machine (PLANNOTATOR_TEST_SANDBOX lets the transport take it) and serves only what a real door
 * serves for it, `attachments/<id>/view` and `html-assets/<token>/<path>`. What regresses: the new tab asking the far
 * door for a page route it does not have, the redirect leaving the forward, the page or its folder losing the
 * sandbox, the folder's cross-site reads refused (the page is an opaque origin), or that exception reaching any other
 * forwarded route.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxMachines } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";
import { INBOX_HTML_DOCUMENT_CSP } from "./inbox-attachments";

const FAR = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";
const ATT = "att_01K7DDDDDDDDDDDDDDDDDDDDDD";
const FOLDER = "f0f1f2f3f4f5f6f7";

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];
let asked: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-machine-page-"));
  savedSandbox = process.env.PLANNOTATOR_TEST_SANDBOX;
  process.env.PLANNOTATOR_TEST_SANDBOX = "1";
  asked = [];
});

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (savedSandbox === undefined) delete process.env.PLANNOTATOR_TEST_SANDBOX;
  else process.env.PLANNOTATOR_TEST_SANDBOX = savedSandbox;
  rmSync(root, { recursive: true, force: true });
});

const PAGE_HTML = `<!doctype html><html><head><base href="/api/html-assets/${FOLDER}/"><link rel="stylesheet" href="style.css"></head><body><h1>Pricing</h1><img src="/api/html-assets/pic00000000000001/shot.png"></body></html>`;

/** The far machine's door: health, list and stream to stay online, then what it serves for an attached page. */
function farDoor() {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    fetch(req) {
      const url = new URL(req.url);
      const route = url.pathname.replace("/api/inbox/device/", "");
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return Response.json({ code: "device_token_invalid" }, { status: 401 });
      if (route === "health") return Response.json({ ok: true, inbox_id: FAR, machine_links: 1, version: "0.28.66" });
      if (route === "threads") return Response.json({ cursor: 0, sections: [], projects: [] });
      if (route === "events") {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`));
          },
        });
        return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
      }
      asked.push(`${route}${url.search}`);
      if (route === `attachments/${ATT}/view`) {
        return Response.json({
          serverSession: "far",
          attachment: { id: ATT, kind: "html", name: "pricing.html", path: "/work/site/pricing.html", unavailable: null, current: { sha256: "a".repeat(64), size: 300, mtime: "2026-11-01T00:00:00Z" } },
          version: url.searchParams.get("version") === "sent" ? "a".repeat(64) : "current",
          text: "<h1>Pricing</h1>",
          html: PAGE_HTML,
        });
      }
      if (route === `html-assets/${FOLDER}/pricing.html`) {
        return new Response('<h1>Pricing</h1><img src="/api/html-assets/pic00000000000001/shot.png">', {
          headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": INBOX_HTML_DOCUMENT_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
        });
      }
      // An older or careless far machine's stylesheet with no CSP at all: the forward adds the sandbox.
      if (route === `html-assets/${FOLDER}/style.css`) return new Response("h1{background:url(/api/html-assets/pic00000000000001/bg.png)}", { headers: { "Content-Type": "text/css; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
      return Response.json({ code: "device_route_not_found" }, { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  return `http://127.0.0.1:${server.port}`;
}

async function linkedInbox() {
  const dataDir = join(root, "data");
  InboxLinks.open(dataDir).put({ id: FAR, name: "Mini", token: TOKEN, transport: { kind: "tailnet", url: farDoor() }, device_id: null, linked_at: "2026-11-01T00:00:00Z" });
  const noop = () => {};
  const machines = createInboxMachines({
    dataDir,
    serverSession: "srv",
    computerName: () => "Studio",
    door: {
      openMachineOffer: () => ({ secret: "s", code: "000000", expires_at: "" }),
      offerDevice: () => null,
      closeMachineOffer: () => null,
      revokeDevice: noop,
      tailnetAddress: () => null,
      tailnetError: () => null,
      publishTailnet: () => ({ ok: false, message: "no" }),
      closeTailnetIfUnused: noop,
    },
    readBody: async (req) => ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    holds: () => false,
    ownVersions: () => ({ current: "0.28.66", latest: null }),
    timings: { silenceMs: 60_000, backoffMinMs: 50, backoffMaxMs: 200, requestMs: 2000, sendMs: 2000 },
  });
  cleanups.push(() => machines.stop());
  machines.start();
  for (let i = 0; i < 100 && machines.machinesView().find((m) => m.id === FAR)?.state !== "online"; i++) await Bun.sleep(20);
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const url = new URL(`http://127.0.0.1:1${path}`);
    return (await machines.route(new Request(url, { headers: { Host: "127.0.0.1:1", ...headers } }), url, "local"))!;
  };
  return { get };
}

const SAME = { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" };
/** What the sandboxed page sends for its folder: an opaque origin, so cross-site. */
const FROM_PAGE = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" };

test("the new tab: a 303 to the page's own file through the forward, made from the far door's view (no page route asked there)", async () => {
  const { get } = await linkedInbox();
  const tab = await get(`/api/inbox/m/${FAR}/attachments/${ATT}/page`, SAME);
  expect(tab.status).toBe(303);
  expect(tab.headers.get("location")).toBe(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/pricing.html`);
  expect([tab.headers.get("cache-control"), tab.headers.get("referrer-policy")]).toEqual(["no-store", "no-referrer"]);
  expect(asked).toEqual([`attachments/${ATT}/view`]);

  // The page itself: a local page's document headers, its pictures named through the forward.
  const doc = await get(tab.headers.get("location")!, { ...SAME, "Sec-Fetch-Dest": "document" });
  expect(doc.status).toBe(200);
  expect(doc.headers.get("content-security-policy")).toBe(INBOX_HTML_DOCUMENT_CSP);
  expect(doc.headers.get("access-control-allow-origin")).toBe("*");
  expect(doc.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await doc.text()).toContain(`<img src="/api/inbox/m/${FAR}/html-assets/pic00000000000001/shot.png">`);
});

test("its folder loads cross-site, as the sandboxed page asks; a far answer without a sandbox gets one; nothing else under the forward opens cross-site", async () => {
  const { get } = await linkedInbox();
  const style = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/style.css`, FROM_PAGE);
  expect(style.status).toBe(200);
  expect(style.headers.get("content-security-policy")).toBe("sandbox");
  expect(await style.text()).toBe(`h1{background:url(/api/inbox/m/${FAR}/html-assets/pic00000000000001/bg.png)}`);
  // A font or a module script: CORS mode, `Origin: null`.
  const cors = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/style.css`, { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "cors", Origin: "null" });
  expect([cors.status, cors.headers.get("access-control-allow-origin")]).toEqual([200, "*"]);
  for (const route of ["threads", `attachments/${ATT}/page`, `attachments/${ATT}/view`, `attachments/${ATT}/image`]) {
    const refused = await get(`/api/inbox/m/${FAR}/${route}`, FROM_PAGE);
    expect([route, refused.status]).toEqual([route, 403]);
  }
  // Only the folder's two reads reached the far door.
  expect(asked).toEqual([`html-assets/${FOLDER}/style.css`, `html-assets/${FOLDER}/style.css`]);
});

test("the sent version is the page itself under a local page's headers; the viewer's read names its folder through the forward", async () => {
  const { get } = await linkedInbox();
  const sent = await get(`/api/inbox/m/${FAR}/attachments/${ATT}/page?version=sent`, SAME);
  expect(sent.status).toBe(200);
  expect(sent.headers.get("content-security-policy")).toBe(INBOX_HTML_DOCUMENT_CSP);
  expect(sent.headers.get("referrer-policy")).toBe("no-referrer");
  expect(sent.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(await sent.text()).toContain(`<base href="/api/inbox/m/${FAR}/html-assets/${FOLDER}/">`);
  expect(asked).toEqual([`attachments/${ATT}/view?version=sent`]);
  const view = await get(`/api/inbox/m/${FAR}/attachments/${ATT}/view`, { "Sec-Fetch-Site": "same-origin" });
  expect(view.status).toBe(200);
  const body = (await view.json()) as { html: string; text: string };
  expect(body.html).toContain(`<base href="/api/inbox/m/${FAR}/html-assets/${FOLDER}/">`);
  expect(body.text).toBe("<h1>Pricing</h1>");
});
