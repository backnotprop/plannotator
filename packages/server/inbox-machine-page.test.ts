/**
 * Another linked machine's attached page opened here (inbox-machine-page.ts), from that machine's door's `view`
 * answer alone. What regresses: the new tab pointing at this origin's own asset route (which never knew the far
 * token: 404), a page or a stylesheet naming its pictures at `/api/html-assets/` here, the frozen (sent) page served
 * without a local page's sandbox, a rewrite reaching into another site's URL, a hostile far machine's CSP or view
 * fields loosening what this origin serves, or an oversized far answer read whole into memory.
 */
import { describe, expect, test } from "bun:test";
import { HTML_ASSET_SUBRESOURCE_CSP } from "@plannotator/shared/html-assets";
import { INBOX_HTML_DOCUMENT_CSP } from "./inbox-attachments";
import {
  farCsp,
  MACHINE_ASSET_REBASE_MAX_BYTES,
  MACHINE_VIEW_MAX_BYTES,
  machineAssetAnswer,
  machineAssetCsp,
  machinePageAnswer,
  machineViewAnswer,
  rebaseMachineHtmlAssets,
} from "./inbox-machine-page";

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
    // A base inside a comment (closed, or open to the end) never names the folder.
    const commented = await machinePageAnswer(view(page, `<!-- <base href="/api/html-assets/other/"> -->${html}`), B, "", pass);
    expect(commented.headers.get("location")).toBe(`${FORWARD}tok123/pricing.html`);
    const unclosed = await machinePageAnswer(view(page, `<!-- ${html}`), B, "", pass);
    expect([unclosed.status, unclosed.headers.get("location")]).toEqual([200, null]);
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

  test("a page or a stylesheet from the folder: its token URLs rebased, B's length and range dropped; a picture as it came", async () => {
    const css = await machineAssetAnswer(new Response("body{background:url(/api/html-assets/pic1/bg.png)}", { headers: { "Content-Type": "text/css; charset=utf-8", "Content-Security-Policy": "sandbox", "Content-Length": "48", "Accept-Ranges": "bytes", "Content-Range": "bytes 0-47/48" } }), B);
    expect(await css.text()).toBe(`body{background:url(${FORWARD}pic1/bg.png)}`);
    expect(css.headers.get("content-security-policy")).toBe("sandbox");
    expect([css.headers.get("content-length"), css.headers.get("content-range"), css.headers.get("accept-ranges")]).toEqual([null, null, null]);
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

describe("whatever the far machine sends", () => {
  test("its CSP keeps a sandbox and loses every flag that escapes it", () => {
    expect(farCsp("sandbox allow-scripts allow-same-origin allow-top-navigation allow-popups-to-escape-sandbox; connect-src *")).toBe("sandbox allow-scripts; connect-src *");
    expect(farCsp("SANDBOX Allow-Same-Origin allow-top-navigation-by-user-activation allow-top-navigation-to-custom-protocols allow-forms")).toBe("sandbox allow-forms");
    // No sandbox at all, an empty one, a second policy that tries to add one back loosely: always sandboxed.
    expect(farCsp("default-src *")).toBe("default-src *; sandbox");
    expect(farCsp(null)).toBe("sandbox");
    expect(farCsp("sandbox, sandbox allow-same-origin allow-scripts")).toBe("sandbox; sandbox allow-scripts");
    expect(farCsp(INBOX_HTML_DOCUMENT_CSP)).toBe(INBOX_HTML_DOCUMENT_CSP);
  });

  test("a far folder's answer gets a local folder's CSP: a page a local page's, anything else a local support asset's", () => {
    expect(machineAssetCsp(new Response("", { headers: { "Content-Type": "TEXT/HTML; charset=utf-8" } }))).toBe(INBOX_HTML_DOCUMENT_CSP);
    for (const type of ["image/svg+xml", "text/css", "application/xhtml+xml", ""]) {
      expect([type, machineAssetCsp(new Response("", { headers: type ? { "Content-Type": type } : {} }))]).toEqual([type, HTML_ASSET_SUBRESOURCE_CSP]);
    }
  });

  test("a hostile view cannot move the new tab off the page's own folder through the forward", async () => {
    const target = new RegExp(`^/api/inbox/m/${B}/html-assets/[A-Za-z0-9_-]+/[^/?#\\\\]+$`);
    const cases: [Record<string, unknown>, string][] = [
      [{ path: "/work/site/../../threads/evil.html" }, html],
      [{ path: "/work/site/..%2f..%2fthreads.html" }, html],
      [{ path: "C:\\work\\site\\..\\evil.html" }, html],
      [{ path: "/work/site/a?b#c/x.html" }, html],
      [{ path: "/work/site/.." }, html],
      [{ path: 42 }, html],
      [{}, '<base href="/api/html-assets/../threads/">'],
      [{}, '<base href="/api/html-assets/tok%2f..%2f/">'],
      [{}, '<base href="//evil.example/api/html-assets/tok/">'],
      [{}, '<base href="https://evil.example/">'],
      [{ current: { size: "1" } }, html],
    ];
    for (const [changed, served] of cases) {
      const answer = await machinePageAnswer(view({ ...page, ...changed }, served), B, "", pass);
      const location = answer.headers.get("location");
      if (answer.status === 303) expect([JSON.stringify(changed), location]).toEqual([JSON.stringify(changed), expect.stringMatching(target)]);
      else expect([JSON.stringify(changed), answer.status, location, answer.headers.get("content-security-policy")]).toEqual([JSON.stringify(changed), 200, null, INBOX_HTML_DOCUMENT_CSP]);
    }
    // An unknown refusal code is a missing file's, its words cut short.
    const odd = await machinePageAnswer(view({ ...page, unavailable: { code: "x".repeat(50), message: "m".repeat(5000) } }, html), B, "", pass);
    expect(odd.status).toBe(404);
    const body = (await odd.json()) as { code: string; error: string };
    expect([body.code, body.error.length]).toEqual(["attachment_missing", 300]);
  });
});

describe("what is read here is capped", () => {
  /**
   * A body of `size` bytes in 1 MB chunks between `head` and `tail`, with no declared length, so only reading it
   * shows its size. The head names an asset route, so a body read and rebased whole would show it.
   */
  function streamed(size: number, head: string, tail = ""): ReadableStream<Uint8Array> {
    const parts = [new TextEncoder().encode(head)];
    let left = size - parts[0]!.length - tail.length;
    return new ReadableStream({
      pull(controller) {
        const first = parts.shift();
        if (first) return controller.enqueue(first);
        if (left <= 0) {
          if (tail) controller.enqueue(new TextEncoder().encode(tail));
          tail = "";
          return controller.close();
        }
        const chunk = new Uint8Array(Math.min(left, 1024 * 1024)).fill(0x61);
        left -= chunk.length;
        controller.enqueue(chunk);
      },
    });
  }
  const head = (answer: Response) => answer.arrayBuffer().then((bytes) => [bytes.byteLength, new TextDecoder().decode(bytes.slice(0, 40))]);

  test("a page or stylesheet past the cap streams on whole and unrebased", async () => {
    const size = MACHINE_ASSET_REBASE_MAX_BYTES + 10;
    const answer = await machineAssetAnswer(new Response(streamed(size, "/api/html-assets/t/x "), { headers: { "Content-Type": "text/css" } }), B);
    expect(answer.status).toBe(200);
    expect(await head(answer)).toEqual([size, `/api/html-assets/t/x ${"a".repeat(19)}`]);
    // A declared length past the cap is not read at all.
    const declared = new Response("/api/html-assets/t/x", { headers: { "Content-Type": "text/html", "Content-Length": String(MACHINE_ASSET_REBASE_MAX_BYTES + 1) } });
    expect(await machineAssetAnswer(declared, B)).toBe(declared);
  });

  test("a view past the cap: the new tab is refused, the viewer's read streams on as it came", async () => {
    const size = MACHINE_VIEW_MAX_BYTES + 10;
    const tooBig = () => new Response(streamed(size, '{"html":"/api/html-assets/t/', '"}'), { headers: { "Content-Type": "application/json" } });
    const tab = await machinePageAnswer(tooBig(), B, "", pass);
    expect(tab.status).toBe(413);
    expect(((await tab.json()) as { code: string }).code).toBe("machine_page_too_large");
    expect(await head(await machineViewAnswer(tooBig(), B))).toEqual([size, `{"html":"/api/html-assets/t/${"a".repeat(12)}`]);
  });

  test("the rebase is byte for byte, whatever the charset", async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode("caf\u00e9 \u{1F600} "), 0xe9, 0xff, ...new TextEncoder().encode(' url("/api/html-assets/t/a.png")')]);
    const answer = await machineAssetAnswer(new Response(bytes, { headers: { "Content-Type": "text/css; charset=iso-8859-1" } }), B);
    const expected = new Uint8Array([...new TextEncoder().encode("caf\u00e9 \u{1F600} "), 0xe9, 0xff, ...new TextEncoder().encode(` url("${FORWARD}t/a.png")`)]);
    expect(new Uint8Array(await answer.arrayBuffer())).toEqual(expected);
  });

  test("only a plain 200 is rebased: a part (206) or any other answer passes untouched", async () => {
    const part = new Response("/api/html-assets/t/x", { status: 206, headers: { "Content-Type": "text/css", "Content-Range": "bytes 10-29/100", "Content-Length": "20" } });
    expect(await machineAssetAnswer(part, B)).toBe(part);
    const viewPart = new Response('{"html":"/api/html-assets/t/"}', { status: 203, headers: { "Content-Type": "application/json" } });
    expect(await machineViewAnswer(viewPart, B)).toBe(viewPart);
  });
});
