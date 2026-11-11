import { normalizeMarkdownExtensions } from "@plannotator/core/annotatable";

const BUILTIN_LINKED_DOC_REGEX = /\.(mdx?|txt|adoc|asciidoc|html?)$/i;

let extraExtensions: string[] = [];

/** Register the extra markdown extensions for this page. */
export function setExtraMarkdownExtensions(value: unknown): void {
	extraExtensions = normalizeMarkdownExtensions(value);
}

export function getExtraMarkdownExtensions(): string[] {
	return extraExtensions;
}

/** Does this link target name a local document the linked-doc overlay can open? */
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
