export function normalizeBrowserPath(path: string): string {
	const withForwardSlashes = path.replace(/\\/g, "/");
	const prefix = withForwardSlashes.startsWith("//") ? "//" : "";
	const collapsed = prefix + withForwardSlashes.slice(prefix.length).replace(/\/+/g, "/");
	if (collapsed === "/" || /^[A-Za-z]:\/$/.test(collapsed)) return collapsed;
	return collapsed.replace(/\/+$/, "");
}

export function dirnameBrowserPath(path: string): string {
	const normalized = normalizeBrowserPath(path);
	const driveRootMatch = normalized.match(/^([A-Za-z]:)\/[^/]+$/);
	if (driveRootMatch) return `${driveRootMatch[1]}/`;
	const index = normalized.lastIndexOf("/");
	if (index < 0) return normalized;
	if (index === 0) return "/";
	return normalized.slice(0, index);
}

export function pathIsInsideDir(path: string, dir: string): boolean {
	const normalizedPath = normalizeBrowserPath(path);
	const normalizedDir = normalizeBrowserPath(dir);
	if (!normalizedDir) return normalizedPath === "";
	const dirPrefix = normalizedDir.endsWith("/") ? normalizedDir : `${normalizedDir}/`;
	return normalizedPath === normalizedDir || normalizedPath.startsWith(dirPrefix);
}
