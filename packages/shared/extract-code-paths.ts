import {
	CODE_PATH_BARE_REGEX,
	isCodeFilePath,
	isCodeFilePathStrict,
} from "./code-file";

const FENCED_CODE_BLOCK = /(^|\n)([ \t]*)(```|~~~)[\s\S]*?\n\2\3/g;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
// Match InlineMarkdown.tsx's bare-URL regex exactly so URL ranges excised
// here mirror the ranges the renderer would consume.
const URL_REGEX = /https?:\/\/[^\s<>"']+/g;
const BACKTICK_SPAN = /`([^`\n]+)`/g;

/**
 * Extract candidate code-file paths from markdown text. Mirrors the renderer's
 * detection precedence so the validator only sees paths the renderer would
 * actually linkify:
 *   1. fenced code blocks and HTML comments are stripped first;
 *   2. URL ranges are excised before the bare-prose scan (URLs win);
 *   3. backtick spans matching `isCodeFilePath` are collected;
 *   4. bare-prose paths matching `CODE_PATH_BARE_REGEX` and
 *      `isCodeFilePathStrict` are collected.
 *
 * Hash anchors (`#L42`) are stripped from results to match the renderer's
 * `cleanPath` transform. Returns deduped candidate strings.
 */
function collectCandidateCodePaths(markdown: string, dedupe: boolean): string[] {
	const stripped = markdown
		.replace(FENCED_CODE_BLOCK, "")
		.replace(HTML_COMMENT, "");

	const seen = new Set<string>();
	const candidates: string[] = [];

	const addCandidate = (candidate: string) => {
		const clean = candidate.replace(/#.*$/, "");
		if (dedupe) {
			if (seen.has(clean)) return;
			seen.add(clean);
		}
		candidates.push(clean);
	};

	let m: RegExpExecArray | null;
	const backtickRe = new RegExp(BACKTICK_SPAN.source, "g");
	while ((m = backtickRe.exec(stripped)) !== null) {
		const inner = m[1].trim();
		if (isCodeFilePath(inner)) {
			addCandidate(inner);
		}
	}

	const strippedForBareScan = stripped.replace(BACKTICK_SPAN, (match) =>
		" ".repeat(match.length),
	);

	for (const line of strippedForBareScan.split("\n")) {
		const urlRanges: Array<[number, number]> = [];
		const urlRe = new RegExp(URL_REGEX.source, "g");
		while ((m = urlRe.exec(line)) !== null) {
			urlRanges.push([m.index, m.index + m[0].length]);
		}

		const pathRe = new RegExp(CODE_PATH_BARE_REGEX.source, "g");
		while ((m = pathRe.exec(line)) !== null) {
			const start = m.index;
			const end = start + m[0].length;
			const prev = start === 0 ? "" : line[start - 1];
			if (/\w/.test(prev)) continue;
			const overlapsUrl = urlRanges.some(
				([s, e]) => start < e && end > s,
			);
			if (overlapsUrl) continue;
			if (!isCodeFilePathStrict(m[0])) continue;
			addCandidate(m[0]);
		}
	}

	return candidates;
}

export function extractCandidateCodePaths(markdown: string): string[] {
	return collectCandidateCodePaths(markdown, true);
}

/**
 * Extract candidate code-file path mentions without deduplication.
 * Uses the same stripping and validation rules as `extractCandidateCodePaths`,
 * but keeps repeated mentions so UI summaries can show frequency.
 */
export function extractCandidateCodePathMentions(markdown: string): string[] {
	return collectCandidateCodePaths(markdown, false);
}
