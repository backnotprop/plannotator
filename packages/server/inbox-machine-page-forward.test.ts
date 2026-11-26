/**
 * Another linked machine's attached HTML page through this Inbox's forward, in process: a loopback door stands in
 * for the far machine (PLANNOTATOR_TEST_SANDBOX lets the transport take it) and serves only what a real door
 * serves for it, `attachments/<id>/view` and `html-assets/<token>/<path>`. What regresses: the new tab asking the far
 * door for a page route it does not have, the redirect leaving the forward, the page or its folder losing the
 * sandbox, the folder's cross-site reads refused (the page is an opaque origin), that exception reaching any other
 * forwarded route (an encoded or stepped path included), or a hostile far machine's headers loosening what this
 * origin serves.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboxMachines } from "./inbox-machines";
import { InboxLinks } from "./inbox-links";
import { HTML_ASSET_SUBRESOURCE_CSP } from "@plannotator/shared/html-assets";
import { INBOX_HTML_DOCUMENT_CSP } from "./inbox-attachments";

const FAR = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";
const ATT = "att_01K7DDDDDDDDDDDDDDDDDDDDDD";
/** An attachment whose far `view` is not JSON at all. */
const ODD = "att_01K7EEEEEEEEEEEEEEEEEEEEEE";
/** A sandbox that would let a document act as this origin, and leave its tab. */
const HOSTILE_CSP = "sandbox allow-scripts allow-same-origin allow-top-navigation allow-popups-to-escape-sandbox";
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
      // An older or careless far machine's stylesheet with no CSP at all: the forward gives it a local asset's.
      if (route === `html-assets/${FOLDER}/style.css`) {
        const css = "h1{background:url(/api/html-assets/pic00000000000001/bg.png)}";
        const range = req.headers.get("range");
        if (range === "bytes=0-9") return new Response(css.slice(0, 10), { status: 206, headers: { "Content-Type": "text/css; charset=utf-8", "Content-Range": `bytes 0-9/${css.length}`, "Accept-Ranges": "bytes" } });
        return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "Access-Control-Allow-Origin": "*" } });
      }
      // A hostile far machine: loosened sandboxes, a sniffing hint, a CORS grant on a route that is not the folder.
      const hostile = { "Content-Security-Policy": HOSTILE_CSP, "X-Content-Type-Options": "sniff", "Access-Control-Allow-Origin": "*" };
      if (route === `html-assets/${FOLDER}/evil.html`) return new Response("<script>parent.x</script>", { headers: { ...hostile, "Content-Type": "text/html; charset=utf-8" } });
      if (route === `html-assets/${FOLDER}/evil.svg`) return new Response("<svg/>", { headers: { ...hostile, "Content-Type": "image/svg+xml" } });
      if (route === `attachments/${ATT}/image`) return new Response("<svg/>", { headers: { ...hostile, "Content-Type": "image/svg+xml" } });
      if (route === `attachments/${ODD}/view`) return new Response("<script>x</script>", { headers: { ...hostile, "Content-Type": "text/html" } });
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
      openIntroductionOffer: () => ({ secret: "s", expires_at: "" }),
      introduction: () => null,
      settleIntroduction: noop,
      dropIntroductions: noop,
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
  const get = async (path: string, headers: Record<string, string> = {}, method = "GET") => {
    const url = new URL(`http://127.0.0.1:1${path}`);
    return (await machines.route(new Request(url, { method, headers: { Host: "127.0.0.1:1", ...headers } }), url, "local"))!;
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

test("its folder loads cross-site, as the sandboxed page asks, under a local folder's CSP; nothing else under the forward opens cross-site", async () => {
  const { get } = await linkedInbox();
  const style = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/style.css`, FROM_PAGE);
  expect(style.status).toBe(200);
  expect(style.headers.get("content-security-policy")).toBe(HTML_ASSET_SUBRESOURCE_CSP);
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

test("a hostile far machine's headers: its folder gets a local folder's CSP, everything else a sandbox it cannot escape, always nosniff, CORS only for the folder", async () => {
  const { get } = await linkedInbox();
  const doc = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/evil.html`, SAME);
  expect([doc.status, doc.headers.get("content-security-policy"), doc.headers.get("x-content-type-options")]).toEqual([200, INBOX_HTML_DOCUMENT_CSP, "nosniff"]);
  const svg = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/evil.svg`, SAME);
  expect([svg.status, svg.headers.get("content-security-policy"), svg.headers.get("x-content-type-options")]).toEqual([200, HTML_ASSET_SUBRESOURCE_CSP, "nosniff"]);
  // The picture's own tab (Open in → Browser) and a page whose far `view` is not JSON.
  for (const route of [`attachments/${ATT}/image`, `attachments/${ODD}/page`]) {
    const answer = await get(`/api/inbox/m/${FAR}/${route}`, SAME);
    expect([route, answer.status, answer.headers.get("content-security-policy"), answer.headers.get("x-content-type-options"), answer.headers.get("access-control-allow-origin")]).toEqual([
      route,
      200,
      "sandbox allow-scripts",
      "nosniff",
      null,
    ]);
  }
});

test("an encoded, stepped or empty path under the forwarded folder opens nothing cross-site", async () => {
  const { get } = await linkedInbox();
  for (const path of [
    `html-assets/${FOLDER}/..%2fthreads`,
    `html-assets/${FOLDER}/..%2Fthreads`,
    `html-assets/${FOLDER}/%2e%2e/threads`,
    `html-assets/%2e%2e/threads`,
    `html-assets/${FOLDER}/a%5c..%5cthreads`,
    `html-assets/${FOLDER}//threads`,
    `html-assets//threads`,
  ]) {
    // Refused by the forward (404), or stepped by the URL itself (`%2e%2e` is `..` to it) out of the folder's path
    // and refused as any cross-site read (403), or still inside the far folder route, which refuses it there.
    const refused = await get(`/api/inbox/m/${FAR}/${path}`, FROM_PAGE);
    expect([path, [403, 404].includes(refused.status)]).toEqual([path, true]);
  }
  const stepped = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/../../threads`, FROM_PAGE);
  expect(stepped.status).toBe(403);
  // Nothing but the far folder route was ever asked.
  expect(asked.filter((route) => !route.startsWith("html-assets/"))).toEqual([]);
  expect(asked).toEqual([`html-assets/threads`]);
});

test("a part of a far page or stylesheet passes untouched; HEAD answers the new tab and the folder as locally", async () => {
  const { get } = await linkedInbox();
  const part = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/style.css`, { ...FROM_PAGE, Range: "bytes=0-9" });
  expect([part.status, part.headers.get("content-range"), await part.text()]).toEqual([206, "bytes 0-9/61", "h1{backgro"]);
  const tab = await get(`/api/inbox/m/${FAR}/attachments/${ATT}/page`, SAME, "HEAD");
  expect([tab.status, tab.headers.get("location"), await tab.text()]).toEqual([303, `/api/inbox/m/${FAR}/html-assets/${FOLDER}/pricing.html`, ""]);
  const sent = await get(`/api/inbox/m/${FAR}/attachments/${ATT}/page?version=sent`, SAME, "HEAD");
  expect([sent.status, sent.headers.get("content-security-policy"), await sent.text()]).toEqual([200, INBOX_HTML_DOCUMENT_CSP, ""]);
  const doc = await get(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/pricing.html`, FROM_PAGE, "HEAD");
  expect([doc.status, doc.headers.get("content-security-policy"), await doc.text()]).toEqual([200, INBOX_HTML_DOCUMENT_CSP, ""]);
  // HEAD elsewhere under the forward is still not a forwarded read, and cross-site HEAD is refused as GET is.
  expect((await get(`/api/inbox/m/${FAR}/threads`, SAME, "HEAD")).status).toBe(405);
  expect((await get(`/api/inbox/m/${FAR}/threads`, FROM_PAGE, "HEAD")).status).toBe(403);
});

