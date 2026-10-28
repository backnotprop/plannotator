/**
 * Live HTML embeds: an agent's ```html fence drawn as a page inside a message
 * (approval "inbox-inline-html", 2026-10-28). Pure strings, browser-safe and
 * dependency-free: the Inbox server builds the embed's document with it, and
 * ui's `HtmlEmbedBlock` frames that document and reads its messages.
 *
 * Why a served document and not a srcdoc frame: a srcdoc (and a `data:` or
 * `blob:` frame) inherits the window's own CSP, which allows no remote
 * script, style, image or fetch, and a policy inside the frame can only
 * narrow it. The owner chose pages that may load from the web ("anything,
 * like t3code's pages"), so the embed is a document the Inbox serves with its
 * own policy (`EMBED_RESPONSE_CSP`).
 *
 * A sandboxed frame, as T3 Code draws an agent's HTML:
 * - The frame's `sandbox` is `allow-scripts allow-forms` (`EMBED_SANDBOX`):
 *   an opaque origin (no cookies, storage or parent DOM), no popups, modals
 *   or top navigation. Never `allow-same-origin`.
 * - The response's CSP sandboxes the document too, so the same holds when the
 *   embed's URL is opened as a page of its own, and lets it load from the
 *   web over HTTPS only (`EMBED_REMOTE_SOURCES`), never from the Inbox.
 * - The page speaks to the window only through `readEmbedMessage` (its
 *   height, a web link, Escape), checked against the frame's own window by
 *   the host, which opens a link only while the person is using the frame.
 */

/** The embed frame's sandbox. Exactly this: never `allow-same-origin` (pinned by html-embed.test.ts). */
export const EMBED_SANDBOX = "allow-scripts allow-forms";

/**
 * Where an embedded page may load scripts, styles, images, fonts, media,
 * frames and fetches from: the web over HTTPS (owner, 2026-10-28). The one
 * place to narrow it: `"'none'"` makes embeds offline, or a short list of
 * hosts (`"https://cdn.jsdelivr.net https://unpkg.com"`) allows only those.
 */
export const EMBED_REMOTE_SOURCES = "https:";

/**
 * The embed document's response CSP. `'self'` is never a source: the page
 * never reaches the Inbox. Only the Inbox's own window may frame it.
 */
export const EMBED_RESPONSE_CSP = [
  `sandbox ${EMBED_SANDBOX}`,
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' data: blob: ${EMBED_REMOTE_SOURCES}`,
  `style-src 'unsafe-inline' data: ${EMBED_REMOTE_SOURCES}`,
  `img-src data: blob: ${EMBED_REMOTE_SOURCES}`,
  `font-src data: ${EMBED_REMOTE_SOURCES}`,
  `media-src data: blob: ${EMBED_REMOTE_SOURCES}`,
  `connect-src ${EMBED_REMOTE_SOURCES}`,
  `worker-src blob: ${EMBED_REMOTE_SOURCES}`,
  `frame-src ${EMBED_REMOTE_SOURCES}`,
  "object-src 'none'",
  "manifest-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

/** A fence larger than this stays code (and the Inbox refuses to serve it). */
export const EMBED_MAX_BYTES = 512 * 1024;

/** The tallest an embed reports itself; a page that keeps growing stops here. */
export const EMBED_MAX_HEIGHT = 20_000;

/**
 * The host's theme tokens an embed receives as CSS variables of the same
 * name (`var(--foreground)`, `var(--chart-1)` …), with `color-scheme`.
 */
export const EMBED_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--destructive",
  "--success",
  "--warning",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

export type EmbedScheme = "light" | "dark";
/** `inline`: in the message, as tall as its page, never scrolling. `full`: the Full screen view, which scrolls. */
export type EmbedMode = "inline" | "full";
export interface EmbedTheme {
  vars: Record<string, string>;
  scheme: EmbedScheme;
}

/**
 * The defaults under the host's values: a theme without chart colors still
 * gets five, and a page whose host sent nothing still reads.
 */
const BASE_CSS = [
  ":root{--chart-1:#4f6bed;--chart-2:#e8833a;--chart-3:#2fa37a;--chart-4:#d64c63;--chart-5:#8b5cf6}",
  "html,body{margin:0;background:transparent}",
  "html{font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;line-height:1.5;color:var(--foreground,CanvasText)}",
  // In the message the frame is as tall as its page: no inner scrolling, and
  // a page wider than the column scrolls sideways without a bar.
  "html[data-pn-embed=inline]{overflow:hidden}",
  "html[data-pn-embed=inline] body{overflow-x:auto;scrollbar-width:none}",
  "html[data-pn-embed=inline] body::-webkit-scrollbar{display:none}",
  "img,svg,canvas,video{max-width:100%}",
].join("");

/**
 * The embed's first script. It applies the theme from the URL fragment
 * before the page paints (so a dark message never flashes white), takes
 * theme changes from the parent window only, reports the page's height,
 * hands a click on a web link to the host (the sandbox opens no popups), and
 * passes Escape out.
 */
export const EMBED_BOOTSTRAP = `(function () {
  var P = window.parent, root = document.documentElement, mode = "inline";
  var post = function (m) { m.pnEmbed = 1; try { P.postMessage(m, "*"); } catch (e) {} };
  var apply = function (t) {
    if (!t || typeof t !== "object") return;
    var v = t.vars;
    if (v && typeof v === "object") for (var k in v) if (/^--[a-z0-9-]+$/.test(k) && typeof v[k] === "string") root.style.setProperty(k, v[k]);
    if (t.scheme === "dark" || t.scheme === "light") root.style.colorScheme = t.scheme;
  };
  try {
    var m = /(?:^#|&)pn=([^&]*)/.exec(location.hash);
    if (m) { var t = JSON.parse(decodeURIComponent(m[1])); if (t && t.mode === "full") mode = "full"; apply(t); }
  } catch (e) {}
  root.setAttribute("data-pn-embed", mode);
  addEventListener("message", function (e) {
    if (e.source !== P) return;
    var d = e.data;
    if (d && d.pnEmbed === 1 && d.kind === "theme") apply(d);
  });
  var last = -1;
  var send = function () {
    var b = document.body;
    var h = Math.ceil(Math.max(root.getBoundingClientRect().height, b ? b.scrollHeight : 0));
    if (h !== last) { last = h; post({ kind: "height", height: h }); }
  };
  if (typeof ResizeObserver === "function") {
    var ro = new ResizeObserver(send);
    ro.observe(root);
    document.addEventListener("DOMContentLoaded", function () { if (document.body) ro.observe(document.body); send(); });
  }
  addEventListener("load", send);
  setTimeout(send, 0);
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented) return;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#") return;
    e.preventDefault();
    if (/^https?:\\/\\//i.test(href)) post({ kind: "link", url: href });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !e.defaultPrevented) post({ kind: "escape" });
  });
})();`;

/** A doctype (after any comments) at the very start of the page: ours replaces it. */
const LEADING_DOCTYPE = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;

/**
 * The document the Inbox serves for one fence: our head first (charset, the
 * defaults, the bootstrap), then the agent's HTML as written. A fragment
 * lands in the body; a whole document's `<html>`, `<head>` and `<body>` merge
 * into ours (the HTML parser folds a second `<html>` and `<head>` in), so the
 * bootstrap always runs before any of the page's own code.
 */
export function buildEmbedDocument(html: string): string {
  const page = html.replace(LEADING_DOCTYPE, "");
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${BASE_CSS}</style><script>${EMBED_BOOTSTRAP}</script>` +
    page
  );
}

/** The fragment that hands the embed its theme and mode before it paints (`#pn=…`). */
export function embedFragment(theme: EmbedTheme, mode: EmbedMode = "inline"): string {
  return `#pn=${encodeURIComponent(JSON.stringify({ vars: theme.vars, scheme: theme.scheme, mode }))}`;
}

/** A message the host sends an embed: a theme change, applied without a reload. */
export function embedThemeMessage(theme: EmbedTheme): { pnEmbed: 1; kind: "theme"; vars: Record<string, string>; scheme: EmbedScheme } {
  return { pnEmbed: 1, kind: "theme", vars: theme.vars, scheme: theme.scheme };
}

export type EmbedMessage =
  | { kind: "height"; height: number }
  | { kind: "link"; url: string }
  | { kind: "escape" };

/**
 * A message from an embed, checked; null for anything else. The caller has
 * already checked that it came from its own frame (`event.source`).
 */
export function readEmbedMessage(data: unknown): EmbedMessage | null {
  if (!data || typeof data !== "object" || (data as { pnEmbed?: unknown }).pnEmbed !== 1) return null;
  const m = data as Record<string, unknown>;
  if (m.kind === "height" && typeof m.height === "number" && Number.isFinite(m.height)) {
    return { kind: "height", height: Math.max(0, Math.min(EMBED_MAX_HEIGHT, Math.round(m.height))) };
  }
  if (m.kind === "link" && typeof m.url === "string" && m.url.length <= 4096 && /^https?:\/\/[^\s]+$/i.test(m.url)) {
    return { kind: "link", url: m.url };
  }
  if (m.kind === "escape") return { kind: "escape" };
  return null;
}

/** The id the Inbox gives an embed: the first 32 hex digits of the SHA-256 of its HTML. */
export const EMBED_ID = /^[a-f0-9]{32}$/;
