// The URL grammars. Ported from the Workspaces suites (main 7379b0195):
//   apps/rooms/test/external-refs.test.ts       "the GitHub match grammar"
//   apps/rooms/test/external-refs-providers.test.ts  "linear — match grammar", "gitlab — match grammar"
//   apps/rooms/test/code-link-grammar.test.ts   the GitHub and GitLab rows of the census
//   apps/web/test/external-ref-match.test.ts    the GitHub, GitLab and Linear cases of matchExternalRefUrl
//   apps/web/test/code-link-match.test.ts       (mirrors the census; one table here now)
// The server and client copies were separate grammars kept in step by
// convention; in this package there is one grammar per provider, so the two
// test tables run against the same functions.

import { describe, expect, it } from "bun:test";

import { matchCodeLinkUrl, matchExternalRef, matchExternalRefUrl } from "../src/registry.ts";

const match = (url: string) => matchExternalRef(new URL(url));

describe("GitHub match grammar", () => {
	it("recognizes issue and PR URLs and produces the canonical key/url", () => {
		expect(match("https://github.com/acme-eng/api/issues/482")?.ref).toEqual({
			provider: "github",
			key: "acme-eng/api#482",
			url: "https://github.com/acme-eng/api/issues/482",
		});
		const pull = match("https://github.com/acme-eng/api/pull/512");
		expect(pull?.ref.key).toBe("acme-eng/api#512");
		expect(pull?.ref.url).toBe("https://github.com/acme-eng/api/pull/512");
	});

	it("normalizes display noise: trailing segments, query, fragment, http, www", () => {
		expect(match("https://github.com/a/b/pull/5/files")?.ref.url).toBe(
			"https://github.com/a/b/pull/5",
		);
		expect(match("https://github.com/a/b/issues/9?foo=1#issuecomment-3")?.ref.url).toBe(
			"https://github.com/a/b/issues/9",
		);
		expect(match("http://github.com/a/b/issues/9")?.ref.url).toBe(
			"https://github.com/a/b/issues/9",
		);
		expect(match("https://www.github.com/a/b/issues/9")?.ref.key).toBe("a/b#9");
	});

	it("owner and repo grammars split (INT-008): repos take `_`, owners never do", () => {
		expect(match("https://github.com/codesections/_/issues/16")?.ref).toEqual({
			provider: "github",
			key: "codesections/_#16",
			url: "https://github.com/codesections/_/issues/16",
		});
		expect(match("https://github.com/acme-eng/__tests__/pull/3")?.ref.key).toBe(
			"acme-eng/__tests__#3",
		);
		expect(matchExternalRefUrl("https://github.com/acme-eng/repo.js/issues/7")).toBe(
			"https://github.com/acme-eng/repo.js/issues/7",
		);
		for (const bad of [
			"https://github.com/bad_owner/repo/issues/1",
			"https://github.com/_/repo/issues/1",
			"https://github.com/dot.name/repo/issues/1",
			"https://github.com/-lead/repo/issues/1",
			"https://github.com/trail-/repo/issues/1",
			`https://github.com/${"a".repeat(40)}/repo/issues/1`,
		]) {
			expect(match(bad), bad).toBeNull();
		}
		expect(match(`https://github.com/${"a".repeat(39)}/repo/issues/1`)).not.toBeNull();
		expect(matchExternalRefUrl("https://github.com/acme-eng-2/repo/issues/1")).toBe(
			"https://github.com/acme-eng-2/repo/issues/1",
		);
	});

	it("hostile and near-miss inputs stay plain links", () => {
		for (const bad of [
			"https://github.com.evil.example/acme/api/issues/1",
			"https://evil.example/github.com/acme/api/issues/1",
			"https://gist.github.com/acme/api/issues/1",
			"https://github.com:8443/acme/api/issues/1",
			"https://github.com/acme/api/pulls/1",
			"https://github.com/acme/api/issues/abc",
			"https://github.com/acme/api/issues/0",
			"https://github.com/acme/api/issues/12345678901",
			"https://github.com/acme/api/issues/",
			"https://github.com/acme/api",
			"https://github.com/../api/issues/1",
			"https://github.com/acme/..%2F/issues/1",
			"ftp://github.com/acme/api/issues/1",
		]) {
			expect(match(bad), bad).toBeNull();
		}
		expect(matchExternalRefUrl("https://github.com/acme/./issues/1")).toBeNull();
		expect(matchExternalRefUrl("https://github.com/acme/../issues/1")).toBeNull();
		// Sentence punctuation is not part of the number.
		expect(matchExternalRefUrl("https://github.com/acme/api/issues/2.")).toBeNull();
		expect(matchExternalRefUrl("not a url")).toBeNull();
	});
});

describe("GitLab match grammar", () => {
	it("recognizes issues, work_items, and merge_requests at any group depth; the sigil key carries the kind", () => {
		const issue = match("https://gitlab.com/gitlab-org/gitlab/-/issues/259606");
		expect(issue?.ref).toEqual({
			provider: "gitlab",
			key: "gitlab-org/gitlab#259606",
			url: "https://gitlab.com/gitlab-org/gitlab/-/issues/259606",
		});
		// The modern alias canonicalizes to the issues form (same REST item).
		expect(match("https://gitlab.com/gitlab-org/gitlab/-/work_items/259606")?.ref).toEqual(
			issue?.ref,
		);
		const nested = match("https://gitlab.com/group/subgroup/project/-/merge_requests/88228/diffs");
		expect(nested?.ref.key).toBe("group/subgroup/project!88228");
		expect(nested?.ref.url).toBe("https://gitlab.com/group/subgroup/project/-/merge_requests/88228");
		expect(matchExternalRefUrl("https://gitlab.com/group/sub/project/-/merge_requests/88228/diffs")).toBe(
			"https://gitlab.com/group/sub/project/-/merge_requests/88228",
		);

		for (const bad of [
			"https://gitlab.com/project/-/issues/1", // no namespace before /-/
			"https://gitlab.com/g/p/-/pipelines/5",
			"https://gitlab.com/g/p/issues/1", // no /-/ separator
			"https://gitlab.example.com/g/p/-/issues/1", // self-managed: plain link
			"https://gitlab.com/g/p/-/issues/abc",
		]) {
			expect(match(bad), bad).toBeNull();
		}
	});
});

describe("Linear match grammar", () => {
	it("recognizes issues, projects, and documents by their stable tails; slugs and trailing segments are noise", () => {
		expect(match("https://linear.app/acme/issue/ENG-123/rate-limit-export")?.ref).toEqual({
			provider: "linear",
			key: "acme/ENG-123",
			url: "https://linear.app/acme/issue/ENG-123",
		});
		const project = match("https://linear.app/acme/project/rate-limits-q3-8f2a91cd0e/overview");
		expect(project?.ref.key).toBe("acme/project/8f2a91cd0e");
		expect(project?.ref.url).toBe("https://linear.app/acme/project/rate-limits-q3-8f2a91cd0e");
		const doc = match("https://linear.app/acme/document/rfc-permission-gateway-38359beef67c");
		expect(doc?.ref.key).toBe("acme/document/38359beef67c");
		expect(matchExternalRefUrl("https://linear.app/acme/document/rfc-gateway-38359beef67c")).toBe(
			"https://linear.app/acme/document/rfc-gateway-38359beef67c",
		);

		for (const bad of [
			"https://linear.app/acme/issue/notakey",
			"https://linear.app/acme/team/ENG", // collections stay plain links
			"https://linear.app/acme/project/no-slug-id-", // no stable tail
			"https://linear.app/settings/issue/ENG-1", // app chrome
			"https://evil.example/acme/issue/ENG-123",
		]) {
			expect(match(bad), bad).toBeNull();
		}
	});
});

interface GrammarFixture {
	readonly url: string;
	/** null = rejected (a plain link). */
	readonly expect: {
		readonly provider: "github" | "gitlab";
		readonly kind: "pr" | "repo" | "branch" | "issue";
		readonly repoPath: string;
		readonly number?: number;
		readonly branch?: string;
		readonly canonical: string;
	} | null;
}

/** The GitHub and GitLab rows of the Workspaces code-link census. */
const CODE_LINK_FIXTURES: readonly GrammarFixture[] = [
	// GitHub repo
	{
		url: "https://github.com/acme-eng/api",
		expect: { provider: "github", kind: "repo", repoPath: "acme-eng/api", canonical: "https://github.com/acme-eng/api" },
	},
	{
		// Clone-URL noise: trailing "/", ".git", ?tab= and fragment all drop.
		url: "https://github.com/acme-eng/api.git/?tab=readme-ov-file#readme",
		expect: { provider: "github", kind: "repo", repoPath: "acme-eng/api", canonical: "https://github.com/acme-eng/api" },
	},
	{
		// Display case survives into repo_path and the canonical URL.
		url: "https://www.github.com/AcMe-Eng/API",
		expect: { provider: "github", kind: "repo", repoPath: "AcMe-Eng/API", canonical: "https://github.com/AcMe-Eng/API" },
	},
	{ url: "https://github.com/orgs/acme", expect: null },
	{ url: "https://github.com/topics/testing", expect: null },
	{ url: "https://github.com/marketplace/actions", expect: null },
	{ url: "https://github.com/bad_owner/api", expect: null },
	{ url: "https://github.com/acme-eng", expect: null },
	{ url: "https://github.com/acme-eng/api/blob/main/README.md", expect: null },
	{ url: "https://github.com/acme-eng/api/releases", expect: null },
	// GitHub issue
	{
		url: "https://github.com/acme-eng/api/issues/482",
		expect: { provider: "github", kind: "issue", repoPath: "acme-eng/api", number: 482, canonical: "https://github.com/acme-eng/api/issues/482" },
	},
	{ url: "https://www.github.com/acme-eng/api/issues/0482/linked_closing_reference?x=1#top", expect: null },
	{
		url: "https://github.com/acme-eng/api/issues/77/?q=1#issuecomment-9",
		expect: { provider: "github", kind: "issue", repoPath: "acme-eng/api", number: 77, canonical: "https://github.com/acme-eng/api/issues/77" },
	},
	// GitHub branch
	{
		url: "https://github.com/acme-eng/api/tree/feature/session-resume",
		expect: {
			provider: "github",
			kind: "branch",
			repoPath: "acme-eng/api",
			branch: "feature/session-resume",
			canonical: "https://github.com/acme-eng/api/tree/feature/session-resume",
		},
	},
	{
		url: "https://github.com/acme-eng/api/tree/feature%2Fsession-resume",
		expect: {
			provider: "github",
			kind: "branch",
			repoPath: "acme-eng/api",
			branch: "feature/session-resume",
			canonical: "https://github.com/acme-eng/api/tree/feature/session-resume",
		},
	},
	{ url: "https://github.com/acme-eng/api/tree", expect: null },
	{ url: "https://github.com/acme-eng/api/tree/-leading-dash", expect: null },
	{ url: "https://github.com/acme-eng/api/tree/has..dots", expect: null },
	{ url: "https://github.com/acme-eng/api/tree/ends.lock", expect: null },
	{ url: "https://github.com/acme-eng/api/tree/@", expect: null },
	{ url: "https://github.com/acme-eng/api/tree/has%20space", expect: null },
	{ url: "https://github.com/acme-eng/api/tree/has%7E1tilde", expect: null },
	// GitHub pr
	{
		url: "https://github.com/acme-eng/api/pull/482/files?diff=split#discussion_r1",
		expect: { provider: "github", kind: "pr", repoPath: "acme-eng/api", number: 482, canonical: "https://github.com/acme-eng/api/pull/482" },
	},
	// GitLab repo
	{
		url: "https://gitlab.com/acme-group/platform/api-service",
		expect: {
			provider: "gitlab",
			kind: "repo",
			repoPath: "acme-group/platform/api-service",
			canonical: "https://gitlab.com/acme-group/platform/api-service",
		},
	},
	{
		url: "https://gitlab.com/acme-group/platform.git",
		expect: { provider: "gitlab", kind: "repo", repoPath: "acme-group/platform", canonical: "https://gitlab.com/acme-group/platform" },
	},
	{ url: "https://gitlab.com/acme-group", expect: null },
	{ url: "https://gitlab.com/groups/acme-group", expect: null },
	{ url: "https://gitlab.com/users/someone/projects", expect: null },
	{ url: "https://gitlab.com/-/profile", expect: null },
	// GitLab branch
	{
		url: "https://gitlab.com/acme-group/platform/api-service/-/tree/feature/session-resume",
		expect: {
			provider: "gitlab",
			kind: "branch",
			repoPath: "acme-group/platform/api-service",
			branch: "feature/session-resume",
			canonical: "https://gitlab.com/acme-group/platform/api-service/-/tree/feature/session-resume",
		},
	},
	{ url: "https://gitlab.com/acme-group/api/-/tree", expect: null },
	// GitLab pr
	{
		url: "https://gitlab.com/acme-group/platform/api-service/-/merge_requests/57?diff_id=1",
		expect: {
			provider: "gitlab",
			kind: "pr",
			repoPath: "acme-group/platform/api-service",
			number: 57,
			canonical: "https://gitlab.com/acme-group/platform/api-service/-/merge_requests/57",
		},
	},
	{ url: "https://gitlab.com/acme-group/api/-/issues/12", expect: null },
	{ url: "https://gitlab.com/acme-group/api/-/work_items/12", expect: null },
	// Cross-provider rejects: self-managed hosts stay plain links.
	{ url: "https://gitlab.example.com/acme/api", expect: null },
	{ url: "https://github.com:8443/acme/api", expect: null },
	{ url: "ftp://github.com/acme/api", expect: null },
	// Linear has no code-link forms.
	{ url: "https://linear.app/acme/issue/ENG-123", expect: null },
];

describe("code-link grammar census", () => {
	for (const fixture of CODE_LINK_FIXTURES) {
		it(`${fixture.expect === null ? "rejects" : `${fixture.expect.provider} ${fixture.expect.kind}`}: ${fixture.url}`, () => {
			const found = matchCodeLinkUrl(new URL(fixture.url));
			if (fixture.expect === null) {
				expect(found).toBeNull();
				return;
			}
			expect(found).not.toBeNull();
			if (found === null) return;
			expect(found.provider).toBe(fixture.expect.provider);
			expect(found.link.kind).toBe(fixture.expect.kind);
			expect(found.link.repoPath).toBe(fixture.expect.repoPath);
			expect(found.link.number).toBe(fixture.expect.number);
			expect(found.link.branch).toBe(fixture.expect.branch);
			// Byte identity with the reference grammar: the canonical string is
			// the per-URL facts cache key.
			expect(found.link.url).toBe(fixture.expect.canonical);
			if (found.link.kind === "pr" || found.link.kind === "issue") {
				expect(match(fixture.url)?.ref.url).toBe(found.link.url);
			}
		});
	}

	it("a branch name longer than 255 chars is refused (the git ref bound)", () => {
		const long = "a/".repeat(140) + "b";
		expect(matchCodeLinkUrl(new URL(`https://github.com/acme-eng/api/tree/${long}`))).toBeNull();
	});
});
