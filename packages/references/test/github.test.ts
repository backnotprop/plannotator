// The GitHub read adapter. Ported from the Workspaces suites (main 7379b0195):
//   apps/rooms/test/external-refs.test.ts  the public rung, the state table,
//     the issues-form PR, 404 / 403 answers, the connection rung, the dead
//     credential (now answered by the port), the HOME-installation rung
//     (now the port's choice of credential)
//   apps/rooms/test/github-pulls.test.ts   G1 to G10
// The route-level shapes (HTTP 404/502/422, the cache, the guest fence,
// broken_at stamping) are Workspaces' and stay there; here the adapter's
// own ResolveResult is asserted.

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

import { githubAdapter } from "../src/adapters/github.ts";
import { fetchPullDiff, listPullFiles, readPullSummary } from "../src/adapters/github-pull-diff.ts";
import { githubScopes, githubSearch } from "../src/adapters/github-pulls.ts";
import type { ExternalRefKind, ExternalRefState } from "../src/contract.ts";
import type { ReferenceCredential } from "../src/port.ts";
import { adapterFor, matchExternalRef } from "../src/registry.ts";
import { fakeProvider, json, makePort } from "./helpers.ts";

const API = "https://api.github.com";
const installation: ReferenceCredential = { kind: "installation", token: "token-install", host: "github.com" };
const userToken: ReferenceCredential = { kind: "bearer", token: "token-user", host: "github.com" };

function issuePayload(over: Record<string, unknown> = {}): unknown {
	return {
		number: 482,
		title: "Rate-limit the export endpoint",
		state: "open",
		state_reason: null,
		user: { login: "mara" },
		created_at: "2026-05-30T10:00:00Z",
		updated_at: "2026-07-22T09:14:00Z",
		...over,
	};
}

function pullPayload(over: Record<string, unknown> = {}): unknown {
	return {
		number: 512,
		title: "Gate exports behind the rate limiter",
		state: "open",
		merged: false,
		merged_at: null,
		draft: false,
		user: { login: "mara" },
		created_at: "2026-07-01T10:00:00Z",
		updated_at: "2026-07-22T09:14:00Z",
		...over,
	};
}

function refOf(url: string) {
	const found = matchExternalRef(new URL(url));
	if (found === null) throw new Error(`no match: ${url}`);
	return found.ref;
}

// Bun runs every test file in one process: the console spy is restored after each test.
let info: Mock<typeof console.info>;
beforeEach(() => {
	info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	info.mockRestore();
});

describe("resolve: the public rung (no credential)", () => {
	it("answers issue facts UNAUTHENTICATED when the port has no credential", async () => {
		const gh = fakeProvider();
		gh.on(`GET ${API}/repos/acme-eng/api/issues/482`, () => json(200, issuePayload()));
		const port = makePort(gh.fetch);
		const result = await githubAdapter.resolve(refOf("https://github.com/acme-eng/api/issues/482"), port);
		expect(result).toEqual({
			ok: true,
			facts: {
				ref: {
					provider: "github",
					key: "acme-eng/api#482",
					url: "https://github.com/acme-eng/api/issues/482",
				},
				kind: "issue",
				shortId: "api#482",
				title: "Rate-limit the export endpoint",
				state: { label: "Open", tone: "open" },
				author: "mara",
				createdAt: "2026-05-30T10:00:00Z",
				updatedAt: "2026-07-22T09:14:00Z",
			},
		});
		expect(gh.calls.map((c) => c.headers.get("authorization"))).toEqual([null]);
		expect(gh.calls[0]?.headers.get("x-github-api-version")).toBe("2022-11-28");
		expect(port.asked).toEqual(["github github.com"]);
	});

	it("maps the whole state table: closed-completed and closed with no reason → done, not-planned and duplicate → closed, PR merged/draft/closed", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch);
		const cases: Array<{ path: string; url: string; body: unknown; state: ExternalRefState; kind: ExternalRefKind }> = [
			{
				path: "/repos/a/b/issues/1",
				url: "https://github.com/a/b/issues/1",
				body: issuePayload({ state: "closed", state_reason: "completed" }),
				state: { label: "Closed", tone: "done" },
				kind: "issue",
			},
			{
				path: "/repos/a/b/issues/2",
				url: "https://github.com/a/b/issues/2",
				body: issuePayload({ state: "closed", state_reason: "not_planned" }),
				state: { label: "Closed", tone: "closed" },
				kind: "issue",
			},
			{
				path: "/repos/a/b/issues/8",
				url: "https://github.com/a/b/issues/8",
				body: issuePayload({ state: "closed", state_reason: null }),
				state: { label: "Closed", tone: "done" },
				kind: "issue",
			},
			{
				path: "/repos/a/b/issues/9",
				url: "https://github.com/a/b/issues/9",
				body: issuePayload({ state: "closed", state_reason: "duplicate" }),
				state: { label: "Closed", tone: "closed" },
				kind: "issue",
			},
			{
				path: "/repos/a/b/pulls/3",
				url: "https://github.com/a/b/pull/3",
				body: pullPayload({ state: "closed", merged: true, merged_at: "2026-07-22T09:00:00Z" }),
				state: { label: "Merged", tone: "done" },
				kind: "change",
			},
			{
				path: "/repos/a/b/pulls/4",
				url: "https://github.com/a/b/pull/4",
				body: pullPayload({ draft: true }),
				state: { label: "Draft", tone: "open" },
				kind: "change",
			},
			{
				path: "/repos/a/b/pulls/5",
				url: "https://github.com/a/b/pull/5",
				body: pullPayload({ state: "closed" }),
				state: { label: "Closed", tone: "closed" },
				kind: "change",
			},
		];
		for (const c of cases) {
			gh.on(`GET ${API}${c.path}`, () => json(200, c.body));
			const ref = refOf(c.url);
			const result = await githubAdapter.resolve(ref, port);
			if (!result.ok) throw new Error(`${c.url}: ${result.reason}`);
			expect(result.facts.state, c.url).toEqual(c.state);
			expect(result.facts.kind, c.url).toBe(c.kind);
			expect(githubAdapter.kindOf?.(ref), c.url).toBe(c.url.includes("/pull/") ? "change" : "issue");
		}
	});

	it("an issues-form URL that is really a PR answers kind change with the merged truth", async () => {
		const gh = fakeProvider();
		gh.on(`GET ${API}/repos/a/b/issues/7`, () =>
			json(200, issuePayload({ state: "closed", pull_request: { merged_at: "2026-07-20T08:00:00Z" } })),
		);
		const result = await githubAdapter.resolve(refOf("https://github.com/a/b/issues/7"), makePort(gh.fetch));
		expect(result.ok && result.facts.kind).toBe("change");
		expect(result.ok && result.facts.state).toEqual({ label: "Merged", tone: "done" });
	});

	it("404 and 410 → not_linked; 403 and 429 → not_resolvable rateLimited; a 5xx → not_resolvable; a network throw → not_resolvable", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch);
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/404"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		gh.on(`GET ${API}/repos/a/b/issues/410`, () => json(410, { message: "Gone" }));
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/410"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		gh.on(`GET ${API}/repos/a/b/issues/9`, () =>
			json(403, { message: "API rate limit exceeded for 1.2.3.4", documentation_url: "https://docs.github.com" }),
		);
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/9"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			rateLimited: true,
		});
		gh.on(`GET ${API}/repos/a/b/issues/10`, () => json(429, { message: "slow down" }));
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/10"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			rateLimited: true,
		});
		gh.on(`GET ${API}/repos/a/b/issues/11`, () => json(502, { message: "bad gateway" }));
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/11"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
		});
		const broken = makePort(async () => {
			throw new TypeError("network down");
		});
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/12"), broken)).toEqual({
			ok: false,
			reason: "not_resolvable",
		});
	});
});

describe("resolve: the credential rung (the port's token)", () => {
	it("an installation or user token from the port rides Authorization: Bearer", async () => {
		for (const credential of [installation, userToken]) {
			const gh = fakeProvider();
			gh.on(`GET ${API}/repos/acme-eng/api/pulls/512`, ({ headers }) =>
				headers.get("authorization") === `Bearer ${credential.token}`
					? json(200, pullPayload())
					: json(404, { message: "Not Found" }),
			);
			const port = makePort(gh.fetch, { "github github.com": credential });
			const result = await githubAdapter.resolve(refOf("https://github.com/acme-eng/api/pull/512"), port);
			expect(result.ok, credential.kind).toBe(true);
		}
	});

	it("a dead credential (the port answers unavailable, credentialDead) is not_resolvable credentialDead, with no provider fetch", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch, { "github github.com": { kind: "unavailable", credentialDead: true } });
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: true,
		});
		const blip = makePort(gh.fetch, { "github github.com": { kind: "unavailable", credentialDead: false } });
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), blip)).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: false,
		});
		expect(gh.calls).toHaveLength(0);
	});

	it("a credential for another host, of another kind, or empty is never sent: the read rides the public rung", async () => {
		for (const credential of [
			{ kind: "bearer", token: "token-ghe", host: "github.example.com" },
			{ kind: "private-token", token: "token-gl", host: "github.com" },
			{ kind: "bearer", token: "", host: "github.com" },
		] as const) {
			const gh = fakeProvider();
			gh.on(`GET ${API}/repos/a/b/issues/1`, () => json(200, issuePayload()));
			const port = makePort(gh.fetch, async () => credential);
			const result = await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port);
			expect(result.ok).toBe(true);
			expect(gh.calls.map((c) => c.headers.get("authorization"))).toEqual([null]);
		}
	});

	it("a port that throws answers not_resolvable, never a throw", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch, async () => {
			throw new Error("keychain locked");
		});
		expect(await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: false,
		});
	});
});

// ── the picker and pull reads (github-pulls.test.ts) ─────────────────────────

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const SHA_F = "f".repeat(40);
const AUTH_PATCH = `@@ -1 +1,2 @@
 export function refresh(token: string) {
+  if (!token) throw new Error("missing token");`;
const authFile = {
	sha: SHA_F,
	filename: "src/auth.ts",
	status: "modified",
	additions: 1,
	deletions: 0,
	changes: 1,
	patch: AUTH_PATCH,
};
const DIFF = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
${AUTH_PATCH}
`;

function pull(number: number, head: string, base = BASE_SHA, changedFiles = 2) {
	return () =>
		json(200, {
			number,
			title: "Auth token refresh",
			state: "open",
			merged: false,
			user: { login: "author-a" },
			base: { ref: "main", sha: base },
			head: { ref: "feat/refresh", sha: head },
			additions: 12,
			deletions: 3,
			changed_files: changedFiles,
		});
}

describe("GitHub picker and pull reads", () => {
	it("G1: scopes reads every page of the installation's repositories, with the installation token", async () => {
		const gh = fakeProvider();
		gh.on(`GET ${API}/installation/repositories?per_page=100&page=1`, () =>
			json(
				200,
				{ total_count: 2, repositories: [{ full_name: "acme/web" }] },
				{ link: '<https://api.github.com/installation/repositories?per_page=100&page=2>; rel="next"' },
			),
		);
		gh.on(`GET ${API}/installation/repositories?per_page=100&page=2`, () =>
			json(200, { total_count: 2, repositories: [{ full_name: "acme/api" }] }),
		);
		const port = makePort(gh.fetch, { "github github.com": installation });
		expect(await githubScopes(port)).toEqual({
			ok: true,
			items: [
				{ id: "acme/web", label: "acme/web" },
				{ id: "acme/api", label: "acme/api" },
			],
		});
		expect(gh.calls.map((c) => c.url)).toEqual([
			`${API}/installation/repositories?per_page=100&page=1`,
			`${API}/installation/repositories?per_page=100&page=2`,
		]);
		expect(gh.calls.every((c) => c.headers.get("authorization") === "Bearer token-install")).toBe(true);
		expect(adapterFor("github")?.scopes).toBe(githubScopes);
		expect(adapterFor("github")?.search).toBe(githubSearch);
	});

	it("scopes needs an installation token: a user token or no credential is not_linked, with no fetch", async () => {
		const gh = fakeProvider();
		expect(await githubScopes(makePort(gh.fetch, { "github github.com": userToken }))).toEqual({
			ok: false,
			reason: "not_linked",
		});
		expect(await githubScopes(makePort(gh.fetch))).toEqual({ ok: false, reason: "not_linked" });
		expect(gh.calls).toHaveLength(0);
	});

	it("G2: search needs a repository and answers its open pull requests, one page at a time", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch, { "github github.com": installation });
		expect(await githubSearch({ query: "" }, port)).toEqual({ ok: false, reason: "not_resolvable", field: "scope" });
		expect(await githubSearch({ query: "", scope: "acme/web", cursor: "0" }, port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			field: "cursor",
		});
		const list = [
			{
				number: 14485,
				title: "chore(deps): bump grpc from 1.83.2 to 1.84.0",
				html_url: "https://github.com/acme/web/pull/14485",
				draft: false,
				user: { login: "dependabot[bot]" },
				created_at: "2026-09-21T14:02:58Z",
				updated_at: "2026-09-22T17:16:21Z",
			},
			{
				number: 14474,
				title: "Remove CLAUDE.md in favor of AGENTS.md",
				html_url: "https://github.com/acme/web/pull/14474",
				draft: true,
				user: { login: "author-a" },
				created_at: "2026-09-18T22:53:14Z",
				updated_at: "2026-09-22T12:29:58Z",
			},
		];
		const path = "/repos/acme/web/pulls?state=open&sort=created&direction=desc&per_page=100&page=1";
		gh.on(
			`GET ${API}${path}`,
			() =>
				json(200, list, {
					link: '<https://api.github.com/repositories/212613049/pulls?state=open&per_page=100&page=2>; rel="next", <https://api.github.com/repositories/212613049/pulls?state=open&per_page=100&page=31>; rel="last"',
				}),
			() => json(200, list),
		);
		const result = await githubSearch({ query: "", scope: "acme/web" }, port);
		expect(result).toMatchObject({ ok: true, cursor: "2" });
		if (!result.ok) throw new Error("search failed");
		expect(result.items.map((item) => [item.ref.url, item.shortId, item.state?.label])).toEqual([
			["https://github.com/acme/web/pull/14485", "web#14485", "Open"],
			["https://github.com/acme/web/pull/14474", "web#14474", "Draft"],
		]);
		const narrowed = await githubSearch({ query: "#14474", scope: "acme/web" }, port);
		expect(narrowed.ok && narrowed.items.map((item) => item.ref.key)).toEqual(["acme/web#14474"]);
	});

	it("search works on a user token too, and a 403 or 429 is rateLimited", async () => {
		const gh = fakeProvider();
		const path = "/repos/acme/web/pulls?state=open&sort=created&direction=desc&per_page=100&page=1";
		gh.on(`GET ${API}${path}`, () => json(200, []), () => json(429, { message: "slow down" }));
		const port = makePort(gh.fetch, { "github github.com": userToken });
		expect(await githubSearch({ query: "", scope: "acme/web" }, port)).toEqual({ ok: true, items: [] });
		expect(await githubSearch({ query: "", scope: "acme/web" }, port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			rateLimited: true,
		});
		expect(gh.calls[0]?.headers.get("authorization")).toBe("Bearer token-user");
	});

	it("G10: include=issues lists open issues and pull requests together from the issues list, each in its own form", async () => {
		const gh = fakeProvider();
		const path = "/repos/acme/web/issues?state=open&sort=updated&direction=desc&per_page=100&page=1";
		gh.on(`GET ${API}${path}`, () =>
			json(
				200,
				[
					{
						number: 1814,
						title: "Ask this session is missing",
						html_url: "https://github.com/acme/web/issues/1814",
						state: "open",
						user: { login: "tester" },
						created_at: "2026-10-09T10:00:00Z",
						updated_at: "2026-10-10T10:00:00Z",
					},
					{
						number: 1816,
						title: "Question card tag",
						html_url: "https://github.com/acme/web/pull/1816",
						state: "open",
						draft: true,
						pull_request: { url: "https://api.github.com/repos/acme/web/pulls/1816" },
						user: { login: "author-a" },
					},
				],
				{ link: '<https://api.github.com/repositories/1/issues?state=open&per_page=100&page=2>; rel="next"' },
			),
		);
		const port = makePort(gh.fetch, { "github github.com": installation });
		const result = await githubSearch({ query: "", scope: "acme/web", include: "issues" }, port);
		expect(result).toMatchObject({ ok: true, cursor: "2" });
		if (!result.ok) throw new Error("search failed");
		expect(result.items.map((item) => [item.kind, item.ref.url, item.state?.label, item.author])).toEqual([
			["issue", "https://github.com/acme/web/issues/1814", "Open", "tester"],
			["change", "https://github.com/acme/web/pull/1816", "Draft", "author-a"],
		]);
		expect(gh.calls.map((c) => c.url)).toEqual([`${API}${path}`]);
	});

	it("G3: the diff is built from the files list and pinned to one head; a head or base that moves is read again, then refused", async () => {
		const path = `${API}/repos/acme/web/pulls/42`;
		const files = `GET ${path}/files?per_page=100&page=1`;
		const page = () => json(200, [authFile]);
		const port = (gh: ReturnType<typeof fakeProvider>) => makePort(gh.fetch, { "github github.com": installation });

		let gh = fakeProvider();
		gh.on(`GET ${path}`, pull(42, HEAD_A), pull(42, HEAD_A));
		gh.on(files, page);
		expect(await fetchPullDiff({ repo: "acme/web", number: 42 }, port(gh))).toEqual({
			ok: true,
			diff: DIFF,
			title: "Auth token refresh",
			url: "https://github.com/acme/web/pull/42",
			state: "open",
			author: "author-a",
			baseRef: "main",
			headRef: "feat/refresh",
			baseSha: BASE_SHA,
			headSha: HEAD_A,
			additions: 12,
			deletions: 3,
			changedFiles: 2,
		});
		expect(gh.calls.map((c) => [c.url, c.headers.get("accept")])).toEqual([
			[path, "application/vnd.github+json"],
			[`${path}/files?per_page=100&page=1`, "application/vnd.github+json"],
			[path, "application/vnd.github+json"],
		]);
		// G6: the diff media type is never asked for.
		expect(gh.calls.map((c) => c.headers.get("accept"))).not.toContain("application/vnd.github.diff");

		// A push lands between the first head read and the files list: read again.
		gh = fakeProvider();
		gh.on(`GET ${path}`, pull(42, HEAD_A), pull(42, HEAD_B), pull(42, HEAD_B), pull(42, HEAD_B));
		gh.on(files, page);
		const reread = await fetchPullDiff({ repo: "acme/web", number: 42 }, port(gh));
		expect(reread.ok && reread.headSha).toBe(HEAD_B);

		// The BASE moves with the head unchanged: read again.
		const BASE_B = "d".repeat(40);
		gh = fakeProvider();
		gh.on(`GET ${path}`, pull(42, HEAD_A), pull(42, HEAD_A, BASE_B), pull(42, HEAD_A, BASE_B), pull(42, HEAD_A, BASE_B));
		gh.on(files, page);
		const rebased = await fetchPullDiff({ repo: "acme/web", number: 42 }, port(gh));
		expect(rebased.ok && rebased.baseSha).toBe(BASE_B);

		// It keeps moving: refused rather than passed off as pinned.
		gh = fakeProvider();
		gh.on(`GET ${path}`, pull(42, HEAD_A), pull(42, HEAD_B), pull(42, HEAD_B), pull(42, HEAD_A));
		gh.on(files, page);
		expect(await fetchPullDiff({ repo: "acme/web", number: 42 }, port(gh))).toEqual({ ok: false, reason: "moved" });
	});

	it("G4: a PR past the 300-file bound is `too_large` before its files are listed", async () => {
		const gh = fakeProvider();
		const path = `${API}/repos/acme/web/pulls/43`;
		gh.on(`GET ${path}`, pull(43, HEAD_A, BASE_SHA, 301));
		const port = makePort(gh.fetch, { "github github.com": installation });
		expect(await fetchPullDiff({ repo: "acme/web", number: 43 }, port)).toEqual({ ok: false, reason: "too_large" });
		expect(gh.calls.map((c) => c.url)).toEqual([path]);
	});

	it("G7: the files list is read every page to exhaustion", async () => {
		const gh = fakeProvider();
		const path = `${API}/repos/acme/web/pulls/45`;
		const first = Array.from({ length: 100 }, (_, i) => ({ ...authFile, filename: `src/f${String(i).padStart(3, "0")}.ts` }));
		const second = [{ ...authFile, filename: "src/last.ts" }];
		gh.on(`GET ${path}`, pull(45, HEAD_A, BASE_SHA, 101), pull(45, HEAD_A, BASE_SHA, 101));
		gh.on(`GET ${path}/files?per_page=100&page=1`, () => json(200, first));
		gh.on(`GET ${path}/files?per_page=100&page=2`, () => json(200, second));
		const port = makePort(gh.fetch, { "github github.com": installation });
		const read = await fetchPullDiff({ repo: "acme/web", number: 45 }, port);
		if (!read.ok) throw new Error(`diff failed: ${read.reason}`);
		const headers = read.diff.split("\n").filter((line) => line.startsWith("diff --git "));
		expect(headers).toHaveLength(101);
		expect(headers[0]).toBe("diff --git a/src/f000.ts b/src/f000.ts");
		expect(headers[100]).toBe("diff --git a/src/last.ts b/src/last.ts");
		expect(gh.calls.map((c) => c.url).filter((u) => u.includes("/files"))).toEqual([
			`${path}/files?per_page=100&page=1`,
			`${path}/files?per_page=100&page=2`,
		]);
		// listPullFiles reads the same pages and the head it was listed at.
		gh.on(`GET ${path}`, pull(45, HEAD_A, BASE_SHA, 101));
		const listed = await listPullFiles({ repo: "acme/web", number: 45 }, port);
		expect(listed.ok && listed.files.length).toBe(101);
		expect(listed.ok && listed.headSha).toBe(HEAD_A);
	});

	it("G8: renames, additions, deletions and a pure rename carry git's headers", async () => {
		const gh = fakeProvider();
		const path = `${API}/repos/acme/web/pulls/46`;
		gh.on(`GET ${path}`, pull(46, HEAD_A, BASE_SHA, 4), pull(46, HEAD_A, BASE_SHA, 4));
		gh.on(`GET ${path}/files?per_page=100&page=1`, () =>
			json(200, [
				{ ...authFile, filename: "src/session.ts", previous_filename: "src/auth.ts", status: "renamed" },
				{ sha: SHA_F, filename: "src/new.ts", status: "added", additions: 1, deletions: 0, changes: 1, patch: "@@ -0,0 +1 @@\n+export const x = 1;" },
				{ sha: SHA_F, filename: "src/gone.ts", status: "removed", additions: 0, deletions: 1, changes: 1, patch: "@@ -1 +0,0 @@\n-export const y = 2;" },
				{ sha: SHA_F, filename: "docs/b.md", previous_filename: "docs/a.md", status: "renamed", additions: 0, deletions: 0, changes: 0 },
			]),
		);
		const read = await fetchPullDiff({ repo: "acme/web", number: 46 }, makePort(gh.fetch, { "github github.com": installation }));
		if (!read.ok) throw new Error(`diff failed: ${read.reason}`);
		expect(read.diff).toBe(
			[
				"diff --git a/src/auth.ts b/src/session.ts",
				"rename from src/auth.ts",
				"rename to src/session.ts",
				"--- a/src/auth.ts",
				"+++ b/src/session.ts",
				AUTH_PATCH,
				"diff --git a/src/new.ts b/src/new.ts",
				"new file mode 100644",
				"--- /dev/null",
				"+++ b/src/new.ts",
				"@@ -0,0 +1 @@",
				"+export const x = 1;",
				"diff --git a/src/gone.ts b/src/gone.ts",
				"deleted file mode 100644",
				"--- a/src/gone.ts",
				"+++ /dev/null",
				"@@ -1 +0,0 @@",
				"-export const y = 2;",
				"diff --git a/docs/a.md b/docs/b.md",
				"rename from docs/a.md",
				"rename to docs/b.md",
				"",
			].join("\n"),
		);
	});

	it("G9: a file GitHub sends no patch for gets its header and a marker, never a throw", async () => {
		const gh = fakeProvider();
		const path = `${API}/repos/acme/web/pulls/47`;
		gh.on(`GET ${path}`, pull(47, HEAD_A, BASE_SHA, 3), pull(47, HEAD_A, BASE_SHA, 3));
		gh.on(`GET ${path}/files?per_page=100&page=1`, () =>
			json(200, [
				{ sha: SHA_F, filename: "img/logo.png", status: "added", additions: 0, deletions: 0, changes: 0 },
				{ sha: SHA_F, filename: "img/icon.png", status: "modified", additions: 0, deletions: 0, changes: 0 },
				{ sha: SHA_F, filename: "data/big.json", status: "modified", additions: 40000, deletions: 12, changes: 40012 },
			]),
		);
		const read = await fetchPullDiff({ repo: "acme/web", number: 47 }, makePort(gh.fetch, { "github github.com": installation }));
		if (!read.ok) throw new Error(`diff failed: ${read.reason}`);
		expect(read.diff).toBe(
			[
				"diff --git a/img/logo.png b/img/logo.png",
				"new file mode 100644",
				"Binary files /dev/null and b/img/logo.png differ",
				"diff --git a/img/icon.png b/img/icon.png",
				"Binary files a/img/icon.png and b/img/icon.png differ",
				"diff --git a/data/big.json b/data/big.json",
				"GitHub did not include this file's diff (too large to show): 40000 additions, 12 deletions",
				"",
			].join("\n"),
		);
	});

	it("G5: a credential the port proves dead marks the read credentialDead; an invalid pull is not_linked before any credential", async () => {
		const gh = fakeProvider();
		const dead = makePort(gh.fetch, { "github github.com": { kind: "unavailable", credentialDead: true } });
		expect(await githubScopes(dead)).toEqual({ ok: false, reason: "not_resolvable", credentialDead: true });
		expect(await readPullSummary({ repo: "acme/web", number: 1 }, dead)).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: true,
		});
		expect(await readPullSummary({ repo: "bad_owner/web", number: 1 }, dead)).toEqual({ ok: false, reason: "not_linked" });
		expect(dead.asked).toEqual(["github github.com", "github github.com"]);
		expect(gh.calls).toHaveLength(0);
		// The adapter carries the pull reads under `pulls`.
		expect(githubAdapter.pulls?.diff).toBe(fetchPullDiff);
	});
});
