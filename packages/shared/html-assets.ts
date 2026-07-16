import { posix as pathPosix } from "path";
import * as parse5 from "parse5";

export const HTML_ASSET_ROUTE_PREFIX = "/api/html-assets";

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

export function normalizeHtmlAssetRoutePath(routePath: string): string | null {
  const decoded = decodeUrlPath(routePath);
  if (decoded === null) return null;
  return normalizeDecodedLocalAssetPath(decoded);
}

export function rewriteHtmlAssetReferences(
  html: string,
  assetUrlFor: HtmlAssetUrlMapper,
): string {
  const tree = looksLikeFullDocument(html)
    ? parse5.parse(html)
    : parse5.parseFragment(html);
  visit(tree as unknown as HtmlNode, (node) => rewriteNodeAssetReferences(node, assetUrlFor));
  return parse5.serialize(tree as never);
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
