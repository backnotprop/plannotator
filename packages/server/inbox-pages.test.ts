/**
 * An attached HTML page's own document ("Pages only", inbox-pages.ts), tested
 * on the route alone (no Inbox is started). What regresses if these fail:
 * - the page is served without its own sandbox (it would run on the Inbox's
 *   origin when its URL is opened), or without web pictures (`https:` and
 *   plain `http:`, local servers included);
 * - the window's own policy lets a picture in from the web again (a message's
 *   text, a diagram in it, would make the browser call the agent's site);
 * - a page's own video or audio (`<video src="data:video/mp4;base64,…">`, a
 *   blob:) is blocked again: neither the window's policy (a srcdoc page
 *   inherits it) nor the page document's names a media source, so media falls
 *   back to `default-src 'self'`;
 * - a page the Inbox no longer keeps (a restart) leaves the frame blank
 *   instead of telling the window to post it again;
 * - the store grows without bound.
 */
import { describe, expect, test } from "bun:test";
import { WINDOW_CSP } from "./inbox";
import { createInboxPages, INBOX_PAGE_CSP, INBOX_PAGE_GONE_MESSAGE, INBOX_PAGE_MAX_BYTES } from "./inbox-pages";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const directives = (csp: string) => new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

function pagesWith(options: { maxEntries?: number; maxBytes?: number } = {}) {
  let body: Record<string, unknown> = {};
  const pages = createInboxPages({ readBody: async () => body, json, ...options });
  const post = async (html: unknown) => {
    body = { html };
    const res = await pages.route(new Request("http://127.0.0.1/api/inbox/pages", { method: "POST" }), new URL("http://127.0.0.1/api/inbox/pages"));
    return { status: res!.status, answer: (await res!.json()) as Record<string, any> };
  };
  const get = async (path: string, method = "GET") => (await pages.route(new Request(`http://127.0.0.1${path}`, { method }), new URL(`http://127.0.0.1${path}`)))!;
  return { pages, post, get };
}

describe("the window's policy", () => {
  test("loads pictures from this server, data: and blob: only, never the web", () => {
    expect(directives(WINDOW_CSP).get("img-src")).toEqual(["'self'", "data:", "blob:"]);
  });

  test("plays a srcdoc page's own video and audio (data: and blob:), never the web's", () => {
    expect(directives(WINDOW_CSP).get("media-src")).toEqual(["'self'", "data:", "blob:"]);
  });
});

describe("an attached page's document", () => {
  test("is served as kept, sandboxed, with web pictures over https only", async () => {
    const { post, get } = pagesWith();
    const html = '<!doctype html><base href="/api/html-assets/tok/"><img src="https://example.com/a.png">';
    const { status, answer } = await post(html);
    expect(status).toBe(200);
    expect(answer.url).toBe(`/api/inbox/pages/${answer.id}`);
    expect(answer.id).toMatch(/^[0-9a-f]{32}$/);
    const res = await get(answer.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(html);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toBe(INBOX_PAGE_CSP);
    const policy = directives(csp);
    // An opaque origin even opened as a tab: never allow-same-origin.
    expect(policy.get("sandbox")).toEqual(["allow-scripts", "allow-modals"]);
    expect(policy.get("img-src")).toEqual(["'self'", "data:", "blob:", "https:", "http:"]);
    // Its own video and audio play (data: and blob:), as in the window's srcdoc.
    expect(policy.get("media-src")).toEqual(["'self'", "data:", "blob:"]);
    // Pictures only: nothing else reaches the web.
    for (const [name, values] of policy) {
      if (name === "img-src") continue;
      for (const value of values) expect(value).not.toMatch(/^(https?:|\*)/);
    }
    expect(policy.get("base-uri")).toEqual(["'self'"]);
    expect(policy.get("form-action")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
  });

  test("the same page is kept once; another Inbox (a restart) does not know it and says it is gone", async () => {
    const first = pagesWith();
    const a = await first.post("<p>one</p>");
    const b = await first.post("<p>one</p>");
    expect(b.answer.id).toBe(a.answer.id);
    expect(first.pages.size()).toBe(1);
    const restarted = pagesWith();
    const gone = await restarted.get(a.answer.url);
    expect(gone.status).toBe(404);
    const text = await gone.text();
    expect(text).toContain(INBOX_PAGE_GONE_MESSAGE);
    expect(gone.headers.get("Content-Security-Policy")).toStartWith("sandbox allow-scripts;");
    // Posted again, it is served again (under a new id: the key is made per run).
    const again = await restarted.post("<p>one</p>");
    expect(again.answer.id).not.toBe(a.answer.id);
    expect((await restarted.get(again.answer.url)).status).toBe(200);
  });

  test("refuses no page, a page too large, and the wrong method", async () => {
    const { post, get } = pagesWith();
    expect((await post("")).status).toBe(400);
    expect((await post(42)).status).toBe(400);
    expect((await post("x".repeat(INBOX_PAGE_MAX_BYTES + 1))).status).toBe(413);
    expect((await get("/api/inbox/pages")).status).toBe(405);
    expect((await get("/api/inbox/pages/abc", "POST")).status).toBe(405);
    expect((await get("/api/inbox/pages/not-an-id")).status).toBe(404);
  });

  test("keeps at most its entries and bytes, oldest out first", async () => {
    const byCount = pagesWith({ maxEntries: 2 });
    const one = await byCount.post("<p>1</p>");
    await byCount.post("<p>2</p>");
    await byCount.post("<p>3</p>");
    expect(byCount.pages.size()).toBe(2);
    expect((await byCount.get(one.answer.url)).status).toBe(404);
    const byBytes = pagesWith({ maxBytes: 2_500 });
    const big = await byBytes.post("a".repeat(1_000));
    await byBytes.post("b".repeat(1_000));
    await byBytes.post("c".repeat(1_000));
    expect(byBytes.pages.bytes()).toBeLessThanOrEqual(2_500);
    expect((await byBytes.get(big.answer.url)).status).toBe(404);
  });
});
