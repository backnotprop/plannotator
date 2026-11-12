import { readFileSync, realpathSync, statSync } from "fs";
import { basename, dirname, join, posix } from "path";
import { parseCodePath, type ParsedCodePath } from "./code-file";
import {
	getAnnotatableDocRegex,
	getExtraMarkdownExtensions,
	isAbsoluteUserPath,
	isAnnotatableTextPath,
	isCodeFilePath,
	isWithinProjectRoot,
	MAX_ANNOTATABLE_FILE_BYTES,
	resolveCodeFile,
	resolveMarkdownFile,
	resolveUserPath,
} from "./resolve-file";

export type DocRender = "document" | "code";

export type DocResolution =
	| { kind: "file"; path: string; render: "document" }
	| { kind: "file"; path: string; render: "code"; code: ParsedCodePath }
	| { kind: "not_found"; input: string; path?: string }
	| { kind: "ambiguous"; input: string; matches: string[]; render: DocRender }
	| { kind: "unavailable"; input: string };

export interface DocResolveOptions {
	base?: string | null;
	forceDoc?: boolean;
	roots: string[];
	anyPath?: boolean;
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

export function isPathAllowed(candidate: string, roots: string[]): boolean {
	if (!candidate) return false;
	if (!roots.some((root) => isWithinProjectRoot(candidate, root))) return false;
	const real = realpathAllowingMissingLeaf(candidate);
	if (!real) return false;
	return roots.some((root) => isWithinProjectRoot(real, root));
}

export function getTrustedBaseDir(base: string | null | undefined, roots: string[], anyPath = false): string | null {
	if (!base) return null;
	const resolvedBase = resolveUserPath(base);
	return isDocPathAllowed(resolvedBase, roots, anyPath) ? resolvedBase : null;
}

export function isDocPathAllowed(candidate: string, roots: string[], anyPath = false): boolean {
	return anyPath ? !!candidate : isPathAllowed(candidate, roots);
}

const ANY_PATH_DOCUMENT_RE = /\.(?:mdx?|html?|adoc|asciidoc|mmd|mermaid|dot|gv)$/i;

export function isAnyPathDocument(path: string): boolean {
	const trimmed = path.trim();
	if (ANY_PATH_DOCUMENT_RE.test(trimmed)) return true;
	const lower = trimmed.toLowerCase();
	return getExtraMarkdownExtensions().some((ext) => lower.endsWith(ext));
}

export function isDocServeAllowed(
	candidate: string,
	render: DocRender | null,
	roots: string[],
	anyPath = false,
): boolean {
	if (!candidate) return false;
	const real = realpathAllowingMissingLeaf(candidate);
	if (!real) return false;
	const anywhere = anyPath && render !== "code" && isAnyPathDocument(candidate) && isAnyPathDocument(real);
	if (!isDocPathAllowed(candidate, roots, anywhere)) return false;
	if (render === "code") return isCodeFilePath(real);
	if (render === "document") return getAnnotatableDocRegex().test(real);
	return true;
}

export interface PlanFile {
	path: string;
	dir: string;
	targets: Set<string>;
}

export function readPlanFile(planFilePath: unknown, plan: string): PlanFile | null {
	if (typeof planFilePath !== "string" || !plan) return null;
	if (!isAbsoluteUserPath(planFilePath) || !/\.md$/i.test(planFilePath)) return null;
	const path = resolveUserPath(planFilePath);
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_ANNOTATABLE_FILE_BYTES) return null;
		if (readFileSync(path, "utf8").trimEnd() !== plan.trimEnd()) return null;
		const real = realpathSync(path);
		return { path: real, dir: dirname(real), targets: planLinkTargets(plan) };
	} catch {
		return null;
	}
}

function normalizeLinkTarget(target: string): string {
	let path = target.trim().replace(/[?#].*$/, "");
	try {
		path = decodeURIComponent(path);
	} catch {
	}
	return path ? posix.normalize(path) : "";
}

function stripCode(plan: string): string {
	const kept: string[] = [];
	let fence: string | null = null;
	for (const line of plan.split("\n")) {
		const opener = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
		if (fence) {
			if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length && !opener[2].trim()) fence = null;
			continue;
		}
		if (opener && !(opener[1][0] === "`" && opener[2].includes("`"))) {
			fence = opener[1];
			continue;
		}
		kept.push(line);
	}
	return kept.join("\n").replace(/`[^`\n]*`/g, "");
}

const WIKI_LINK_DOC_EXTENSION = /\.(mdx?|txt|html?)$/i;

export function planLinkTargets(plan: string): Set<string> {
	const targets = new Set<string>();
	const text = stripCode(plan);
	const add = (target: string) => {
		const normalized = normalizeLinkTarget(target);
		if (normalized) targets.add(normalized);
	};
	for (const match of text.matchAll(/\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g)) add(match[1]);
	for (const match of text.matchAll(/\[\[([^\]|[\n]+)(?:\|[^\]\n]+)?\]\]/g)) {
		const target = match[1].trim();
		const hasExtension =
			WIKI_LINK_DOC_EXTENSION.test(target) ||
			getExtraMarkdownExtensions().some((ext) => target.toLowerCase().endsWith(ext));
		add(hasExtension ? target : `${target}.md`);
	}
	for (const match of text.matchAll(/\bhref\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)')/gi)) add(match[1] ?? match[2]);
	return targets;
}

export function isPlanDirBase(base: string | null | undefined, planFile: PlanFile | null | undefined): boolean {
	return !!planFile && !!base && resolveUserPath(base) === planFile.dir;
}

export function resolvePlanLinkedDoc(
	requestedPath: string,
	base: string | null | undefined,
	planFile: PlanFile | null | undefined,
): string | null {
	if (!planFile || !isPlanDirBase(base, planFile)) return null;
	const key = normalizeLinkTarget(requestedPath);
	if (!key || isAbsoluteUserPath(key)) return null;
	if (!getAnnotatableDocRegex().test(key) && !/\.html?$/i.test(key)) return null;
	if (!planFile.targets.has(key)) return null;
	const candidate = resolveUserPath(key, planFile.dir);
	if (!isPathAllowed(candidate, [planFile.dir])) return null;
	return isReadableFile(candidate) ? candidate : null;
}

export function isPlanLinkedDocPath(realPath: string, planFile: PlanFile | null | undefined): boolean {
	if (!planFile || !realPath) return false;
	for (const target of planFile.targets) {
		const served = resolvePlanLinkedDoc(target, planFile.dir, planFile);
		if (!served) continue;
		try {
			if (realpathSync(served) === realPath) return true;
		} catch {
		}
	}
	return false;
}

export type ResolveAllowedDocPathResult =
	| { kind: "resolved"; path: string }
	| { kind: "denied" };

export function resolveAllowedDocPath(
	requestedPath: string,
	base: string | null,
	options?: { rootPaths?: string[]; anyPath?: boolean },
): ResolveAllowedDocPathResult {
	const allowedRoots = getAllowedRootPaths(options);
	const anyPath = options?.anyPath === true;
	const resolvedBase = getTrustedBaseDir(base, allowedRoots, anyPath);
	const candidate = resolveUserPath(requestedPath, resolvedBase ?? undefined);
	return isDocServeAllowed(candidate, null, allowedRoots, anyPath)
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

	if (base && !isAbsoluteUserPath(requestedPath) && wantsDocRender(requestedPath)) {
		const fromBase = resolveUserPath(requestedPath, base);
		if (!(options.anyPath && isAnyPathDocument(fromBase)) && !roots.some((root) => isWithinProjectRoot(fromBase, root))) {
			return { kind: "not_found", input: requestedPath, path: fromBase };
		}
		if (isReadableFile(fromBase)) {
			return { kind: "file", path: fromBase, render: "document" };
		}
	}

	if (/\.html?$/i.test(requestedPath)) {
		const resolvedHtml = resolveUserPath(requestedPath, base || projectRoot);
		return isReadableFile(resolvedHtml)
			? { kind: "file", path: resolvedHtml, render: "document" }
			: { kind: "not_found", input: requestedPath, path: resolvedHtml };
	}

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
