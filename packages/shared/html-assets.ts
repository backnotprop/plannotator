import { posix as pathPosix } from "path";
import * as parse5 from "parse5";
import { MAX_ANNOTATABLE_FILE_BYTES } from "@plannotator/core/annotatable";

export const HTML_ASSET_ROUTE_PREFIX = "/api/html-assets";

/**
 * Embedded local documents (`<iframe src="sibling.html">`, `<embed>`,
 * `<object data>`, `<frame>`) are served from the SAME token'd directory the
 * page's other support assets come from, as real `text/html` documents.
 *
 * They are untrusted author HTML on the Plannotator server's origin, so every
 * HTML response from the asset route carries a CSP `sandbox` that gives it an
 * opaque origin with scripting but NO `allow-same-origin`. Inside the annotate
 * surface the primary document's own `sandbox="allow-scripts"` iframe already
 * forces this on every nested browsing context (sandboxing flags are inherited
 * and intersected); the header is what protects a reviewer who opens an asset
 * URL directly in a top-level tab, where no parent sandbox applies.
 */
export const HTML_ASSET_DOCUMENT_CONTENT_TYPE = "text/html; charset=utf-8";
export const HTML_ASSET_DOCUMENT_CSP = "sandbox allow-scripts";
/** Scripting is pointless in a generated error page, so it gets the tighter policy. */
export const HTML_ASSET_ERROR_CSP = "sandbox";
/** Embedded documents honour the same 2MB ceiling single-file annotate reads do. */
export const MAX_HTML_ASSET_DOCUMENT_BYTES = MAX_ANNOTATABLE_FILE_BYTES;

/** Fetch destinations that mean "this response will become a nested document". */
const FRAMED_FETCH_DESTS = new Set(["iframe", "frame", "embed", "object"]);

/** Elements whose URL attribute loads another browsing context. */
const FRAME_URL_ATTRS: Record<string, string> = {
  iframe: "src",
  frame: "src",
  embed: "src",
  object: "data",
};

export function isHtmlDocumentAssetPath(assetPath: string): boolean {
  return /\.html?$/i.test(assetPath);
}

/**
 * `Sec-Fetch-Dest` of a request the browser is about to render as a nested
 * document. Chromium, Firefox and Safari all send it; a header-less client
 * simply reads as not-framed, which only ever costs it the friendlier 404.
 */
export function isFramedFetchDest(secFetchDest: string | null | undefined): boolean {
  return typeof secFetchDest === "string" && FRAMED_FETCH_DESTS.has(secFetchDest.trim().toLowerCase());
}

/**
 * A single path segment that names a file: `page.html`, `chart.svg`, `app.js`.
 * Bounded on purpose — a long trailing dot-run in a slug (`v1.2.3-release`) is
 * still a file shape, but an arbitrary tail is not worth treating as one.
 */
const FILE_NAME_SEGMENT = /\.[A-Za-z0-9][A-Za-z0-9_-]{0,9}$/;

/**
 * Could this path name a MISSING embedded document, as opposed to the app
 * document itself?
 *
 * The annotate catch-all serves the editor app for every non-`/api` path, so
 * without this the framed-404 guard answers 404 for the app root too — which is
 * exactly how the VS Code extension loads a session (`panel-manager.ts` puts the
 * session URL in an `<iframe src>`, and every subcommand launched from a VS Code
 * terminal is routed there), so the panel rendered "404 Not found" instead of
 * the app (#1561 regression).
 *
 * The rule is the SHAPE OF THE PATH, not `Sec-Fetch-Site`: an annotated page is
 * a sandboxed srcdoc with an opaque origin, so its nested-document requests are
 * `cross-site` — the same value the VS Code webview wrapper produces, and a
 * pasted URL is `none` on both sides. Site can never separate the two; the path
 * can, because the app is only ever loaded at `/` while an embed that reaches
 * the catch-all was written as a root-relative file reference (relative ones are
 * anchored at `/api/html-assets/<token>/` by #1561's `<base href>`, which has
 * its own 404).
 */
export function pathNamesEmbeddedDocument(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  // `/` (and `//`): the app document. Never a missing embed.
  if (segments.length === 0) return false;
  // Under a directory segment (`/assets/frame`): only a file reference is
  // spelled that way; the app has no nested routes.
  if (segments.length > 1) return true;
  // One segment: a file name (`/prototype-slash.html`), not a bare word, which
  // stays with the app so a future SPA route cannot 404 inside a frame.
  return FILE_NAME_SEGMENT.test(segments[0]);
}

/**
 * The catch-all's guard, shared by both runtimes: a request the browser will
 * render as a nested document AND whose path names a file gets the small 404
 * document instead of the editor app.
 */
export function isFramedEmbeddedDocumentRequest(
  secFetchDest: string | null | undefined,
  pathname: string,
): boolean {
  return isFramedFetchDest(secFetchDest) && pathNamesEmbeddedDocument(pathname);
}

/** `<base href>` value that anchors a document's relative URLs at its own directory. */
export function htmlAssetBaseHref(token: string): string {
  return `${HTML_ASSET_ROUTE_PREFIX}/${encodeURIComponent(token)}/`;
}

/**
 * The tiny document a framed request gets instead of the app's catch-all HTML.
 * Naming the missing file is the whole point: an empty frame says nothing,
 * while "prototype-slash.html — not found" tells the author what to fix.
 */
export function buildHtmlAssetErrorDocument(status: number, message: string, name?: string): string {
  const detail = name ? `${escapeHtmlText(name)} — ${escapeHtmlText(message)}` : escapeHtmlText(message);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${status} ${escapeHtmlText(message)}</title>`
    + `<style>html{color-scheme:light dark}body{margin:0;display:flex;align-items:center;justify-content:center;`
    + `min-height:100vh;font:13px/1.5 ui-sans-serif,system-ui,sans-serif;opacity:.75}`
    + `p{margin:0;padding:16px;text-align:center;word-break:break-word}</style></head>`
    + `<body><p>${detail}</p></body></html>`;
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const CONTENT_TYPES_BY_EXT: Record<string, string> = {
  ".apng": "image/apng",
  ".avif": "image/avif",
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ogg": "audio/ogg",
  ".otf": "font/otf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".xml": "application/xml; charset=utf-8",
};

interface HtmlAttr {
  name: string;
  value: string;
}

interface HtmlNode {
  nodeName?: string;
  namespaceURI?: string;
  parentNode?: HtmlNode | null;
  tagName?: string;
  attrs?: HtmlAttr[];
  childNodes?: HtmlNode[];
  value?: string;
}

type HtmlAssetUrlMapper = (assetPath: string) => string | null;

export function htmlAssetContentType(assetPath: string): string | null {
  return CONTENT_TYPES_BY_EXT[pathPosix.extname(assetPath).toLowerCase()] ?? null;
}

export function encodeHtmlAssetPath(assetPath: string): string {
  return assetPath.split("/").map(encodeURIComponent).join("/");
}

/**
 * The whole decision an `/api/html-assets/<token>/<path>` request needs, made
 * once for both runtimes. Everything here is pure: the caller owns the token
 * table (`lookupRoot`), path containment against the real filesystem, and the
 * read itself. Keeping it shared is what stops the Bun route and the Pi mirror
 * from drifting on which extensions are documents, which errors render as HTML,
 * and which headers a document response must carry.
 */
export type HtmlAssetRouteDecision =
  | { kind: "not-asset-route" }
  | {
      kind: "error";
      status: number;
      message: string;
      /** Render as a small HTML document (a frame/document request) or as JSON. */
      asDocument: boolean;
      name?: string;
    }
  | {
      kind: "serve";
      root: string;
      assetPath: string;
      contentType: string;
      /** The response is author HTML: apply the sandbox CSP and the 2MB cap. */
      document: boolean;
      /** Render failures as an HTML document (framed request, or an html path). */
      asDocument: boolean;
      maxBytes: number;
    };

export interface HtmlAssetRouteRequest {
  pathname: string;
  secFetchDest?: string | null;
}

export function resolveHtmlAssetRoute(
  request: HtmlAssetRouteRequest,
  lookupRoot: (token: string) => string | undefined,
): HtmlAssetRouteDecision {
  const prefix = `${HTML_ASSET_ROUTE_PREFIX}/`;
  if (!request.pathname.startsWith(prefix)) return { kind: "not-asset-route" };

  // Under the assets prefix a framed request is the common case, but a plain
  // `.html` request is a document however it was made — a reviewer pasting the
  // URL into a tab must not get JSON either.
  const framed = isFramedFetchDest(request.secFetchDest);
  const rest = request.pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) {
    return { kind: "error", status: 404, message: "Missing asset token or path", asDocument: framed };
  }

  const root = lookupRoot(rest.slice(0, slash));
  const rawPath = rest.slice(slash + 1);
  const htmlRequest = framed || isHtmlDocumentAssetPath(stripUrlSuffix(rawPath));
  const name = assetDisplayName(rawPath);

  if (!root) {
    return { kind: "error", status: 404, message: "Unknown asset root", asDocument: htmlRequest, name };
  }

  const assetPath = normalizeHtmlAssetRoutePath(rawPath);
  if (!assetPath) {
    return { kind: "error", status: 400, message: "Invalid asset path", asDocument: htmlRequest, name };
  }

  const document = isHtmlDocumentAssetPath(assetPath);
  const contentType = document
    ? HTML_ASSET_DOCUMENT_CONTENT_TYPE
    : htmlAssetContentType(assetPath);
  if (!contentType) {
    return {
      kind: "error",
      status: 415,
      message: "Unsupported asset type",
      asDocument: htmlRequest,
      name,
    };
  }

  return {
    kind: "serve",
    root,
    assetPath,
    contentType,
    document,
    asDocument: htmlRequest,
    maxBytes: document ? MAX_HTML_ASSET_DOCUMENT_BYTES : MAX_HTML_ASSET_BYTES_HINT,
  };
}

/**
 * Upper bound for non-document assets. The real constant lives in
 * `html-assets-node` (it is the share inliner's cap too); repeating the number
 * here would be a second source of truth, so the route decision carries a hint
 * the caller may override with its own `MAX_HTML_ASSET_BYTES`.
 */
export const MAX_HTML_ASSET_BYTES_HINT = 50 * 1024 * 1024;

/** Headers every HTML response from the asset route must carry. */
export function htmlAssetDocumentHeaders(csp: string): Record<string, string> {
  return {
    "Content-Type": HTML_ASSET_DOCUMENT_CONTENT_TYPE,
    // No allow-same-origin: an embedded document gets an opaque origin, so it
    // can never read cookies or call /api/feedback, /api/approve or the PTY
    // websocket as this session.
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function stripUrlSuffix(value: string): string {
  return splitPathSuffix(value).path;
}

function assetDisplayName(rawPath: string): string | undefined {
  const path = stripUrlSuffix(rawPath);
  const segments = path.split("/").filter(Boolean);
  const last = segments[segments.length - 1];
  if (!last) return undefined;
  try {
    return decodeURIComponent(last).slice(0, 120);
  } catch {
    return last.slice(0, 120);
  }
}

export function normalizeHtmlAssetRoutePath(routePath: string): string | null {
  const decoded = decodeUrlPath(routePath);
  if (decoded === null) return null;
  return normalizeDecodedLocalAssetPath(decoded);
}

export interface RewriteHtmlAssetOptions {
  /**
   * Anchor the document's relative URLs here with a `<base href>` at the top of
   * `<head>`. This is what makes EMBEDDED local documents work: a srcdoc page
   * has no URL of its own, so without a base every relative URL — including one
   * a script assigns at runtime from `data-src` — resolves onto the Plannotator
   * server root and hits the catch-all. A serve-time attribute rewrite cannot
   * reach a runtime-assigned URL; a base can, because it changes resolution
   * rather than the markup.
   */
  baseHref?: string;
  /**
   * Portable/share path: point relative URLs at a base nothing resolves
   * against, so an embedded sibling renders EMPTY instead of loading whatever
   * the hosting origin answers with. Assets are data: URLs by then, and link
   * clicks are carried to the parent as raw hrefs, so nothing else depends on
   * relative resolution.
   */
  inertBase?: boolean;
}

/** A base URL that no relative reference can resolve against. */
export const INERT_HTML_BASE_HREF = "about:blank";

export function rewriteHtmlAssetReferences(
  html: string,
  assetUrlFor: HtmlAssetUrlMapper,
  options: RewriteHtmlAssetOptions = {},
): string {
  const tree = looksLikeFullDocument(html)
    ? parse5.parse(html)
    : parse5.parseFragment(html);
  const root = tree as unknown as HtmlNode;
  let hasFrame = false;
  visit(root, (node) => {
    rewriteNodeAssetReferences(node, assetUrlFor);
    const tagName = node.tagName?.toLowerCase();
    if (tagName && tagName in FRAME_URL_ATTRS) hasFrame = true;
  });
  const baseHref = options.baseHref ?? (options.inertBase && hasFrame ? INERT_HTML_BASE_HREF : null);
  if (baseHref) applyDocumentBase(root, baseHref);
  return parse5.serialize(tree as never);
}

/**
 * Install (or re-anchor) the document's base URL.
 *
 * An author `<base href>` that is already absolute, scheme-relative or
 * root-relative is left exactly as written — they pinned an origin deliberately
 * and we must not silently retarget it. A RELATIVE author base is re-anchored
 * onto ours, which is the only reading that preserves what they meant
 * ("assets under my own directory") now that the document's own directory is
 * reachable. Otherwise ours is inserted FIRST in `<head>`, since only the first
 * `<base href>` in document order has any effect and every relative URL after
 * it must see it.
 */
function applyDocumentBase(root: HtmlNode, baseHref: string): void {
  let existing: HtmlNode | null = null;
  visit(root, (node) => {
    if (existing) return;
    if (node.tagName?.toLowerCase() === "base" && findAttr(node, "href")) existing = node;
  });

  if (existing) {
    const attr = findAttr(existing, "href")!;
    const value = attr.value.trim();
    if (!value || shouldSkipUrl(value) || baseHref === INERT_HTML_BASE_HREF) return;
    const normalized = normalizeLocalAssetPath(value);
    if (normalized === null) return;
    attr.value = `${baseHref}${encodeHtmlAssetPath(normalized)}${value.endsWith("/") && !normalized.endsWith("/") ? "/" : ""}`;
    return;
  }

  const head = findElement(root, "head") ?? root;
  const node: HtmlNode = {
    nodeName: "base",
    tagName: "base",
    attrs: [{ name: "href", value: baseHref }],
    namespaceURI: "http://www.w3.org/1999/xhtml",
    childNodes: [],
    parentNode: head,
  };
  if (!head.childNodes) head.childNodes = [];
  head.childNodes.unshift(node);
}

function findElement(root: HtmlNode, tagName: string): HtmlNode | null {
  let found: HtmlNode | null = null;
  visit(root, (node) => {
    if (!found && node.tagName?.toLowerCase() === tagName) found = node;
  });
  return found;
}

export function rewriteCssAssetReferences(
  css: string,
  assetUrlFor: HtmlAssetUrlMapper,
  basePath = "",
): string {
  let rewritten = css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (match, _quote: string, value: string) => {
      const next = rewriteLocalAssetUrl(value, assetUrlFor, basePath);
      return next === null ? match : `url("${next}")`;
    },
  );

  rewritten = rewritten.replace(
    /@import\s+(?:url\(\s*)?(["'])([^"']+)\1\s*\)?/gi,
    (match, _quote: string, value: string) => {
      const next = rewriteLocalAssetUrl(value, assetUrlFor, basePath);
      return next === null ? match : `@import url("${next}")`;
    },
  );

  return rewritten;
}

function rewriteNodeAssetReferences(
  node: HtmlNode,
  assetUrlFor: HtmlAssetUrlMapper,
): void {
  const tagName = node.tagName?.toLowerCase();
  if (!tagName) return;

  rewriteStyleAttr(node, assetUrlFor);

  if (tagName === "style") {
    rewriteStyleContent(node, assetUrlFor);
    return;
  }

  if (tagName === "img") {
    rewriteAttr(node, "src", assetUrlFor);
    rewriteSrcsetAttr(node, "srcset", assetUrlFor);
    return;
  }

  if (tagName === "source") {
    rewriteAttr(node, "src", assetUrlFor);
    rewriteSrcsetAttr(node, "srcset", assetUrlFor);
    return;
  }

  if (tagName === "video") {
    rewriteAttr(node, "src", assetUrlFor);
    rewriteAttr(node, "poster", assetUrlFor);
    return;
  }

  if (tagName === "audio" || tagName === "script") {
    rewriteAttr(node, "src", assetUrlFor);
    return;
  }

  if (tagName === "link" && isSupportLink(node)) {
    rewriteAttr(node, "href", assetUrlFor);
  }
}

function visit(node: HtmlNode, fn: (node: HtmlNode) => void): void {
  fn(node);
  for (const child of node.childNodes ?? []) visit(child, fn);
}

function rewriteAttr(
  node: HtmlNode,
  name: string,
  assetUrlFor: HtmlAssetUrlMapper,
): void {
  const attr = findAttr(node, name);
  if (!attr) return;
  const rewritten = rewriteLocalAssetUrl(attr.value, assetUrlFor);
  if (rewritten !== null) attr.value = rewritten;
}

function rewriteSrcsetAttr(
  node: HtmlNode,
  name: string,
  assetUrlFor: HtmlAssetUrlMapper,
): void {
  const attr = findAttr(node, name);
  if (!attr) return;
  const rewritten = rewriteSrcset(attr.value, assetUrlFor);
  if (rewritten !== attr.value) attr.value = rewritten;
}

function findAttr(node: HtmlNode, name: string): HtmlAttr | null {
  const target = name.toLowerCase();
  return node.attrs?.find((attr) => attr.name.toLowerCase() === target) ?? null;
}

function attrValue(node: HtmlNode, name: string): string | null {
  return findAttr(node, name)?.value.trim() ?? null;
}

function rewriteStyleAttr(node: HtmlNode, assetUrlFor: HtmlAssetUrlMapper): void {
  const attr = findAttr(node, "style");
  if (!attr) return;
  attr.value = rewriteCssAssetReferences(attr.value, assetUrlFor);
}

function rewriteStyleContent(node: HtmlNode, assetUrlFor: HtmlAssetUrlMapper): void {
  for (const child of node.childNodes ?? []) {
    if (typeof child.value === "string") {
      child.value = rewriteCssAssetReferences(child.value, assetUrlFor);
    }
  }
}

function isSupportLink(node: HtmlNode): boolean {
  const rel = attrValue(node, "rel");
  if (!rel) return false;
  const tokens = new Set(rel.toLowerCase().split(/\s+/).filter(Boolean));
  return (
    tokens.has("stylesheet") ||
    tokens.has("preload") ||
    tokens.has("modulepreload") ||
    tokens.has("icon") ||
    tokens.has("apple-touch-icon") ||
    tokens.has("mask-icon") ||
    tokens.has("manifest")
  );
}

function rewriteLocalAssetUrl(
  value: string,
  assetUrlFor: HtmlAssetUrlMapper,
  basePath = "",
): string | null {
  const trimmed = value.trim();
  if (shouldSkipUrl(trimmed)) return null;

  const { path, suffix } = splitPathSuffix(trimmed);
  const normalized = normalizeLocalAssetPath(
    basePath ? pathPosix.join(basePath, path) : path,
  );
  if (normalized === null) return null;
  if (htmlAssetContentType(normalized) === null) return null;

  const next = assetUrlFor(normalized);
  if (next === null) return null;
  return /^data:/i.test(next) ? next : `${next}${suffix}`;
}

function rewriteSrcset(
  srcset: string,
  assetUrlFor: HtmlAssetUrlMapper,
): string {
  const rewritten: string[] = [];
  let changed = false;
  let i = 0;

  while (i < srcset.length) {
    while (i < srcset.length && /[\s,]/u.test(srcset[i])) i++;
    if (i >= srcset.length) break;

    const urlStart = i;
    while (i < srcset.length && !/[\s,]/u.test(srcset[i])) i++;

    if (srcset.slice(urlStart, i).toLowerCase().startsWith("data:")) {
      while (i < srcset.length && !/\s/u.test(srcset[i])) i++;
    }

    const originalUrl = srcset.slice(urlStart, i);
    const descriptorStart = i;
    while (i < srcset.length && srcset[i] !== ",") i++;
    const descriptor = srcset.slice(descriptorStart, i).trim();

    const nextUrl = rewriteLocalAssetUrl(originalUrl, assetUrlFor) ?? originalUrl;
    if (nextUrl !== originalUrl) changed = true;
    rewritten.push(descriptor ? `${nextUrl} ${descriptor}` : nextUrl);

    if (srcset[i] === ",") i++;
  }

  return changed ? rewritten.join(", ") : srcset;
}

function shouldSkipUrl(value: string): boolean {
  if (!value || value.startsWith("#") || value.startsWith("/") || value.startsWith("//")) {
    return true;
  }
  return /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function splitPathSuffix(value: string): { path: string; suffix: string } {
  const queryIndex = value.indexOf("?");
  const hashIndex = value.indexOf("#");
  let splitAt = -1;
  if (queryIndex >= 0) splitAt = queryIndex;
  if (hashIndex >= 0 && (splitAt < 0 || hashIndex < splitAt)) splitAt = hashIndex;
  if (splitAt < 0) return { path: value, suffix: "" };
  return { path: value.slice(0, splitAt), suffix: value.slice(splitAt) };
}

function decodeUrlPath(value: string): string | null {
  try {
    return value
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");
  } catch {
    return null;
  }
}

function normalizeLocalAssetPath(value: string): string | null {
  const decoded = decodeUrlPath(value.trim());
  if (decoded === null) return null;
  return normalizeDecodedLocalAssetPath(decoded);
}

function normalizeDecodedLocalAssetPath(value: string): string | null {
  const normalized = pathPosix.normalize(value.trim().replace(/\\/g, "/"));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.startsWith("/") ||
    normalized.includes("\0") ||
    /[\u0000-\u001f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function looksLikeFullDocument(html: string): boolean {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html);
}
