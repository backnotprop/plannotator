/**
 * Another linked machine's attached page opened here (inbox-machine-page.ts), from that machine's door's `view`
 * answer alone. What regresses: the new tab pointing at this origin's own asset route (which never knew the far
 * token: 404), a page or a stylesheet naming its pictures at `/api/html-assets/` here, the frozen (sent) page served
 * without a local page's sandbox, or a rewrite reaching into another site's URL.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_HTML_DOCUMENT_CSP } from "./inbox-attachments";
import { machineAssetAnswer, machinePageAnswer, machineViewAnswer, rebaseMachineHtmlAssets } from "./inbox-machine-page";

const B = "ibx_01K7MMMMMMMMMMMMMMMMMMMMMM";
const FORWARD = `/api/inbox/m/${B}/html-assets/`;

function view(attachment: Record<string, unknown>, html: string | null, status = 200): Response {
  return Response.json({ serverSession: "s", attachment, version: "current", text: "<h1>Pricing</h1>", html }, { status });
}

const page = {
  id: "att_01K7DDDDDDDDDDDDDDDDDDDDDD",
  kind: "html",
  name: "pricing.html",
  path: "/work/shop/site/pricing.html",
  unavailable: null,
  current: { sha256: "a".repeat(64), size: 1200, mtime: "2026-10-10T10:42:00.000Z" },
};
const html = '<!doctype html><html><head><base href="/api/html-assets/tok123/"><link rel="stylesheet" href="style.css"></head><body><img src="/api/html-assets/pic999/shot.png"><a href="https://example.com/api/html-assets/x">x</a></body></html>';
const pass = (response: Response) => new Response(response.body, { status: response.status, headers: { "X-Passed": "1", "Content-Type": response.headers.get("content-type") ?? "" } });

describe("machinePageAnswer", () => {
  test("the current page: a 303 to its own file through the forward, with a local page's redirect headers", async () => {
    const answer = await machinePageAnswer(view(page, html), B, "", pass);
    expect(answer.status).toBe(303);
    expect(Object.fromEntries(answer.headers)).toEqual({ location: `${FORWARD}tok123/pricing.html`, "cache-control": "no-store", "referrer-policy": "no-referrer" });
  });

  test("the sent version: the page itself, rebased onto the forward, under exactly a local page's headers", async () => {
    const answer = await machinePageAnswer(view(page, html), B, "?version=sent", pass);
    expect(answer.status).toBe(200);
    expect(Object.fromEntries(answer.headers)).toEqual({
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": INBOX_HTML_DOCUMENT_CSP,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "cross-origin-resource-policy": "same-origin",
      "referrer-policy": "no-referrer",
    });
    expect(INBOX_HTML_DOCUMENT_CSP).toStartWith("sandbox allow-scripts allow-modals");
    expect(INBOX_HTML_DOCUMENT_CSP).not.toContain("allow-same-origin");
    const body = await answer.text();
    expect(body).toContain(`<base href="${FORWARD}tok123/">`);
    expect(body).toContain(`<img src="${FORWARD}pic999/shot.png">`);
    expect(body).toContain('href="https://example.com/api/html-assets/x"');
    expect(body).not.toContain('"/api/html-assets/');
  });

  test("a page the asset route would refuse by name, or one over its size: served as a body, never redirected", async () => {
    for (const changed of [
      { name: ".draft.html", path: "/work/shop/site/.draft.html" },
      { path: "/work/shop/site/pricing.htm.txt" },
      { current: { size: 50 * 1024 * 1024 } },
    ]) {
      const answer = await machinePageAnswer(view({ ...page, ...changed }, html), B, "", pass);
      expect([JSON.stringify(changed), answer.status, answer.headers.get("content-security-policy")]).toEqual([JSON.stringify(changed), 200, INBOX_HTML_DOCUMENT_CSP]);
    }
  });

  test("the current file gone or changed type is refused as locally; its sent version still opens", async () => {
    const gone = { ...page, current: null, unavailable: { code: "attachment_missing", message: "pricing.html is no longer on disk." } };
    const refused = await machinePageAnswer(view(gone, html), B, "", pass);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "pricing.html is no longer on disk.", code: "attachment_missing" });
    const changedType = await machinePageAnswer(view({ ...page, unavailable: { code: "attachment_changed_type", message: "changed" } }, html), B, "", pass);
    expect(changedType.status).toBe(409);
    const sent = await machinePageAnswer(view(gone, html), B, "?version=sent", pass);
    expect([sent.status, sent.headers.get("content-security-policy")]).toEqual([200, INBOX_HTML_DOCUMENT_CSP]);
  });

  test("a refusal passes on as the forward passes it; a file that is not a page is refused as locally", async () => {
    const refused = await machinePageAnswer(Response.json({ error: "No attachment att_x.", code: "attachment_not_found" }, { status: 404 }), B, "", pass);
    expect([refused.status, refused.headers.get("x-passed")]).toEqual([404, "1"]);
    const notPage = await machinePageAnswer(view({ ...page, kind: "markdown", name: "plan.md" }, null), B, "", pass);
    expect(notPage.status).toBe(415);
    expect(((await notPage.json()) as { code: string }).code).toBe("attachment_not_html");
  });
});

describe("the viewer and the folder", () => {
  test("the viewer's read: its page's html points at the forward, the rest of the answer unchanged", async () => {
    const answer = await machineViewAnswer(view(page, html), B);
    const body = (await answer.json()) as { html: string; text: string; attachment: { id: string } };
    expect(body.html).toContain(`<base href="${FORWARD}tok123/">`);
    expect(body.text).toBe("<h1>Pricing</h1>");
    expect(body.attachment.id).toBe(page.id);
    // A Markdown file's read has no html: as it came.
    const markdown = await machineViewAnswer(view({ ...page, kind: "markdown" }, null), B);
    expect(((await markdown.json()) as { html: unknown }).html).toBeNull();
  });

  test("a page or a stylesheet from the folder: its token URLs rebased, its sandboxed headers kept; a picture as it came", async () => {
    const css = await machineAssetAnswer(new Response("body{background:url(/api/html-assets/pic1/bg.png)}", { headers: { "Content-Type": "text/css; charset=utf-8", "Content-Security-Policy": "sandbox", "Content-Length": "48" } }), B);
    expect(await css.text()).toBe(`body{background:url(${FORWARD}pic1/bg.png)}`);
    expect(css.headers.get("content-security-policy")).toBe("sandbox");
    expect(css.headers.get("content-length")).not.toBe("48");
    const doc = await machineAssetAnswer(new Response('<img src="/api/html-assets/pic1/a.png">', { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": INBOX_HTML_DOCUMENT_CSP } }), B);
    expect(await doc.text()).toBe(`<img src="${FORWARD}pic1/a.png">`);
    expect(doc.headers.get("content-security-policy")).toBe(INBOX_HTML_DOCUMENT_CSP);
    const bytes = new Uint8Array([1, 2, 3]);
    const picture = await machineAssetAnswer(new Response(bytes, { headers: { "Content-Type": "image/png" } }), B);
    expect(new Uint8Array(await picture.arrayBuffer())).toEqual(bytes);
  });

  test("only root-relative asset URLs move: never another site's, never twice", () => {
    expect(rebaseMachineHtmlAssets(`a "/api/html-assets/t/x" b url(/api/html-assets/t/y) c srcset="/api/html-assets/t/1.png 1x, /api/html-assets/t/2.png 2x"`, B)).toBe(
      `a "${FORWARD}t/x" b url(${FORWARD}t/y) c srcset="${FORWARD}t/1.png 1x, ${FORWARD}t/2.png 2x"`,
    );
    expect(rebaseMachineHtmlAssets("https://example.com/api/html-assets/t/x //cdn.example/api/html-assets/t/x", B)).toBe("https://example.com/api/html-assets/t/x //cdn.example/api/html-assets/t/x");
    const once = rebaseMachineHtmlAssets('"/api/html-assets/t/x"', B);
    expect(rebaseMachineHtmlAssets(once, B)).toBe(once);
  });
});
