// list(query): one filtered page of issues per provider. New in Plannotator
// (not ported from Workspaces). Canned GraphQL answers behind the port's
// fetch only. Guards: each filter reaches the provider in its own words;
// oldest first is honoured (Linear by reading backwards); labels mean every
// label; search values cannot add a qualifier or an operator; rows carry the
// grammar's canonical, the filter facts and the provider's state; inputs are
// checked before any credential is asked; rows outside the scope, host or
// workspace, or failing the re-check, are dropped, and an emptied page keeps
// its cursor.

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

import { createGithubAdapter, githubAdapter } from "../src/adapters/github.ts";
import { createGitlabAdapter, gitlabAdapter } from "../src/adapters/gitlab.ts";
import { linearAdapter } from "../src/adapters/linear.ts";
import type { ReferenceCredential } from "../src/port.ts";
import { fakeProvider, json, makePort, type SeenCall } from "./helpers.ts";

let info: Mock<typeof console.info>;
beforeEach(() => {
	info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	info.mockRestore();
});

interface GraphqlBody {
	query: string;
	variables: Record<string, unknown>;
}
const bodyOf = (call: SeenCall): GraphqlBody => JSON.parse(call.body ?? "{}") as GraphqlBody;

// ── GitHub ──────────────────────────────────────────────────────────────────

const GH_GRAPHQL = "POST https://api.github.com/graphql";
const ghToken: ReferenceCredential = { kind: "bearer", token: "token-user", host: "github.com" };

function ghIssue(n: number, over: Record<string, unknown> = {}) {
	return {
		number: n,
		title: `Issue ${n}`,
		url: `https://github.com/acme/web/issues/${n}`,
		state: "OPEN",
		stateReason: null,
		createdAt: `2026-01-0${n}T00:00:00Z`,
		updatedAt: "2026-02-01T00:00:00Z",
		author: { login: "mara" },
		labels: { nodes: [{ name: "bug" }, { name: "p1" }] },
		assignees: { nodes: [{ login: "mara" }] },
		milestone: { title: "v1" },
		...over,
	};
}

describe("GitHub list", () => {
	it("reads repository.issues with filterBy and orderBy: oldest first, one label re-checked, facts with filter fields", async () => {
		const gh = fakeProvider();
		gh.on(GH_GRAPHQL, ({ headers }) => {
			expect(headers.get("authorization")).toBe("Bearer token-user");
			return json(200, {
				data: {
					repository: {
						issues: {
							pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjI=" },
							nodes: [
								ghIssue(1),
								// Without the label asked for: the re-check drops it.
								ghIssue(2, { labels: { nodes: [{ name: "p1" }] } }),
								ghIssue(3, { state: "CLOSED", stateReason: "NOT_PLANNED", milestone: null, assignees: { nodes: [] } }),
							],
						},
					},
				},
			});
		});
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		const result = await githubAdapter.list?.(
			{ scope: "acme/web", state: "all", labels: ["BUG"], assignee: "mara", order: "created_asc" },
			port,
		);
		const call = gh.calls[0];
		if (call === undefined) throw new Error("no call");
		const { query, variables } = bodyOf(call);
		expect(query).toContain("repository(owner: $owner, name: $name)");
		expect(variables).toEqual({
			owner: "acme",
			name: "web",
			first: 100,
			after: null,
			filterBy: { labels: ["BUG"], assignee: "mara" },
			orderBy: { field: "CREATED_AT", direction: "ASC" },
		});
		expect(result).toEqual({
			ok: true,
			cursor: "Y3Vyc29yOjI=",
			items: [
				{
					ref: { provider: "github", key: "acme/web#1", url: "https://github.com/acme/web/issues/1" },
					kind: "issue",
					shortId: "web#1",
					title: "Issue 1",
					state: { label: "Open", tone: "open" },
					author: "mara",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-02-01T00:00:00Z",
					labels: ["bug", "p1"],
					assignees: ["mara"],
					milestone: "v1",
				},
				{
					ref: { provider: "github", key: "acme/web#3", url: "https://github.com/acme/web/issues/3" },
					kind: "issue",
					shortId: "web#3",
					title: "Issue 3",
					state: { label: "Closed", tone: "closed" },
					author: "mara",
					createdAt: "2026-01-03T00:00:00Z",
					updatedAt: "2026-02-01T00:00:00Z",
					labels: ["bug", "p1"],
					assignees: [],
				},
			],
		});
	});

	it("defaults to open issues, most recently updated first, and passes the cursor back", async () => {
		const gh = fakeProvider();
		gh.on(GH_GRAPHQL, () => json(200, { data: { repository: { issues: { pageInfo: { hasNextPage: false }, nodes: [] } } } }));
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		expect(await githubAdapter.list?.({ scope: "acme/web", cursor: "Y3Vyc29yOjI=" }, port)).toEqual({ ok: true, items: [] });
		const call = gh.calls[0];
		if (call === undefined) throw new Error("no call");
		expect(bodyOf(call).variables).toMatchObject({
			after: "Y3Vyc29yOjI=",
			filterBy: { states: ["OPEN"] },
			orderBy: { field: "UPDATED_AT", direction: "DESC" },
		});
	});

	it("with no text, two labels and a milestone stay off search: filterBy takes the first label and the milestone number; the re-check requires the rest", async () => {
		const gh = fakeProvider();
		const milestonePages = [
			{ pageInfo: { hasNextPage: true, endCursor: "bTE=" }, nodes: [{ number: 7, title: "v1.1" }] },
			{ pageInfo: { hasNextPage: false }, nodes: [{ number: 3, title: "V1" }] },
		];
		gh.on(GH_GRAPHQL, (call) => {
			const { query } = bodyOf(call);
			if (query.includes("milestones(")) {
				return json(200, { data: { repository: { milestones: milestonePages.shift() } } });
			}
			return json(200, {
				data: {
					repository: {
						issues: {
							pageInfo: { hasNextPage: false },
							nodes: [
								ghIssue(1, { milestone: { title: "V1" } }),
								// Another milestone, or one label short: dropped.
								ghIssue(2, { milestone: { title: "v1.1" } }),
								ghIssue(3, { labels: { nodes: [{ name: "bug" }] } }),
								// Labels past the page read for the row: kept, never dropped for a label.
								ghIssue(4, { labels: { pageInfo: { hasNextPage: true }, nodes: [{ name: "bug" }] } }),
							],
						},
					},
				},
			});
		});
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		const result = await githubAdapter.list?.({ scope: "acme/web", labels: ["bug", "p1"], milestone: "v1" }, port);
		expect(result?.ok && result.items.map((i) => i.ref.key)).toEqual(["acme/web#1", "acme/web#4"]);
		expect(gh.calls.map((c) => bodyOf(c).variables)).toEqual([
			{ owner: "acme", name: "web", query: "v1", after: null },
			{ owner: "acme", name: "web", query: "v1", after: "bTE=" },
			{
				owner: "acme",
				name: "web",
				first: 100,
				after: null,
				filterBy: { states: ["OPEN"], labels: ["bug"], milestoneNumber: "3" },
				orderBy: { field: "UPDATED_AT", direction: "DESC" },
			},
		]);
		expect(gh.calls.some((c) => bodyOf(c).query.includes("search("))).toBe(false);
	});

	it("two labels with no text read repository.issues and answer only rows with both labels", async () => {
		const gh = fakeProvider();
		gh.on(GH_GRAPHQL, () =>
			json(200, {
				data: {
					repository: {
						issues: {
							pageInfo: { hasNextPage: false },
							nodes: [ghIssue(1), ghIssue(2, { labels: { nodes: [{ name: "bug" }] } }), ghIssue(3, { labels: { nodes: [{ name: "P1" }, { name: "BUG" }] } })],
						},
					},
				},
			}),
		);
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		const result = await githubAdapter.list?.({ scope: "acme/web", labels: ["bug", "p1"] }, port);
		expect(result?.ok && result.items.map((i) => i.ref.key)).toEqual(["acme/web#1", "acme/web#3"]);
		const call = gh.calls[0];
		if (call === undefined) throw new Error("no call");
		expect(bodyOf(call).query).toContain("repository(owner: $owner, name: $name)");
		expect(bodyOf(call).variables["filterBy"]).toEqual({ states: ["OPEN"], labels: ["bug"] });
	});

	it("a milestone the repository does not have is an empty page, with no issue read", async () => {
		const gh = fakeProvider();
		gh.on(GH_GRAPHQL, () =>
			json(200, { data: { repository: { milestones: { pageInfo: { hasNextPage: false }, nodes: [{ number: 7, title: "v1.1" }] } } } }),
		);
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		expect(await githubAdapter.list?.({ scope: "acme/web", milestone: "v1" }, port)).toEqual({ ok: true, items: [] });
		expect(gh.calls).toHaveLength(1);
	});

	it("a page whose rows all fail the re-check is empty and still carries the cursor", async () => {
		const gh = fakeProvider();
		gh.on(GH_GRAPHQL, () =>
			json(200, {
				data: {
					repository: {
						issues: {
							pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29yOjk=" },
							nodes: [ghIssue(1, { state: "CLOSED" }), ghIssue(2, { labels: { nodes: [{ name: "bug" }] } })],
						},
					},
				},
			}),
		);
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		expect(await githubAdapter.list?.({ scope: "acme/web", labels: ["bug", "p1"] }, port)).toEqual({
			ok: true,
			items: [],
			cursor: "Y3Vyc29yOjk=",
		});
	});

	it("with text, a label or milestone with a colon keeps it inside its quotes; free-text operators are neutralised", async () => {
		const gh = fakeProvider();
		gh.on(GH_GRAPHQL, () =>
			json(200, {
				data: {
					search: {
						pageInfo: {},
						nodes: [ghIssue(1, { labels: { nodes: [{ name: "type: bug" }] }, milestone: { title: "Q1: launch" } })],
					},
				},
			}),
		);
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		const result = await githubAdapter.list?.(
			{ scope: "acme/web", labels: ["type: bug"], milestone: "Q1: launch", text: "crash OR (is:pr) -label:x NOT y AND z" },
			port,
		);
		expect(result?.ok && result.items.map((i) => i.ref.key)).toEqual(["acme/web#1"]);
		expect(gh.calls).toHaveLength(1);
		const call = gh.calls[0];
		if (call === undefined) throw new Error("no call");
		expect(bodyOf(call).query).toContain("search(query: $q, type: ISSUE");
		expect(bodyOf(call).variables["q"]).toBe(
			'repo:acme/web is:issue is:open label:"type: bug" milestone:"Q1: launch" sort:updated-desc "crash" "OR" "is:pr" "-label:x" "NOT" "y" "AND" "z"',
		);
	});

	it("with text, a label or milestone holding a quote, or text past GitHub's 256-character limit, is a filter error with no credential asked", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		for (const query of [
			{ scope: "acme/web", labels: ['say "hi"'], text: "crash" },
			{ scope: "acme/web", milestone: "back\\slash", text: "crash" },
			// 100 one-letter words: 199 characters raw, 399 once each word is quoted.
			{ scope: "acme/web", text: Array(100).fill("a").join(" ") },
		]) {
			expect(await githubAdapter.list?.(query, port), JSON.stringify(query)).toEqual({
				ok: false,
				reason: "not_resolvable",
				field: "filter",
			});
		}
		expect(port.asked).toEqual([]);
		expect(gh.calls).toEqual([]);
	});

	it("an Enterprise Managed User login (with `_`) is a valid assignee on a *.ghe.com host", async () => {
		const gh = fakeProvider();
		const host = "acme.ghe.com";
		gh.on(`POST https://api.${host}/graphql`, () =>
			json(200, {
				data: {
					repository: {
						issues: { pageInfo: {}, nodes: [ghIssue(1, { url: `https://${host}/acme/web/issues/1`, assignees: { nodes: [{ login: "mona_acme" }] } })] },
					},
				},
			}),
		);
		const adapter = createGithubAdapter({ hosts: [host] });
		const port = makePort(gh.fetch, { [`github ${host}`]: { kind: "bearer", token: "token-ghe", host } });
		const result = await adapter.list?.({ scope: "acme/web", host, assignee: "mona_acme" }, port);
		expect(result?.ok && result.items.map((i) => i.ref.key)).toEqual([`${host}:acme/web#1`]);
		const call = gh.calls[0];
		if (call === undefined) throw new Error("no call");
		expect(bodyOf(call).variables["filterBy"]).toEqual({ states: ["OPEN"], assignee: "mona_acme" });
	});

	it("text uses the search API with qualifiers that cannot be widened; rows from another repository or a PR are dropped", async () => {
		const gh = fakeProvider();
		gh.on(GH_GRAPHQL, () =>
			json(200, {
				data: {
					search: {
						pageInfo: { hasNextPage: false, endCursor: null },
						nodes: [
							ghIssue(4),
							ghIssue(5, { url: "https://github.com/other/secret/issues/5" }),
							{},
						],
					},
				},
			}),
		);
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		const result = await githubAdapter.list?.(
			{ scope: "acme/web", text: 'login "fails" repo:other/secret', labels: ["needs review"], order: "created_asc" },
			port,
		);
		expect(result?.ok && result.items.map((i) => i.ref.url)).toEqual([]);
		const call = gh.calls[0];
		if (call === undefined) throw new Error("no call");
		const { query, variables } = bodyOf(call);
		expect(query).toContain("search(query: $q, type: ISSUE");
		expect(variables["q"]).toBe(
			'repo:acme/web is:issue is:open label:"needs review" sort:created-asc "login" "fails" "repo:other/secret"',
		);
		// The label filter narrowed ghIssue(4) (bug, p1) away; without it the row stays.
		const plain = await githubAdapter.list?.({ scope: "acme/web", text: "login" }, port);
		expect(plain?.ok && plain.items.map((i) => i.ref.url)).toEqual(["https://github.com/acme/web/issues/4"]);
	});

	it("inputs are checked before any credential is asked", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		expect(await githubAdapter.list?.({}, port)).toMatchObject({ field: "scope" });
		expect(await githubAdapter.list?.({ scope: "acme" }, port)).toMatchObject({ field: "scope" });
		expect(await githubAdapter.list?.({ scope: "acme/web", cursor: "bad cursor" }, port)).toMatchObject({ field: "cursor" });
		expect(await githubAdapter.list?.({ scope: "acme/web", labels: [" "] }, port)).toMatchObject({ field: "filter" });
		expect(await githubAdapter.list?.({ scope: "acme/web", assignee: "a b" }, port)).toMatchObject({ field: "filter" });
		expect(await githubAdapter.list?.({ scope: "acme/web", host: "github.acme.example" }, port)).toMatchObject({ field: "scope" });
		expect(port.asked).toEqual([]);
		expect(gh.calls).toEqual([]);
	});

	it("no credential is not_linked; a hidden repository is not_linked; rate limits are flagged", async () => {
		const gh = fakeProvider();
		expect(await githubAdapter.list?.({ scope: "acme/web" }, makePort(gh.fetch))).toEqual({ ok: false, reason: "not_linked" });
		expect(gh.calls).toEqual([]);
		const port = makePort(gh.fetch, { "github github.com": ghToken });
		gh.on(
			GH_GRAPHQL,
			() => json(200, { data: { repository: null }, errors: [{ type: "NOT_FOUND" }] }),
			() => json(200, { data: null, errors: [{ type: "RATE_LIMITED" }] }),
			() => json(403, { message: "rate limit" }),
		);
		expect(await githubAdapter.list?.({ scope: "acme/web" }, port)).toEqual({ ok: false, reason: "not_linked" });
		expect(await githubAdapter.list?.({ scope: "acme/web" }, port)).toEqual({ ok: false, reason: "not_resolvable", rateLimited: true });
		expect(await githubAdapter.list?.({ scope: "acme/web" }, port)).toEqual({ ok: false, reason: "not_resolvable", rateLimited: true });
	});

	it("a GitHub Enterprise host lists from its own GraphQL endpoint with its own credential, and answers its own rows only", async () => {
		const gh = fakeProvider();
		gh.on("POST https://github.acme.example/api/graphql", () =>
			json(200, {
				data: {
					repository: {
						issues: {
							pageInfo: {},
							nodes: [
								ghIssue(6, { url: "https://github.acme.example/acme/web/issues/6" }),
								// The same repository path on another served host: not this list's.
								ghIssue(7),
							],
						},
					},
				},
			}),
		);
		const adapter = createGithubAdapter({ hosts: ["github.acme.example"] });
		const port = makePort(gh.fetch, {
			"github github.acme.example": { kind: "bearer", token: "token-ghes", host: "github.acme.example" },
		});
		const result = await adapter.list?.({ scope: "acme/web", host: "github.acme.example" }, port);
		expect(result?.ok && result.items.map((i) => i.ref.key)).toEqual(["github.acme.example:acme/web#6"]);
		expect(gh.calls.map((c) => c.headers.get("authorization"))).toEqual(["Bearer token-ghes"]);
	});
});

// ── GitLab ──────────────────────────────────────────────────────────────────

function glIssue(iid: number, over: Record<string, unknown> = {}) {
	return {
		iid: String(iid),
		title: `Issue ${iid}`,
		webUrl: `https://gitlab.com/g/sub/p/-/issues/${iid}`,
		state: "opened",
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-02-01T00:00:00Z",
		author: { username: "mara" },
		labels: { nodes: [{ title: "bug" }] },
		assignees: { nodes: [{ username: "josie" }] },
		milestone: { title: "16.0" },
		...over,
	};
}

describe("GitLab list", () => {
	it("reads project.issues with GitLab's own filters and sort, oldest first", async () => {
		const gl = fakeProvider();
		gl.on("POST https://gitlab.com/api/graphql", ({ headers }) => {
			expect(headers.get("PRIVATE-TOKEN")).toBe("token-gl");
			return json(200, {
				data: {
					project: {
						issues: {
							pageInfo: { hasNextPage: true, endCursor: "eyJpZCI6IjQyIn0" },
							nodes: [
								glIssue(1),
								glIssue(2, { webUrl: "https://gitlab.com/g/sub/p/-/work_items/2", state: "closed" }),
								// Another milestone (a wildcard such as `Started` can answer it): dropped.
								glIssue(3, { milestone: { title: "16.1" } }),
								// No milestone at all (the `Any`/`None` wildcards): dropped.
								glIssue(4, { milestone: null }),
							],
						},
					},
				},
			});
		});
		const port = makePort(gl.fetch, { "gitlab gitlab.com": { kind: "private-token", token: "token-gl", host: "gitlab.com" } });
		const result = await gitlabAdapter.list?.(
			{ scope: "g/sub/p", labels: ["bug"], assignee: "josie", milestone: "16.0", text: "cache", state: "all", order: "created_asc" },
			port,
		);
		const call = gl.calls[0];
		if (call === undefined) throw new Error("no call");
		const { query, variables } = bodyOf(call);
		expect(query).toContain("project(fullPath: $fullPath)");
		expect(variables).toEqual({
			fullPath: "g/sub/p",
			first: 100,
			after: null,
			state: "all",
			sort: "CREATED_ASC",
			labelName: ["bug"],
			assigneeUsernames: ["josie"],
			milestoneTitle: ["16.0"],
			search: "cache",
		});
		expect(result).toEqual({
			ok: true,
			cursor: "eyJpZCI6IjQyIn0",
			items: [
				{
					ref: { provider: "gitlab", key: "g/sub/p#1", url: "https://gitlab.com/g/sub/p/-/issues/1" },
					kind: "issue",
					shortId: "p#1",
					title: "Issue 1",
					state: { label: "Open", tone: "open" },
					author: "mara",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-02-01T00:00:00Z",
					labels: ["bug"],
					assignees: ["josie"],
					milestone: "16.0",
				},
				{
					ref: { provider: "gitlab", key: "g/sub/p#2", url: "https://gitlab.com/g/sub/p/-/issues/2" },
					kind: "issue",
					shortId: "p#2",
					title: "Issue 2",
					state: { label: "Closed", tone: "closed" },
					author: "mara",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-02-01T00:00:00Z",
					labels: ["bug"],
					assignees: ["josie"],
					milestone: "16.0",
				},
			],
		});
	});

	it("rows are re-checked: state, every label, and rows from another host are dropped", async () => {
		const host = "gitlab.acme.example";
		const gl = fakeProvider();
		gl.on(`POST https://${host}/api/graphql`, () =>
			json(200, {
				data: {
					project: {
						issues: {
							pageInfo: { hasNextPage: true, endCursor: "eyJpZCI6Ijk5In0" },
							nodes: [
								glIssue(1, { webUrl: `https://${host}/g/sub/p/-/issues/1`, state: "closed" }),
								glIssue(2, { webUrl: `https://${host}/g/sub/p/-/issues/2`, labels: { nodes: [{ title: "Any" }] } }),
								// The same project path on gitlab.com: not this list's.
								glIssue(3),
								glIssue(4, { webUrl: `https://${host}/g/sub/p/-/issues/4`, state: "locked" }),
							],
						},
					},
				},
			}),
		);
		const adapter = createGitlabAdapter({ hosts: [host] });
		const port = makePort(gl.fetch, { [`gitlab ${host}`]: { kind: "bearer", token: "token-sm", host } });
		expect(await adapter.list?.({ scope: "g/sub/p", host, labels: ["bug"] }, port)).toEqual({
			ok: true,
			cursor: "eyJpZCI6Ijk5In0",
			items: [expect.objectContaining({ ref: expect.objectContaining({ key: `${host}:g/sub/p#4` }) })],
		});
	});

	it("open is GitLab's opened, newest updated first; with no credential the public rung lists anonymously", async () => {
		const gl = fakeProvider();
		gl.on("POST https://gitlab.com/api/graphql", ({ headers }) => {
			expect(headers.get("PRIVATE-TOKEN")).toBeNull();
			expect(headers.get("authorization")).toBeNull();
			return json(200, { data: { project: { issues: { pageInfo: { hasNextPage: false }, nodes: [glIssue(3)] } } } });
		});
		const result = await gitlabAdapter.list?.({ scope: "g/sub/p" }, makePort(gl.fetch));
		expect(result?.ok && result.items.map((i) => i.ref.key)).toEqual(["g/sub/p#3"]);
		const call = gl.calls[0];
		if (call === undefined) throw new Error("no call");
		expect(bodyOf(call).variables).toEqual({ fullPath: "g/sub/p", first: 100, after: null, state: "opened", sort: "UPDATED_DESC" });
	});

	it("a self-managed host lists from its own API; a hidden project is not_linked; a 401 on a token is credential-dead", async () => {
		const host = "gitlab.acme.example";
		const gl = fakeProvider();
		gl.on(
			`POST https://${host}/api/graphql`,
			() =>
				json(200, {
					data: { project: { issues: { pageInfo: {}, nodes: [glIssue(4, { webUrl: `https://${host}/g/sub/p/-/issues/4` })] } } },
				}),
			() => json(200, { data: { project: null } }),
			() => json(401, { message: "401 Unauthorized" }),
		);
		const adapter = createGitlabAdapter({ hosts: [host] });
		const port = makePort(gl.fetch, { [`gitlab ${host}`]: { kind: "bearer", token: "token-sm", host } });
		const first = await adapter.list?.({ scope: "g/sub/p", host }, port);
		expect(first?.ok && first.items.map((i) => i.ref.key)).toEqual([`${host}:g/sub/p#4`]);
		expect(gl.calls[0]?.headers.get("authorization")).toBe("Bearer token-sm");
		expect(await adapter.list?.({ scope: "g/sub/p", host }, port)).toEqual({ ok: false, reason: "not_linked" });
		expect(await adapter.list?.({ scope: "g/sub/p", host }, port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: true,
		});
	});

	it("a scope that is not a project path is a scope error with no credential asked", async () => {
		const gl = fakeProvider();
		const port = makePort(gl.fetch);
		for (const scope of ["p", "g/../p", "g/p q"]) {
			expect(await gitlabAdapter.list?.({ scope }, port), scope).toMatchObject({ field: "scope" });
		}
		expect(port.asked).toEqual([]);
	});
});

// ── Linear ──────────────────────────────────────────────────────────────────

const LIN_GRAPHQL = "POST https://api.linear.app/graphql";
const linKey: ReferenceCredential = { kind: "linear-api-key", token: "key-lin", host: "linear.app", account: "acme" };

function linIssue(n: number, over: Record<string, unknown> = {}) {
	return {
		identifier: `ENG-${n}`,
		title: `Issue ${n}`,
		url: `https://linear.app/acme/issue/ENG-${n}/issue-${n}`,
		createdAt: `2026-01-0${n}T00:00:00.000Z`,
		updatedAt: "2026-02-01T00:00:00.000Z",
		state: { name: "Todo", type: "unstarted" },
		assignee: { name: "Mara Lee", displayName: "mara" },
		creator: { name: "Josie" },
		labels: { nodes: [{ name: "Bug" }] },
		projectMilestone: { name: "Beta" },
		...over,
	};
}

describe("Linear list", () => {
	it("oldest first reads the last page backwards and reverses it; every filter reaches Linear's IssueFilter", async () => {
		const lin = fakeProvider();
		lin.on(LIN_GRAPHQL, ({ headers }) => {
			expect(headers.get("authorization")).toBe("key-lin");
			return json(200, {
				data: {
					issues: {
						// Linear answers a `last` page in its own (newest first) order.
						pageInfo: { hasNextPage: false, endCursor: "end", hasPreviousPage: true, startCursor: "start-2" },
						nodes: [linIssue(2), linIssue(1, { assignee: null })],
					},
				},
			});
		});
		const port = makePort(lin.fetch, { "linear linear.app": linKey });
		const result = await linearAdapter.list?.(
			{ scope: "ENG", labels: ["bug"], assignee: "mara", milestone: "Beta", text: "export", order: "created_asc" },
			port,
		);
		const call = lin.calls[0];
		if (call === undefined) throw new Error("no call");
		expect(bodyOf(call).variables).toEqual({
			last: 100,
			before: null,
			orderBy: "createdAt",
			filter: {
				and: [
					{ team: { key: { eqIgnoreCase: "ENG" } } },
					{ state: { type: { nin: ["completed", "canceled"] } } },
					{ labels: { some: { name: { eqIgnoreCase: "bug" } } } },
					{ assignee: { or: [{ displayName: { eqIgnoreCase: "mara" } }, { email: { eqIgnoreCase: "mara" } }] } },
					{ projectMilestone: { name: { eqIgnoreCase: "Beta" } } },
					{ or: [{ title: { containsIgnoreCase: "export" } }, { description: { containsIgnoreCase: "export" } }] },
				],
			},
		});
		expect(result).toEqual({
			ok: true,
			cursor: "start-2",
			items: [
				{
					ref: { provider: "linear", key: "acme/ENG-1", url: "https://linear.app/acme/issue/ENG-1" },
					kind: "issue",
					shortId: "ENG-1",
					title: "Issue 1",
					state: { label: "Todo", tone: "open" },
					author: "Josie",
					createdAt: "2026-01-01T00:00:00.000Z",
					updatedAt: "2026-02-01T00:00:00.000Z",
					labels: ["Bug"],
					assignees: [],
					milestone: "Beta",
				},
				{
					ref: { provider: "linear", key: "acme/ENG-2", url: "https://linear.app/acme/issue/ENG-2" },
					kind: "issue",
					shortId: "ENG-2",
					title: "Issue 2",
					state: { label: "Todo", tone: "open" },
					author: "Mara Lee",
					createdAt: "2026-01-02T00:00:00.000Z",
					updatedAt: "2026-02-01T00:00:00.000Z",
					labels: ["Bug"],
					assignees: ["mara"],
					milestone: "Beta",
				},
			],
		});
	});

	it("oldest first, page two: the cursor is sent as `before` with `last: 100`; the next cursor is the startCursor until no previous page", async () => {
		const lin = fakeProvider();
		lin.on(
			LIN_GRAPHQL,
			() =>
				json(200, {
					data: {
						issues: {
							pageInfo: { hasNextPage: true, endCursor: "end-2", hasPreviousPage: true, startCursor: "start-3" },
							nodes: [linIssue(4), linIssue(3)],
						},
					},
				}),
			() =>
				json(200, {
					data: {
						issues: {
							// The newest page: no previous page, so no cursor even with a startCursor.
							pageInfo: { hasNextPage: true, endCursor: "end-3", hasPreviousPage: false, startCursor: "start-4" },
							nodes: [linIssue(6), linIssue(5)],
						},
					},
				}),
		);
		const port = makePort(lin.fetch, { "linear linear.app": linKey });
		const second = await linearAdapter.list?.({ order: "created_asc", cursor: "start-2" }, port);
		expect(second).toMatchObject({ ok: true, cursor: "start-3" });
		expect(second?.ok && second.items.map((i) => i.ref.key)).toEqual(["acme/ENG-3", "acme/ENG-4"]);
		const third = await linearAdapter.list?.({ order: "created_asc", cursor: "start-3" }, port);
		expect(third).toEqual({ ok: true, items: expect.any(Array) });
		expect(third?.ok && third.items.map((i) => i.ref.key)).toEqual(["acme/ENG-5", "acme/ENG-6"]);
		expect(lin.calls.map((call) => bodyOf(call).variables)).toEqual([
			{ last: 100, before: "start-2", orderBy: "createdAt", filter: { and: [{ state: { type: { nin: ["completed", "canceled"] } } }] } },
			{ last: 100, before: "start-3", orderBy: "createdAt", filter: { and: [{ state: { type: { nin: ["completed", "canceled"] } } }] } },
		]);
	});

	it("newest updated first pages forward; rows outside the credential's workspace are dropped", async () => {
		const lin = fakeProvider();
		lin.on(LIN_GRAPHQL, ({ headers }) => {
			expect(headers.get("authorization")).toBe("Bearer token-lin");
			return json(200, {
				data: {
					issues: {
						pageInfo: { hasNextPage: true, endCursor: "end-1" },
						nodes: [linIssue(3), linIssue(4, { url: "https://linear.app/zebra/issue/ENG-4" })],
					},
				},
			});
		});
		const port = makePort(lin.fetch, { "linear linear.app": { kind: "bearer", token: "token-lin", host: "linear.app", account: "acme" } });
		const result = await linearAdapter.list?.({ state: "closed" }, port);
		expect(result).toMatchObject({ ok: true, cursor: "end-1" });
		expect(result?.ok && result.items.map((i) => i.ref.key)).toEqual(["acme/ENG-3"]);
		const call = lin.calls[0];
		if (call === undefined) throw new Error("no call");
		expect(bodyOf(call).variables).toEqual({
			first: 100,
			after: null,
			orderBy: "updatedAt",
			filter: { and: [{ state: { type: { in: ["completed", "canceled"] } } }] },
		});
	});

	it("no credential, or one with no account, reads nothing with zero fetches; a 401 is credential-dead", async () => {
		const lin = fakeProvider();
		expect(await linearAdapter.list?.({}, makePort(lin.fetch))).toEqual({ ok: false, reason: "not_linked" });
		const unbound = makePort(lin.fetch, { "linear linear.app": { kind: "bearer", token: "token-lin", host: "linear.app" } });
		expect(await linearAdapter.list?.({}, unbound)).toEqual({ ok: false, reason: "not_linked" });
		expect(lin.calls).toEqual([]);
		lin.on(LIN_GRAPHQL, () => json(401, { errors: [] }));
		expect(await linearAdapter.list?.({}, makePort(lin.fetch, { "linear linear.app": linKey }))).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: true,
		});
	});
});
