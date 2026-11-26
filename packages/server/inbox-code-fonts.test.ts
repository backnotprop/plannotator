/**
 * Settings → Reviews → Code Font in the Inbox window: every web font the menu
 * offers loads its stylesheet (`style-src`) and font files (`font-src`) under
 * the window's policy (`WINDOW_CSP`, inbox.ts), and nothing else reaches the
 * web because of it. What regresses if these fail: a font in the menu is
 * picked and nothing changes (the browser blocks its stylesheet), or the
 * policy lets more of a host in than the fonts need (all of jsDelivr, say).
 *
 * The matcher below is CSP's source-expression match for the forms the policy
 * uses (`'self'`-style keywords never match a remote URL): scheme and host
 * exactly, a path ending in `/` as a prefix, any other path exactly.
 */
import { expect, test } from "bun:test";
// The menu's own table (ui; the server package does not depend on ui, so by path, as annotate-agent-instructions.test.ts).
import { DIFF_FONT_URLS } from "../ui/utils/diffFonts";
import { WINDOW_CSP } from "./inbox";

const directives = (csp: string) => new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

function sourceAllows(source: string, url: URL): boolean {
  if (source === "*") return url.protocol === "https:" || url.protocol === "http:";
  if (/^[a-z][a-z0-9+.-]*:$/.test(source)) return url.protocol === source;
  const match = /^(https?):\/\/(\*\.)?([^/]+)(\/.*)?$/.exec(source);
  if (!match) return false;
  const [, scheme, wildcard, host, path = ""] = match;
  if (`${scheme}:` !== url.protocol) return false;
  if (wildcard ? !url.host.endsWith(`.${host}`) : url.host !== host) return false;
  if (path === "" || path === "/") return true;
  return path.endsWith("/") ? url.pathname.startsWith(path) : url.pathname === path;
}

const allows = (directive: string, href: string) => (directives(WINDOW_CSP).get(directive) ?? []).some((source) => sourceAllows(source, new URL(href)));

test("every web font in the menu: its stylesheet is allowed by the window's style-src", () => {
  const urls = Object.entries(DIFF_FONT_URLS);
  expect(urls.length).toBeGreaterThan(0);
  for (const [name, href] of urls) expect([name, allows("style-src", href)]).toEqual([name, true]);
});

test("the font files those stylesheets name are allowed by font-src: Google's file host and Hack's own folder", () => {
  // As Google's css2 answers and as hack.css names its files (relative to itself).
  expect(allows("font-src", "https://fonts.gstatic.com/s/firacode/v27/uU9NCBsR6Z2vfE9aq3bh3dSD.woff2")).toBe(true);
  expect(allows("font-src", new URL("fonts/hack-regular.woff2?sha=3114f1256", DIFF_FONT_URLS.Hack).href)).toBe(true);
});

test("no more of those hosts than the fonts need, and nothing but styles and fonts from them", () => {
  // Another package on jsDelivr, or another file host, is still blocked.
  for (const href of ["https://cdn.jsdelivr.net/npm/evil@1/x.css", "https://cdn.jsdelivr.net/gh/someone/repo/x.css", "https://example.com/x.css"]) {
    expect([href, allows("style-src", href)]).toEqual([href, false]);
    expect([href, allows("font-src", href)]).toEqual([href, false]);
  }
  const policy = directives(WINDOW_CSP);
  // Anything but this origin's keywords, data: and blob: reaches beyond the Inbox: a host, a scheme-only source, a wildcard.
  const LOCAL = new Set(["'self'", "'none'", "'unsafe-inline'", "'wasm-unsafe-eval'", "data:", "blob:"]);
  const remote = (name: string) => (policy.get(name) ?? []).filter((source) => !LOCAL.has(source));
  for (const name of ["default-src", "script-src", "connect-src", "media-src", "worker-src"]) expect([name, remote(name)]).toEqual([name, []]);
  // The font places in no directive but style-src and font-src, every directive the policy has (img-src's own places
  // are inbox-pages.test.ts's to pin).
  const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];
  for (const [name, sources] of policy) {
    if (name === "style-src" || name === "font-src") continue;
    for (const source of sources) expect([name, source, FONT_HOSTS.some((host) => source.includes(host))]).toEqual([name, source, false]);
  }
});

test("styles and fonts come from exactly Google Fonts' two hosts and one pinned jsDelivr folder: no wildcard, no scheme-only source, no http:", () => {
  const policy = directives(WINDOW_CSP);
  const LOCAL = new Set(["'self'", "'unsafe-inline'", "data:"]);
  const hosts = new Set<string>();
  for (const name of ["style-src", "font-src"]) {
    for (const source of policy.get(name) ?? []) {
      if (LOCAL.has(source)) continue;
      // https://<host> or https://<host>/<path>/, the host spelled out.
      const match = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/(?:[A-Za-z0-9@._-]+\/)+)?$/.exec(source);
      expect([name, source, !!match]).toEqual([name, source, true]);
      const [, host, path] = match!;
      hosts.add(host!);
      if (host === "cdn.jsdelivr.net") expect([source, /^\/npm\/hack-font@\d+\.\d+\.\d+\/build\/web\/$/.test(path ?? "")]).toEqual([source, true]);
      else expect([source, path ?? ""]).toEqual([source, ""]);
    }
  }
  expect([...hosts].sort()).toEqual(["cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"]);
});

test("IBM Plex Mono is not a variable font: its stylesheet names weights, not a range (Google answers a range with 400)", () => {
  expect(new URL(DIFF_FONT_URLS["IBM Plex Mono"]!).searchParams.get("family")).toBe("IBM Plex Mono:wght@300;400;500;600;700");
});
