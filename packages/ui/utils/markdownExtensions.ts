/**
 * Extra markdown extensions, renderer side (#1307).
 *
 * The server resolves `markdownExtensions` from `~/.plannotator/config.json`
 * and ships the normalized list with the annotate payload. The renderer needs
 * it for one job: deciding whether a relative link or a wiki-link target names
 * a local document it should open in the linked-doc overlay (`/api/doc`) or a
 * plain external link. Without it, `[notes](notes.livemd)` renders as a dead
 * external link even though the server would happily serve it.
 *
 * Module-level registry seam, like `skillReferences.ts`: a host (or the app's
 * own boot code) registers the list once, everything else reads it. Empty by
 * default, so nothing changes for a user with no config.
 *
 * The built-in set here is deliberately NARROWER than the annotatable set on
 * the server (`.md`/`.mdx`/`.txt`/`.html`/`.htm` only) — widening it is a
 * separate decision. Extras are added on top of it.
 */

import { normalizeMarkdownExtensions } from "@plannotator/core/annotatable";

/** Built-in extensions the renderer treats as openable local documents. */
const BUILTIN_LINKED_DOC_REGEX = /\.(mdx?|txt|html?)$/i;

let extraExtensions: string[] = [];

/**
 * Register the extra markdown extensions for this page. Values are normalized
 * with the same rules the server applies (dot-led, lowercased, `.env` denied),
 * so a hostile or malformed payload cannot inject regex or path fragments.
 */
export function setExtraMarkdownExtensions(value: unknown): void {
	extraExtensions = normalizeMarkdownExtensions(value);
}

/** The registered extra extensions (normalized, possibly empty). */
export function getExtraMarkdownExtensions(): string[] {
	return extraExtensions;
}

/**
 * Does this link target name a local document the linked-doc overlay can open?
 *
 * `allowFragment` mirrors the two call sites this replaced: markdown links
 * accept a trailing `#fragment` (stripped by the caller before navigating),
 * wiki-link targets do not.
 */
export function hasLinkedDocExtension(
	target: string,
	options?: { allowFragment?: boolean },
): boolean {
	const trimmed = target.trim();
	const path = options?.allowFragment ? trimmed.replace(/#.*$/, "") : trimmed;
	if (BUILTIN_LINKED_DOC_REGEX.test(path)) return true;
	const lower = path.toLowerCase();
	return extraExtensions.some((ext) => lower.endsWith(ext));
}
