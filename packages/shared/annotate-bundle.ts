export type AnnotateBundleRenderAs = "markdown" | "html" | "mermaid" | "graphviz" | "asciidoc" | "code";

export interface AnnotateBundleFile {
	path: string;
	renderAs: AnnotateBundleRenderAs;
}

const RENDER_AS: readonly AnnotateBundleRenderAs[] = ["markdown", "html", "mermaid", "graphviz", "asciidoc", "code"];

function separatorFree(path: string): string {
	return path.replace(/\\/g, "/");
}

export function annotateBundleBaseName(path: string): string {
	const normalized = separatorFree(path).replace(/\/+$/, "");
	return normalized.slice(normalized.lastIndexOf("/") + 1) || normalized;
}

export function annotateBundleRoot(paths: readonly string[]): string {
	if (paths.length === 0) return "/";
	const split = paths.map((path) => separatorFree(path).split("/"));
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
	if (joined === "") return "/";
	if (/^[A-Za-z]:$/.test(joined)) return `${joined}/`;
	return joined;
}

export function annotateBundleRelativePath(path: string, root: string): string {
	const normalized = separatorFree(path);
	const base = separatorFree(root).replace(/\/+$/, "");
	if (base === "") return normalized.replace(/^\/+/, "");
	return normalized.startsWith(`${base}/`) ? normalized.slice(base.length + 1) : normalized;
}

export function annotateBundlePositionText(index: number, total: number): string {
	return `file ${index} of ${total}`;
}

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

export function annotateBundleTargetText(paths: readonly string[]): string {
	return paths.join(", ");
}

export interface AnnotateBundleDocumentCount {
	path: string;
	annotationCount: number;
}

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

export function annotateBundleIndexOf(files: readonly AnnotateBundleFile[], path: string | null | undefined): number {
	if (!path) return -1;
	const wanted = separatorFree(path);
	return files.findIndex((file) => separatorFree(file.path) === wanted);
}
