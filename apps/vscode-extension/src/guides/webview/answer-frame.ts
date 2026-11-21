/**
 * The agent's answer page, as it wrote it, scripts included (owner's
 * decision, 2026-10-23: "If its html scripts can be embedded … we need to
 * support"), inside an `<iframe sandbox="allow-scripts">` of the answer tab:
 *
 * - The frame has an opaque origin: its scripts cannot reach the tab's DOM or
 *   the webview API (`acquireVsCodeApi`); they can only post messages.
 * - It inherits the answer tab's CSP: inline scripts and styles, images only
 *   from `data:` and the extension, and nothing else, so it reaches no network.
 * - No top navigation, popups, forms or modals (the sandbox allows none).
 *
 * A small script we put first in the page reports clicks on `code:`,
 * `symbol:` and `chapter:` links (and `data-link` on any element, such as a
 * box in a drawing) and on web links, and the page's height. The tab accepts
 * only those messages, only from this frame. Mermaid blocks
 * (`<pre class="mermaid">`) are drawn beforehand with the Guide tab's engine.
 */

import { renderMermaid } from "./diagram-loader";

/** Theme colors the page can use, read from VS Code's variables. */
const THEME_VARS: Array<[string, string, string]> = [
  // [our name, VS Code variable, fallback]
  ["--foreground", "--vscode-editor-foreground", "#cccccc"],
  // The frame paints its own background: a color-scheme the tab does not declare makes it opaque.
  ["--background", "--vscode-editor-background", "#1f1f1f"],
  ["--muted", "--vscode-descriptionForeground", "#9d9d9d"],
  ["--card", "--vscode-editorWidget-background", "#252526"],
  ["--code-background", "--vscode-textCodeBlock-background", "#2b2b2b"],
  ["--border", "--vscode-widget-border", "#454545"],
  ["--accent", "--vscode-textLink-foreground", "#4daafc"],
  ["--add", "--vscode-gitDecoration-addedResourceForeground", "#81b88b"],
  ["--del", "--vscode-gitDecoration-deletedResourceForeground", "#c74e39"],
  ["--chart-1", "--vscode-charts-blue", "#3794ff"],
  ["--chart-2", "--vscode-charts-yellow", "#cca700"],
  ["--chart-3", "--vscode-charts-green", "#89d185"],
  ["--chart-4", "--vscode-charts-red", "#f14c4c"],
  ["--chart-5", "--vscode-charts-purple", "#b180d7"],
  ["--chart-6", "--vscode-charts-orange", "#d18616"],
  ["--font", "--vscode-font-family", "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"],
  ["--mono", "--vscode-editor-font-family", "Menlo, Monaco, monospace"],
  ["--font-size", "--vscode-font-size", "13px"],
];

/** The CSS the page gets before its own: the color variables and plain defaults. */
export function answerThemeCss(read: (name: string) => string = (name) => getComputedStyle(document.documentElement).getPropertyValue(name)): string {
  const vars = THEME_VARS.map(([ours, theirs, fallback]) => `${ours}: ${read(theirs).trim() || fallback};`).join(" ");
  return `:root { ${vars} color-scheme: ${isLight() ? "light" : "dark"}; }
html { background: var(--background); }
html, body { margin: 0; color: var(--foreground); font-family: var(--font); font-size: var(--font-size); line-height: 1.55; }
body { padding: 2px 2px 8px; overflow-wrap: anywhere; }
a, [data-link] { color: var(--accent); cursor: pointer; }
code, pre { font-family: var(--mono); }
:not(pre) > code { background: var(--code-background); padding: 1px 4px; border-radius: 3px; }
pre { background: var(--code-background); padding: 8px 10px; border-radius: 4px; overflow: auto; }
svg { max-width: 100%; height: auto; }`;
}

function isLight(): boolean {
  return document.body.classList.contains("vscode-light") || document.body.classList.contains("vscode-high-contrast-light");
}

/** The first script of the page: link clicks and the page height go to the tab, nothing else. */
export const ANSWER_BOOTSTRAP = `(function () {
  var post = function (m) { m.pnAnswer = 1; parent.postMessage(m, "*"); };
  var target = function (e) { var t = e.target; return t && t.closest ? t.closest("[data-link], a[href]") : null; };
  var follow = function (el, e) {
    var link = el.getAttribute("data-link") || el.getAttribute("href") || "";
    if (/^(code|symbol|chapter):/i.test(link)) { e.preventDefault(); post({ kind: "link", link: link }); return; }
    if (/^https?:/i.test(link)) { e.preventDefault(); post({ kind: "external", url: link }); return; }
    if (link.charAt(0) === "#") return;
    if (el.tagName === "A" || el.tagName === "a") e.preventDefault();
  };
  document.addEventListener("click", function (e) { var el = target(e); if (el) follow(el, e); }, true);
  document.addEventListener("keydown", function (e) { if (e.key !== "Enter") return; var el = target(e); if (el && el.hasAttribute("data-link")) follow(el, e); }, true);
  var last = 0;
  var send = function () { var h = Math.ceil(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)); if (h !== last) { last = h; post({ kind: "height", height: h }); } };
  addEventListener("load", send);
  if (typeof ResizeObserver === "function") new ResizeObserver(send).observe(document.documentElement);
  setTimeout(send, 0);
})();`;

/** Mermaid blocks drawn with the Guide tab's engine; a block that does not draw stays as its source. */
async function drawMermaid(doc: Document): Promise<void> {
  for (const block of Array.from(doc.querySelectorAll("pre.mermaid, div.mermaid"))) {
    const result = await renderMermaid(block.textContent ?? "");
    if (!result.ok) continue;
    const wrap = doc.createElement("div");
    wrap.className = "pn-answer-diagram";
    wrap.innerHTML = result.svg.outerHTML;
    block.replaceWith(wrap);
  }
}

/**
 * The page as the frame's `srcdoc`: the agent's HTML (a fragment or a whole
 * document) with our theme and bootstrap script first in its head. The
 * agent's scripts are kept; DOMParser does not run them here.
 */
export async function buildAnswerDocument(html: string, themeCss: string, options: { mermaid?: boolean } = {}): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  if (options.mermaid !== false && /\bmermaid\b/.test(html)) await drawMermaid(doc);
  const style = doc.createElement("style");
  style.textContent = themeCss;
  const script = doc.createElement("script");
  script.textContent = ANSWER_BOOTSTRAP;
  doc.head.prepend(style, script);
  if (!doc.querySelector("meta[charset]")) {
    const meta = doc.createElement("meta");
    meta.setAttribute("charset", "utf-8");
    doc.head.prepend(meta);
  }
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}

export type AnswerFrameMessage = { kind: "link"; link: string } | { kind: "external"; url: string } | { kind: "height"; height: number };

/** A message from the answer frame, checked; null for anything else. */
export function readAnswerMessage(data: unknown): AnswerFrameMessage | null {
  if (!data || typeof data !== "object" || (data as { pnAnswer?: unknown }).pnAnswer !== 1) return null;
  const m = data as Record<string, unknown>;
  if (m.kind === "link" && typeof m.link === "string" && m.link.length < 2048 && /^(code|symbol|chapter):/i.test(m.link)) return { kind: "link", link: m.link };
  if (m.kind === "external" && typeof m.url === "string" && m.url.length < 4096 && /^https?:\/\//i.test(m.url)) return { kind: "external", url: m.url };
  if (m.kind === "height" && typeof m.height === "number" && Number.isFinite(m.height)) return { kind: "height", height: Math.max(80, Math.min(40_000, Math.round(m.height))) };
  return null;
}

/** The frame, with its messages routed: links open, the frame grows with its page. */
export function answerFrame(html: string, on: { link(link: string): void; external(url: string): void }): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = "pn-answer-frame";
  // Never add allow-same-origin: the webview trusts only messages from its own origin
  // (host-messages.ts), and this frame must stay opaque ("null") so the agent's page
  // can never pass that check or reach the tab's DOM.
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("title", "The agent's answer");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.style.height = "360px";
  const listener = (event: MessageEvent) => {
    if (!frame.isConnected) {
      window.removeEventListener("message", listener);
      return;
    }
    if (event.source !== frame.contentWindow) return;
    const msg = readAnswerMessage(event.data);
    if (!msg) return;
    if (msg.kind === "height") frame.style.height = `${msg.height + 4}px`;
    else if (msg.kind === "link") on.link(msg.link);
    else on.external(msg.url);
  };
  window.addEventListener("message", listener);
  void buildAnswerDocument(html, answerThemeCss()).then((doc) => {
    frame.srcdoc = doc;
  });
  return frame;
}
