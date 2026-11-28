/**
 * Srcdoc injection builder for the HTML viewer.
 *
 * Product rule: arbitrary HTML must render exactly as it would in a plain
 * browser tab. The viewer never writes into the document's namespace — no bare
 * CSS custom properties, no classes on the author's root, no `color-scheme`,
 * no screen styling of author elements. Print-only defaults keep a page from
 * being cut off on paper (`injectPrintDefaults`); section page breaks are
 * added only for a document with the host-theme marker. Host theme tokens
 * are pushed under the viewer-owned `--pn-*` prefix, which the annotation CSS reads.
 *
 * Documents that WANT to follow the host theme (e.g. Plannotator-generated
 * artifacts) opt in with `<meta name="plannotator-theme" content="host">`,
 * which re-enables the bare-token push, the `light` class on their root, and
 * `color-scheme` sync — for that document only.
 *
 * Pure string logic (no DOM) so the rendering-neutrality contract is unit-testable.
 */
import { ANNOTATION_HIGHLIGHT_CSS, BRIDGE_SCRIPT } from "./bridge-script";
import { SANDBOX_SHIM_SCRIPT } from "./sandboxShim";
import { LINK_KEY_RE, linkGuardScriptTag } from "./linkGuard";

export const THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--primary",
  "--primary-foreground",
  "--secondary",
  "--secondary-foreground",
  "--muted",
  "--muted-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
  "--destructive-foreground",
  "--success",
  "--success-foreground",
  "--warning",
  "--warning-foreground",
  "--border",
  "--input",
  "--ring",
  "--code-bg",
  "--focus-highlight",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

/** Viewer-owned namespace for properties injected into the document. */
export const PN_TOKEN_PREFIX = "--pn-";

/**
 * Version-diff highlights. htmlDiff tags the <ins>/<del> it generates with
 * this class so author-written <ins>/<del> markup is never restyled.
 */
export const DIFF_HIGHLIGHT_CSS =
  "ins.plannotator-diff{background:#e6ffec;color:#0a7d33;text-decoration:none;border-radius:2px;box-shadow:0 0 0 1px #abf2bc inset}" +
  "del.plannotator-diff{background:#ffebe9;color:#b31d28;text-decoration:line-through;border-radius:2px;box-shadow:0 0 0 1px #ffc1bc inset}";

/**
 * True when the document opts in to following the host theme via
 * `<meta name="plannotator-theme" content="host">` (attribute order/quoting agnostic).
 */
export function hasHostThemeOptIn(rawHtml: string): boolean {
  const metas = rawHtml.match(/<meta\b[^>]*>/gi);
  if (!metas) return false;
  return metas.some(
    (tag) =>
      /\bname\s*=\s*["']?plannotator-theme["']?/i.test(tag) &&
      /\bcontent\s*=\s*["']?host["']?/i.test(tag),
  );
}

/**
 * Build the theme properties to write into the document. Bare host token names
 * (`--muted`, `--background`, …) collide with author variables, so they are
 * remapped to `--pn-*`; the originals ride along only for host-theme documents.
 */
export function buildThemeTokenPayload(
  tokens: Record<string, string>,
  hostTheme: boolean,
): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const [key, val] of Object.entries(tokens)) {
    payload[PN_TOKEN_PREFIX + key.slice(2)] = val;
    if (hostTheme) payload[key] = val;
  }
  return payload;
}

export interface SrcdocInjectionOptions {
  /** Host theme tokens, keyed by bare name (as read from the host root). */
  tokens: Record<string, string>;
  /** Whether the host is currently in its light theme. */
  isLight: boolean;
  /** Document opted in to host theming (see {@link hasHostThemeOptIn}). */
  hostTheme: boolean;
  /** The version-diff view is showing (rawHtml is htmlDiff output). */
  diffActive: boolean;
  /**
   * The key of this load's link guard (`linkGuard.ts`). On the URL path the
   * bridge asset installs the guard itself and reads the key from its tag
   * (`data-plannotator-link-key`); the inline path injects the guard first in
   * the document instead ({@link injectLinkGuard}) and ignores this.
   */
  linkKey?: string;
  /**
   * Load the bridge through a classic `<script src>` from this URL instead of
   * inlining `BRIDGE_SCRIPT`. Absent or empty: inline, exactly as before. The
   * tag takes the inline script's place, so placement is identical on both
   * paths: at the end of `<head>`, before the body (head scripts of the page
   * run first, body scripts after the bridge). No `crossorigin` attribute is
   * set: the srcdoc frame is an opaque origin, and a classic script needs no
   * CORS to execute. Callers must pass an ABSOLUTE URL (see
   * {@link resolveBridgeScriptUrl}): the framed page may carry its own
   * `<base href>`, which precedes the injected tag and would re-anchor a
   * relative URL onto an attacker-chosen origin.
   */
  bridgeScriptUrl?: string;
  /**
   * The page starts in Interact (clicks reach the page) instead of armed
   * Annotate. The bridge reads it from its tag (`data-plannotator-start`)
   * before the page paints, so it never waits on the parent's first
   * `set-annotate-mode` to be in the right mode. Absent: armed, as always.
   */
  startInteract?: boolean;
}

/**
 * Resolve a host-supplied bridge URL against the PARENT document (its
 * `document.baseURI`), never against the framed page. The injection lands at
 * the end of the page's `<head>`, after any `<base href>` the page declares,
 * so a relative URL written into the srcdoc would resolve against that base:
 * a hostile document could point the viewer at an attacker-served bridge and
 * defeat the version check. Resolving here pins the URL before it is written.
 * An unparsable input is returned unchanged (nothing loads, the ready timeout
 * reports it) rather than throwing during render.
 */
export function resolveBridgeScriptUrl(bridgeScriptUrl: string, parentBaseUrl: string): string {
  try {
    return new URL(bridgeScriptUrl, parentBaseUrl).href;
  } catch {
    return bridgeScriptUrl;
  }
}

/** Escape a string for a double-quoted HTML attribute value. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * The bridge `<script>` element, the ONE injection point for both delivery
 * paths. Inline is the default and Plannotator's only path; the URL form is
 * the opt-in for hosts that serve the generated `bridge-script.asset.js`.
 */
export function buildBridgeScriptTag(bridgeScriptUrl?: string, linkKey?: string, startInteract?: boolean): string {
  const start = startInteract ? ` data-plannotator-start="interact"` : "";
  if (bridgeScriptUrl) {
    const key = linkKey && LINK_KEY_RE.test(linkKey) ? ` data-plannotator-link-key="${linkKey}"` : "";
    return `<script src="${escapeAttribute(bridgeScriptUrl)}"${key}${start}></script>`;
  }
  if (!BRIDGE_SCRIPT) {
    // Only reachable when a host aliased `./bridge-script` to the generated
    // `bridge-script.lite` module (which stubs the inline literal) and then
    // rendered an HtmlViewer without `bridgeScriptUrl`: an empty inline
    // script would be a silently dead surface, so fail loudly instead.
    throw new Error(
      "@plannotator/ui HtmlViewer: the inline bridge script is stubbed out "
        + "(bridge-script.lite alias) but no bridgeScriptUrl was passed.",
    );
  }
  return `<script${start}>${BRIDGE_SCRIPT}</script>`;
}

// These defaults live inside the sandbox: host print.css cannot style a
// child document. Every page gets only what keeps it from being cut off on
// paper: no clipping by an app shell's `height: 100vh; overflow: hidden`, and
// long code lines wrapped instead of running off the sheet. Otherwise an
// arbitrary page prints exactly as it would from a browser tab.
const DOCUMENT_PRINT_CSS = `
@layer plannotator-print-defaults {
@media print {
  :where(pre) { white-space: pre-wrap; overflow-wrap: anywhere; }
}
}
@media print {
  html, body { height: auto !important; overflow: visible !important; }
}
`;

// Only a document that opts in to the host's look
// (`<meta name="plannotator-theme" content="host">`, which Plannotator's own
// explainers carry) gets pagination: each sibling section on a new sheet,
// headings kept with what follows, and figures, images, diagrams, code and
// tables kept whole where they fit. Low specificity leaves authored print
// layouts in control.
const SECTION_BREAK_PRINT_CSS = `
@layer plannotator-print-defaults {
@media print {
  :where(html, body) { min-height: 0; }
  :where(section ~ section) { break-before: page; }
  :where(h1, h2, h3, h4, h5, h6) { break-after: avoid; }
  :where(figure, img, svg, pre, table) { break-inside: avoid; }
}
}
`;

/**
 * A comment as the HTML tokenizer ends it: `<!-->` and `<!--->` (abrupt), or
 * the first `-->` or `--!>`. The body can never contain an end, so the match
 * is the browser's and no backtracking can stretch it over a later one.
 */
const HTML_COMMENT = "<!--(?:>|->|(?!-?>)(?:(?!--!?>)[\\s\\S])*--!?>)";

/** The rest of an end tag after its name: `>`, or whitespace or `/` and anything up to `>` (`</title x>`). */
const END_TAG_REST = "(?:[\\t\\n\\f\\r /][^>]*)?>";

/**
 * Where an injection goes so it comes before everything the author wrote in
 * `<head>`: just inside the real `<head>`, or right after the doctype when
 * there is no `<head>` (before it would put the page in quirks mode). A
 * `<head` inside a comment, a script, a `<style>`, `<title>` or `<textarea>`,
 * or an attribute value is skipped. `firstScript` is where the first page
 * script before that point starts, if one does (a script ahead of `<head>`).
 */
function headStart(rawHtml: string): { position: number; firstScript: number | null } {
  // Built from strings: Semgrep's TypeScript parser cannot read this pattern
  // as a regex literal, and a file it cannot parse fails the security scan.
  const attributes = "(?:\"[^\"]*\"|'[^']*'|[^>\"'])*";
  const tokens = new RegExp(
    [
      `${HTML_COMMENT}|<!--[\\s\\S]*$`,
      `<script\\b[\\s\\S]*?(?:</script${END_TAG_REST}|$)`,
      `<(style|title|textarea)\\b[\\s\\S]*?(?:</\\1${END_TAG_REST}|$)`,
      "<!doctype\\b[^>]*>",
      `<head\\b${attributes}>`,
      "<body\\b",
      `<[a-z][^\\s/>]*${attributes}>`,
    ].join("|"),
    "gi",
  );
  let afterDoctype = 0;
  let firstScript: number | null = null;
  for (let match = tokens.exec(rawHtml); match; match = tokens.exec(rawHtml)) {
    const token = match[0].toLowerCase();
    const end = match.index + match[0].length;
    if (token.startsWith("<script")) firstScript ??= match.index;
    else if (token.startsWith("<!doctype")) afterDoctype = end;
    else if (/^<head[\s>]/.test(token)) return { position: end, firstScript };
    else if (token === "<body") break;
  }
  return { position: afterDoctype, firstScript: firstScript !== null && firstScript < afterDoctype ? firstScript : null };
}

function printDefaultsPosition(rawHtml: string): number {
  return headStart(rawHtml).position;
}

/**
 * Splice the print defaults in ahead of author styles, declaring their layer
 * before any authored one. Every document gets the no-clip rule (it wins over
 * an app shell's `html, body { height: 100vh; overflow: hidden }`) and
 * wrapped code lines; `sectionBreaks` adds the pagination (a new sheet per
 * section and the keep-together hints).
 */
export function injectPrintDefaults(rawHtml: string, { sectionBreaks = false }: { sectionBreaks?: boolean } = {}): string {
  const style = `<style>${DOCUMENT_PRINT_CSS}${sectionBreaks ? SECTION_BREAK_PRINT_CSS : ""}</style>`;
  const position = printDefaultsPosition(rawHtml);
  return rawHtml.slice(0, position) + style + rawHtml.slice(position);
}

/** The `<style>` + `<script>` block spliced into the document's head. */
export function buildSrcdocInjection({
  tokens,
  isLight,
  hostTheme,
  diffActive,
  bridgeScriptUrl,
  linkKey,
  startInteract,
}: SrcdocInjectionOptions): string {
  const payload = buildThemeTokenPayload(tokens, hostTheme);
  let themeCSS = ":root {\n";
  for (const [key, val] of Object.entries(payload)) {
    themeCSS += `  ${key}: ${val};\n`;
  }
  themeCSS += "}\n";
  // Host-theme documents mirror the host's light/dark; arbitrary documents keep
  // their own color-scheme resolution (document + OS), like a standalone tab.
  if (hostTheme) {
    themeCSS += `:root { color-scheme: ${isLight ? "light" : "dark"}; }\n`;
  }
  const diffCSS = diffActive ? DIFF_HIGHLIGHT_CSS : "";
  return `<style>${themeCSS}${ANNOTATION_HIGHLIGHT_CSS}${diffCSS}</style>${buildBridgeScriptTag(bridgeScriptUrl, linkKey, startInteract)}`;
}

/**
 * A document-authored CSP `<meta>` tag (e.g. `default-src 'none'` in
 * Plannotator's own portable guided-review exports) blocks the inline bridge
 * script and disables annotation entirely. The iframe `sandbox` attribute is
 * the security boundary for the annotate surface; the page's CSP was written
 * for its standalone context, so it is removed before injection.
 *
 * The package adds a CSP `<meta>` to the srcdoc document only for a page its
 * server marked (`connect-src 'none'`, {@link injectNoNetworkCsp}); that
 * policy names no `script-src`, so nothing here blocks a `<script src>` on
 * the URL path. A CSP delivered as an HTTP header on the
 * HOST page is inherited by the srcdoc document, and the host must allow
 * `script-src` for the origin the asset is served from.
 */
const META_CSP_RE =
  /<meta\s[^>]*http-equiv\s*=\s*["']?\s*content-security-policy\s*["']?[^>]*\/?>/gi;

export function neutralizeMetaCsp(rawHtml: string): string {
  return rawHtml.replace(META_CSP_RE, "<!-- plannotator: meta CSP removed for annotation -->");
}

/**
 * A server marks a document it opened outside its session's roots with
 * `<meta name="plannotator-network" content="none">` (Plannotator's servers:
 * `HTML_NO_NETWORK_MARKER` in packages/shared/html-assets.ts). Such a page gets
 * no network in the frame: see {@link injectNoNetworkCsp}. Attribute order and
 * quoting agnostic, and read anywhere in the text, so nothing the page puts
 * around the tag hides it. A page that carries the tag itself only
 * restricts itself.
 */
export function hasNoNetworkMarker(rawHtml: string): boolean {
  const metas = rawHtml.match(/<meta\b[^>]*>/gi);
  if (!metas) return false;
  return metas.some(
    (tag) =>
      /\bname\s*=\s*["']?plannotator-network["']?/i.test(tag) &&
      /\bcontent\s*=\s*["']?none["']?/i.test(tag),
  );
}

/** The policy a marked document gets: no fetch, XHR, WebSocket, EventSource or beacon. */
export const NO_NETWORK_CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="connect-src 'none'">`;

/**
 * A doctype the document starts with: after only a BOM, ASCII whitespace,
 * comments (ended as the tokenizer ends them, {@link HTML_COMMENT}) and `<?...>`
 * prologs. Every part is deterministic, so a match is exactly how a browser
 * reads those bytes; anything else before the doctype (a script, text, an
 * unclosed comment) is no match.
 */
const LEADING_DOCTYPE_RE = new RegExp(`^\uFEFF?(?:[\\t\\n\\f\\r ]|${HTML_COMMENT}|<\\?[^>]*>)*<!doctype[^>]*>`, "i");

/**
 * The first position a browser runs before anything the page wrote: right
 * after a leading doctype (standards mode kept), else the very start. Found
 * without reading the page past its doctype, so nothing the page contains
 * (a comment, a `<title>`, a `<script>` the parser reads differently) can
 * come before it or swallow what goes there. Fails closed: when the start is
 * anything else, it is 0.
 */
export function documentStart(html: string): number {
  const doctype = LEADING_DOCTYPE_RE.exec(html);
  return doctype ? doctype[0].length : 0;
}

/**
 * Put {@link NO_NETWORK_CSP_META} first in the document: right after the
 * doctype (so standards mode is kept), else at the very start. A meta CSP
 * covers only what loads after it is parsed, so it must come before any page
 * script (and before the sandbox shim); the parser opens `<head>` for it and
 * folds the page's own `<html>` attributes onto the same root. Call it on the
 * finished srcdoc (after {@link injectIntoHead}, which removes the page's own
 * CSP tags).
 */
export function injectNoNetworkCsp(html: string): string {
  const at = documentStart(html);
  return html.slice(0, at) + NO_NETWORK_CSP_META + html.slice(at);
}

/**
 * The sandbox shim (`sandboxShim.ts`) ahead of every page script, so a page's
 * own head scripts already find history and storage safe to use: at the start
 * of `<head>` (or after the doctype when there is none), or just before a
 * script that comes ahead of `<head>`. The bridge, at the end of `<head>`,
 * runs it again, which then does nothing.
 */
export function injectSandboxShim(html: string): string {
  const { position, firstScript } = headStart(html);
  const at = firstScript ?? position;
  return `${html.slice(0, at)}<script>${SANDBOX_SHIM_SCRIPT}</script>${html.slice(at)}`;
}

/**
 * The link guard (`linkGuard.ts`) for this load, ahead of every script in the
 * document: at {@link documentStart}, right after a leading doctype or at the
 * very start, never where a scan of the page says `<head>` is. A script there
 * runs first whatever the page contains (the parser opens `<head>` for it and
 * folds the page's own `<html>`/`<head>` onto the same elements). Run it on
 * the finished srcdoc, after {@link injectSandboxShim}, so it lands before the
 * shim too; {@link injectNoNetworkCsp} after it puts the policy first.
 */
export function injectLinkGuard(html: string, key: string): string {
  const at = documentStart(html);
  return `${html.slice(0, at)}${linkGuardScriptTag(key)}${html.slice(at)}`;
}

/** Splice the injection just before `</head>`, or prepend when there is none. */
export function injectIntoHead(rawHtml: string, injection: string): string {
  const html = neutralizeMetaCsp(rawHtml);
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return html.slice(0, headClose) + injection + html.slice(headClose);
  }
  return injection + html;
}
