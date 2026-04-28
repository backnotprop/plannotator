/**
 * Reference/document route handlers for the plan server.
 *
 * Handles /api/doc, /api/obsidian/vaults, /api/reference/obsidian/files,
 * /api/reference/obsidian/doc, and /api/reference/files. Extracted from index.ts for modularity.
 */

import { existsSync, statSync } from "fs";
import { resolve } from "path";
import { buildFileTree, FILE_BROWSER_EXCLUDED } from "@plannotator/shared/reference-common";
import { detectObsidianVaults } from "./integrations";
import {
	isAbsoluteUserPath,
	resolveMarkdownFile,
	resolveUserPath,
	isWithinProjectRoot,
} from "@plannotator/shared/resolve-file";
import { htmlToMarkdown } from "@plannotator/shared/html-to-markdown";

// --- Route handlers ---

/** Serve a linked markdown document. Resolves absolute, relative, or bare filename paths. */
export async function handleDoc(req: Request): Promise<Response> {
	const url = new URL(req.url);
	const requestedPath = url.searchParams.get("path");
	if (!requestedPath) {
		return Response.json({ error: "Missing path parameter" }, { status: 400 });
	}

	// If a base directory is provided, try resolving relative to it first
	// (used by annotate mode to resolve paths relative to the source file).
	// No isWithinProjectRoot check here — intentional, matches pre-existing
	// markdown behavior. The base param is set server-side by the annotate
	// server (see annotate.ts /api/doc route). The standalone HTML block
	// below (no base) retains its cwd-based containment check.
	const base = url.searchParams.get("base");
	const resolvedBase = base ? resolveUserPath(base) : null;
	if (
		resolvedBase &&
		!isAbsoluteUserPath(requestedPath) &&
		/\.(mdx?|html?)$/i.test(requestedPath)
	) {
		const fromBase = resolveUserPath(requestedPath, resolvedBase);
		try {
			const file = Bun.file(fromBase);
			if (await file.exists()) {
				const raw = await file.text();
				const isHtml = /\.html?$/i.test(requestedPath);
				const markdown = isHtml ? htmlToMarkdown(raw) : raw;
				return Response.json({ markdown, filepath: fromBase, isConverted: isHtml });
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
			return Response.json({ error: "Access denied: path is outside project root" }, { status: 403 });
		}
		try {
			const file = Bun.file(resolvedHtml);
			if (await file.exists()) {
				const html = await file.text();
				const markdown = htmlToMarkdown(html);
				return Response.json({ markdown, filepath: resolvedHtml, isConverted: true });
			}
		} catch { /* fall through */ }
		return Response.json({ error: `File not found: ${requestedPath}` }, { status: 404 });
	}

	const result = resolveMarkdownFile(requestedPath, projectRoot);

	if (result.kind === "ambiguous") {
		return Response.json(
			{
				error: `Ambiguous filename '${result.input}': found ${result.matches.length} matches`,
				matches: result.matches,
			},
			{ status: 400 },
		);
	}

	if (result.kind === "not_found") {
		return Response.json(
			{ error: `File not found: ${result.input}` },
			{ status: 404 },
		);
	}

	try {
		const markdown = await Bun.file(result.path).text();
		return Response.json({ markdown, filepath: result.path });
	} catch {
		return Response.json({ error: "Failed to read file" }, { status: 500 });
	}
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
		const glob = new Bun.Glob("**/*.{md,mdx,html,htm}");
		const files: string[] = [];
		for await (const match of glob.scan({
			cwd: resolvedDir,
			onlyFiles: true,
		})) {
			if (FILE_BROWSER_EXCLUDED.some((dir) => match.includes(dir))) continue;
			files.push(match);
		}
		files.sort();

		const tree = buildFileTree(files);
		return Response.json({ tree });
	} catch {
		return Response.json(
			{ error: "Failed to list directory files" },
			{ status: 500 },
		);
	}
}
