import { isReviewImagePath } from "@plannotator/core/diff-paths";
import { hasLinkedDocExtension } from "./markdownExtensions";

export const HTML_ASSET_ROUTE_PREFIX = "/api/html-assets";

export const MAX_HTML_LINK_HREF_LENGTH = 2048;

export type HtmlLinkIntent =
	| { kind: "document"; path: string; hash: string; rendersHtml: boolean }
	| { kind: "external"; url: string }
	| { kind: "image"; path: string; url: string; label: string }
	| {
			kind: "unsupported";
			path: string;
			label: string;
			reason: HtmlLinkUnsupportedReason;
	  }
	| { kind: "ignored"; reason: HtmlLinkIgnoreReason };

export type HtmlLinkUnsupportedReason = "type" | "outside-asset-root" | "no-asset-root";

export type HtmlLinkIgnoreReason =
	| "empty"
	| "too-long"
	| "fragment"
	| "scheme"
	| "invalid"
	| "no-base";

export interface HtmlLinkContext {
	baseDir?: string | null;
	rootDir?: string | null;
	serverOrigin: string;
	convertHtml?: boolean;
	assetRoot?: { dir: string; url: string } | null;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function resolveHtmlLinkIntent(
	href: string,
	context: HtmlLinkContext,
): HtmlLinkIntent {
	if (typeof href !== "string") return { kind: "ignored", reason: "invalid" };
	const raw = href.trim();
	if (!raw) return { kind: "ignored", reason: "empty" };
	if (raw.length > MAX_HTML_LINK_HREF_LENGTH) return { kind: "ignored", reason: "too-long" };
	if (CONTROL_CHARS.test(raw)) return { kind: "ignored", reason: "invalid" };
	if (raw.startsWith("#")) return { kind: "ignored", reason: "fragment" };

	if (raw.startsWith("//") || HAS_SCHEME.test(raw)) {
		return resolveAbsolute(raw, context);
	}

	const rootRelative = raw.startsWith("/");
	const base = rootRelative ? context.rootDir : context.baseDir;
	return resolveRelative(raw, base, context);
}

function resolveAbsolute(raw: string, context: HtmlLinkContext): HtmlLinkIntent {
	let url: URL;
	try {
		url = new URL(raw, context.serverOrigin);
	} catch {
		return { kind: "ignored", reason: "invalid" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { kind: "ignored", reason: "scheme" };
	}
	if (url.origin !== context.serverOrigin) {
		return { kind: "external", url: url.href };
	}
	return resolveRelative(`${url.pathname}${url.hash}`, context.rootDir, context);
}

function resolveRelative(
	raw: string,
	baseDir: string | null | undefined,
	context: HtmlLinkContext,
): HtmlLinkIntent {
	const { path: pathPart, hash } = splitHash(stripQuery(raw));
	if (!pathPart) return { kind: "ignored", reason: "fragment" };
	const decoded = decodePath(pathPart);
	if (decoded === null || CONTROL_CHARS.test(decoded)) {
		return { kind: "ignored", reason: "invalid" };
	}
	if (!baseDir) return { kind: "ignored", reason: "no-base" };
	const resolved = joinPath(baseDir, decoded);
	if (!resolved) return { kind: "ignored", reason: "invalid" };
	const label = basename(resolved);
	if (isReviewImagePath(resolved)) return resolveImage(resolved, label, context.assetRoot);
	if (!hasLinkedDocExtension(resolved)) {
		return { kind: "unsupported", path: resolved, label, reason: "type" };
	}
	return {
		kind: "document",
		path: resolved,
		hash,
		rendersHtml: documentRendersHtml(resolved, context.convertHtml),
	};
}

function resolveImage(
	path: string,
	label: string,
	assetRoot: HtmlLinkContext["assetRoot"],
): HtmlLinkIntent {
	if (!assetRoot?.dir || !assetRoot.url) {
		return { kind: "unsupported", path, label, reason: "no-asset-root" };
	}
	const dir = assetRoot.dir.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!path.startsWith(`${dir}/`)) {
		return { kind: "unsupported", path, label, reason: "outside-asset-root" };
	}
	const relative = path
		.slice(dir.length + 1)
		.split("/")
		.map(encodeURIComponent)
		.join("/");
	const base = assetRoot.url.endsWith("/") ? assetRoot.url : `${assetRoot.url}/`;
	return { kind: "image", path, url: `${base}${relative}`, label };
}

const HTML_COMMENT_PATTERN = new RegExp("<!--[\\s\\S]*?(?:-->|$)", "g");

export function htmlAssetRouteFromDocument(rawHtml: string | null | undefined): string | null {
	if (!rawHtml) return null;
	const withoutComments = rawHtml.replace(HTML_COMMENT_PATTERN, "");
	const baseTag = /<base\b[^>]*>/i.exec(withoutComments);
	if (!baseTag) return null;
	const match = /\bhref\s*=\s*["']?\/api\/html-assets\/([A-Za-z0-9_-]+)\//i.exec(baseTag[0]);
	return match ? `${HTML_ASSET_ROUTE_PREFIX}/${match[1]}/` : null;
}

export function documentRendersHtml(path: string, convertHtml?: boolean): boolean {
	return /\.html?$/i.test(path) && !convertHtml;
}

function stripQuery(value: string): string {
	const q = value.indexOf("?");
	if (q < 0) return value;
	const h = value.indexOf("#");
	return h > q ? value.slice(0, q) + value.slice(h) : value.slice(0, q);
}

function splitHash(value: string): { path: string; hash: string } {
	const h = value.indexOf("#");
	if (h < 0) return { path: value, hash: "" };
	return { path: value.slice(0, h), hash: value.slice(h + 1) };
}

function decodePath(value: string): string | null {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] || path;
}

function joinPath(baseDir: string, relative: string): string | null {
	const base = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const rel = relative.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!rel) return null;
	const segments = base.split("/");
	for (const segment of rel.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			if (segments.length > 1) segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const joined = segments.join("/");
	return joined || null;
}
