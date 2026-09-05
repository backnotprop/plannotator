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
import { parseCodePath, type ParsedCodePath } from "@plannotator/shared/code-file";
import { detectObsidianVaults } from "./integrations";
import {
	resolveUserPath,
	getFileBrowserMaxFiles,
	warmFileListCache,
	getAnnotatableDocRegex,
	MAX_ANNOTATABLE_FILE_BYTES,
	isAnnotatableTextPath,
} from "@plannotator/shared/resolve-file";
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
} from "@plannotator/shared/doc-resolve";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";
import { disabledSourceSave, type SourceFileSnapshot, type SourceSaveCapability } from "@plannotator/shared/source-save";
import {
	createSourceSaveCapability,
	createSourceSaveCapabilityFromSnapshot,
	readSourceFileSnapshot,
	resolveExistingSourceSaveFile,
} from "@plannotator/shared/source-save-node";
import type { AnnotateHistoryResult } from "@plannotator/shared/annotate-history";
import { preloadFile } from "@pierre/diffs/ssr";

/**
 * Subset of AnnotateHistoryResult the folder /api/doc path actually needs.
 * `diffCurrent` is omitted: it always equals the request's own `content` and
 * the client never reads it off this response (the single-file /api/plan
 * payload still returns the full AnnotateHistoryResult, `diffCurrent`
 * included, for legacy shape parity — see annotate.ts).
 */
export type FolderAnnotateHistory = Omit<AnnotateHistoryResult, "diffCurrent">;

// --- Route handlers ---

// History eligibility for folder /api/doc documents is `isAnnotatableTextPath`
// (ANNOTATABLE_TEXT_REGEX in @plannotator/core/annotatable) — the exact set the
// single-file pipeline snapshots (.md/.mdx/.txt plus the plain-text config
// formats; no HTML, no .env). Reusing the canonical predicate keeps cross-mode
// slug continuity: a .yaml with single-file history must diff when opened via
// its folder too.

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
	 * version diff. Every other document is untouched.
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

function errorResponse(payload: DocErrorPayload): Response {
	return Response.json(payload.body, { status: payload.status });
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
	// needed here.
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

function docJson(data: Record<string, unknown>, options?: HandleDocOptions, sourceSnapshot?: SourceFileSnapshot): Response {
	return Response.json(applyDocOptions(data, options, sourceSnapshot));
}

/** The render decision is a pure function of resolved path plus `?convert=1`. */
async function readDocument(path: string, convert: boolean, options: HandleDocOptions): Promise<Response> {
	if (Bun.file(path).size > MAX_ANNOTATABLE_FILE_BYTES) {
		return errorResponse(DOC_TOO_LARGE);
	}
	try {
		const snapshot = readSourceFileSnapshot(path);
		if (/\.html?$/i.test(path)) {
			return convert
				? docJson({ markdown: htmlToMarkdown(snapshot.text), filepath: path, isConverted: true, renderAs: "markdown" }, options)
				: docJson({ rawHtml: snapshot.text, renderAs: "html", filepath: path }, options);
		}
		return docJson({ markdown: snapshot.text, filepath: path, renderAs: "markdown" }, options, snapshot);
	} catch {
		return Response.json({ error: "Failed to read file" }, { status: 500 });
	}
}

async function readCodeFile(path: string, input: string, parsed: ParsedCodePath): Promise<Response> {
	try {
		const file = Bun.file(path);
		if (file.size > MAX_ANNOTATABLE_FILE_BYTES) {
			return errorResponse(DOC_TOO_LARGE);
		}
		const contents = await file.text();
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
		return Response.json({ codeFile: true, contents, filepath: path, prerenderedHTML, line: parsed.line, lineEnd: parsed.lineEnd });
	} catch {
		return Response.json({ error: `File not found: ${input}` }, { status: 404 });
	}
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

	// A base is only honored when it is itself inside an allowed root.
	const resolvedBase = getTrustedBaseDir(url.searchParams.get("base"), allowedRoots);
	// HTML renders raw by default; `?convert=1` (set by the frontend when the session's
	// --markdown preference is on) forces Turndown conversion instead.
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
		return errorResponse(DOC_ACCESS_DENIED);
	}
	if (resolution.kind !== "file") {
		return errorResponse(docResolutionError(resolution, allowedRoots));
	}
	return resolution.render === "code"
		? readCodeFile(resolution.path, requestedPath, resolution.code)
		: readDocument(resolution.path, convert, options);
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
			const r = await resolveCodeFileInRoots(parseCodePath(p).filePath, allowedRoots, baseDir);
			if (r.kind === "found") {
				results[p] = isPathAllowed(r.path, allowedRoots)
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

// Resolved per call, not captured at module load: the accepted set includes
// the user's configured extra markdown extensions (#1307), which the shared
// resolver reads from config.json on first use.
function includeWorkspaceFile(relativePath: string, _change: WorkspaceFileChange): boolean {
	return getAnnotatableDocRegex().test(relativePath) && !isFileBrowserExcludedPath(relativePath);
}

type FileBrowserWalkState = {
	files: Set<string>;
	limit: number;
	truncated: boolean;
};

function addFileBrowserFile(state: FileBrowserWalkState, relativePath: string): void {
	if (state.files.has(relativePath)) return;
	if (state.files.size >= state.limit) {
		state.truncated = true;
		return;
	}
	state.files.add(relativePath);
}

async function walkFileBrowserFiles(dir: string, root: string, state: FileBrowserWalkState): Promise<void> {
	if (state.truncated) return;
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return;
	}

	for (const entry of entries) {
		if (state.truncated) return;
		const fullPath = join(dir, entry.name);
		const relativePath = relative(root, fullPath).replace(/\\/g, "/");
		if (entry.isDirectory()) {
			if (isFileBrowserExcludedPath(relativePath)) continue;
			await walkFileBrowserFiles(fullPath, root, state);
		} else if (entry.isFile() && getAnnotatableDocRegex().test(entry.name)) {
			if (isFileBrowserExcludedPath(relativePath)) continue;
			addFileBrowserFile(state, relativePath);
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
		const state: FileBrowserWalkState = {
			files: new Set<string>(),
			limit: getFileBrowserMaxFiles(),
			truncated: false,
		};
		// Seed the user's own modified/untracked files BEFORE the bulk walk: the
		// walk fills the cap in raw readdir order and addFileBrowserFile drops
		// everything once the cap latches — the one set of files that must never
		// silently vanish from the browser is the ones the user just touched.
		const workspaceStatus = filterWorkspaceStatusForDirectory(await getWorkspaceStatusForDirectory(resolvedDir), resolvedDir, includeWorkspaceFile);
		for (const match of getWorkspaceStatusRelativePaths(workspaceStatus, resolvedDir, includeWorkspaceFile)) {
			addFileBrowserFile(state, match);
			if (state.truncated) break;
		}
		await walkFileBrowserFiles(resolvedDir, resolvedDir, state);
		const sortedFiles = [...state.files].sort();

		const tree = buildFileTree(sortedFiles);
		return Response.json({
			tree,
			workspaceStatus,
			truncated: state.truncated,
			fileLimit: state.limit,
		});
	} catch {
		return Response.json(
			{ error: "Failed to list directory files" },
			{ status: 500 },
		);
	}
}
