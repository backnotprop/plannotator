/**
 * Document resolution and containment for `/api/doc` and `/api/doc/exists`,
 * shared by the Bun and node:http servers.
 *
 * Resolving which file a path names is separated from reading it so
 * authorization sits on one seam: every reachable path comes from
 * `resolveDocTarget`, and `isPathAllowed` alone decides whether it is served.
 * Resolution may `stat`; it never reads contents.
 */

import { realpathSync, statSync } from "fs";
import { basename, dirname, join } from "path";
import { parseCodePath, type ParsedCodePath } from "./code-file";
import {
	getAnnotatableDocRegex,
	isAbsoluteUserPath,
	isAnnotatableTextPath,
	isCodeFilePath,
	isWithinProjectRoot,
	resolveCodeFile,
	resolveMarkdownFile,
	resolveUserPath,
} from "./resolve-file";

/** How a resolved file is rendered: an annotatable document, or a code-file popout. */
export type DocRender = "document" | "code";

export type DocResolution =
	| { kind: "file"; path: string; render: "document" }
	| { kind: "file"; path: string; render: "code"; code: ParsedCodePath }
	// `path` is set when the input named one path that does not exist; it is
	// gated like a found path so an escaping name is denied, not reported absent.
	| { kind: "not_found"; input: string; path?: string }
	| { kind: "ambiguous"; input: string; matches: string[]; render: DocRender }
	| { kind: "unavailable"; input: string };

export interface DocResolveOptions {
	/** Base directory for relative paths, already vetted by `getTrustedBaseDir`. */
	base?: string | null;
	/** `?doc=1`. Renders annotatable plain text for extensions that overlap code files. */
	forceDoc?: boolean;
	roots: string[];
}

export interface DocErrorPayload {
	status: number;
	body: Record<string, unknown>;
}

export const DOC_ACCESS_DENIED: DocErrorPayload = {
	status: 403,
	body: { error: "Access denied: path is outside project root" },
};

export const DOC_TOO_LARGE: DocErrorPayload = {
	status: 413,
	body: { error: "File too large (max 2MB)" },
};

export function getAllowedRootPaths(options?: { rootPath?: string; rootPaths?: string[] }): string[] {
	const rawRoots = options?.rootPaths?.length
		? options.rootPaths
		: [options?.rootPath ?? process.cwd()];
	const roots: string[] = [];
	const addRoot = (root: string) => {
		const resolved = resolveUserPath(root);
		if (!resolved) return;
		if (!roots.includes(resolved)) roots.push(resolved);
		// A root reachable through a symlink contributes both spellings, or a
		// request naming either one fails the half it does not match.
		const real = realpathAllowingMissingLeaf(resolved);
		if (real && !roots.includes(real)) roots.push(real);
	};
	for (const root of rawRoots) {
		if (typeof root !== "string" || root.length === 0) continue;
		addRoot(root);
	}
	if (roots.length === 0) addRoot(process.cwd());
	return roots;
}

/**
 * Realpath the deepest existing ancestor and re-join the rest, so a candidate
 * whose leaf need not exist still resolves through symlinked parents. Any
 * failure other than a missing entry fails closed.
 */
function realpathAllowingMissingLeaf(candidate: string): string | null {
	if (!candidate) return null;
	let current = candidate;
	const missing: string[] = [];
	for (;;) {
		try {
			const real = realpathSync(current);
			return missing.length > 0 ? join(real, ...missing) : real;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return null;
			const parent = dirname(current);
			if (parent === current) return null;
			missing.unshift(basename(current));
			current = parent;
		}
	}
}

/**
 * The containment gate: a path must sit inside an allowed root both as written
 * and after symlink resolution. Lexical containment alone reads a symlink
 * planted under a root through to whatever it points at.
 *
 * Path-based, so it does not survive a local writer swapping the path between
 * this check and the reader's open.
 */
export function isPathAllowed(candidate: string, roots: string[]): boolean {
	if (!candidate) return false;
	if (!roots.some((root) => isWithinProjectRoot(candidate, root))) return false;
	const real = realpathAllowingMissingLeaf(candidate);
	if (!real) return false;
	return roots.some((root) => isWithinProjectRoot(real, root));
}

export function getTrustedBaseDir(base: string | null | undefined, roots: string[]): string | null {
	if (!base) return null;
	const resolvedBase = resolveUserPath(base);
	return isPathAllowed(resolvedBase, roots) ? resolvedBase : null;
}

export type ResolveAllowedDocPathResult =
	| { kind: "resolved"; path: string }
	| { kind: "denied" };

/**
 * Resolve a path through the same gate `/api/doc` uses, for callers needing the
 * canonical contained path without reading the file. The annotate version
 * endpoints derive a history slug from it, since the history dir lookup joins
 * the slug into a path unsanitized.
 */
export function resolveAllowedDocPath(
	requestedPath: string,
	base: string | null,
	options?: { rootPaths?: string[] },
): ResolveAllowedDocPathResult {
	const allowedRoots = getAllowedRootPaths(options);
	const resolvedBase = getTrustedBaseDir(base, allowedRoots);
	const candidate = resolveUserPath(requestedPath, resolvedBase ?? undefined);
	return isPathAllowed(candidate, allowedRoots)
		? { kind: "resolved", path: candidate }
		: { kind: "denied" };
}

export function relativizeToAllowedRoots(path: string, roots: string[]): string {
	for (const root of roots) {
		const prefix = `${root}/`;
		if (path.startsWith(prefix)) return path.slice(prefix.length);
		if (path === root) return ".";
	}
	return path;
}

function isReadableFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

// A symlinked root is searched under both spellings; the same file found twice
// that way is one match, not an ambiguity.
function matchKey(path: string): string {
	if (!isAbsoluteUserPath(path)) return path;
	return realpathAllowingMissingLeaf(path) ?? path;
}

export type RootSearchResult =
	| { kind: "found"; path: string }
	| { kind: "not_found" }
	| { kind: "ambiguous"; matches: string[] }
	| { kind: "unavailable" };

function collectRootSearch(
	found: Map<string, string>,
	ambiguous: Map<string, string>,
	results: readonly { root: string; result: ReturnType<typeof resolveMarkdownFile> }[],
): boolean {
	let unavailable = false;
	for (const { root, result } of results) {
		if (result.kind === "found") {
			if (!isWithinProjectRoot(result.path, root)) continue;
			const key = matchKey(result.path);
			if (!found.has(key)) found.set(key, result.path);
		} else if (result.kind === "ambiguous") {
			for (const match of result.matches) {
				const key = matchKey(match);
				if (!ambiguous.has(key)) ambiguous.set(key, match);
			}
		} else if (result.kind === "unavailable") {
			unavailable = true;
		}
	}
	return unavailable;
}

function summarizeRootSearch(
	found: Map<string, string>,
	ambiguous: Map<string, string>,
	unavailable: boolean,
): RootSearchResult {
	if (found.size === 1) return { kind: "found", path: [...found.values()][0] };
	if (found.size > 1) return { kind: "ambiguous", matches: [...found.values()] };
	if (ambiguous.size > 0) return { kind: "ambiguous", matches: [...ambiguous.values()] };
	if (unavailable) return { kind: "unavailable" };
	return { kind: "not_found" };
}

export async function resolveCodeFileInRoots(
	input: string,
	roots: string[],
	baseDir: string | null,
): Promise<RootSearchResult> {
	const results = await Promise.all(
		roots.map(async (root) => {
			const rootBase = baseDir && isWithinProjectRoot(baseDir, root) ? baseDir : undefined;
			return { root, result: await resolveCodeFile(input, root, rootBase) };
		}),
	);
	const found = new Map<string, string>();
	const ambiguous = new Map<string, string>();
	const unavailable = collectRootSearch(found, ambiguous, results);
	return summarizeRootSearch(found, ambiguous, unavailable);
}

function searchMarkdownFile(input: string, roots: string[]): RootSearchResult {
	const results = roots.map((root) => ({ root, result: resolveMarkdownFile(input, root) }));
	const found = new Map<string, string>();
	const ambiguous = new Map<string, string>();
	const unavailable = collectRootSearch(found, ambiguous, results);
	return summarizeRootSearch(found, ambiguous, unavailable);
}

/** The returned path is not authorized here. */
export async function resolveDocTarget(
	requestedPath: string,
	options: DocResolveOptions,
): Promise<DocResolution> {
	const { roots } = options;
	const base = options.base ?? null;
	const projectRoot = roots[0];
	const docExtensions = getAnnotatableDocRegex();
	const wantsDocRender = (path: string) =>
		docExtensions.test(path) && (options.forceDoc || !isCodeFilePath(path));

	// Relative to the source document's own directory (annotate sibling links).
	if (base && !isAbsoluteUserPath(requestedPath) && wantsDocRender(requestedPath)) {
		const fromBase = resolveUserPath(requestedPath, base);
		// An escaping name means only itself, so it never falls through.
		if (!roots.some((root) => isWithinProjectRoot(fromBase, root))) {
			return { kind: "not_found", input: requestedPath, path: fromBase };
		}
		if (isReadableFile(fromBase)) {
			return { kind: "file", path: fromBase, render: "document" };
		}
	}

	// resolveMarkdownFile only handles plain text, so HTML resolves directly.
	if (/\.html?$/i.test(requestedPath)) {
		const resolvedHtml = resolveUserPath(requestedPath, base || projectRoot);
		return isReadableFile(resolvedHtml)
			? { kind: "file", path: resolvedHtml, render: "document" }
			: { kind: "not_found", input: requestedPath, path: resolvedHtml };
	}

	// Literal path first; on a miss the smart resolver walks the roots for
	// case-insensitive and suffix matches.
	if (isCodeFilePath(requestedPath) && !(options.forceDoc && isAnnotatableTextPath(requestedPath))) {
		const parsed = parseCodePath(requestedPath);
		const cleanPath = parsed.filePath;
		const literalPath = resolveUserPath(cleanPath, base || projectRoot);
		if (roots.some((root) => isWithinProjectRoot(literalPath, root)) && isReadableFile(literalPath)) {
			return { kind: "file", path: literalPath, render: "code", code: parsed };
		}
		if (isAbsoluteUserPath(cleanPath)) {
			const absolutePath = resolveUserPath(cleanPath);
			return isReadableFile(absolutePath)
				? { kind: "file", path: absolutePath, render: "code", code: parsed }
				: { kind: "not_found", input: requestedPath, path: absolutePath };
		}
		const search = await resolveCodeFileInRoots(cleanPath, roots, base);
		if (search.kind === "found") return { kind: "file", path: search.path, render: "code", code: parsed };
		if (search.kind === "ambiguous") {
			return { kind: "ambiguous", input: requestedPath, matches: search.matches, render: "code" };
		}
		if (search.kind === "unavailable") return { kind: "unavailable", input: requestedPath };
		return { kind: "not_found", input: requestedPath };
	}

	// An absolute path names one file, so it skips the fuzzy search.
	if (isAbsoluteUserPath(requestedPath)) {
		const trimmed = requestedPath.trim();
		const absolutePath = resolveUserPath(trimmed);
		return isAnnotatableTextPath(trimmed) && isReadableFile(absolutePath)
			? { kind: "file", path: absolutePath, render: "document" }
			: { kind: "not_found", input: requestedPath, path: absolutePath };
	}

	const search = searchMarkdownFile(requestedPath, roots);
	if (search.kind === "found") return { kind: "file", path: search.path, render: "document" };
	if (search.kind === "ambiguous") {
		return { kind: "ambiguous", input: requestedPath, matches: search.matches, render: "document" };
	}
	if (search.kind === "unavailable") return { kind: "unavailable", input: requestedPath };
	return { kind: "not_found", input: requestedPath };
}

/** The response both transports send for a non-`file` resolution. */
export function docResolutionError(
	resolution: Exclude<DocResolution, { kind: "file" }>,
	roots: string[],
): DocErrorPayload {
	if (resolution.kind === "ambiguous") {
		const matches = resolution.matches.map((match) => relativizeToAllowedRoots(match, roots));
		return resolution.render === "code"
			? { status: 400, body: { error: `Ambiguous path '${resolution.input}'`, matches } }
			: {
					status: 400,
					body: {
						error: `Ambiguous filename '${resolution.input}': found ${resolution.matches.length} matches`,
						matches,
					},
				};
	}
	if (resolution.kind === "unavailable") {
		return {
			status: 503,
			body: { error: `Cannot scan project: ${resolution.input}`, reason: "unavailable" },
		};
	}
	return { status: 404, body: { error: `File not found: ${resolution.input}` } };
}
