/**
 * Document format detection shared by the client and all server runtimes.
 *
 * The format of an annotatable document is derived from its file extension —
 * there is no format field on the wire. Servers gate which files are
 * annotatable/browsable; the client picks the block parser from the path.
 */

export type DocumentFormat = "markdown" | "asciidoc";

export const ASCIIDOC_PATH_REGEX = /\.(adoc|asciidoc)$/i;

export const isAsciidocPath = (path: string): boolean =>
	ASCIIDOC_PATH_REGEX.test(path.trim());

export const documentFormatForPath = (
	path?: string | null,
): DocumentFormat => (path && isAsciidocPath(path) ? "asciidoc" : "markdown");

/** Text documents parsed into annotatable blocks (resolve gate). */
export const ANNOTATABLE_DOC_EXTENSIONS = /\.(mdx?|txt|adoc|asciidoc)$/i;

/** Folder guard / file browser / `/api/doc` base gate — adds HTML, which is
 *  browsable but rendered raw rather than parsed to blocks. */
export const BROWSABLE_DOC_EXTENSIONS = /\.(mdx?|txt|adoc|asciidoc|html?)$/i;
