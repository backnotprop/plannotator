/**
 * A linked machine's Markdown file and the documents next to an attached file, read through this Inbox's forward in
 * process: a loopback door stands in for the far machine (PLANNOTATOR_TEST_SANDBOX lets the transport take it). What
 * regresses: the far door not opening `markdown-image` and `linked-page` to a linked machine (broken pictures, a
 * sibling that does not open), a phone reaching them, a hostile far machine's headers or fields reaching this origin,
 * a far picture past the local cap, an encoded or stepped route, or the reads opening cross-site.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_MESSAGE_IMAGE_CSP } from "@plannotator/shared/inbox/message-images";
import { doorRouteOf } from "./inbox-devices";
import { INBOX_HTML_DOCUMENT_CSP } from "./inbox-attachments";
import { InboxLinks } from "./inbox-links";
import { MACHINE_IMAGE_MAX_BYTES, machineMarkdownImageAnswer } from "./inbox-machine-files";
import { createInboxMachines } from "./inbox-machines";

const FAR = "ibx_01K00000000000000000000000";
const TOKEN = "tok_test";
const MD = "att_01K7MDMDMDMDMDMDMDMDMDMDMD";
const PAGE = "att_01K7PAPAPAPAPAPAPAPAPAPAPA";
const FOLDER = "f0f1f2f3f4f5f6f7";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
/** What a hostile far machine adds to every answer: a sandbox that escapes, a sniffing hint, CORS and a cross-origin CORP. */
const HOSTILE = {
  "Content-Security-Policy": "sandbox allow-scripts allow-same-origin allow-top-navigation",
  "X-Content-Type-Options": "sniff",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "Cache-Control": "public, max-age=31536000, immutable",
  "Content-Disposition": 'attachment; filename="setup.exe"',
};

let root: string;
let savedSandbox: string | undefined;
const cleanups: (() => void)[] = [];
let asked: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "plannotator-machine-files-"));
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

/** `size` bytes in 1 MB chunks, with no declared length. */
function streamed(size: number): ReadableStream<Uint8Array> {
  let left = size;
  return new ReadableStream({
    pull(controller) {
      if (left <= 0) return controller.close();
      const chunk = new Uint8Array(Math.min(left, 1024 * 1024));
      left -= chunk.length;
      controller.enqueue(chunk);
    },
  });
}

/** The far machine's door: what keeps it online, then what its window routes answer (some of them hostile). */
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
        return new Response(new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode(`event: hello\ndata: {"cursor":0}\n\n`)) }), { headers: { "Content-Type": "text/event-stream" } });
      }
      asked.push(`${route}${url.search}`);
      const path = url.searchParams.get("path");
      if (route === `attachments/${MD}/markdown-image`) {
        if (req.headers.get("if-none-match") === '"png"') return new Response(null, { status: 304, headers: { ...HOSTILE, ETag: '"png"' } });
        // A picture a linked Markdown file next to the attached one shows (`?document=`).
        if (path === "deep.png" && url.searchParams.get("document") === "notes.md") return new Response(PNG, { headers: { "Content-Type": "image/png" } });
        if (path === "shot.png") return new Response(PNG, { headers: { ...HOSTILE, "Content-Type": "image/png", ETag: '"png"' } });
        if (path === "page.png") return new Response("<script>top.x()</script>", { headers: { ...HOSTILE, "Content-Type": "text/html" } });
        if (path === "huge.png") return new Response(streamed(MACHINE_IMAGE_MAX_BYTES + 10), { headers: { "Content-Type": "image/png" } });
        return Response.json({ error: "That image is not shown by this file.", code: "image_not_referenced" }, { status: 404, headers: HOSTILE });
      }
      if (route === `attachments/${MD}/linked-page`) {
        if (path === "notes.md") return Response.json({ serverSession: "far", path: "/work/docs/notes.md", name: "notes.md", html: null, text: "# Notes", url: "https://evil.example/" });
        if (path === "odd.md") return Response.json({ serverSession: "far", path: 42, name: "odd.md", html: null });
        // JSON words under an HTML type, and fields past what any real answer carries.
        if (path === "typed.md") return new Response(JSON.stringify({ serverSession: "far", path: "/work/docs/typed.md", name: "typed.md", html: null, text: "<script>x()</script>", url: null }), { headers: { "Content-Type": "text/html; x=json" } });
        if (path === "named.md") return Response.json({ serverSession: "far", path: "/work/docs/named.md", name: "n".repeat(5000), html: null, text: "x", url: null });
        if (path === "long.md") return Response.json({ serverSession: "far", path: "/work/docs/long.md", name: "long.md", html: null, text: "x".repeat(3 * 1024 * 1024), url: null });
        return Response.json({ error: "notes2.md is not in this file's folder.", code: "linked_page_refused" }, { status: 403 });
      }
      if (route === `attachments/${PAGE}/linked-page`) {
        const url = { "faq.html": `/api/html-assets/${FOLDER}/faq.html`, "evil.html": "https://evil.example/x", "up.html": `/api/html-assets/${FOLDER}/../threads`, "enc.html": `/api/html-assets/${FOLDER}/%2e%2e/threads`, "far.html": "/api/inbox/threads", "js.html": "javascript:alert(1)", "proto.html": `//evil.example/api/html-assets/${FOLDER}/x.html`, "abs.html": `https://evil.example/api/html-assets/${FOLDER}/x.html` }[path ?? ""];
        if (path === "big.html") return new Response(streamed(64 * 1024 * 1024), { headers: { "Content-Type": "application/json" } });
        // A 2 MB page whose served html grew past 2 MB (thousands of pictures, each given its folder's route); and html
        // past anything a 2 MB page grows to.
        const pictures = (count: number) => `<base href="/api/html-assets/${FOLDER}/">${`<img src="/api/html-assets/${FOLDER}/shot.png">`.repeat(count)}`;
        if (path === "grown.html") return Response.json({ serverSession: "far", path: "/work/site/grown.html", name: "grown.html", html: pictures(60_000), url: null });
        if (path === "huge.html") return Response.json({ serverSession: "far", path: "/work/site/huge.html", name: "huge.html", html: pictures(200_000), url: null });
        return Response.json(
          { serverSession: "far", path: `/work/site/${path}`, name: path, html: `<base href="/api/html-assets/${FOLDER}/"><img src="/api/html-assets/${FOLDER}/a.png"><a href="https://example.com/api/html-assets/x">x</a>`, url, extra: "dropped" },
          { headers: HOSTILE },
        );
      }
      if (route === `html-assets/${FOLDER}/faq.html`) return new Response("<h1>FAQ</h1>", { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": INBOX_HTML_DOCUMENT_CSP } });
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
  const get = async (path: string, headers: Record<string, string> = WINDOW, method = "GET") => {
    const url = new URL(`http://127.0.0.1:1${path}`);
    return (await machines.route(new Request(url, { method, headers: { Host: "127.0.0.1:1", ...headers } }), url, "local"))!;
  };
  return { get };
}

/** The window's own read (an `<img>` or a fetch from the Inbox page). */
const WINDOW = { "Sec-Fetch-Site": "same-origin" };
const image = (path: string) => `/api/inbox/m/${FAR}/attachments/${MD}/markdown-image?path=${encodeURIComponent(path)}&version=current`;

describe("the far door", () => {
  test("opens a file's pictures and the documents next to it to a linked machine, never to a phone", () => {
    for (const route of ["markdown-image", "linked-page"]) {
      expect(doorRouteOf("GET", `attachments/att_x/${route}`, true)?.windowPath).toBe(`/api/inbox/attachments/att_x/${route}`);
      expect(doorRouteOf("GET", `attachments/att_x/${route}`, false)).toBeNull();
      expect(doorRouteOf("POST", `attachments/att_x/${route}`, true)).toBeNull();
    }
  });
});

describe("a far Markdown file's pictures", () => {
  test("load through the forward as a local picture: the far bytes, this computer's headers", async () => {
    const { get } = await linkedInbox();
    const shot = await get(image("shot.png"));
    expect(shot.status).toBe(200);
    expect(Buffer.from(await shot.arrayBuffer()).equals(PNG)).toBe(true);
    expect([shot.headers.get("content-type"), shot.headers.get("content-security-policy"), shot.headers.get("x-content-type-options"), shot.headers.get("cross-origin-resource-policy"), shot.headers.get("access-control-allow-origin")]).toEqual([
      "image/png",
      INBOX_MESSAGE_IMAGE_CSP,
      "nosniff",
      "same-origin",
      null,
    ]);
    // A local picture's cache rule and no far disposition, whatever the far one said; its ETag kept.
    expect([shot.headers.get("cache-control"), shot.headers.get("content-disposition"), shot.headers.get("etag")]).toEqual(["private, no-cache", null, '"png"']);
    // The query rides to the far route as the window wrote it; a revalidation passes as a 304, with the same rules.
    expect(asked).toEqual([`attachments/${MD}/markdown-image?path=shot.png&version=current`]);
    const again = await get(image("shot.png"), { ...WINDOW, "If-None-Match": '"png"' });
    expect([again.status, again.headers.get("cache-control"), again.headers.get("content-disposition"), again.headers.get("content-security-policy"), again.headers.get("etag")]).toEqual([
      304,
      "private, no-cache",
      null,
      INBOX_MESSAGE_IMAGE_CSP,
      '"png"',
    ]);
    // A picture a linked Markdown file shows: `?document=` rides through to the far route.
    const deep = await get(`${image("deep.png")}&document=notes.md`);
    expect([deep.status, Buffer.from(await deep.arrayBuffer()).equals(PNG)]).toEqual([200, true]);
    expect(asked.at(-1)).toBe(`attachments/${MD}/markdown-image?path=deep.png&version=current&document=notes.md`);
    // HEAD, as locally: the headers alone.
    const head = await get(image("shot.png"), WINDOW, "HEAD");
    expect([head.status, head.headers.get("content-security-policy"), await head.text()]).toEqual([200, INBOX_MESSAGE_IMAGE_CSP, ""]);
  });

  test("a far refusal comes back sandboxed; a far answer that is not a picture never does", async () => {
    const { get } = await linkedInbox();
    const refused = await get(image("../secret.png"));
    expect([refused.status, refused.headers.get("content-security-policy"), refused.headers.get("x-content-type-options")]).toEqual([404, INBOX_MESSAGE_IMAGE_CSP, "nosniff"]);
    expect(((await refused.json()) as { code: string }).code).toBe("image_not_referenced");
    const page = await get(image("page.png"));
    expect([page.status, ((await page.json()) as { code: string }).code]).toEqual([502, "machine_answer_unreadable"]);
  });

  test("a far picture past the local cap: refused when it says so, cut off when it streams past it", async () => {
    const { get } = await linkedInbox();
    // A declared length past it is refused before a byte is read (a real server sets the length itself, so in memory).
    const declared = machineMarkdownImageAnswer(new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": String(MACHINE_IMAGE_MAX_BYTES + 1) } }));
    expect([declared.status, ((await declared.json()) as { code: string }).code]).toEqual([413, "image_too_large"]);
    const huge = await get(image("huge.png"));
    expect(huge.status).toBe(200);
    await expect(huge.arrayBuffer()).rejects.toThrow();
  });
});

describe("a document next to a far attached file", () => {
  test("a Markdown sibling: its text, its own fields only, no new-tab URL", async () => {
    const { get } = await linkedInbox();
    const notes = await get(`/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=notes.md`);
    expect(notes.status).toBe(200);
    expect(await notes.json()).toEqual({ serverSession: "far", path: "/work/docs/notes.md", name: "notes.md", html: null, text: "# Notes", url: null });
    const refused = await get(`/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=../notes2.md`);
    expect([refused.status, refused.headers.get("content-security-policy")]).toEqual([403, "sandbox"]);
    const odd = await get(`/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=odd.md`);
    expect(odd.status).toBe(502);
  });

  test("rebuilt under this Inbox's own JSON headers; a 200 that is not JSON, or a field past any real answer's, is refused", async () => {
    const { get } = await linkedInbox();
    const notes = await get(`/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=notes.md`);
    expect([notes.headers.get("content-type"), notes.headers.get("x-content-type-options"), notes.headers.get("cache-control"), notes.headers.get("content-security-policy")]).toEqual([
      "application/json; charset=utf-8",
      "nosniff",
      "no-store",
      "sandbox",
    ]);
    const typed = await get(`/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=typed.md`);
    expect([typed.status, typed.headers.get("content-type")?.startsWith("application/json"), ((await typed.json()) as { code: string }).code]).toEqual([502, true, "machine_answer_unreadable"]);
    const named = await get(`/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=named.md`);
    expect(named.status).toBe(502);
    const long = await get(`/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=long.md`);
    expect([long.status, ((await long.json()) as { code: string }).code]).toEqual([413, "machine_page_too_large"]);
  });

  test("an HTML sibling whose served html grew past 2 MB opens, as on that machine; html past any 2 MB page's is refused", async () => {
    const { get } = await linkedInbox();
    const grown = await get(`/api/inbox/m/${FAR}/attachments/${PAGE}/linked-page?path=grown.html`);
    expect(grown.status).toBe(200);
    const body = (await grown.json()) as { html: string };
    expect(body.html.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(body.html).toStartWith(`<base href="/api/inbox/m/${FAR}/html-assets/${FOLDER}/">`);
    const huge = await get(`/api/inbox/m/${FAR}/attachments/${PAGE}/linked-page?path=huge.html`);
    expect([huge.status, ((await huge.json()) as { code: string }).code]).toEqual([413, "machine_page_too_large"]);
  });

  test("an HTML sibling: its folder and its new tab through the forward, which opens it under a local page's CSP", async () => {
    const { get } = await linkedInbox();
    const faq = await get(`/api/inbox/m/${FAR}/attachments/${PAGE}/linked-page?path=faq.html`);
    expect([faq.status, faq.headers.get("access-control-allow-origin"), faq.headers.get("x-content-type-options")]).toEqual([200, null, "nosniff"]);
    // This Inbox's own headers on the rebuilt answer, never the far one's (which sent an escaping sandbox).
    expect([faq.headers.get("content-security-policy"), faq.headers.get("content-type")]).toEqual(["sandbox", "application/json; charset=utf-8"]);
    const body = (await faq.json()) as Record<string, unknown>;
    expect(body.html).toBe(`<base href="/api/inbox/m/${FAR}/html-assets/${FOLDER}/"><img src="/api/inbox/m/${FAR}/html-assets/${FOLDER}/a.png"><a href="https://example.com/api/html-assets/x">x</a>`);
    expect(body.url).toBe(`/api/inbox/m/${FAR}/html-assets/${FOLDER}/faq.html`);
    expect(body.extra).toBeUndefined();
    const tab = await get(body.url as string, { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "navigate" });
    expect([tab.status, tab.headers.get("content-security-policy"), await tab.text()]).toEqual([200, INBOX_HTML_DOCUMENT_CSP, "<h1>FAQ</h1>"]);
  });

  test("a far new-tab URL that is not its own folder's is dropped", async () => {
    const { get } = await linkedInbox();
    for (const path of ["evil.html", "up.html", "enc.html", "far.html", "js.html", "proto.html", "abs.html"]) {
      const answer = await get(`/api/inbox/m/${FAR}/attachments/${PAGE}/linked-page?path=${path}`);
      expect([path, ((await answer.json()) as { url: unknown }).url]).toEqual([path, null]);
    }
  });

  test("a far answer past the cap is refused, never read whole", async () => {
    const { get } = await linkedInbox();
    const big = await get(`/api/inbox/m/${FAR}/attachments/${PAGE}/linked-page?path=big.html`);
    expect([big.status, ((await big.json()) as { code: string }).code]).toEqual([413, "machine_page_too_large"]);
  });
});

describe("what stays closed", () => {
  test("only this Inbox's window reads them: a bare call (an agent, a script) or another origin is refused, never asked of the far machine", async () => {
    const { get } = await linkedInbox();
    for (const path of [image("shot.png"), `/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=notes.md`]) {
      for (const headers of [{}, { "Sec-Fetch-Site": "none" }, { "Sec-Fetch-Site": "same-origin", Origin: "http://evil.test" }] as Record<string, string>[]) {
        const refused = await get(path, headers);
        expect([path, headers, refused.status, ((await refused.json()) as { code: string }).code]).toEqual([path, headers, 403, "window_only"]);
      }
      // The window's own: an `<img>` sends no Origin, a fetch may send its own.
      for (const headers of [WINDOW, { ...WINDOW, Origin: "http://127.0.0.1:1" }]) {
        const read = await get(path, headers);
        expect([path, headers, read.status]).toEqual([path, headers, 200]);
        await read.arrayBuffer();
      }
    }
    expect(asked.length).toBe(4);
  });

  test("another site, an encoded or stepped route: refused here, never asked of the far machine", async () => {
    const { get } = await linkedInbox();
    const crossSite = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" };
    for (const path of [image("shot.png"), `/api/inbox/m/${FAR}/attachments/${MD}/linked-page?path=notes.md`]) {
      expect([path, (await get(path, crossSite)).status]).toEqual([path, 403]);
    }
    for (const route of [`attachments/${MD}%2f..%2fthreads/markdown-image`, `attachments/${MD}/..%2flinked-page`, `attachments//markdown-image`, `attachments/${MD}/markdown-image%2f..`]) {
      const refused = await get(`/api/inbox/m/${FAR}/${route}?path=shot.png`);
      expect([route, refused.status]).toEqual([route, 404]);
    }
    expect(asked).toEqual([]);
  });
});
