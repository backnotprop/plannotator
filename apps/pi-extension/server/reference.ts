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
	FILE_BROWSER_EXCLUDED,
} from "../generated/reference-common.js";
import { detectObsidianVaults } from "../generated/integrations-common.js";
import {
	isAbsoluteUserPath,
	isCodeFilePath,
	resolveCodeFile,
	resolveMarkdownFile,
	resolveUserPath,
	isWithinProjectRoot,
	warmFileListCache,
} from "../generated/resolve-file.js";
import { parseCodePath } from "../generated/code-file.js";
import { htmlToMarkdown } from "../generated/html-to-markdown.js";
import { preloadFile } from "@pierre/diffs/ssr";

type Res = ServerResponse;

/** Recursively walk a directory collecting files by extension, skipping ignored dirs. */
function walkMarkdownFiles(dir: string, root: string, results: string[], extensions: RegExp = /\.(mdx?|html?)$/i): void {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry.isDirectory()) {
			if (FILE_BROWSER_EXCLUDED.includes(entry.name + "/")) continue;
			walkMarkdownFiles(join(dir, entry.name), root, results, extensions);
		} else if (entry.isFile() && extensions.test(entry.name)) {
			const relative = join(dir, entry.name)
				.slice(root.length + 1)
				.replace(/\\/g, "/");
			results.push(relative);
		}
	}
}

/** Serve a linked markdown document. Uses shared resolveMarkdownFile for parity with Bun server. */
export async function handleDocRequest(res: Res, url: URL): Promise<void> {
	const requestedPath = url.searchParams.get("path");
	if (!requestedPath) {
		json(res, { error: "Missing path parameter" }, 400);
		return;
	}

	// Side-channel: warm the code-file walk so /api/doc/exists POSTs land warm.
	void warmFileListCache(process.cwd(), "code");

	// Try resolving relative to base directory first (used by annotate mode).
	// No isWithinProjectRoot check here — intentional, matches pre-existing
	// markdown behavior. The base param is set server-side by the annotate
	// server (see serverAnnotate.ts /api/doc route). The standalone HTML
	// block below (no base) retains its cwd-based containment check.
	const base = url.searchParams.get("base");
	const resolvedBase = base ? resolveUserPath(base) : null;
	if (
		resolvedBase &&
		!isAbsoluteUserPath(requestedPath) &&
		/\.(mdx?|html?)$/i.test(requestedPath)
	) {
		const fromBase = resolveUserPath(requestedPath, resolvedBase);
		try {
			if (existsSync(fromBase)) {
				const raw = readFileSync(fromBase, "utf-8");
				const isHtml = /\.html?$/i.test(requestedPath);
				const markdown = isHtml ? htmlToMarkdown(raw) : raw;
				json(res, { markdown, filepath: fromBase, isConverted: isHtml });
				return;
			}
		} catch {
			/* fall through to standard resolution */
		}
	}

	// HTML files: resolve directly (not via resolveMarkdownFile which only handles .md/.mdx)
	const projectRoot = process.cwd();
	if (/\.html?$/i.test(requestedPath)) {
		const resolvedHtml = resolveUserPath(requestedPath, resolvedBase || projectRoot);
		if (!isWithinProjectRoot(resolvedHtml, projectRoot)) {
			json(res, { error: "Access denied: path is outside project root" }, 403);
			return;
		}
		try {
			if (existsSync(resolvedHtml)) {
				const html = readFileSync(resolvedHtml, "utf-8");
				json(res, { markdown: htmlToMarkdown(html), filepath: resolvedHtml, isConverted: true });
				return;
			}
		} catch { /* fall through to 404 */ }
		json(res, { error: `File not found: ${requestedPath}` }, 404);
		return;
	}

	// Code files: try literal resolve first; on miss, fall back to smart resolver.
	if (isCodeFilePath(requestedPath)) {
		const parsed = parseCodePath(requestedPath);
		const cleanPath = parsed.filePath;
		const literalPath = resolveUserPath(cleanPath, resolvedBase || projectRoot);
		const literalAllowed = resolvedBase || isWithinProjectRoot(literalPath, projectRoot);

		let resolvedCode: string | null = null;
		if (literalAllowed && existsSync(literalPath)) {
			resolvedCode = literalPath;
		}

		if (!resolvedCode) {
			const result = await resolveCodeFile(cleanPath, projectRoot);
			if (result.kind === "found") {
				resolvedCode = result.path;
			} else if (result.kind === "ambiguous") {
				const prefix = `${projectRoot}/`;
				const relative = result.matches.map((m: string) =>
					m.startsWith(prefix) ? m.slice(prefix.length) : m,
				);
				json(res, { error: `Ambiguous path '${requestedPath}'`, matches: relative }, 400);
				return;
			} else {
				json(res, { error: `File not found: ${requestedPath}` }, 404);
				return;
			}
			if (!isWithinProjectRoot(resolvedCode, projectRoot)) {
				json(res, { error: "Access denied: path is outside project root" }, 403);
				return;
			}
		}

		try {
			const stat = statSync(resolvedCode);
			if (stat.size > 2 * 1024 * 1024) {
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

	const result = resolveMarkdownFile(requestedPath, projectRoot);

	if (result.kind === "ambiguous") {
		json(
			res,
			{
				error: `Ambiguous filename '${result.input}': found ${result.matches.length} matches`,
				matches: result.matches,
			},
			400,
		);
		return;
	}

	if (result.kind === "not_found" || result.kind === "unavailable") {
		json(res, { error: `File not found: ${result.input}` }, 404);
		return;
	}

	try {
		const markdown = readFileSync(result.path, "utf-8");
		json(res, { markdown, filepath: result.path });
	} catch {
		json(res, { error: "Failed to read file" }, 500);
	}
}

/**
 * Batch existence check for code-file paths the renderer wants to linkify.
 * POST /api/doc/exists with { paths: string[] }.
 *
 * TODO(security): see packages/server/reference-handlers.ts handleDocExists —
 * both absolute paths in `paths[]` AND the `base` field are honored verbatim
 * with no project-root containment check, leaking file existence back to the
 * caller. Fix in lockstep with the Bun handler.
 */
export async function handleDocExistsRequest(res: Res, req: IncomingMessage): Promise<void> {
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
	const baseRaw = (body as { base?: unknown }).base;
	const baseDir = typeof baseRaw === "string" && baseRaw.length > 0
		? resolveUserPath(baseRaw)
		: undefined;

	const projectRoot = process.cwd();
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
			const r = await resolveCodeFile(cleanP, projectRoot, baseDir);
			if (r.kind === "found") {
				results[p] = { status: "found", resolved: r.path };
			} else if (r.kind === "ambiguous") {
				const prefix = `${projectRoot}/`;
				results[p] = {
					status: "ambiguous",
					matches: r.matches.map((m: string) => (m.startsWith(prefix) ? m.slice(prefix.length) : m)),
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

export function handleFileBrowserRequest(res: Res, url: URL): void {
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
		const files: string[] = [];
		walkMarkdownFiles(resolvedDir, resolvedDir, files);
		files.sort();
		json(res, { tree: buildFileTree(files) });
	} catch {
		json(res, { error: "Failed to list directory files" }, 500);
	}
}
