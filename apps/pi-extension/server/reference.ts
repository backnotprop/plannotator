/**
 * Document and reference handlers (Node.js equivalents of packages/server/reference-handlers.ts).
 * VaultNode, buildFileTree, walkMarkdownFiles, handleDocRequest,
 * detectObsidianVaults, handleObsidian*, handleFileBrowserRequest
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	type Dirent,
} from "node:fs";
import type { ServerResponse } from "node:http";
import { join, resolve as resolvePath } from "node:path";

import { json, parseBody } from "./helpers";
import type { IncomingMessage } from "node:http";

import {
	type VaultNode,
	buildFileTree,
	isFileBrowserExcludedPath,
} from "../generated/reference-common.js";
import {
	filterWorkspaceStatusForDirectory,
	getWorkspaceStatusForDirectory,
	getWorkspaceStatusRelativePaths,
	type WorkspaceFileChange,
} from "../generated/workspace-status.js";
import { detectObsidianVaults } from "../generated/integrations-common.js";
import {
	isAbsoluteUserPath,
	isCodeFilePath,
	resolveCodeFile,
	resolveMarkdownFile,
	resolveUserPath,
	isWithinProjectRoot,
	warmFileListCache,
	ANNOTATABLE_DOC_REGEX,
	MAX_ANNOTATABLE_FILE_BYTES,
	isAnnotatableTextPath,
} from "../generated/resolve-file.js";
import { parseCodePath } from "../generated/code-file.js";
import { htmlToMarkdown } from "../generated/html-to-markdown.js";
import { disabledSourceSave, type SourceFileSnapshot, type SourceSaveCapability } from "../generated/source-save.js";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromSnapshot,
	readSourceFileSnapshot,
	resolveExistingSourceSaveFile,
} from "../generated/source-save-node.js";
import { preloadFile } from "@pierre/diffs/ssr";

type Res = ServerResponse;

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

function jsonDoc(
	res: Res,
	data: Record<string, unknown>,
	options?: HandleDocOptions,
	status?: number,
	sourceSnapshot?: SourceFileSnapshot,
): void {
	json(res, applyDocOptions(data, options, sourceSnapshot), status);
}

/** Recursively walk a directory collecting files by extension, skipping ignored dirs. */
const FILE_BROWSER_EXTENSIONS = ANNOTATABLE_DOC_REGEX;

function walkMarkdownFiles(dir: string, root: string, results: string[], extensions: RegExp = FILE_BROWSER_EXTENSIONS): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	} catch {
		return;
	}
	for (const entry of entries) {
		const relative = join(dir, entry.name)
			.slice(root.length + 1)
			.replace(/\\/g, "/");
		if (entry.isDirectory()) {
			if (isFileBrowserExcludedPath(relative)) continue;
			walkMarkdownFiles(join(dir, entry.name), root, results, extensions);
		} else if (entry.isFile() && extensions.test(entry.name)) {
			if (isFileBrowserExcludedPath(relative)) continue;
			results.push(relative);
		}
	}
}

function includeWorkspaceFile(relativePath: string, _change: WorkspaceFileChange): boolean {
	return FILE_BROWSER_EXTENSIONS.test(relativePath) && !isFileBrowserExcludedPath(relativePath);
}

/** Serve a linked markdown document. Uses shared resolveMarkdownFile for parity with Bun server. */
export async function handleDocRequest(res: Res, url: URL, options: HandleDocOptions = {}): Promise<void> {
	const requestedPath = url.searchParams.get("path");
	if (!requestedPath) {
		json(res, { error: "Missing path parameter" }, 400);
		return;
	}

	const allowedRoots = getAllowedRootPaths(options);
	// Side-channel: warm the code-file walk so /api/doc/exists POSTs land warm.
	for (const root of allowedRoots) {
		void warmFileListCache(root, "code");
	}

	// Try resolving relative to base directory first (used by annotate mode).
	const base = url.searchParams.get("base");
	const resolvedBase = getTrustedBaseDir(base, allowedRoots);
	const convert = url.searchParams.get("convert") === "1";
	// `?doc=1` (set by the file browser) forces annotatable plain-text rendering
	// for extensions that overlap CODE_FILE_REGEX (.yaml, .json, .toml, .ini,
	// .xml). Without it, those paths keep the syntax-highlighted code-file
	// popout response, so code-file links inside documents are unaffected.
	const forceDoc = url.searchParams.get("doc") === "1";
	const wantsDocRender = (path: string) =>
		ANNOTATABLE_DOC_REGEX.test(path) && (forceDoc || !isCodeFilePath(path));
	if (
		resolvedBase &&
		!isAbsoluteUserPath(requestedPath) &&
		wantsDocRender(requestedPath)
	) {
		const fromBase = resolveUserPath(requestedPath, resolvedBase);
		if (!isWithinAllowedRoots(fromBase, allowedRoots)) {
			json(res, { error: "Access denied: path is outside project root" }, 403);
			return;
		}
		try {
			if (existsSync(fromBase)) {
				if (statSync(fromBase).size > MAX_ANNOTATABLE_FILE_BYTES) {
					json(res, { error: "File too large (max 2MB)" }, 413);
					return;
				}
				const snapshot = readSourceFileSnapshot(fromBase);
				const raw = snapshot.text;
				const isHtml = /\.html?$/i.test(requestedPath);
				if (isHtml && !convert) {
					jsonDoc(res, { rawHtml: raw, renderAs: "html", filepath: fromBase }, options);
					return;
				}
				const markdown = isHtml ? htmlToMarkdown(raw) : raw;
				jsonDoc(
					res,
					{ markdown, filepath: fromBase, isConverted: isHtml, renderAs: "markdown" },
					options,
					undefined,
					isHtml ? undefined : snapshot,
				);
				return;
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
			json(res, { error: "Access denied: path is outside project root" }, 403);
			return;
		}
		try {
			if (existsSync(resolvedHtml)) {
				const html = readFileSync(resolvedHtml, "utf-8");
				if (!convert) {
					jsonDoc(res, { rawHtml: html, renderAs: "html", filepath: resolvedHtml }, options);
					return;
				}
				jsonDoc(res, { markdown: htmlToMarkdown(html), filepath: resolvedHtml, isConverted: true, renderAs: "markdown" }, options);
				return;
			}
		} catch { /* fall through to 404 */ }
		json(res, { error: `File not found: ${requestedPath}` }, 404);
		return;
	}

	// Code files: try literal resolve first; on miss, fall back to smart resolver.
	// Skipped when the client asked for doc rendering (`?doc=1`) on an
	// annotatable plain-text path — those fall through to the markdown
	// resolution below and render like .txt.
	if (isCodeFilePath(requestedPath) && !(forceDoc && isAnnotatableTextPath(requestedPath))) {
		const parsed = parseCodePath(requestedPath);
		const cleanPath = parsed.filePath;
		const literalPath = resolveUserPath(cleanPath, resolvedBase || projectRoot);
		const literalAllowed = isWithinAllowedRoots(literalPath, allowedRoots);

		let resolvedCode: string | null = null;
		if (literalAllowed && existsSync(literalPath)) {
			resolvedCode = literalPath;
		}

		if (!resolvedCode) {
			if (isAbsoluteUserPath(cleanPath) && !isWithinAllowedRoots(resolveUserPath(cleanPath), allowedRoots)) {
				json(res, { error: "Access denied: path is outside project root" }, 403);
				return;
			}
			const result = await resolveCodeFileFromAllowedRoots(cleanPath, allowedRoots, resolvedBase);
			if (result.kind === "found") {
				resolvedCode = result.path;
			} else if (result.kind === "ambiguous") {
				const relative = result.matches.map((m: string) => relativizeToAllowedRoots(m, allowedRoots));
				json(res, { error: `Ambiguous path '${requestedPath}'`, matches: relative }, 400);
				return;
			} else if (result.kind === "unavailable") {
				json(res, { error: `Cannot scan project: ${requestedPath}`, reason: "unavailable" }, 503);
				return;
			} else {
				json(res, { error: `File not found: ${requestedPath}` }, 404);
				return;
			}
			if (!isWithinAllowedRoots(resolvedCode, allowedRoots)) {
				json(res, { error: "Access denied: path is outside project root" }, 403);
				return;
			}
		}

		try {
			const stat = statSync(resolvedCode);
			if (stat.size > MAX_ANNOTATABLE_FILE_BYTES) {
				json(res, { error: "File too large (max 2MB)" }, 413);
				return;
			}
			const contents = readFileSync(resolvedCode, "utf-8");
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
			json(res, { codeFile: true, contents, filepath: resolvedCode, prerenderedHTML, line: parsed.line, lineEnd: parsed.lineEnd });
			return;
		} catch {
			json(res, { error: `File not found: ${requestedPath}` }, 404);
			return;
		}
	}

	if (isAbsoluteUserPath(requestedPath) && !isWithinAllowedRoots(resolveUserPath(requestedPath), allowedRoots)) {
		json(res, { error: "Access denied: path is outside project root" }, 403);
		return;
	}
	const result = resolveMarkdownFileFromAllowedRoots(requestedPath, allowedRoots);

	if (result.kind === "ambiguous") {
		json(
			res,
			{
				error: `Ambiguous filename '${result.input}': found ${result.matches.length} matches`,
				matches: result.matches.map((m: string) => relativizeToAllowedRoots(m, allowedRoots)),
			},
			400,
		);
		return;
	}

	if (result.kind === "unavailable") {
		json(res, { error: `Cannot scan project: ${result.input}`, reason: "unavailable" }, 503);
		return;
	}

	if (result.kind === "not_found") {
		json(res, { error: `File not found: ${result.input}` }, 404);
		return;
	}

	try {
		if (statSync(result.path).size > MAX_ANNOTATABLE_FILE_BYTES) {
			json(res, { error: "File too large (max 2MB)" }, 413);
			return;
		}
		const snapshot = readSourceFileSnapshot(result.path);
		jsonDoc(res, { markdown: snapshot.text, filepath: result.path, renderAs: "markdown" }, options, undefined, snapshot);
	} catch {
		json(res, { error: "Failed to read file" }, 500);
	}
}

/**
 * Batch existence check for code-file paths the renderer wants to linkify.
 * POST /api/doc/exists with { paths: string[] }.
 */
export async function handleDocExistsRequest(res: Res, req: IncomingMessage, options?: HandleDocExistsOptions): Promise<void> {
	const body = await parseBody(req);
	const paths = (body as { paths?: unknown }).paths;
	if (!Array.isArray(paths) || !paths.every((p) => typeof p === "string")) {
		json(res, { error: "Expected { paths: string[] }" }, 400);
		return;
	}
	if (paths.length > 500) {
		json(res, { error: "Too many paths (max 500)" }, 400);
		return;
	}
	const allowedRoots = getAllowedRootPaths(options);
	const baseRaw = (body as { base?: unknown }).base;
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
					matches: r.matches.map((m: string) => relativizeToAllowedRoots(m, allowedRoots)),
				};
			} else if (r.kind === "unavailable") {
				results[p] = { status: "unavailable" };
			} else {
				results[p] = { status: "missing" };
			}
		}),
	);

	json(res, { results });
}

export function handleObsidianVaultsRequest(res: Res): void {
	json(res, { vaults: detectObsidianVaults() });
}

export function handleObsidianFilesRequest(res: Res, url: URL): void {
	const vaultPath = url.searchParams.get("vaultPath");
	if (!vaultPath) {
		json(res, { error: "Missing vaultPath parameter" }, 400);
		return;
	}
	const resolvedVault = resolveUserPath(vaultPath);
	if (!existsSync(resolvedVault) || !statSync(resolvedVault).isDirectory()) {
		json(res, { error: "Invalid vault path" }, 400);
		return;
	}
	try {
		const files: string[] = [];
		walkMarkdownFiles(resolvedVault, resolvedVault, files, /\.mdx?$/i);
		files.sort();
		json(res, { tree: buildFileTree(files) });
	} catch {
		json(res, { error: "Failed to list vault files" }, 500);
	}
}

export function handleObsidianDocRequest(res: Res, url: URL): void {
	const vaultPath = url.searchParams.get("vaultPath");
	const filePath = url.searchParams.get("path");
	if (!vaultPath || !filePath) {
		json(res, { error: "Missing vaultPath or path parameter" }, 400);
		return;
	}
	if (!/\.mdx?$/i.test(filePath)) {
		json(res, { error: "Only markdown files are supported" }, 400);
		return;
	}
	const resolvedVault = resolveUserPath(vaultPath);
	let resolvedFile = resolvePath(resolvedVault, filePath);

	// Bare filename search within vault
	if (!existsSync(resolvedFile) && !filePath.includes("/")) {
		const files: string[] = [];
		walkMarkdownFiles(resolvedVault, resolvedVault, files, /\.mdx?$/i);
		const matches = files.filter(
			(f) => f.split("/").pop()!.toLowerCase() === filePath.toLowerCase(),
		);
		if (matches.length === 1) {
			resolvedFile = resolvePath(resolvedVault, matches[0]);
		} else if (matches.length > 1) {
			json(
				res,
				{
					error: `Ambiguous filename '${filePath}': found ${matches.length} matches`,
					matches,
				},
				400,
			);
			return;
		}
	}

	// Security: must be within vault
	if (
		!resolvedFile.startsWith(resolvedVault + "/") &&
		resolvedFile !== resolvedVault
	) {
		json(res, { error: "Access denied: path is outside vault" }, 403);
		return;
	}

	if (!existsSync(resolvedFile)) {
		json(res, { error: `File not found: ${filePath}` }, 404);
		return;
	}
	try {
		const markdown = readFileSync(resolvedFile, "utf-8");
		json(res, { markdown, filepath: resolvedFile });
	} catch {
		json(res, { error: "Failed to read file" }, 500);
	}
}

export async function handleFileBrowserRequest(res: Res, url: URL): Promise<void> {
	const dirPath = url.searchParams.get("dirPath");
	if (!dirPath) {
		json(res, { error: "Missing dirPath parameter" }, 400);
		return;
	}
	const resolvedDir = resolveUserPath(dirPath);
	if (!existsSync(resolvedDir) || !statSync(resolvedDir).isDirectory()) {
		json(res, { error: "Invalid directory path" }, 400);
		return;
	}
	try {
		const files = new Set<string>();
		const diskFiles: string[] = [];
		walkMarkdownFiles(resolvedDir, resolvedDir, diskFiles);
		for (const file of diskFiles) files.add(file);
		const workspaceStatus = filterWorkspaceStatusForDirectory(await getWorkspaceStatusForDirectory(resolvedDir), resolvedDir, includeWorkspaceFile);
		for (const file of getWorkspaceStatusRelativePaths(workspaceStatus, resolvedDir, includeWorkspaceFile)) {
			files.add(file);
		}
		json(res, { tree: buildFileTree([...files].sort()), workspaceStatus });
	} catch {
		json(res, { error: "Failed to list directory files" }, 500);
	}
}
