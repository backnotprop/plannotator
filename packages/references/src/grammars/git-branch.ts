const FORBIDDEN_BRANCH_CHARS = /[ \\~^:?*[\u0000-\u001F\u007F]/;

export function parseBranchTail(
	rawSegments: readonly string[],
): { branch: string; canonicalTail: string } | null {
	if (rawSegments.length === 0) return null;
	const decoded: string[] = [];
	for (const raw of rawSegments) {
		try {
			decoded.push(decodeURIComponent(raw));
		} catch {
			return null;
		}
	}
	const branch = decoded.join("/");
	if (branch.length < 1 || branch.length > 255) return null;
	if (branch.startsWith("-")) return null;
	if (branch.startsWith("/") || branch.endsWith("/")) return null;
	if (branch.endsWith(".")) return null;
	if (branch.includes("..")) return null;
	if (branch.includes("@{")) return null;
	if (branch.includes("//")) return null;
	if (branch.endsWith(".lock")) return null;
	if (branch === "@") return null;
	if (FORBIDDEN_BRANCH_CHARS.test(branch)) return null;
	const canonicalTail = branch.split("/").map(encodeURIComponent).join("/");
	return { branch, canonicalTail };
}
