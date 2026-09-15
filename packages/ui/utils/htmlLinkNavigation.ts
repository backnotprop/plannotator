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

import { hasLinkedDocExtension } from "./markdownExtensions";

/** Longest href the parent will look at. Matches the bridge's own cap. */
export const MAX_HTML_LINK_HREF_LENGTH = 2048;

export type HtmlLinkIntent =
	/** A local document to open in the linked-doc overlay. `path` is absolute. */
	| { kind: "document"; path: string; hash: string }
	/** Another origin. Opens in a new tab; the frame never navigates. */
	| { kind: "external"; url: string }
	/** A local file Plannotator cannot render as a document (`.pdf`, `.zip`, …). */
	| { kind: "unsupported"; path: string; label: string }
	/** Nothing to do: empty, fragment-only, or a scheme we do not follow. */
	| { kind: "ignored"; reason: HtmlLinkIgnoreReason };

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
	return resolveRelative(raw, base);
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
	return resolveRelative(`${url.pathname}${url.hash}`, context.rootDir);
}

function resolveRelative(
	raw: string,
	baseDir: string | null | undefined,
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
	// Containment is the server's call (`/api/doc` answers 403 for an escaping
	// path). The extension gate is ours: a `.pdf` would be a pointless fetch
	// and a confusing server error, so it is reported as unsupported here.
	if (!hasLinkedDocExtension(resolved)) {
		return { kind: "unsupported", path: resolved, label: basename(resolved) };
	}
	return { kind: "document", path: resolved, hash };
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
