// Source: apps/rooms/src/external-refs/git-branch.ts (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Unchanged apart from comments; the client mirror in apps/web/src/components/external-refs/match.ts was the same rule.
//
// Branch-tail parsing shared by the forge grammars' matchCodeLink forms. A
// SEAM module: it holds no provider name, and exists so the forge grammars
// enforce ONE set of git ref rules instead of drifting copies.
//
// The branch is the ENTIRE remaining path after the kind marker, slashes
// included, each raw segment percent-decoded. The slashed-tail rule is a
// ruled simplification without provider truth: `.../tree/feature/foo` COULD
// be branch `feature` plus a subpath, and only the provider API could tell;
// matching makes no provider calls, so the whole tail is the branch.
//
// After decoding, the git ref rules that matter are enforced (git
// check-ref-format, the subset that matters here): 1 to 255 chars; no
// leading `-`; no leading or trailing `/`; no trailing `.`; no `..`; no
// `@{`; no `//`; no `.lock` suffix; not the sole name `@`; no space, `\`,
// `~ ^ : ? * [`, or control chars. Comparison stays EXACT case (git refs
// are case-sensitive).

/** Space, backslash, the git-forbidden specials, and control chars (DEL
 * included): any one of these disqualifies a decoded branch name. The
 * control-char range is deliberate (git refuses them in ref names). */
// oxlint-disable no-control-regex
const FORBIDDEN_BRANCH_CHARS = /[ \\~^:?*[\u0000-\u001F\u007F]/;
// oxlint-enable no-control-regex

/** Decode and validate a branch tail. `rawSegments` are the URL path
 * segments after the kind marker (`tree/` or `branch/`), still
 * percent-encoded. Answers the decoded branch (exact case) plus the
 * canonical re-encoded tail, or null when the tail is empty or violates the
 * git ref rules: the caller's "not a branch URL" answer. */
export function parseBranchTail(
	rawSegments: readonly string[],
): { branch: string; canonicalTail: string } | null {
	if (rawSegments.length === 0) return null;
	const decoded: string[] = [];
	for (const raw of rawSegments) {
		try {
			decoded.push(decodeURIComponent(raw));
		} catch {
			// Malformed percent-encoding is not a branch name.
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
	// Canonical re-encodes PER SEGMENT of the decoded name, so an encoded
	// slash (`feature%2Ffoo`) and a literal one canonicalize identically:
	// one resolve-cache identity per branch.
	const canonicalTail = branch.split("/").map(encodeURIComponent).join("/");
	return { branch, canonicalTail };
}
