/**
 * Which app origins may frame the Inbox window (config.json
 * `inboxFrameAncestors`, inbox-framing.ts), and the policies the window's own
 * documents send with them, on the routes alone (no Inbox is started; the
 * listeners are in inbox-frame-ancestors.test.ts). What regresses if these fail:
 * - a wildcard, `file:`, a scheme alone, a site on the web or a value carrying
 *   a second directive reaches the window's policy;
 * - an exact origin of an app on this computer (a loopback port, `app://`,
 *   `tauri://localhost`) is refused, so the host shows a blank frame;
 * - an attached page, an html fence or the tour's mock stays `'self'` only and
 *   goes blank inside the host, or loses `'self'` and goes blank in the window;
 * - with no list, any of those documents' policies is not the constant it was.
 */
import { describe, expect, test } from "bun:test";
import { EMBED_RESPONSE_CSP } from "@plannotator/core/html-embed";
import { INBOX_WINDOW_CSP } from "./inbox";
import { createInboxEmbeds } from "./inbox-embeds";
import { framedWindowHeaders, inboxFrameAncestor, NO_FRAME_ANCESTORS, resolveInboxFrameAncestors, withFrameAncestors } from "./inbox-framing";
import { createInboxPages, INBOX_PAGE_CSP } from "./inbox-pages";
import { handleInboxTourRequest, INBOX_TOUR_MOCK_CSP } from "./inbox-tour";

const HOSTS = ["app://hermes", "http://localhost:5173"];
const json = (body: unknown, status = 200) => Response.json(body, { status });
const directives = (csp: string) => new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

describe("inboxFrameAncestors: what is kept", () => {
  test("exact origins of an app on this computer: loopback http(s) with its port, and app schemes with a host", () => {
    for (const origin of [
      "http://localhost:5173",
      "https://localhost:8443",
      "http://127.0.0.1:3000",
      "http://127.4.5.6:3000",
      "http://[::1]:5173",
      "http://hermes.localhost:61738",
      "app://hermes",
      "app://hermes:3000",
      "tauri://localhost",
      "electron-app://main.window",
    ]) {
      expect([origin, inboxFrameAncestor(origin)]).toEqual([origin, origin]);
    }
    // Written loosely, named as the browser compares it.
    expect(inboxFrameAncestor("  APP://Hermes ")).toBe("app://hermes");
    expect(inboxFrameAncestor("HTTP://LOCALHOST:5173")).toBe("http://localhost:5173");
  });

  test("everything else is dropped: wildcards, keywords, file: and other browser schemes, a scheme alone, a path, a default or missing port, any host on the network, a second directive", () => {
    for (const entry of [
      "*",
      "'self'",
      "'none'",
      "self",
      "http:",
      "https:",
      "app:",
      "app://",
      "file://",
      "file:///Users/me/app/index.html",
      "data:text/html,x",
      "blob:http://localhost:5173/uuid",
      "javascript://alert",
      "about://blank",
      "chrome-extension://abcdefghijklmnop",
      "ws://localhost:5173",
      "http://localhost",
      "http://localhost:80",
      "https://localhost:443",
      "http://localhost:5173/",
      "http://localhost:5173/app",
      "http://localhost:5173?x=1",
      "http://me@localhost:5173",
      "http://*.localhost:5173",
      "http://localhost:*",
      "app://*",
      "app://hermes/",
      "app://hermes/index.html",
      "app://hermes:0",
      "app://hermes:70000",
      "app://-x",
      "https://example.com",
      "https://example.com:443",
      "http://192.168.1.20:5173",
      "http://127.0.0.1.evil.example:5173",
      "http://localhost.evil.example:5173",
      "http://localhost:5173; script-src *",
      "app://hermes;script-src *",
      "app://hermes app://other",
      "app://hermes,app://other",
      "app://her'mes",
      "",
      "   ",
    ]) {
      expect([entry, inboxFrameAncestor(entry)]).toEqual([entry, null]);
    }
    for (const entry of [1, null, undefined, true, {}, ["app://hermes"]]) expect(inboxFrameAncestor(entry)).toBeNull();
  });

  test("the list: kept entries once each in the order written, one stderr line per dropped entry; unset, empty or not a list frames nothing", () => {
    const lines: string[] = [];
    const kept = resolveInboxFrameAncestors(["app://hermes", "*", "APP://hermes", "https://example.com", 7, "http://localhost:5173"], (line) => lines.push(line));
    expect(kept).toEqual(HOSTS);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('"*" is not used');
    expect(lines[1]).toContain('"https://example.com" is not used');
    expect(lines[2]).toContain("7 is not used");
    for (const line of lines) expect(line.endsWith("\n")).toBe(true);

    const quiet: string[] = [];
    expect(resolveInboxFrameAncestors(undefined, (line) => quiet.push(line))).toBe(NO_FRAME_ANCESTORS);
    expect(resolveInboxFrameAncestors([], (line) => quiet.push(line))).toBe(NO_FRAME_ANCESTORS);
    expect(quiet).toEqual([]);
    expect(resolveInboxFrameAncestors(["*", "file://"])).toBe(NO_FRAME_ANCESTORS);
    const wrongShape: string[] = [];
    expect(resolveInboxFrameAncestors("app://hermes", (line) => wrongShape.push(line))).toBe(NO_FRAME_ANCESTORS);
    expect(wrongShape).toHaveLength(1);
  });
});

describe("the policies with a list", () => {
  test("the window: no X-Frame-Options, frame-ancestors is exactly the list, every other directive and header as it was; no list, the headers as they were", () => {
    const base = { "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer", "Content-Security-Policy": INBOX_WINDOW_CSP };
    const framed = framedWindowHeaders(base, HOSTS);
    expect(Object.keys(framed).sort()).toEqual(["Content-Security-Policy", "Referrer-Policy", "X-Content-Type-Options"]);
    const csp = directives(framed["Content-Security-Policy"]!);
    expect(csp.get("frame-ancestors")).toEqual(HOSTS);
    const before = directives(INBOX_WINDOW_CSP);
    expect([...csp.keys()]).toEqual([...before.keys()]);
    for (const [name, values] of before) if (name !== "frame-ancestors") expect([name, csp.get(name)]).toEqual([name, values]);
    expect(framedWindowHeaders(base, NO_FRAME_ANCESTORS)).toEqual(base);
  });

  test("a document the window frames keeps 'self' and adds the list; no list, the policy is the same string", () => {
    expect(directives(withFrameAncestors(INBOX_PAGE_CSP, HOSTS)).get("frame-ancestors")).toEqual(["'self'", ...HOSTS]);
    for (const csp of [INBOX_PAGE_CSP, EMBED_RESPONSE_CSP, INBOX_TOUR_MOCK_CSP, INBOX_WINDOW_CSP]) expect(withFrameAncestors(csp, NO_FRAME_ANCESTORS)).toBe(csp);
  });

  test("attached pages, the gone page, html fences and the tour's mock: 'self' plus the list when given one, their own policy as it was without", async () => {
    let body: Record<string, unknown> = { html: "<!doctype html><p>a page</p>" };
    const pages = createInboxPages({ readBody: async () => body, json });
    const posted = (await (await pages.route(new Request("http://127.0.0.1/api/inbox/pages", { method: "POST" }), new URL("http://127.0.0.1/api/inbox/pages")))!.json()) as { url: string };
    const page = (path: string, framers?: readonly string[]) => pages.route(new Request(`http://127.0.0.1${path}`), new URL(`http://127.0.0.1${path}`), framers);
    const framedPage = (await page(posted.url, HOSTS))!;
    expect(framedPage.status).toBe(200);
    expect(directives(framedPage.headers.get("content-security-policy")!).get("frame-ancestors")).toEqual(["'self'", ...HOSTS]);
    expect(directives(framedPage.headers.get("content-security-policy")!).get("sandbox")).toEqual(["allow-scripts", "allow-modals"]);
    expect((await page(posted.url))!.headers.get("content-security-policy")).toBe(INBOX_PAGE_CSP);
    const gone = (await page("/api/inbox/pages/0123456789abcdef0123456789abcdef", HOSTS))!;
    expect(gone.status).toBe(404);
    expect(directives(gone.headers.get("content-security-policy")!).get("frame-ancestors")).toEqual(["'self'", ...HOSTS]);
    expect(directives(gone.headers.get("content-security-policy")!).get("default-src")).toEqual(["'none'"]);
    expect(directives((await page("/api/inbox/pages/0123456789abcdef0123456789abcdef"))!.headers.get("content-security-policy")!).get("frame-ancestors")).toEqual(["'self'"]);

    body = { html: "<p>a fence</p>" };
    const embeds = createInboxEmbeds({ readBody: async () => body, json });
    const kept = (await (await embeds.route(new Request("http://127.0.0.1/api/inbox/embeds", { method: "POST" }), new URL("http://127.0.0.1/api/inbox/embeds")))!.json()) as { url: string };
    const embed = (framers?: readonly string[]) => embeds.route(new Request(`http://127.0.0.1${kept.url}`), new URL(`http://127.0.0.1${kept.url}`), framers);
    expect(directives((await embed(HOSTS))!.headers.get("content-security-policy")!).get("frame-ancestors")).toEqual(["'self'", ...HOSTS]);
    expect((await embed())!.headers.get("content-security-policy")).toBe(EMBED_RESPONSE_CSP);

    const mockPath = "/api/inbox/tour/assets/vscode-mockups.html";
    const mock = (framers?: readonly string[]) => handleInboxTourRequest(new Request(`http://127.0.0.1${mockPath}`), mockPath, framers);
    const framedMock = (await mock(HOSTS))!;
    expect(framedMock.status).toBe(200);
    expect(directives(framedMock.headers.get("content-security-policy")!).get("frame-ancestors")).toEqual(["'self'", ...HOSTS]);
    expect((await mock())!.headers.get("content-security-policy")).toBe(INBOX_TOUR_MOCK_CSP);
  });
});
