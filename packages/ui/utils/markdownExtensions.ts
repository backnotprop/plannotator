import { normalizeMarkdownExtensions } from "@plannotator/core/annotatable";

const BUILTIN_LINKED_DOC_REGEX = /\.(mdx?|txt|adoc|asciidoc|html?)$/i;

let extraExtensions: string[] = [];

export function setExtraMarkdownExtensions(value: unknown): void {
	extraExtensions = normalizeMarkdownExtensions(value);
}

export function getExtraMarkdownExtensions(): string[] {
	return extraExtensions;
}

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
