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
 * - Source-code extensions (.ts, .py, …) — those belong to the code-file
 *   link/popout system (`CODE_FILE_REGEX` in `code-file.ts`) and would also
 *   flood the annotate folder file browser.
 *
 * Note the overlap with `CODE_FILE_REGEX` (.yaml/.json/.toml/.ini/.xml appear
 * in both): a path's *rendering* depends on the surface. Code-file links
 * inside a document keep the syntax-highlighted popout; the annotate CLI and
 * the annotate file browser render the same file as an annotatable plain-text
 * document.
 */

/** Plain-text file extensions annotate accepts as markdown-rendered text (no HTML). */
export const ANNOTATABLE_TEXT_REGEX =
	/(\.(mdx?|txt|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)$/i;

/**
 * Everything the annotate surfaces can open: the plain-text set plus
 * .html/.htm (which render as raw HTML via their own branch). Used by folder
 * discovery and the file-browser listing.
 */
export const ANNOTATABLE_DOC_REGEX =
	/(\.(mdx?|txt|html?|ya?ml|jsonc?|json5|toml|ini|cfg|conf|properties|csv|tsv|log|xml)|\.env\.example)$/i;

/** True when annotate can open `input` as a plain-text (markdown-rendered) document. */
export function isAnnotatableTextPath(input: string): boolean {
	return ANNOTATABLE_TEXT_REGEX.test(input.trim());
}

/** True when annotate can open `input` at all (plain text or raw HTML). */
export function isAnnotatableDocPath(input: string): boolean {
	return ANNOTATABLE_DOC_REGEX.test(input.trim());
}

/**
 * Human-readable description of the accepted set for error messages —
 * keep in sync with the regexes above.
 */
export const ANNOTATABLE_EXTENSIONS_HINT =
	".md, .mdx, .txt, .html, .htm, .yaml, .yml, .json, .jsonc, .json5, .toml, .ini, .cfg, .conf, .properties, .csv, .tsv, .log, .xml, .env.example";

/**
 * Size cap for files served/read as annotatable documents — the same 2MB
 * limit the code-file popout has always enforced. Applies to the annotate
 * CLI single-file read and the /api/doc document branches in both runtimes:
 * a multi-GB `server.log` must produce a clear error, not OOM the server
 * (and get copied into annotate history).
 */
export const MAX_ANNOTATABLE_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Whether the markdown parser should strip a leading `--- ... ---` pair as
 * frontmatter for a document from `path`.
 *
 * Frontmatter is a markdown convention. Non-markdown plain-text sources use
 * the same delimiters for real content — a multi-document YAML (k8s style)
 * starts with `---\napiVersion: …\n---` — so stripping there swallows the
 * first document. Strip only for markdown sources (.md/.mdx) and for sources
 * without a file path (plans and agent messages are always markdown);
 * converted sources (URLs, .html via --markdown) keep stripping too since
 * their markdown is generated.
 */
export function shouldStripFrontmatter(path: string | null | undefined): boolean {
	if (!path) return true;
	const trimmed = path.trim();
	if (/\.mdx?$/i.test(trimmed)) return true;
	return !isAnnotatableTextPath(trimmed);
}
