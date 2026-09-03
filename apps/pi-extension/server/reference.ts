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

import { json, parseBody } from "./helpers.ts";
import type { IncomingMessage } from "node:http";

import {
	type VaultNode,
	buildFileTree,
	isFileBrowserExcludedPath,
} from "../generated/reference-common.ts";
import {
	filterWorkspaceStatusForDirectory,
	getWorkspaceStatusForDirectory,
	getWorkspaceStatusRelativePaths,
	type WorkspaceFileChange,
} from "../generated/workspace-status.ts";
import { detectObsidianVaults } from "../generated/integrations-common.ts";
import {
	resolveUserPath,
	warmFileListCache,
	getAnnotatableDocRegex,
	MAX_ANNOTATABLE_FILE_BYTES,
	isAnnotatableTextPath,
} from "../generated/resolve-file.ts";
import {
	DOC_ACCESS_DENIED,
	DOC_TOO_LARGE,
	docResolutionError,
	getAllowedRootPaths,
	getTrustedBaseDir,
	isPathAllowed,
	relativizeToAllowedRoots,
	resolveAllowedDocPath,
	resolveCodeFileInRoots,
	resolveDocTarget,
	type DocErrorPayload,
	type ResolveAllowedDocPathResult,
} from "../generated/doc-resolve.ts";
import { parseCodePath, type ParsedCodePath } from "../generated/code-file.ts";
import { htmlToMarkdown } from "../generated/html-to-markdown.ts";
import { disabledSourceSave, type SourceFileSnapshot, type SourceSaveCapability } from "../generated/source-save.ts";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromSnapshot,
	readSourceFileSnapshot,
	resolveExistingSourceSaveFile,
} from "../generated/source-save-node.ts";
import type { AnnotateHistoryResult } from "../generated/annotate-history.ts";
import { preloadFile } from "@pierre/diffs/ssr";

/**
 * Subset of AnnotateHistoryResult the folder /api/doc path actually needs.
 * `diffCurrent` is omitted: it always equals the request's own `content` and
 * the client never reads it off this response (the single-file /api/plan
 * payload still returns the full AnnotateHistoryResult, `diffCurrent`
 * included, for legacy shape parity — see serverAnnotate.ts). Mirrors
 * packages/server/reference-handlers.ts.
 */
export type FolderAnnotateHistory = Omit<AnnotateHistoryResult, "diffCurrent">;

type Res = ServerResponse;

// History eligibility for folder /api/doc documents is `isAnnotatableTextPath`
// (ANNOTATABLE_TEXT_REGEX in @plannotator/core/annotatable) — the exact set the
// single-file pipeline snapshots (.md/.mdx/.txt plus the plain-text config
// formats; no HTML, no .env). Reusing the canonical predicate keeps cross-mode
// slug continuity: a .yaml with single-file history must diff when opened via
// its folder too. Mirrors packages/server/reference-handlers.ts.

export interface HandleDocOptions {
	rewriteHtml?: (html: string, filepath: string) => string;
	sourceSaveFilePath?: string;
	sourceSaveFolderPath?: string;
	onSourceDocumentServed?: (path: string) => void;
	rootPaths?: string[];
	/**
	 * When set, /api/doc runs annotate's per-file version-history pipeline for
	 * eligible markdown-branch documents (local file under an allowed root,
	 * any annotatable plain-text extension per `isAnnotatableTextPath`, not
	 * HTML, not a converted doc, under the annotatable size cap already
	 * enforced above) and merges `previousPlan`/`versionInfo` into the
	 * response — the same field names the single-file /api/plan payload uses
	 * (which additionally returns `diffCurrent`; the folder path omits it
	 * since it always equals the document's own content and the client never
	 * reads it). `compute` is expected to memoize per resolved path itself
	 * (the annotate server keys its cache by path in its own closure); this
	 * module only decides *whether* to call it.
	 */
	annotateHistory?: {
		compute: (resolvedFilePath: string, content: string) => FolderAnnotateHistory | null;
	};
	/**
	 * Single-file rendered-HTML sessions: when /api/doc serves the session's
	 * ROOT document (`path` equals the resolved root path) as raw HTML, merge
	 * the version-diff fields `compute` derives from the bytes just read
	 * (`previousPlan`/`versionInfo`/`diffHtml`, the same names /api/plan
	 * uses) into the response. This is what lets the in-app Refresh keep the
	 * version diff. Every other document is untouched. Mirrors the Bun
	 * handler in packages/server/reference-handlers.ts.
	 */
	rootHtmlVersionDiff?: {
		path: string;
		compute: (currentHtml: string) => Record<string, unknown>;
	};
}

interface HandleDocExistsOptions {
	rootPath?: string;
	rootPaths?: string[];
}

// Re-exported for the annotate version endpoints, which import it from here.
export { resolveAllowedDocPath, type ResolveAllowedDocPathResult };

function sendDocError(res: Res, payload: DocErrorPayload): void {
	json(res, payload.body, payload.status);
}

type DocOptionsResult<T> = T & {
	sourceSave?: SourceSaveCapability;
	previousPlan?: string | null;
	versionInfo?: AnnotateHistoryResult["versionInfo"];
};

function applyDocOptions<T extends Record<string, unknown>>(
	data: T,
	options: HandleDocOptions = {},
	sourceSnapshot?: SourceFileSnapshot,
): DocOptionsResult<T> {
	const next: Record<string, unknown> = { ...data };
	// Root-document version diff (see HandleDocOptions.rootHtmlVersionDiff):
	// computed on the raw bytes, before the asset rewrite below, because the
	// diff renderer rewrites its own output the same way.
	if (
		options.rootHtmlVersionDiff &&
		data.renderAs === "html" &&
		typeof data.rawHtml === "string" &&
		data.filepath === options.rootHtmlVersionDiff.path
	) {
		Object.assign(next, options.rootHtmlVersionDiff.compute(data.rawHtml));
	}
	if (
		typeof next.rawHtml === "string" &&
		typeof next.filepath === "string" &&
		options.rewriteHtml
	) {
		next.rawHtml = options.rewriteHtml(next.rawHtml, next.filepath);
	}
	// Annotate version history (folder mode only — see HandleDocOptions.annotateHistory).
	// Independent of the sourceSave branching below: only markdown-branch
	// documents (not HTML, not converted) with an annotatable plain-text
	// extension are eligible — the same set the single-file pipeline
	// snapshots. The 2MB annotatable-file size cap is already enforced by the
	// caller before any of these responses are built, so no separate check is
	// needed here. Mirrors packages/server/reference-handlers.ts.
	if (
		options.annotateHistory &&
		typeof data.filepath === "string" &&
		data.renderAs === "markdown" &&
		data.isConverted !== true &&
		typeof data.markdown === "string" &&
		isAnnotatableTextPath(data.filepath)
	) {
		const history = options.annotateHistory.compute(data.filepath, data.markdown);
		if (history) {
			next.previousPlan = history.previousPlan;
			next.versionInfo = history.versionInfo;
		}
	}
	if (typeof data.filepath !== "string") {
		return (options.sourceSaveFolderPath || options.sourceSaveFilePath
			? { ...next, sourceSave: disabledSourceSave("not-local-file") }
			: next) as DocOptionsResult<T>;
	}
	if (data.renderAs === "html") {
		return { ...next, sourceSave: disabledSourceSave("html-render") } as DocOptionsResult<T>;
	}
	if (data.isConverted === true) {
		return { ...next, sourceSave: disabledSourceSave("converted-source") } as DocOptionsResult<T>;
	}
	if (options.sourceSaveFilePath) {
		const sourcePath = resolveExistingSourceSaveFile("single-file", options.sourceSaveFilePath);
		const doc = sourceSnapshot
			? createSourceSaveCapabilityFromSnapshot("single-file", data.filepath, sourceSnapshot)
			: createSourceSaveCapability("single-file", data.filepath);
		if (sourcePath && doc.enabled && sourcePath === doc.path) {
			options.onSourceDocumentServed?.(doc.path);
			return { ...next, sourceSave: doc } as DocOptionsResult<T>;
		}
	}
	if (!options.sourceSaveFolderPath) return next as DocOptionsResult<T>;
	const sourceSave = sourceSnapshot
		? createSourceSaveCapabilityFromSnapshot("folder-file", data.filepath, sourceSnapshot, options.sourceSaveFolderPath)
		: createSourceSaveCapability("folder-file", data.filepath, options.sourceSaveFolderPath);
	if (sourceSave.enabled) options.onSourceDocumentServed?.(sourceSave.path);
	return {
		...next,
		sourceSave,
	} as DocOptionsResult<T>;
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

/**
 * Recursively walk a directory collecting files by extension, skipping ignored
 * dirs. The default matcher is resolved per call, not captured at module load:
 * it includes the user's configured extra markdown extensions (#1307).
 */
function walkMarkdownFiles(dir: string, root: string, results: string[], extensions: RegExp = getAnnotatableDocRegex()): void {
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
	return getAnnotatableDocRegex().test(relativePath) && !isFileBrowserExcludedPath(relativePath);
}

/** The render decision is a pure function of resolved path plus `?convert=1`. */
function readDocument(res: Res, path: string, convert: boolean, options: HandleDocOptions): void {
	try {
		if (statSync(path).size > MAX_ANNOTATABLE_FILE_BYTES) {
			sendDocError(res, DOC_TOO_LARGE);
			return;
		}
		const snapshot = readSourceFileSnapshot(path);
		if (/\.html?$/i.test(path)) {
			if (convert) {
				jsonDoc(res, { markdown: htmlToMarkdown(snapshot.text), filepath: path, isConverted: true, renderAs: "markdown" }, options);
			} else {
				jsonDoc(res, { rawHtml: snapshot.text, renderAs: "html", filepath: path }, options);
			}
			return;
		}
		jsonDoc(res, { markdown: snapshot.text, filepath: path, renderAs: "markdown" }, options, undefined, snapshot);
	} catch {
		json(res, { error: "Failed to read file" }, 500);
	}
}

async function readCodeFile(res: Res, path: string, input: string, parsed: ParsedCodePath): Promise<void> {
	try {
		if (statSync(path).size > MAX_ANNOTATABLE_FILE_BYTES) {
			sendDocError(res, DOC_TOO_LARGE);
			return;
		}
		const contents = readFileSync(path, "utf-8");
		const displayName = path.split("/").pop() || path;
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
		json(res, { codeFile: true, contents, filepath: path, prerenderedHTML, line: parsed.line, lineEnd: parsed.lineEnd });
	} catch {
		json(res, { error: `File not found: ${input}` }, 404);
	}
}

/** Uses the shared doc resolver for parity with the Bun server. */
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

	// A base is only honored when it is itself inside an allowed root.
	const resolvedBase = getTrustedBaseDir(url.searchParams.get("base"), allowedRoots);
	const convert = url.searchParams.get("convert") === "1";
	// `?doc=1` (set by the file browser) forces annotatable plain-text rendering
	// for extensions that overlap CODE_FILE_REGEX (.yaml, .json, .toml, .ini,
	// .xml). Without it, those paths keep the syntax-highlighted code-file
	// popout response, so code-file links inside documents are unaffected.
	const forceDoc = url.searchParams.get("doc") === "1";

	const resolution = await resolveDocTarget(requestedPath, {
		base: resolvedBase,
		forceDoc,
		roots: allowedRoots,
	});
	// The one authorization site. A named path is gated whether or not it
	// exists, so an escaping name is denied rather than reported absent.
	const named = resolution.kind === "file" || resolution.kind === "not_found" ? resolution.path : undefined;
	if (named !== undefined && !isPathAllowed(named, allowedRoots)) {
		sendDocError(res, DOC_ACCESS_DENIED);
		return;
	}
	if (resolution.kind !== "file") {
		sendDocError(res, docResolutionError(resolution, allowedRoots));
		return;
	}
	if (resolution.render === "code") {
		await readCodeFile(res, resolution.path, requestedPath, resolution.code);
		return;
	}
	readDocument(res, resolution.path, convert, options);
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
			const r = await resolveCodeFileInRoots(parseCodePath(p).filePath, allowedRoots, baseDir);
			if (r.kind === "found") {
				results[p] = isPathAllowed(r.path, allowedRoots)
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
