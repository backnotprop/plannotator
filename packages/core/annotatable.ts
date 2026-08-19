/**
 * Annotatable file-type predicates — the single source of truth for which
 * files the annotate flow accepts (#1029).
 *
 * Annotate reads files as UTF-8 text and renders them exactly the way `.txt`
 * is rendered (plain text through the markdown pipeline), so any
 * unambiguously plain-text format is safe to accept. The set is deliberately
 * conservative:
 *
 * - Markdown/plain docs: .md .mdx .txt
 * - Config/data formats: .yaml .yml .json .jsonc .json5 .toml .ini .cfg
 *   .conf .properties .csv .tsv .log .xml .env.example
 *
 * Deliberate exclusions:
 * - `.env` — commonly holds secrets, and annotate's per-file version history
 *   copies file contents into the data dir (`~/.plannotator/history/`).
 *   `.env.example` (the secret-free template convention) is accepted.
 *   `.env` is also denylisted for the user-configurable extra extensions
 *   below, so no config value can register it.
 * - Source-code extensions (.ts, .py, …) — those belong to the code-file
 *   link/popout system (`CODE_FILE_REGEX` in `code-file.ts`) and would also
 *   flood the annotate folder file browser.
 *
 * Note the overlap with `CODE_FILE_REGEX` (.yaml/.json/.toml/.ini/.xml appear
 * in both): a path's *rendering* depends on the surface. Code-file links
 * inside a document keep the syntax-highlighted popout; the annotate CLI and
 * the annotate file browser render the same file as an annotatable plain-text
 * document.
 *
 * User-configurable extras (#1307): a user may register additional extensions
 * (for example `.livemd`, Livebook notebooks) via `markdownExtensions` in
 * `~/.plannotator/config.json`. This module stays browser-safe and zero-dep,
 * so it never reads that config: the server resolves it once and threads the
 * normalized list in as the optional `extra` parameter every predicate here
 * accepts (default: none, i.e. exactly the built-in behavior). Extras are
 * always treated as MARKDOWN — rendered like `.md`, frontmatter stripped —
 * never as HTML.
 */

/** Built-in plain-text extension pattern (no leading anchor, no trailing `$`). */
const BUILTIN_TEXT_PATTERN =
	String.raw`(?:\.(?:mdx?|txt|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)`;

/** Built-in plain-text + raw-HTML extension pattern. */
const BUILTIN_DOC_PATTERN =
	String.raw`(?:\.(?:mdx?|txt|html?|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)`;

/** Plain-text file extensions annotate accepts as markdown-rendered text (no HTML). */
export const ANNOTATABLE_TEXT_REGEX = new RegExp(`${BUILTIN_TEXT_PATTERN}$`, "i");

/**
 * Everything the annotate surfaces can open: the plain-text set plus
 * .html/.htm (which render as raw HTML via their own branch). Used by folder
 * discovery and the file-browser listing.
 */
export const ANNOTATABLE_DOC_REGEX = new RegExp(`${BUILTIN_DOC_PATTERN}$`, "i");

/** Extensions a user may never register through config (see module comment). */
export const DENIED_MARKDOWN_EXTENSIONS = [".env"] as const;

/**
 * The dotenv family is denylisted as a family, not a single name: `.env`
 * itself, suffixed variants like `.prod.env`, and prefixed variants like
 * `.env.local` all commonly hold secrets, and annotate history copies file
 * contents into the data dir. (`.env.example` stays registerable only via
 * the built-in list, where it is a deliberate exception.)
 */
function isDeniedMarkdownExtension(ext: string): boolean {
	return ext.endsWith(".env") || ext.startsWith(".env.");
}

/** Shape a configured extension must have once trimmed and lowercased. */
const CONFIGURABLE_EXTENSION_RE = /^\.[a-z0-9][a-z0-9._-]*$/;

/** Longest configured extension accepted, including the leading dot. */
const MAX_CONFIGURABLE_EXTENSION_LENGTH = 24;

/** Most configured extensions kept, so a pathological config cannot bloat the regexes. */
const MAX_CONFIGURABLE_EXTENSIONS = 32;

function escapeRegExp(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize a user-supplied `markdownExtensions` value into the list the
 * predicates below accept. Invalid entries are dropped silently — a bad
 * config line must never break a session — and the result is deduplicated
 * against itself and against the built-in sets.
 *
 * An entry is kept only when it is a string that, trimmed and lowercased:
 *  - starts with a dot and otherwise contains only `[a-z0-9._-]`, which
 *    rejects path separators, globs, whitespace, and dotless names;
 *  - is at most `MAX_CONFIGURABLE_EXTENSION_LENGTH` characters;
 *  - is not in the denylisted dotenv family (`.env`, `.prod.env`,
 *    `.env.local`, ... — annotate must never copy secrets into the data dir;
 *    see `isDeniedMarkdownExtension`);
 *  - is not already covered by a built-in extension.
 */
export function normalizeMarkdownExtensions(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const result: string[] = [];
	for (const entry of value) {
		if (result.length >= MAX_CONFIGURABLE_EXTENSIONS) break;
		if (typeof entry !== "string") continue;
		const ext = entry.trim().toLowerCase();
		if (ext.length > MAX_CONFIGURABLE_EXTENSION_LENGTH) continue;
		if (!CONFIGURABLE_EXTENSION_RE.test(ext)) continue;
		if (isDeniedMarkdownExtension(ext)) continue;
		// Dedupe against the built-ins: `sample` is a stand-in filename so the
		// anchored built-in patterns match the extension the way they would on
		// a real path.
		if (ANNOTATABLE_DOC_REGEX.test(`sample${ext}`)) continue;
		if (result.includes(ext)) continue;
		result.push(ext);
	}
	return result;
}

const regexCache = new Map<string, RegExp>();

function buildRegex(basePattern: string, extra: readonly string[]): RegExp {
	if (extra.length === 0) {
		return basePattern === BUILTIN_TEXT_PATTERN
			? ANNOTATABLE_TEXT_REGEX
			: ANNOTATABLE_DOC_REGEX;
	}
	const key = `${basePattern}::${extra.join(",")}`;
	const cached = regexCache.get(key);
	if (cached) return cached;
	const alternation = [basePattern, ...extra.map(escapeRegExp)].join("|");
	const regex = new RegExp(`(?:${alternation})$`, "i");
	regexCache.set(key, regex);
	return regex;
}

/** Plain-text (markdown-rendered) extension matcher including configured extras. */
export function buildAnnotatableTextRegex(extra: readonly string[] = []): RegExp {
	return buildRegex(BUILTIN_TEXT_PATTERN, extra);
}

/** Plain-text + raw-HTML extension matcher including configured extras. */
export function buildAnnotatableDocRegex(extra: readonly string[] = []): RegExp {
	return buildRegex(BUILTIN_DOC_PATTERN, extra);
}

/** True when annotate can open `input` as a plain-text (markdown-rendered) document. */
export function isAnnotatableTextPath(input: string, extra: readonly string[] = []): boolean {
	return buildAnnotatableTextRegex(extra).test(input.trim());
}

/** True when annotate can open `input` at all (plain text or raw HTML). */
export function isAnnotatableDocPath(input: string, extra: readonly string[] = []): boolean {
	return buildAnnotatableDocRegex(extra).test(input.trim());
}

/** True when `input` is annotatable only because of a configured extra extension. */
export function isExtraMarkdownPath(input: string, extra: readonly string[] = []): boolean {
	if (extra.length === 0) return false;
	const trimmed = input.trim().toLowerCase();
	return extra.some((ext) => trimmed.endsWith(ext));
}

/**
 * Human-readable description of the accepted set for error messages —
 * keep in sync with the patterns above.
 */
export const ANNOTATABLE_EXTENSIONS_HINT =
	".md, .mdx, .txt, .html, .htm, .yaml, .yml, .json, .jsonc, .json5, .toml, .ini, .cfg, .conf, .properties, .csv, .tsv, .log, .xml, .env.example";

/** The accepted-set hint with any configured extra extensions appended. */
export function buildAnnotatableExtensionsHint(extra: readonly string[] = []): string {
	return extra.length === 0
		? ANNOTATABLE_EXTENSIONS_HINT
		: `${ANNOTATABLE_EXTENSIONS_HINT}, ${extra.join(", ")}`;
}

/**
 * Size cap for files served/read as annotatable documents — the same 2MB
 * limit the code-file popout has always enforced. Applies to the annotate
 * CLI single-file read and the /api/doc document branches in both runtimes:
 * a multi-GB `server.log` must produce a clear error, not OOM the server
 * (and get copied into annotate history). Configured extra extensions are
 * capped exactly like `.md`.
 */
export const MAX_ANNOTATABLE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Whether the markdown parser should strip a leading `--- ... ---` pair as
 * frontmatter for a document from `path`.
 *
 * Frontmatter is a markdown convention. Non-markdown plain-text sources use
 * the same delimiters for real content — a multi-document YAML (k8s style)
 * starts with `---\napiVersion: …\n---` — so stripping there swallows the
 * first document. Strip only for markdown sources (.md/.mdx, plus any
 * configured extra extension, which is markdown by definition) and for
 * sources without a file path (plans and agent messages are always markdown);
 * converted sources (URLs, .html via --markdown) keep stripping too since
 * their markdown is generated.
 */
export function shouldStripFrontmatter(
	path: string | null | undefined,
	extra: readonly string[] = [],
): boolean {
	if (!path) return true;
	const trimmed = path.trim();
	if (/\.mdx?$/i.test(trimmed)) return true;
	if (isExtraMarkdownPath(trimmed, extra)) return true;
	return !isAnnotatableTextPath(trimmed, extra);
}
