/**
 * Annotate bundles: several files opened as ONE annotate review, in the order
 * the agent (or the user) named them, with one decision for all of them.
 *
 * `plannotator annotate spec.md mock.html notes.md` (every argument an
 * existing, annotatable file named by its path) and the `plannotator` tool's
 * `target: [...]` open a bundle. The servers run it as `annotate-bundle`, a
 * folder-like session restricted to the explicit, ordered list: /api/plan
 * carries `bundle` (this module's `AnnotateBundleFile[]`), the file list keeps
 * the given order, and the feedback has one section per file in that order.
 *
 * Browser-safe and dependency-free: the editor, both servers and the hosts
 * share these helpers. The node-side argument rule (which tokens make a
 * bundle) lives in `packages/shared/annotate-target.ts`. It lives in shared,
 * not `@plannotator/core`, on purpose: nothing in the published UI package
 * needs it, so it adds no export to the published core manifest. Vendored to Pi.
 */

/** How one bundle file renders, the same values /api/doc names in `renderAs`. */
export type AnnotateBundleRenderAs = "markdown" | "html" | "mermaid" | "graphviz";

/** One file of a bundle, in bundle order. `path` is absolute. */
export interface AnnotateBundleFile {
	path: string;
	renderAs: AnnotateBundleRenderAs;
}

const RENDER_AS: readonly AnnotateBundleRenderAs[] = ["markdown", "html", "mermaid", "graphviz"];

function separatorFree(path: string): string {
	return path.replace(/\\/g, "/");
}

/** The file name of a path (either separator). */
export function annotateBundleBaseName(path: string): string {
	const normalized = separatorFree(path).replace(/\/+$/, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

/**
 * The deepest directory that contains every file of the bundle: the root the
 * file list labels paths against. `/` (or a drive root) when the files share
 * nothing else. Paths are compared segment by segment, never by string prefix.
 */
export function annotateBundleRoot(paths: readonly string[]): string {
	if (paths.length === 0) return "/";
	const split = paths.map((path) => separatorFree(path).split("/"));
	// Each path's directory segments (the file name is not a directory).
	const dirs = split.map((segments) => segments.slice(0, -1));
	const first = dirs[0] as string[];
	let shared = first.length;
	for (const segments of dirs.slice(1)) {
		let index = 0;
		while (index < shared && index < segments.length && segments[index] === first[index]) index += 1;
		shared = index;
	}
	const common = first.slice(0, shared);
	if (common.length === 0) return "/";
	const joined = common.join("/");
	// "" is the POSIX root; "C:" a Windows drive root.
	if (joined === "") return "/";
	if (/^[A-Za-z]:$/.test(joined)) return `${joined}/`;
	return joined;
}

/** A path relative to the bundle root, for labels ("docs/spec.md"). */
export function annotateBundleRelativePath(path: string, root: string): string {
	const normalized = separatorFree(path);
	const base = separatorFree(root).replace(/\/+$/, "");
	if (base === "") return normalized.replace(/^\/+/, "");
	return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
}

/** "file 2 of 3": where the open file sits in its bundle (1-based). */
export function annotateBundlePositionText(index: number, total: number): string {
	return `file ${index} of ${total}`;
}

/**
 * The `bundle` field of an /api/plan answer, validated: a list of two or
 * more `{ path, renderAs }` with distinct absolute-looking paths. Anything
 * else is null, so a malformed payload opens no bundle UI.
 */
export function parseAnnotateBundle(value: unknown): AnnotateBundleFile[] | null {
	if (!Array.isArray(value) || value.length < 2) return null;
	const files: AnnotateBundleFile[] = [];
	const seen = new Set<string>();
	for (const entry of value) {
		const candidate = entry as { path?: unknown; renderAs?: unknown } | null;
		if (!candidate || typeof candidate.path !== "string" || candidate.path.length === 0) return null;
		if (!RENDER_AS.includes(candidate.renderAs as AnnotateBundleRenderAs)) return null;
		if (seen.has(candidate.path)) return null;
		seen.add(candidate.path);
		files.push({ path: candidate.path, renderAs: candidate.renderAs as AnnotateBundleRenderAs });
	}
	return files;
}

/**
 * The files of a bundle on one line, for the `File: <path>` slot of the
 * annotate feedback prompts (the header there reads "Files").
 */
export function annotateBundleTargetText(paths: readonly string[]): string {
	return paths.join(", ");
}

/** One bundle file and how many submitted comments were made on it. */
export interface AnnotateBundleDocumentCount {
	path: string;
	annotationCount: number;
}

/**
 * Per-file comment counts for a submitted bundle decision, in bundle order:
 * the `documents` field the host result record and the feedback archive
 * carry. A submitted annotation names its file in `documentPath` (the editor
 * sets it on every comment made on a document other than the session's own,
 * and a bundle has no document of its own); comments without one (the
 * bundle-level notes) count toward no file.
 */
export function annotateBundleDocumentCounts(
	paths: readonly string[],
	annotations: readonly unknown[],
): AnnotateBundleDocumentCount[] {
	const counts = new Map<string, number>();
	for (const annotation of annotations) {
		const documentPath = (annotation as { documentPath?: unknown } | null)?.documentPath;
		if (typeof documentPath !== "string") continue;
		const key = separatorFree(documentPath);
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return paths.map((path) => ({ path, annotationCount: counts.get(separatorFree(path)) ?? 0 }));
}

/**
 * The index of `path` in the bundle, or -1. Paths compare with either
 * separator so a Windows path the server sends matches the one the editor
 * built.
 */
export function annotateBundleIndexOf(files: readonly AnnotateBundleFile[], path: string | null | undefined): number {
	if (!path) return -1;
	const wanted = separatorFree(path);
	return files.findIndex((file) => separatorFree(file.path) === wanted);
}
