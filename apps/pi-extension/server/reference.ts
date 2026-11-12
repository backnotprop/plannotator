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
import { explicitFileBrowserMaxFiles, listFileBrowserFiles } from "../generated/file-browser-files.ts";
import {
	filterWorkspaceStatusForDirectory,
	getWorkspaceStatusForDirectory,
	getWorkspaceStatusRelativePaths,
	type WorkspaceFileChange,
} from "../generated/workspace-status.ts";
import { detectObsidianVaults } from "../generated/integrations-common.ts";
import { isReferenceReadPath, referenceReadRefusal, vaultDocRefusal } from "../generated/reference-reader.ts";
import { crossOriginRefusalBody } from "../generated/request-origin.ts";
import { isSameOriginRequest } from "./request-origin-guard.ts";
import { isThisMachineRequest } from "./this-machine.ts";
import {
	resolveUserPath,
	warmFileListCache,
	getAnnotatableDocRegex,
	MAX_ANNOTATABLE_FILE_BYTES,
	isAnnotatableTextPath,
} from "../generated/resolve-file.ts";
import { documentRenderKindForPath, isDocumentRenderKind } from "../generated/annotatable.ts";
import {
	DOC_ACCESS_DENIED,
	DOC_TOO_LARGE,
	docResolutionError,
	getAllowedRootPaths,
	getTrustedBaseDir,
	isDocServeAllowed,
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
	createBundleSourceSaveCapability,
	createSourceSaveCapability,
	createSourceSaveCapabilityFromSnapshot,
	readSourceFileSnapshot,
	resolveExistingSourceSaveFile,
} from "../generated/source-save-node.ts";
import type { AnnotateHistoryResult } from "../generated/annotate-history.ts";
import { preloadFile } from "@pierre/diffs/ssr";

export type FolderAnnotateHistory = Omit<AnnotateHistoryResult, "diffCurrent" | "isNew">;

type Res = ServerResponse;

export interface HandleDocOptions {
	rewriteHtml?: (html: string, filepath: string) => string;
	sourceSaveFilePath?: string;
	sourceSaveFolderPath?: string;
	sourceSaveBundlePaths?: ReadonlySet<string>;
	onSourceDocumentServed?: (path: string) => void;
	rootPaths?: string[];
	anyPath?: boolean;
	annotateHistory?: {
		compute: (resolvedFilePath: string, content: string) => FolderAnnotateHistory | null;
	};
	rootHtmlVersionDiff?: {
		path: string;
		compute: (currentHtml: string) => Record<string, unknown>;
	};
}

interface HandleDocExistsOptions {
	rootPath?: string;
	rootPaths?: string[];
}

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
	if (
		options.annotateHistory &&
		typeof data.filepath === "string" &&
		(data.renderAs === "markdown" || isDocumentRenderKind(data.renderAs)) &&
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
		return (options.sourceSaveFolderPath || options.sourceSaveFilePath || options.sourceSaveBundlePaths
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
	if (options.sourceSaveBundlePaths) {
		const doc = createBundleSourceSaveCapability(data.filepath, options.sourceSaveBundlePaths, sourceSnapshot);
		if (doc?.enabled) {
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
		const renderKind = documentRenderKindForPath(path);
		jsonDoc(res, { markdown: snapshot.text, filepath: path, renderAs: renderKind ?? "markdown" }, options, undefined, snapshot);
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
		}
		json(res, { codeFile: true, contents, filepath: path, prerenderedHTML, line: parsed.line, lineEnd: parsed.lineEnd });
	} catch {
		json(res, { error: `File not found: ${input}` }, 404);
	}
}

export async function handleDocRequest(res: Res, url: URL, options: HandleDocOptions = {}): Promise<void> {
	const requestedPath = url.searchParams.get("path");
	if (!requestedPath) {
		json(res, { error: "Missing path parameter" }, 400);
		return;
	}

	const allowedRoots = getAllowedRootPaths(options);
	for (const root of allowedRoots) {
		void warmFileListCache(root, "code");
	}

	const anyPath = options.anyPath === true;
	const resolvedBase = getTrustedBaseDir(url.searchParams.get("base"), allowedRoots, anyPath);
	const convert = url.searchParams.get("convert") === "1";
	const forceDoc = url.searchParams.get("doc") === "1";

	const resolution = await resolveDocTarget(requestedPath, {
		base: resolvedBase,
		forceDoc,
		roots: allowedRoots,
		anyPath,
	});
	const named = resolution.kind === "file" || resolution.kind === "not_found" ? resolution.path : undefined;
	if (named !== undefined && !isDocServeAllowed(named, resolution.kind === "file" ? resolution.render : null, allowedRoots, anyPath)) {
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

export function refuseReferenceRead(req: IncomingMessage, res: Res, url: URL, roots: () => string[]): boolean {
	if (!isReferenceReadPath(url.pathname)) return false;
	if (!isSameOriginRequest(req)) {
		json(res, crossOriginRefusalBody(), 403);
		return true;
	}
	const refusal = referenceReadRefusal(url, { thisMachine: isThisMachineRequest(req), roots: roots() });
	if (!refusal) return false;
	json(res, { error: refusal.error }, refusal.status);
	return true;
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

export function handleObsidianDocRequest(res: Res, url: URL, thisMachine = false): void {
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

	const refusal = vaultDocRefusal(resolvedFile, resolvedVault, thisMachine);
	if (refusal) {
		json(res, { error: refusal.error }, refusal.status);
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
		const workspaceStatus = filterWorkspaceStatusForDirectory(await getWorkspaceStatusForDirectory(resolvedDir), resolvedDir, includeWorkspaceFile);
		const listing = await listFileBrowserFiles(resolvedDir, {
			seed: getWorkspaceStatusRelativePaths(workspaceStatus, resolvedDir, includeWorkspaceFile),
			limit: explicitFileBrowserMaxFiles(),
		});
		json(res, {
			tree: buildFileTree(listing.files),
			workspaceStatus,
			truncated: listing.truncated,
			...(Number.isFinite(listing.limit) ? { fileLimit: listing.limit } : {}),
		});
	} catch {
		json(res, { error: "Failed to list directory files" }, 500);
	}
}
