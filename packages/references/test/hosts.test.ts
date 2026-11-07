// The `hosts` option: GitHub Enterprise and self-managed GitLab hosts.
// New in Plannotator (not ported from Workspaces). Guards: a served host
// matches and keeps its host in the canonical URL; github.com and
// gitlab.com keys and URLs stay byte-identical; each host's reads go to
// that host's own API with a credential asked for that host; a host the
// adapter does not serve is never asked for a credential or fetched.

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

import { createGithubAdapter, githubAdapter } from "../src/adapters/github.ts";
import { createGitlabAdapter, gitlabAdapter } from "../src/adapters/gitlab.ts";
import { linearAdapter } from "../src/adapters/linear.ts";
import type { ExternalRef, RefReadAdapter } from "../src/contract.ts";
import { githubGrammar } from "../src/grammars/github.ts";
import { gitlabGrammar } from "../src/grammars/gitlab.ts";
import type { ReferenceCredential } from "../src/port.ts";
import { createReferenceAdapters, createReferenceRegistry, matchExternalRef } from "../src/registry.ts";
import { fakeProvider, json, makePort } from "./helpers.ts";

let info: Mock<typeof console.info>;
beforeEach(() => {
	info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	info.mockRestore();
});

const GHES = "github.acme.example";
const GHE_CLOUD = "acme.ghe.com";
const GLSM = "gitlab.acme.example";

function refFrom(adapter: RefReadAdapter, url: string): ExternalRef {
	const ref = adapter.match(new URL(url));
	if (ref === null) throw new Error(`no match: ${url}`);
	return ref;
}

describe("host-aware grammars", () => {
	it("GitHub: an Enterprise host matches with its host in the canonical URL and key; github.com stays byte-identical", () => {
		const grammar = githubGrammar({ hosts: [GHES.toUpperCase()] });
		expect(grammar.match(new URL(`https://${GHES}/acme/web/pull/12/files`))).toEqual({
			provider: "github",
			key: `${GHES}:acme/web#12`,
			url: `https://${GHES}/acme/web/pull/12`,
		});
		expect(grammar.match(new URL("https://www.github.com/acme/web/issues/12"))).toEqual({
			provider: "github",
			key: "acme/web#12",
			url: "https://github.com/acme/web/issues/12",
		});
		// The same path on two hosts never shares a key.
		expect(grammar.match(new URL(`https://${GHES}/acme/web/issues/12`))?.key).not.toBe(
			grammar.match(new URL("https://github.com/acme/web/issues/12"))?.key,
		);
		expect(grammar.matchCodeLink(new URL(`https://${GHES}/acme/web/tree/feat/x`))).toEqual({
			kind: "branch",
			repoPath: "acme/web",
			branch: "feat/x",
			url: `https://${GHES}/acme/web/tree/feat/x`,
		});
		expect(grammar.matchCodeLink(new URL(`https://${GHES}/acme/web.git`))?.url).toBe(`https://${GHES}/acme/web`);
		// A port, another host, or the default grammar: plain links.
		expect(grammar.match(new URL(`https://${GHES}:8443/acme/web/issues/1`))).toBeNull();
		expect(grammar.match(new URL("https://github.other.example/acme/web/issues/1"))).toBeNull();
		expect(githubAdapter.match(new URL(`https://${GHES}/acme/web/issues/1`))).toBeNull();
	});

	it("GitLab: a self-managed host matches at any depth with its host in the canonical URL and key; gitlab.com stays byte-identical", () => {
		const grammar = gitlabGrammar({ hosts: [GLSM] });
		expect(grammar.match(new URL(`https://${GLSM}/g/sub/p/-/work_items/4`))).toEqual({
			provider: "gitlab",
			key: `${GLSM}:g/sub/p#4`,
			url: `https://${GLSM}/g/sub/p/-/issues/4`,
		});
		expect(grammar.match(new URL("https://gitlab.com/g/p/-/merge_requests/5"))).toEqual({
			provider: "gitlab",
			key: "g/p!5",
			url: "https://gitlab.com/g/p/-/merge_requests/5",
		});
		expect(grammar.matchCodeLink(new URL(`https://${GLSM}/g/p/-/merge_requests/5/diffs`))).toEqual({
			kind: "pr",
			repoPath: "g/p",
			number: 5,
			url: `https://${GLSM}/g/p/-/merge_requests/5`,
		});
		expect(gitlabAdapter.match(new URL(`https://${GLSM}/g/p/-/issues/4`))).toBeNull();
	});

	it("a host that is not a bare hostname is refused when the adapter is built", () => {
		for (const bad of ["https://github.acme.example", "github.acme.example:8443", "github.acme.example/x", "localhost", ""]) {
			expect(() => createGithubAdapter({ hosts: [bad] }), bad).toThrow(TypeError);
			expect(() => createGitlabAdapter({ hosts: [bad] }), bad).toThrow(TypeError);
		}
	});

	it("the registry composes host-configured adapters; the default registry stays on the public hosts", () => {
		const registry = createReferenceRegistry(createReferenceAdapters({ github: { hosts: [GHES] }, gitlab: { hosts: [GLSM] } }));
		expect(registry.allAdapters().map((a) => a.provider)).toEqual(["github", "gitlab", "linear"]);
		expect(registry.matchExternalRefUrl(`https://${GHES}/a/b/issues/1`)).toBe(`https://${GHES}/a/b/issues/1`);
		expect(registry.matchExternalRef(new URL(`https://${GLSM}/a/b/-/issues/1`))?.adapter.provider).toBe("gitlab");
		expect(registry.matchCodeLinkUrl(new URL(`https://${GLSM}/a/b`))?.provider).toBe("gitlab");
		expect(matchExternalRef(new URL(`https://${GHES}/a/b/issues/1`))).toBeNull();
	});

	it("the registry refuses a host named for both forges, one another provider owns, or one on another host's API origin", () => {
		const cases: Array<[string, Parameters<typeof createReferenceAdapters>[0]]> = [
			["both forges", { github: { hosts: [GHES] }, gitlab: { hosts: [GHES.toUpperCase()] } }],
			["gitlab.com as GitHub", { github: { hosts: ["gitlab.com"] } }],
			["www.gitlab.com as GitHub", { github: { hosts: ["www.gitlab.com"] } }],
			["github.com as GitLab", { gitlab: { hosts: ["github.com"] } }],
			["linear.app as GitLab", { gitlab: { hosts: ["linear.app"] } }],
			// Another host's API origin.
			["api.github.com as GitHub", { github: { hosts: ["api.github.com"] } }],
			["api.github.com as GitLab", { gitlab: { hosts: ["api.github.com"] } }],
			["api.linear.app as GitHub", { github: { hosts: ["api.linear.app"] } }],
			["api.acme.ghe.com beside acme.ghe.com", { github: { hosts: [GHE_CLOUD] }, gitlab: { hosts: [`api.${GHE_CLOUD}`] } }],
		];
		for (const [name, hosts] of cases) {
			expect(() => createReferenceAdapters(hosts), name).toThrow(TypeError);
		}
		// A forge's own www. alias is its public host, not a clash.
		expect(() => createReferenceAdapters({ github: { hosts: ["www.github.com", GHES] }, gitlab: { hosts: [GLSM] } })).not.toThrow();
	});
});

describe("resolve reads only a canonical the grammar mints", () => {
	it("a hand-made ref whose URL is not its grammar's canonical is not_resolvable, with no credential asked and no fetch", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch, async (_provider, host) => ({ kind: "bearer", token: "token-any", host }));
		const github = createGithubAdapter({ hosts: [GHES] });
		const gitlab = createGitlabAdapter({ hosts: [GLSM] });
		const forged: Array<[RefReadAdapter, string]> = [
			[github, `https://${GHES}/o/r%2F..%2F..%2Fx/issues/1`],
			[github, `https://${GHES}/o/r/issues/1/../../../x`],
			[github, `https://${GHES}/o/r/issues/1?x=1`],
			[gitlab, `https://${GLSM}/g/p%2F..%2Fx/-/issues/1`],
			[gitlab, `https://${GLSM}/g/p/-/work_items/1`],
			[linearAdapter, "https://linear.app/acme/issue/ENG-1?x=1"],
			[linearAdapter, "https://LINEAR.app/acme/issue/ENG-1"],
		];
		for (const [adapter, url] of forged) {
			const ref: ExternalRef = { provider: adapter.provider, key: "x", url };
			expect(await adapter.resolve(ref, port), url).toEqual({ ok: false, reason: "not_resolvable" });
		}
		expect(port.asked).toEqual([]);
		expect(gh.calls).toEqual([]);
	});
});

describe("GitHub Enterprise reads", () => {
	const ghes: ReferenceCredential = { kind: "bearer", token: "token-ghes", host: GHES };
	const dotcom: ReferenceCredential = { kind: "bearer", token: "token-dotcom", host: "github.com" };
	const adapter = createGithubAdapter({ hosts: [GHES, GHE_CLOUD] });

	it("resolve reads the Enterprise Server API (/api/v3) with the credential asked for that host", async () => {
		const gh = fakeProvider();
		gh.on(`GET https://${GHES}/api/v3/repos/acme/web/issues/3`, ({ headers }) => {
			expect(headers.get("authorization")).toBe("Bearer token-ghes");
			return json(200, { title: "On prem", state: "open", user: { login: "mara" } });
		});
		const port = makePort(gh.fetch, { [`github ${GHES}`]: ghes, "github github.com": dotcom });
		const result = await adapter.resolve(refFrom(adapter, `https://${GHES}/acme/web/issues/3`), port);
		expect(result).toMatchObject({ ok: true, facts: { kind: "issue", shortId: "web#3", title: "On prem" } });
		expect(port.asked).toEqual([`github ${GHES}`]);
		expect(gh.calls.map((c) => c.url)).toEqual([`https://${GHES}/api/v3/repos/acme/web/issues/3`]);
	});

	it("a *.ghe.com host reads api.{host}; a github.com token is never sent to it", async () => {
		const gh = fakeProvider();
		gh.on(`GET https://api.${GHE_CLOUD}/repos/acme/web/pulls/4`, () => json(200, { title: "Cloud", state: "open", merged: false }));
		// The port answers only github.com: the ghe.com read rides with no token.
		const port = makePort(gh.fetch, async () => dotcom);
		const result = await adapter.resolve(refFrom(adapter, `https://${GHE_CLOUD}/acme/web/pull/4`), port);
		expect(result.ok).toBe(true);
		expect(gh.calls.map((c) => [c.url, c.headers.get("authorization")])).toEqual([
			[`https://api.${GHE_CLOUD}/repos/acme/web/pulls/4`, null],
		]);
	});

	it("search and pull reads take a host: the Enterprise API, its credential, and canonicals on that host", async () => {
		const gh = fakeProvider();
		gh.on(`GET https://${GHES}/api/v3/repos/acme/web/issues?state=open&sort=updated&direction=desc&per_page=100&page=1`, () =>
			json(200, [{ number: 9, title: "Fix login", user: { login: "mara" } }]),
		);
		gh.on(`GET https://${GHES}/api/v3/repos/acme/web/pulls/2`, () =>
			json(200, {
				title: "t",
				state: "open",
				base: { ref: "main", sha: "c".repeat(40) },
				head: { ref: "f", sha: "a".repeat(40) },
				additions: 1,
				deletions: 0,
				changed_files: 1,
			}),
		);
		const port = makePort(gh.fetch, { [`github ${GHES}`]: ghes });
		const found = await adapter.search?.({ query: "", scope: "acme/web", include: "issues", host: GHES }, port);
		expect(found?.ok && found.items.map((i) => [i.ref.key, i.ref.url])).toEqual([
			[`${GHES}:acme/web#9`, `https://${GHES}/acme/web/issues/9`],
		]);
		const summary = await adapter.pulls?.summary({ repo: "acme/web", number: 2, host: GHES }, port);
		expect(summary?.ok && summary.url).toBe(`https://${GHES}/acme/web/pull/2`);
		expect(gh.calls.every((c) => c.headers.get("authorization") === "Bearer token-ghes")).toBe(true);
	});

	it("a host the adapter does not serve: no credential asked, no fetch", async () => {
		const gh = fakeProvider();
		const port = makePort(gh.fetch, async (_provider, host) => ({ kind: "bearer", token: "token-any", host }));
		const elsewhere = "github.other.example";
		expect(await adapter.search?.({ query: "", scope: "acme/web", host: elsewhere }, port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			field: "scope",
		});
		expect(await adapter.scopes?.(port, { host: elsewhere })).toEqual({ ok: false, reason: "not_resolvable", field: "scope" });
		expect(await adapter.pulls?.summary({ repo: "acme/web", number: 2, host: elsewhere }, port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		// A hand-made ref on that host is not read either.
		const forged: ExternalRef = { provider: "github", key: "x", url: `https://${elsewhere}/acme/web/issues/1` };
		expect(await adapter.resolve(forged, port)).toEqual({ ok: false, reason: "not_resolvable" });
		// And the default adapter serves github.com only.
		expect(await githubAdapter.search?.({ query: "", scope: "acme/web", host: GHES }, port)).toMatchObject({ field: "scope" });
		expect(port.asked).toEqual([]);
		expect(gh.calls).toEqual([]);
	});
});

describe("self-managed GitLab reads", () => {
	const adapter = createGitlabAdapter({ hosts: [GLSM] });

	it("resolve reads that host's own API with the credential asked for it", async () => {
		const gl = fakeProvider();
		gl.on(`GET https://${GLSM}/api/v4/projects/g%2Fsub%2Fp/issues/4`, ({ headers }) => {
			expect(headers.get("PRIVATE-TOKEN")).toBe("token-sm");
			return json(200, { title: "Self-managed", state: "opened" });
		});
		const port = makePort(gl.fetch, { [`gitlab ${GLSM}`]: { kind: "private-token", token: "token-sm", host: GLSM } });
		const result = await adapter.resolve(refFrom(adapter, `https://${GLSM}/g/sub/p/-/issues/4`), port);
		expect(result).toMatchObject({ ok: true, facts: { shortId: "p#4", title: "Self-managed" } });
		expect(port.asked).toEqual([`gitlab ${GLSM}`]);
	});

	it("with no credential the read stays on that host, anonymous; a gitlab.com token never goes there", async () => {
		const gl = fakeProvider();
		gl.on(`GET https://${GLSM}/api/v4/projects/g%2Fp/issues/4`, () => json(200, { title: "Public", state: "opened" }));
		const port = makePort(gl.fetch, async () => ({ kind: "private-token", token: "token-dotcom", host: "gitlab.com" }));
		expect((await adapter.resolve(refFrom(adapter, `https://${GLSM}/g/p/-/issues/4`), port)).ok).toBe(true);
		expect(gl.calls.map((c) => [c.url, c.headers.get("PRIVATE-TOKEN")])).toEqual([
			[`https://${GLSM}/api/v4/projects/g%2Fp/issues/4`, null],
		]);
	});
});
