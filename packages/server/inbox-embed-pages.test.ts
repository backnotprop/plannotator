/**
 * An html block's annotatable document (inbox-embeds.ts `createInboxEmbedPages`:
 * the block's page with the annotation bridge inlined, built by the window),
 * tested on the route alone (no Inbox is started). What regresses if these fail:
 * - the document is served under a policy wider than the block's own: with
 *   `'self'` as a source (the page could then read the Inbox's API, which is
 *   on its own origin's server), with `allow-same-origin`, or under the
 *   attached pages' policy (which names `'self'`);
 * - the attached pages' own route changes path, size or policy because the
 *   two share one store;
 * - a document the Inbox no longer keeps (a restart) leaves the block blank
 *   instead of telling the window to post it again;
 * - a document far larger than a block and its bridge is kept.
 */
import { describe, expect, test } from "bun:test";
import { EMBED_ANNOTATABLE_MAX_BYTES, EMBED_RESPONSE_CSP, EMBED_SANDBOX, SERVED_FRAME_GONE } from "@plannotator/core/html-embed";
import { createInboxEmbedPages, INBOX_EMBED_PAGES_PATH, inboxEmbedHeaders, inboxEmbedPageHeaders } from "./inbox-embeds";
import { createInboxPages, INBOX_PAGE_CSP, INBOX_PAGE_MAX_BYTES } from "./inbox-pages";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const directives = (csp: string) => new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

function routes(make: typeof createInboxEmbedPages, path: string) {
  let body: Record<string, unknown> = {};
  const pages = make({ readBody: async () => body, json });
  const post = async (html: unknown, at = path) => {
    body = { html };
    const res = await pages.route(new Request(`http://127.0.0.1${at}`, { method: "POST" }), new URL(`http://127.0.0.1${at}`));
    return res === null ? null : { status: res.status, answer: (await res.json()) as Record<string, any> };
  };
  const get = async (at: string, method = "GET", framers?: readonly string[]) => pages.route(new Request(`http://127.0.0.1${at}`, { method }), new URL(`http://127.0.0.1${at}`), framers);
  return { pages, post, get };
}

const DOCUMENT = '<!doctype html><html><head><script>/* bootstrap */</script><script>/* bridge */</script></head><svg><rect id="pro-3"/></svg>';

describe("the annotatable document's policy is the block's own", () => {
  test("its headers are the embed's, save that it is never cached (a restart forgets it)", () => {
    const { "Cache-Control": cache, ...page } = inboxEmbedPageHeaders();
    const { "Cache-Control": _embedCache, ...embed } = inboxEmbedHeaders();
    expect(page).toEqual(embed);
    expect(cache).toBe("no-store");
  });

  test("served: exactly EMBED_RESPONSE_CSP, sandboxed without allow-same-origin, and 'self' nowhere but frame-ancestors", async () => {
    const { post, get } = routes(createInboxEmbedPages, INBOX_EMBED_PAGES_PATH);
    const kept = (await post(DOCUMENT))!;
    expect(kept.status).toBe(200);
    expect(kept.answer.id).toMatch(/^[0-9a-f]{32}$/);
    expect(kept.answer.url).toBe(`/api/inbox/embed-pages/${kept.answer.id}`);
    const res = (await get(kept.answer.url))!;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DOCUMENT);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    const csp = res.headers.get("Content-Security-Policy")!;
    expect(csp).toBe(EMBED_RESPONSE_CSP);
    expect(csp).not.toBe(INBOX_PAGE_CSP);
    const policy = directives(csp);
    expect(policy.get("sandbox")).toEqual(EMBED_SANDBOX.split(" "));
    expect(policy.get("sandbox")).not.toContain("allow-same-origin");
    for (const [name, values] of policy) {
      if (name === "frame-ancestors") continue;
      expect(values).not.toContain("'self'");
      expect(values.some((value) => /^http:/i.test(value) || value === "*")).toBe(false);
    }
    expect(policy.get("default-src")).toEqual(["'none'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'self'"]);
  });

  test("an app that may frame the window is added to frame-ancestors only", async () => {
    const { post, get } = routes(createInboxEmbedPages, INBOX_EMBED_PAGES_PATH);
    const kept = (await post(DOCUMENT))!;
    const res = (await get(kept.answer.url, "GET", ["https://app.example"]))!;
    const policy = directives(res.headers.get("Content-Security-Policy")!);
    expect(policy.get("frame-ancestors")).toContain("https://app.example");
    for (const [name, values] of policy) if (name !== "frame-ancestors") expect(values).not.toContain("https://app.example");
  });
});

describe("the annotatable document's store", () => {
  test("refusals: no document, the wrong method, one far past a block and its bridge", async () => {
    const { post, get } = routes(createInboxEmbedPages, INBOX_EMBED_PAGES_PATH);
    expect((await post(""))!.status).toBe(400);
    expect((await post(42))!.status).toBe(400);
    expect((await get(INBOX_EMBED_PAGES_PATH))!.status).toBe(405);
    const big = (await post("x".repeat(EMBED_ANNOTATABLE_MAX_BYTES + 1)))!;
    expect(big.status).toBe(413);
    expect(big.answer.code).toBe("page_too_large");
    expect((await post("x".repeat(EMBED_ANNOTATABLE_MAX_BYTES)))!.status).toBe(200);
    // Far under what an attached page may weigh: the block's own cap decides.
    expect(EMBED_ANNOTATABLE_MAX_BYTES).toBeLessThan(INBOX_PAGE_MAX_BYTES);
  });

  test("a document that went (a restart) says so to its frame, under a policy with no 'self' either", async () => {
    const first = routes(createInboxEmbedPages, INBOX_EMBED_PAGES_PATH);
    const kept = (await first.post(DOCUMENT))!;
    const restarted = routes(createInboxEmbedPages, INBOX_EMBED_PAGES_PATH);
    const gone = (await restarted.get(kept.answer.url))!;
    expect(gone.status).toBe(404);
    expect(await gone.text()).toContain(SERVED_FRAME_GONE);
    const policy = directives(gone.headers.get("Content-Security-Policy")!);
    expect(policy.get("sandbox")).toEqual(["allow-scripts"]);
    for (const [name, values] of policy) if (name !== "frame-ancestors") expect(values).not.toContain("'self'");
  });

  test("an id no one was given names nothing: malformed ids and another path fall through", async () => {
    const { get } = routes(createInboxEmbedPages, INBOX_EMBED_PAGES_PATH);
    expect((await get(`${INBOX_EMBED_PAGES_PATH}/not-an-id`))!.status).toBe(404);
    expect(await get("/api/inbox/pages/0123456789abcdef0123456789abcdef")).toBeNull();
    expect(await get("/api/inbox/embeds/0123456789abcdef0123456789abcdef")).toBeNull();
  });
});

describe("the attached pages' route, which shares the store, is unchanged", () => {
  test("its own path, its own policy, its own size; the blocks' path is not its", async () => {
    const { post, get } = routes(createInboxPages, "/api/inbox/pages");
    const kept = (await post(DOCUMENT))!;
    expect(kept.answer.url).toBe(`/api/inbox/pages/${kept.answer.id}`);
    const res = (await get(kept.answer.url))!;
    expect(res.headers.get("Content-Security-Policy")).toBe(INBOX_PAGE_CSP);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await post(DOCUMENT, INBOX_EMBED_PAGES_PATH)).toBeNull();
    expect(await get(`${INBOX_EMBED_PAGES_PATH}/${kept.answer.id}`)).toBeNull();
    expect((await post("x".repeat(EMBED_ANNOTATABLE_MAX_BYTES + 1)))!.status).toBe(200);
  });
});
