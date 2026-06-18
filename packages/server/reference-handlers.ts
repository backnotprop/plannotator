/**
 * Reference/document route handlers for the plan server.
 *
 * Handles /api/doc, /api/obsidian/vaults, /api/reference/obsidian/files,
 * /api/reference/obsidian/doc, and /api/reference/files. Extracted from index.ts for modularity.
 */

import { existsSync, statSync } from "fs";
import { readdir } from "fs/promises";
import { join, relative, resolve } from "path";
import { buildFileTree, isFileBrowserExcludedPath } from "@plannotator/shared/reference-common";
import {
	filterWorkspaceStatusForDirectory,
	getWorkspaceStatusForDirectory,
	getWorkspaceStatusRelativePaths,
	type WorkspaceFileChange,
} from "@plannotator/shared/workspace-status";
import { parseCodePath } from "@plannotator/shared/code-file";
import { detectObsidianVaults } from "./integrations";
import {
	isAbsoluteUserPath,
	isCodeFilePath,
	resolveCodeFile,
	resolveMarkdownFile,
	resolveUserPath,
	isWithinProjectRoot,
	warmFileListCache,
} from "@plannotator/shared/resolve-file";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { disabledSourceSave, type SourceFileSnapshot, type SourceSaveCapability } from "@plannotator/shared/source-save";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromSnapshot,
	readSourceFileSnapshot,
	resolveExistingSourceSaveFile,
} from "@plannotator/shared/source-save-node";
import { preloadFile } from "@pierre/diffs/ssr";

// --- Route handlers ---

export interface HandleDocOptions {
	rewriteHtml?: (html: string, filepath: string) => string;
	sourceSaveFilePath?: string;
	sourceSaveFolderPath?: string;
	onSourceDocumentServed?: (path: string) => void;
	rootPaths?: string[];
}

interface HandleDocExistsOptions {
	rootPath?: string;
	rootPaths?: string[];
}

type RouteResolveResult =
	| { kind: "found"; path: string }
	| { kind: "not_found"; input: string }
	| { kind: "ambiguous"; input: string; matches: string[] }
	| { kind: "unavailable"; input: string };

function getAllowedRootPaths(options?: { rootPath?: string; rootPaths?: string[] }): string[] {
	const rawRoots = options?.rootPaths?.length
		? options.rootPaths
		: [options?.rootPath ?? process.cwd()];
	const roots: string[] = [];
	for (const root of rawRoots) {
		if (typeof root !== "string" || root.length === 0) continue;
		const resolved = resolveUserPath(root);
		if (!roots.includes(resolved)) roots.push(resolved);
	}
	return roots.length > 0 ? roots : [resolveUserPath(process.cwd())];
}

function isWithinAllowedRoots(candidate: string, roots: string[]): boolean {
	return roots.some((root) => isWithinProjectRoot(candidate, root));
}

function getTrustedBaseDir(base: string | null, roots: string[]): string | null {
	if (!base) return null;
	const resolvedBase = resolveUserPath(base);
	return isWithinAllowedRoots(resolvedBase, roots) ? resolvedBase : null;
}

function relativizeToAllowedRoots(path: string, roots: string[]): string {
	for (const root of roots) {
		const prefix = `${root}/`;
		if (path.startsWith(prefix)) return path.slice(prefix.length);
		if (path === root) return ".";
	}
	return path;
}

async function resolveCodeFileFromAllowedRoots(
	input: string,
	roots: string[],
	baseDir: string | null,
): Promise<RouteResolveResult> {
	const found = new Set<string>();
	const ambiguous = new Set<string>();
	let unavailable = false;

	for (const root of roots) {
		const rootBase = baseDir && isWithinProjectRoot(baseDir, root) ? baseDir : undefined;
		const result = await resolveCodeFile(input, root, rootBase);
		if (result.kind === "found") {
			if (isWithinProjectRoot(result.path, root)) found.add(result.path);
		} else if (result.kind === "ambiguous") {
			for (const match of result.matches) {
				ambiguous.add(match);
			}
		} else if (result.kind === "unavailable") {
			unavailable = true;
		}
	}

	if (found.size === 1) return { kind: "found", path: [...found][0] };
	if (found.size > 1) return { kind: "ambiguous", input, matches: [...found] };
	if (ambiguous.size > 0) return { kind: "ambiguous", input, matches: [...ambiguous] };
	if (unavailable) return { kind: "unavailable", input };
	return { kind: "not_found", input };
}

function resolveMarkdownFileFromAllowedRoots(input: string, roots: string[]): RouteResolveResult {
	const found = new Set<string>();
	const ambiguous = new Set<string>();
	let unavailable = false;

	for (const root of roots) {
		const result = resolveMarkdownFile(input, root);
		if (result.kind === "found") {
			if (isWithinProjectRoot(result.path, root)) found.add(result.path);
		} else if (result.kind === "ambiguous") {
			for (const match of result.matches) {
				ambiguous.add(match);
			}
		} else if (result.kind === "unavailable") {
			unavailable = true;
		}
	}

	if (found.size === 1) return { kind: "found", path: [...found][0] };
	if (found.size > 1) return { kind: "ambiguous", input, matches: [...found] };
	if (ambiguous.size > 0) return { kind: "ambiguous", input, matches: [...ambiguous] };
	if (unavailable) return { kind: "unavailable", input };
	return { kind: "not_found", input };
}

function applyDocOptions<T extends Record<string, unknown>>(
	data: T,
	options: HandleDocOptions = {},
	sourceSnapshot?: SourceFileSnapshot,
): T & { sourceSave?: SourceSaveCapability } {
	const next: Record<string, unknown> = { ...data };
	if (
		typeof next.rawHtml === "string" &&
		typeof next.filepath === "string" &&
		options.rewriteHtml
	) {
		next.rawHtml = options.rewriteHtml(next.rawHtml, next.filepath);
	}
	if (typeof data.filepath !== "string") {
		return options.sourceSaveFolderPath || options.sourceSaveFilePath
			? { ...next, sourceSave: disabledSourceSave("not-local-file") } as T & { sourceSave?: SourceSaveCapability }
			: next as T & { sourceSave?: SourceSaveCapability };
	}
	if (data.renderAs === "html") {
		return { ...next, sourceSave: disabledSourceSave("html-render") } as T & { sourceSave?: SourceSaveCapability };
	}
	if (data.isConverted === true) {
		return { ...next, sourceSave: disabledSourceSave("converted-source") } as T & { sourceSave?: SourceSaveCapability };
	}
	if (options.sourceSaveFilePath) {
		const sourcePath = resolveExistingSourceSaveFile("single-file", options.sourceSaveFilePath);
		const doc = sourceSnapshot
			? createSourceSaveCapabilityFromSnapshot("single-file", data.filepath, sourceSnapshot)
			: createSourceSaveCapability("single-file", data.filepath);
		if (sourcePath && doc.enabled && sourcePath === doc.path) {
			options.onSourceDocumentServed?.(doc.path);
			return { ...next, sourceSave: doc } as T & { sourceSave?: SourceSaveCapability };
		}
	}
	if (!options.sourceSaveFolderPath) return next as T & { sourceSave?: SourceSaveCapability };
	const sourceSave = sourceSnapshot
		? createSourceSaveCapabilityFromSnapshot("folder-file", data.filepath, sourceSnapshot, options.sourceSaveFolderPath)
		: createSourceSaveCapability("folder-file", data.filepath, options.sourceSaveFolderPath);
	if (sourceSave.enabled) options.onSourceDocumentServed?.(sourceSave.path);
	return {
		...next,
		sourceSave,
	} as T & { sourceSave?: SourceSaveCapability };
}

function docJson(data: Record<string, unknown>, options?: HandleDocOptions, sourceSnapshot?: SourceFileSnapshot): Response {
	return Response.json(applyDocOptions(data, options, sourceSnapshot));
}

/** Serve a linked markdown document. Resolves absolute, relative, or bare filename paths. */
export async function handleDoc(req: Request, options: HandleDocOptions = {}): Promise<Response> {
	const url = new URL(req.url);
	const requestedPath = url.searchParams.get("path");
	if (!requestedPath) {
		return Response.json({ error: "Missing path parameter" }, { status: 400 });
	}

	const allowedRoots = getAllowedRootPaths(options);
	// Side-channel: kick off a code-file walk for the project root so that any
	// /api/doc/exists POST issued by the rendered linked-doc lands on warm cache.
	for (const root of allowedRoots) {
		void warmFileListCache(root, "code");
	}

	// If a base directory is provided, try resolving relative to it first
	// (used by annotate mode to resolve paths relative to the source file).
	const base = url.searchParams.get("base");
	const resolvedBase = getTrustedBaseDir(base, allowedRoots);
	// HTML renders raw by default; `?convert=1` (set by the frontend when the session's
	// --markdown preference is on) forces Turndown conversion instead.
	const convert = url.searchParams.get("convert") === "1";
	if (
		resolvedBase &&
		!isAbsoluteUserPath(requestedPath) &&
		/\.(mdx?|txt|html?)$/i.test(requestedPath)
	) {
		const fromBase = resolveUserPath(requestedPath, resolvedBase);
		if (!isWithinAllowedRoots(fromBase, allowedRoots)) {
			return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
		}
		try {
			const file = Bun.file(fromBase);
			if (await file.exists()) {
				const snapshot = readSourceFileSnapshot(fromBase);
				const raw = snapshot.text;
				const isHtml = /\.html?$/i.test(requestedPath);
				if (isHtml && !convert) {
					return docJson({ rawHtml: raw, renderAs: "html", filepath: fromBase }, options);
				}
				const markdown = isHtml ? htmlToMarkdown(raw) : raw;
				return docJson(
					{ markdown, filepath: fromBase, isConverted: isHtml, renderAs: "markdown" },
					options,
					isHtml ? undefined : snapshot,
				);
			}
		} catch {
			/* fall through to standard resolution */
		}
	}

	// HTML files: resolve directly (not via resolveMarkdownFile which only handles .md/.mdx)
	const projectRoot = allowedRoots[0];
	if (/\.html?$/i.test(requestedPath)) {
		const resolvedHtml = resolveUserPath(requestedPath, resolvedBase || projectRoot);
		if (!isWithinAllowedRoots(resolvedHtml, allowedRoots)) {
			return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
		}
		try {
			const file = Bun.file(resolvedHtml);
			if (await file.exists()) {
				const html = await file.text();
				if (!convert) {
					return docJson({ rawHtml: html, renderAs: "html", filepath: resolvedHtml }, options);
				}
				const markdown = htmlToMarkdown(html);
				return docJson({ markdown, filepath: resolvedHtml, isConverted: true, renderAs: "markdown" }, options);
			}
		} catch { /* fall through */ }
		return Response.json({ error: `File not found: ${requestedPath}` }, { status: 404 });
	}

	// Code files: try literal resolve first; on miss, fall back to the smart
	// resolver which walks the project for case-insensitive / suffix matches.
	if (isCodeFilePath(requestedPath)) {
		const parsed = parseCodePath(requestedPath);
		const cleanPath = parsed.filePath;
		const literalPath = resolveUserPath(cleanPath, resolvedBase || projectRoot);
		const literalAllowed = isWithinAllowedRoots(literalPath, allowedRoots);

		let resolvedCode: string | null = null;
		if (literalAllowed) {
			try {
				const file = Bun.file(literalPath);
				if (await file.exists()) resolvedCode = literalPath;
			} catch { /* fall through */ }
		}

		if (!resolvedCode) {
			if (isAbsoluteUserPath(cleanPath) && !isWithinAllowedRoots(resolveUserPath(cleanPath), allowedRoots)) {
				return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
			}
			const result = await resolveCodeFileFromAllowedRoots(cleanPath, allowedRoots, resolvedBase);
			if (result.kind === "found") {
				resolvedCode = result.path;
			} else if (result.kind === "ambiguous") {
				const relative = result.matches.map((m) => relativizeToAllowedRoots(m, allowedRoots));
				return Response.json(
					{ error: `Ambiguous path '${requestedPath}'`, matches: relative },
					{ status: 400 },
				);
			} else if (result.kind === "unavailable") {
				return Response.json({ error: `Cannot scan project: ${requestedPath}`, reason: "unavailable" }, { status: 503 });
			} else {
				return Response.json({ error: `File not found: ${requestedPath}` }, { status: 404 });
			}
			if (!isWithinAllowedRoots(resolvedCode, allowedRoots)) {
				return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
			}
		}

		try {
			const file = Bun.file(resolvedCode);
			if (file.size > 2 * 1024 * 1024) {
				return Response.json({ error: "File too large (max 2MB)" }, { status: 413 });
			}
			const contents = await file.text();
			const displayName = resolvedCode.split("/").pop() || resolvedCode;
			let prerenderedHTML: string | undefined;
			try {
				const result = await preloadFile({
					file: { name: displayName, contents },
					options: { disableFileHeader: true },
				});
				prerenderedHTML = result.prerenderedHTML;
			} catch {
				// Fall back to client-side rendering
			}
			return Response.json({ codeFile: true, contents, filepath: resolvedCode, prerenderedHTML, line: parsed.line, lineEnd: parsed.lineEnd });
		} catch {
			return Response.json({ error: `File not found: ${requestedPath}` }, { status: 404 });
		}
	}

	if (isAbsoluteUserPath(requestedPath) && !isWithinAllowedRoots(resolveUserPath(requestedPath), allowedRoots)) {
		return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
	}
	const result = resolveMarkdownFileFromAllowedRoots(requestedPath, allowedRoots);

	if (result.kind === "ambiguous") {
		return Response.json(
			{
				error: `Ambiguous filename '${result.input}': found ${result.matches.length} matches`,
				matches: result.matches.map((m) => relativizeToAllowedRoots(m, allowedRoots)),
			},
			{ status: 400 },
		);
	}

	if (result.kind === "unavailable") {
		return Response.json(
			{ error: `Cannot scan project: ${result.input}`, reason: "unavailable" },
			{ status: 503 },
		);
	}

	if (result.kind === "not_found") {
		return Response.json(
			{ error: `File not found: ${result.input}` },
			{ status: 404 },
		);
	}

	try {
		const snapshot = readSourceFileSnapshot(result.path);
		return docJson({ markdown: snapshot.text, filepath: result.path, renderAs: "markdown" }, options, snapshot);
	} catch {
		return Response.json({ error: "Failed to read file" }, { status: 500 });
	}
}

/**
 * Batch existence check for code-file paths the renderer wants to linkify.
 * POST /api/doc/exists with { paths: string[] } returns { results: { [path]: ValidationEntry } }.
 * Reads from the warm file-list cache populated at plan/annotate load.
 */
export async function handleDocExists(req: Request, options?: HandleDocExistsOptions): Promise<Response> {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const paths = (body as { paths?: unknown })?.paths;
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
		return Response.json({ error: "Expected { paths: string[] }" }, { status: 400 });
	}
	if (paths.length > 500) {
		return Response.json({ error: "Too many paths (max 500)" }, { status: 400 });
	}
	const allowedRoots = getAllowedRootPaths(options);
	const baseRaw = (body as { base?: unknown })?.base;
	const baseDir = typeof baseRaw === "string" && baseRaw.length > 0
		? getTrustedBaseDir(baseRaw, allowedRoots)
		: null;
	const results: Record<
		string,
		| { status: "found"; resolved: string }
		| { status: "ambiguous"; matches: string[] }
		| { status: "missing" }
		| { status: "unavailable" }
	> = {};

	await Promise.all(
		(paths as string[]).map(async (p) => {
			const cleanP = parseCodePath(p).filePath;
			if (isAbsoluteUserPath(cleanP) && !isWithinAllowedRoots(resolveUserPath(cleanP), allowedRoots)) {
				results[p] = { status: "missing" };
				return;
			}
			const r = await resolveCodeFileFromAllowedRoots(cleanP, allowedRoots, baseDir);
			if (r.kind === "found") {
				results[p] = isWithinAllowedRoots(r.path, allowedRoots)
					? { status: "found", resolved: r.path }
					: { status: "missing" };
			} else if (r.kind === "ambiguous") {
				results[p] = {
					status: "ambiguous",
					matches: r.matches.map((m) => relativizeToAllowedRoots(m, allowedRoots)),
				};
			} else if (r.kind === "unavailable") {
				results[p] = { status: "unavailable" };
			} else {
				results[p] = { status: "missing" };
			}
		}),
	);

	return Response.json({ results });
}

/** Detect available Obsidian vaults. */
export function handleObsidianVaults(): Response {
	const vaults = detectObsidianVaults();
	return Response.json({ vaults });
}

/** List Obsidian vault files as a nested tree. */
export async function handleObsidianFiles(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const vaultPath = url.searchParams.get("vaultPath");
	if (!vaultPath) {
		return Response.json(
			{ error: "Missing vaultPath parameter" },
			{ status: 400 },
		);
	}

	const resolvedVault = resolveUserPath(vaultPath);
	if (!existsSync(resolvedVault) || !statSync(resolvedVault).isDirectory()) {
		return Response.json({ error: "Invalid vault path" }, { status: 400 });
	}

	try {
		const glob = new Bun.Glob("**/*.{md,mdx}");
		const files: string[] = [];
		for await (const match of glob.scan({
			cwd: resolvedVault,
			onlyFiles: true,
		})) {
			if (match.includes(".obsidian/") || match.includes(".trash/")) continue;
			files.push(match);
		}
		files.sort();

		const tree = buildFileTree(files);
		return Response.json({ tree });
	} catch {
		return Response.json(
			{ error: "Failed to list vault files" },
			{ status: 500 },
		);
	}
}

/** Read an Obsidian vault document. Supports direct path and bare filename search. */
export async function handleObsidianDoc(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const vaultPath = url.searchParams.get("vaultPath");
	const filePath = url.searchParams.get("path");
	if (!vaultPath || !filePath) {
		return Response.json(
			{ error: "Missing vaultPath or path parameter" },
			{ status: 400 },
		);
	}
	if (!/\.mdx?$/i.test(filePath)) {
		return Response.json(
			{ error: "Only markdown files are supported" },
			{ status: 400 },
		);
	}

	const resolvedVault = resolveUserPath(vaultPath);
	let resolvedFile = resolve(resolvedVault, filePath);

	// If direct path doesn't exist and it's a bare filename, search the vault
	if (!existsSync(resolvedFile) && !filePath.includes("/")) {
		const glob = new Bun.Glob(`**/${filePath}`);
		const matches: string[] = [];
		for await (const match of glob.scan({
			cwd: resolvedVault,
			onlyFiles: true,
		})) {
			if (match.includes(".obsidian/") || match.includes(".trash/")) continue;
			matches.push(resolve(resolvedVault, match));
		}
		if (matches.length === 1) {
			resolvedFile = matches[0];
		} else if (matches.length > 1) {
			const relativePaths = matches.map((m) =>
				m.replace(resolvedVault + "/", ""),
			);
			return Response.json(
				{
					error: `Ambiguous filename '${filePath}': found ${matches.length} matches`,
					matches: relativePaths,
				},
				{ status: 400 },
			);
		}
	}

	// Security: must be within vault
	if (!resolvedFile.startsWith(resolvedVault + "/")) {
		return Response.json(
			{ error: "Access denied: path is outside vault" },
			{ status: 403 },
		);
	}

	try {
		const file = Bun.file(resolvedFile);
		if (!(await file.exists())) {
			return Response.json(
				{ error: `File not found: ${filePath}` },
				{ status: 404 },
			);
		}
		const markdown = await file.text();
		return Response.json({ markdown, filepath: resolvedFile });
	} catch {
		return Response.json({ error: "Failed to read file" }, { status: 500 });
	}
}

// --- File Browser ---

const FILE_BROWSER_EXTENSIONS = /\.(mdx?|txt|html?)$/i;

function includeWorkspaceFile(relativePath: string, _change: WorkspaceFileChange): boolean {
	return FILE_BROWSER_EXTENSIONS.test(relativePath) && !isFileBrowserExcludedPath(relativePath);
}

async function walkFileBrowserFiles(dir: string, root: string, files: Set<string>): Promise<void> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		const fullPath = join(dir, entry.name);
		const relativePath = relative(root, fullPath).replace(/\\/g, "/");
		if (entry.isDirectory()) {
			if (isFileBrowserExcludedPath(relativePath)) continue;
			await walkFileBrowserFiles(fullPath, root, files);
		} else if (entry.isFile() && FILE_BROWSER_EXTENSIONS.test(entry.name)) {
			if (isFileBrowserExcludedPath(relativePath)) continue;
			files.add(relativePath);
		}
	}
}

/** List markdown files in a directory as a nested tree. */
export async function handleFileBrowserFiles(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const dirPath = url.searchParams.get("dirPath");
	if (!dirPath) {
		return Response.json(
			{ error: "Missing dirPath parameter" },
			{ status: 400 },
		);
	}

	const resolvedDir = resolveUserPath(dirPath);
	if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
		return Response.json({ error: "Invalid directory path" }, { status: 400 });
	}

	try {
		const files = new Set<string>();
		await walkFileBrowserFiles(resolvedDir, resolvedDir, files);
		const workspaceStatus = filterWorkspaceStatusForDirectory(await getWorkspaceStatusForDirectory(resolvedDir), resolvedDir, includeWorkspaceFile);
		for (const match of getWorkspaceStatusRelativePaths(workspaceStatus, resolvedDir, includeWorkspaceFile)) {
			files.add(match);
		}
		const sortedFiles = [...files].sort();

		const tree = buildFileTree(sortedFiles);
		return Response.json({ tree, workspaceStatus });
	} catch {
		return Response.json(
			{ error: "Failed to list directory files" },
			{ status: 500 },
		);
	}
}
