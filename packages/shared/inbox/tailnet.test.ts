/**
 * The Inbox over the tailnet, pure parts: who owns this machine (`tailscale
 * status --json`), the identity header serve sets, the owner check, the
 * served-Host check, the Sec-Fetch-Site rule, and the switch's resolution.
 * Nothing here spawns `tailscale`.
 */
import { describe, expect, test } from "bun:test";
import { resolveInboxTailscale, resolveInboxTailscaleAllow } from "../config";
import { decodeTailscaleHeaderValue, parseTailscaleSelfIdentity, serveStatusRoutes, serveTargetIsLoopbackPort } from "../tailscale";
import { checkTailnetIdentity, isServedTailnetHost, tailnetFetchSiteAllowed } from "./tailnet";

const status = (self: Record<string, unknown>, users: Record<string, unknown> = { "42": { LoginName: "me@example.com" } }) =>
  JSON.stringify({ Self: self, User: users });

describe("parseTailscaleSelfIdentity", () => {
  test("the owner is Self.UserID looked up in User (keyed by the id as a string)", () => {
    expect(parseTailscaleSelfIdentity(status({ UserID: 42 }))).toEqual({ login: "me@example.com", tagged: false });
    expect(parseTailscaleSelfIdentity(status({ UserID: 7 }, { "7": { LoginName: " alice@github " }, "42": { LoginName: "x@y" } }))).toEqual({ login: "alice@github", tagged: false });
  });
  test("a tagged machine has no owner, whatever pseudo-user Tailscale lists for it", () => {
    expect(parseTailscaleSelfIdentity(status({ UserID: 42, Tags: ["tag:server"] }, { "42": { LoginName: "tagged-devices" } }))).toEqual({ login: null, tagged: true });
  });
  test("an unknown user id, a missing User map or an empty login is no login; not a status document is undefined", () => {
    expect(parseTailscaleSelfIdentity(status({ UserID: 9 }))).toEqual({ login: null, tagged: false });
    expect(parseTailscaleSelfIdentity(JSON.stringify({ Self: { UserID: 42 } }))).toEqual({ login: null, tagged: false });
    expect(parseTailscaleSelfIdentity(status({ UserID: 42 }, { "42": { LoginName: "" } }))).toEqual({ login: null, tagged: false });
    expect(parseTailscaleSelfIdentity("not json")).toBeUndefined();
    expect(parseTailscaleSelfIdentity("null")).toBeUndefined();
    expect(parseTailscaleSelfIdentity(JSON.stringify({ User: {} }))).toBeUndefined();
  });
});

describe("decodeTailscaleHeaderValue", () => {
  test("ASCII passes as is", () => {
    expect(decodeTailscaleHeaderValue("me@example.com")).toBe("me@example.com");
  });
  test("RFC 2047 Q-encoded words (Go's mime.QEncoding) decode, adjacent words joined", () => {
    expect(decodeTailscaleHeaderValue("=?utf-8?q?j=C3=BCrgen@example.com?=")).toBe("jürgen@example.com");
    expect(decodeTailscaleHeaderValue("=?UTF-8?Q?J=C3=BCrgen_M?= =?utf-8?q?=C3=BCller?=")).toBe("Jürgen Müller");
  });
  test("an encoded word that decodes to ASCII is not what serve writes: it is kept raw, so it never matches a login", () => {
    expect(decodeTailscaleHeaderValue("=?utf-8?q?me@example.com?=")).toBe("=?utf-8?q?me@example.com?=");
    expect(checkTailnetIdentity(new Headers({ "Tailscale-User-Login": "=?utf-8?q?me@example.com?=" }), ["me@example.com"])).toMatchObject({ ok: false, code: "tailnet_identity_refused" });
  });
  test("a malformed or non-UTF-8 encoded word is null, never a guess", () => {
    expect(decodeTailscaleHeaderValue("=?utf-8?q?bad=ZZ?=")).toBeNull();
    expect(decodeTailscaleHeaderValue("=?utf-8?q?=FF?=")).toBeNull();
    expect(decodeTailscaleHeaderValue("=?iso-8859-1?q?x?=")).toBeNull();
    expect(decodeTailscaleHeaderValue("=?utf-8?q?unterminated")).toBeNull();
  });
});

describe("checkTailnetIdentity", () => {
  const allowed = ["me@example.com"];
  const headers = (init: Record<string, string>) => new Headers(init);
  test("the owner's login, in any case or Q-encoded, is let in", () => {
    expect(checkTailnetIdentity(headers({ "Tailscale-User-Login": "me@example.com" }), allowed)).toEqual({ ok: true, login: "me@example.com" });
    expect(checkTailnetIdentity(headers({ "tailscale-user-login": "ME@Example.COM" }), allowed)).toEqual({ ok: true, login: "me@example.com" });
    expect(checkTailnetIdentity(headers({ "Tailscale-User-Login": "=?utf-8?q?j=C3=BCrgen@example.com?=" }), ["jürgen@example.com"])).toMatchObject({ ok: true });
  });
  test("another login, no login (a tagged peer), an empty or undecodable login and a funnel request are refused", () => {
    expect(checkTailnetIdentity(headers({ "Tailscale-User-Login": "you@example.com" }), allowed)).toMatchObject({ ok: false, status: 403, code: "tailnet_identity_refused" });
    expect(checkTailnetIdentity(headers({}), allowed)).toMatchObject({ ok: false, code: "tailnet_identity_required" });
    expect(checkTailnetIdentity(headers({ "Tailscale-User-Login": "  " }), allowed)).toMatchObject({ ok: false, code: "tailnet_identity_required" });
    expect(checkTailnetIdentity(headers({ "Tailscale-User-Login": "=?utf-8?q?=FF?=" }), allowed)).toMatchObject({ ok: false, code: "tailnet_identity_required" });
    expect(checkTailnetIdentity(headers({ "Tailscale-User-Login": "me@example.com", "Tailscale-Funnel-Request": "?1" }), allowed)).toMatchObject({ ok: false, code: "tailnet_funnel_refused" });
  });
  test("nobody is let in when the list is empty", () => {
    expect(checkTailnetIdentity(headers({ "Tailscale-User-Login": "me@example.com" }), [])).toMatchObject({ ok: false, code: "tailnet_identity_refused" });
  });
});

describe("isServedTailnetHost", () => {
  test("the served name with the HTTPS port, any case, a trailing dot tolerated", () => {
    expect(isServedTailnetHost("mac.tail0.ts.net:52817", "mac.tail0.ts.net", 52817)).toBe(true);
    expect(isServedTailnetHost("MAC.tail0.ts.net.:52817", "mac.tail0.ts.net", 52817)).toBe(true);
  });
  test("no port, another port, another name, a loopback claim, nothing: refused", () => {
    for (const host of [null, "", "mac.tail0.ts.net", "mac.tail0.ts.net:443", "mac.tail0.ts.net:1", "evil.example:52817", "127.0.0.1:52817", "localhost:52817", "mac.tail0.ts.net.evil.example:52817"]) {
      expect([host, isServedTailnetHost(host, "mac.tail0.ts.net", 52817)]).toEqual([host, false]);
    }
  });
});

describe("tailnetFetchSiteAllowed", () => {
  const h = (init: Record<string, string>) => new Headers(init);
  test("same-origin, a direct visit and a non-browser client pass", () => {
    expect(tailnetFetchSiteAllowed("GET", "/api/inbox/threads", h({ "Sec-Fetch-Site": "same-origin" }))).toBe(true);
    expect(tailnetFetchSiteAllowed("GET", "/", h({ "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" }))).toBe(true);
    expect(tailnetFetchSiteAllowed("POST", "/api/inbox/settings", h({}))).toBe(true);
  });
  test("another site (or another machine on the tailnet) may only open the window or load an attached page's assets", () => {
    for (const site of ["cross-site", "same-site"]) {
      expect(tailnetFetchSiteAllowed("GET", "/", h({ "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate" }))).toBe(true);
      expect(tailnetFetchSiteAllowed("GET", "/api/html-assets/tok/img.png", h({ "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "no-cors" }))).toBe(true);
      expect(tailnetFetchSiteAllowed("GET", "/api/inbox/threads", h({ "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "cors" }))).toBe(false);
      expect(tailnetFetchSiteAllowed("GET", "/api/inbox/threads", h({ "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate" }))).toBe(false);
      expect(tailnetFetchSiteAllowed("POST", "/", h({ "Sec-Fetch-Site": site, "Sec-Fetch-Mode": "navigate" }))).toBe(false);
      expect(tailnetFetchSiteAllowed("POST", "/api/html-assets/tok/x", h({ "Sec-Fetch-Site": site }))).toBe(false);
    }
  });
});

describe("serve routes that land on the window's port", () => {
  const status = JSON.stringify({
    TCP: { "443": { HTTPS: true }, "52817": { HTTPS: true }, "7000": { TCPForward: "127.0.0.1:52817" } },
    Web: {
      "mac.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:5274" } } },
      "mac.ts.net:52817": { Handlers: { "/": { Proxy: "http://127.0.0.1:52817" }, "/x": { Proxy: "http://localhost:9" } } },
    },
    Foreground: { s1: { Web: { "mac.ts.net:8080": { Handlers: { "/": { Proxy: "https+insecure://localhost:52817" } } } } } },
  });
  test("every web handler and TCP forward, background and foreground", () => {
    expect(serveStatusRoutes(status)?.sort((a, b) => a.port - b.port || a.target.localeCompare(b.target))).toEqual([
      { port: 443, target: "http://127.0.0.1:5274" },
      { port: 7000, target: "tcp://127.0.0.1:52817" },
      { port: 8080, target: "https+insecure://localhost:52817" },
      { port: 52817, target: "http://127.0.0.1:52817" },
      { port: 52817, target: "http://localhost:9" },
    ]);
    expect(serveStatusRoutes("null")).toEqual([]);
    expect(serveStatusRoutes("")).toBeUndefined();
    expect(serveStatusRoutes("[1]")).toBeUndefined();
  });
  test("a loopback target on the port, in any spelling; nothing else", () => {
    for (const target of ["http://127.0.0.1:52817", "http://localhost:52817/", "https+insecure://localhost:52817", "tcp://127.0.0.1:52817", "http://[::1]:52817"]) {
      expect([target, serveTargetIsLoopbackPort(target, 52817)]).toEqual([target, true]);
    }
    for (const target of ["http://127.0.0.1:5274", "http://10.0.0.2:52817", "http://127.0.0.1.evil.example:52817", "http://localhost", "not a url"]) {
      expect([target, serveTargetIsLoopbackPort(target, 52817)]).toEqual([target, false]);
    }
  });
});

describe("resolveInboxTailscale", () => {
  test("env (a hard switch, both ways), then the flag, then config, then off", () => {
    expect(resolveInboxTailscale({ inboxTailscale: true }, { PLANNOTATOR_INBOX_TAILSCALE: "0" }, true)).toEqual({ on: false, source: "env" });
    expect(resolveInboxTailscale({}, { PLANNOTATOR_INBOX_TAILSCALE: "1" }, true)).toEqual({ on: true, source: "env" });
    expect(resolveInboxTailscale({ inboxTailscale: false }, {}, true)).toEqual({ on: true, source: "flag" });
    expect(resolveInboxTailscale({}, {})).toEqual({ on: false, source: "default" });
    expect(resolveInboxTailscale({ inboxTailscale: true }, {})).toEqual({ on: true, source: "config" });
    expect(resolveInboxTailscale({ inboxTailscale: "true" as never }, {})).toEqual({ on: true, source: "config" });
    expect(resolveInboxTailscale({ inboxTailscale: true }, { PLANNOTATOR_INBOX_TAILSCALE: "off" })).toEqual({ on: false, source: "env" });
    expect(resolveInboxTailscale({}, { PLANNOTATOR_INBOX_TAILSCALE: " ON " })).toEqual({ on: true, source: "env" });
    expect(resolveInboxTailscale({ inboxTailscale: false }, { PLANNOTATOR_INBOX_TAILSCALE: "disabled" }, true)).toEqual({ on: false, source: "env" });
  });
  test("an empty or unrecognized env value counts as unset", () => {
    expect(resolveInboxTailscale({ inboxTailscale: true }, { PLANNOTATOR_INBOX_TAILSCALE: "" })).toEqual({ on: true, source: "config" });
    expect(resolveInboxTailscale({}, { PLANNOTATOR_INBOX_TAILSCALE: "maybe" })).toEqual({ on: false, source: "default" });
  });
  test("inboxTailscaleAllow: trimmed, lower-cased, deduplicated; non-strings and logins with spaces dropped", () => {
    expect(resolveInboxTailscaleAllow({ inboxTailscaleAllow: [" Me@Example.com", "me@example.com", "two words", "", 3 as never, "b@github"] })).toEqual(["me@example.com", "b@github"]);
    expect(resolveInboxTailscaleAllow({ inboxTailscaleAllow: "me@example.com" as never })).toEqual([]);
    expect(resolveInboxTailscaleAllow({})).toEqual([]);
  });
});
