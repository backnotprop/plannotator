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
import { DIFF_FONT_SOURCES, DIFF_FONT_URLS } from "@plannotator/core/diff-fonts";
import { WINDOW_CSP } from "./inbox";

const directives = (csp: string) => new Map(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name!, values]));

function sourceAllows(source: string, url: URL): boolean {
  if (!/^https?:\/\//.test(source)) return false;
  const allowed = new URL(source);
  if (allowed.protocol !== url.protocol || allowed.host !== url.host) return false;
  const path = source.slice(allowed.origin.length);
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
  const remote = (name: string) => (policy.get(name) ?? []).filter((source) => /^(https?:|\*)/.test(source));
  expect(remote("style-src")).toEqual([...DIFF_FONT_SOURCES.stylesheets]);
  expect(remote("font-src")).toEqual([...DIFF_FONT_SOURCES.files]);
  for (const name of ["default-src", "script-src", "connect-src", "media-src", "worker-src"]) expect([name, remote(name)]).toEqual([name, []]);
  expect(remote("img-src")).toEqual(["https://plannotator.ai/assets/hosted/"]);
});
