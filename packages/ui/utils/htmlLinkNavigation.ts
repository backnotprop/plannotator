/**
 * What a link click inside a raw-HTML annotate document means.
 *
 * A srcdoc document has no URL of its own: its base URL is the PARENT page's,
 * so `<a href="02-detail.html">` resolves onto the Plannotator server and the
 * catch-all answers with the app itself — the whole editor rendered inside the
 * annotated frame. The bridge therefore never lets the frame navigate and
 * hands the RAW href to the parent, which is the trust boundary; this module
 * is the pure decision it makes.
 *
 * Deliberately pure (no DOM, no fetch, no `window`): the caller passes the
 * server origin and the directories, so every branch is unit-testable.
 */

import { isReviewImagePath } from "@plannotator/core/diff-paths";
import { hasLinkedDocExtension } from "./markdownExtensions";

/**
 * Route the servers serve a raw-HTML page's support assets from. Spelled here
 * rather than imported because `@plannotator/shared/html-assets` is node-side
 * (parse5, `path`); `htmlLinkNavigation.test.ts` pins the two together.
 */
export const HTML_ASSET_ROUTE_PREFIX = "/api/html-assets";

/** Longest href the parent will look at. Matches the bridge's own cap. */
export const MAX_HTML_LINK_HREF_LENGTH = 2048;

export type HtmlLinkIntent =
	/**
	 * A local document to open in the linked-doc overlay. `path` is absolute.
	 * `rendersHtml` is whether it will open as another raw-HTML surface rather
	 * than as markdown, which is what decides whether the sidebar is revealed:
	 * HTML surfaces keep it closed and carry their own Back control.
	 */
	| { kind: "document"; path: string; hash: string; rendersHtml: boolean }
	/** Another origin. Opens in a new tab; the frame never navigates. */
	| { kind: "external"; url: string }
	/**
	 * A local image inside the page's asset root, shown in the image lightbox.
	 * `url` is the page's own `/api/html-assets/<token>/…` route, so the
	 * lightbox reads exactly what the page itself can already load.
	 */
	| { kind: "image"; path: string; url: string; label: string }
	/**
	 * A local file Plannotator will not open. `type`: not a document or image
	 * (`.pdf`, `.zip`, …). `outside-asset-root`: an image outside the page's
	 * own folder, which the asset route refuses. `no-asset-root`: an image on
	 * a page served without an asset route (share links, converted pages).
	 */
	| {
			kind: "unsupported";
			path: string;
			label: string;
			reason: HtmlLinkUnsupportedReason;
	  }
	/** Nothing to do: empty, fragment-only, or a scheme we do not follow. */
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
	/** Directory of the document the click happened in. */
	baseDir?: string | null;
	/**
	 * Directory the session was opened from. Server-absolute paths
	 * (`/01-entry-point.html`, and the same path spelled with the server's own
	 * origin) resolve against this, because that is the site root the author
	 * meant when they wrote a root-relative link.
	 */
	rootDir?: string | null;
	/** The Plannotator server's own origin, e.g. `http://localhost:19601`. */
	serverOrigin: string;
	/** The session's `--markdown` preference: HTML is Turndowned by `/api/doc`,
	 *  so an `.html` target renders as markdown rather than as an HTML surface. */
	convertHtml?: boolean;
	/**
	 * The current page's asset root: the directory its `/api/html-assets`
	 * token was minted for, and that token's route (`/api/html-assets/<t>/`).
	 * Image links open in the lightbox only from inside `dir`.
	 */
	assetRoot?: { dir: string; url: string } | null;
}

/** Control characters never appear in a real href; they are how structure gets smuggled. */
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
	// The bridge scrolls in-page fragments itself; one reaching here is a no-op.
	if (raw.startsWith("#")) return { kind: "ignored", reason: "fragment" };

	// Scheme-relative (`//host/x`) and absolute URLs both go through URL
	// parsing, which is the only reliable way to compare origins.
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
		// javascript:, data:, mailto:, tel:, file:, blob: — none of them name a
		// document this session can annotate, and none may navigate the frame.
		return { kind: "ignored", reason: "scheme" };
	}
	if (url.origin !== context.serverOrigin) {
		return { kind: "external", url: url.href };
	}
	// The server's own origin: the author wrote `http://localhost:<port>/x.html`
	// meaning "the file x.html of this site", so treat it as root-relative.
	// Left alone it would hit the catch-all and render the app in the frame.
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
	// Containment is the server's call (`/api/doc` answers 403 for an escaping
	// path). The extension gate is ours: a `.pdf` would be a pointless fetch
	// and a confusing server error, so it is reported as unsupported here.
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

/**
 * An image link opens in the lightbox, read through the page's own asset
 * route. That route serves only files below the token's directory (it refuses
 * `..` and checks the realpath), so an image outside it is reported here
 * instead of becoming a request the server would refuse. This check is
 * lexical and only decides the UI; the server's check is the one that holds.
 */
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

/**
 * The asset route a served raw-HTML page is anchored at. Both servers install
 * `<base href="/api/html-assets/<token>/">` first in `<head>` (re-anchoring a
 * relative author base under the same token). Returns that token's route, or
 * null when the page carries none (share links, an author's absolute base).
 *
 * Only the FIRST `<base>` element counts, as in the browser, and comments are
 * skipped: a page cannot name a different token in a comment or a later base
 * tag and have the lightbox read through it.
 */
const HTML_COMMENT_PATTERN = new RegExp("<!--[\\s\\S]*?(?:-->|$)", "g");

export function htmlAssetRouteFromDocument(rawHtml: string | null | undefined): string | null {
	if (!rawHtml) return null;
	// RegExp constructor, not a literal: Semgrep's TS parser chokes on `<!--` in a regex literal.
	const withoutComments = rawHtml.replace(HTML_COMMENT_PATTERN, "");
	const baseTag = /<base\b[^>]*>/i.exec(withoutComments);
	if (!baseTag) return null;
	const match = /\bhref\s*=\s*["']?\/api\/html-assets\/([A-Za-z0-9_-]+)\//i.exec(baseTag[0]);
	return match ? `${HTML_ASSET_ROUTE_PREFIX}/${match[1]}/` : null;
}

/**
 * Whether opening `path` lands on another raw-HTML surface rather than a
 * markdown one. `--markdown` sessions convert HTML on the way in, so nothing
 * renders as HTML there. This is the one rule behind `rendersHtml`, and the
 * same question the annotations panel's cross-file jump asks before deciding
 * whether to reveal the sidebar — so it lives here rather than being spelled
 * twice.
 */
export function documentRendersHtml(path: string, convertHtml?: boolean): boolean {
	return /\.html?$/i.test(path) && !convertHtml;
}

function stripQuery(value: string): string {
	const q = value.indexOf("?");
	if (q < 0) return value;
	const h = value.indexOf("#");
	// `a.html?x=1#frag` — drop the query, keep the fragment.
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

/**
 * Join a relative path onto a directory, resolving `.` and `..` lexically.
 * A root-relative input (`/x.html`) is taken as relative to `baseDir` too —
 * the caller has already chosen which directory plays the role of root.
 */
function joinPath(baseDir: string, relative: string): string | null {
	const base = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
	const rel = relative.replace(/\\/g, "/").replace(/^\/+/, "");
	if (!rel) return null;
	const segments = base.split("/");
	for (const segment of rel.split("/")) {
		if (!segment || segment === ".") continue;
		if (segment === "..") {
			// Never pop past the root marker (the leading "" of an absolute base).
			if (segments.length > 1) segments.pop();
			continue;
		}
		segments.push(segment);
	}
	const joined = segments.join("/");
	return joined || null;
}
