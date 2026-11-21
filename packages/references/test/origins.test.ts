// apiOrigin(provider, host): the one origin every provider call for an
// item on a host goes to. New in Plannotator (not ported from Workspaces).
// Guards: the origin table for each host kind, and that every read of
// every adapter, for host H, reaches the port's fetch on apiOrigin(H) only,
// so a port that binds its fetch to that origin never refuses a real read.

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

import { createGithubAdapter } from "../src/adapters/github.ts";
import { githubApiBase, githubGraphqlUrl } from "../src/adapters/github-pulls.ts";
import { createGitlabAdapter, gitlabApiBase } from "../src/adapters/gitlab.ts";
import { linearAdapter } from "../src/adapters/linear.ts";
import type { RefReadAdapter } from "../src/contract.ts";
import { apiOrigin } from "../src/hosts.ts";
import type { FetchLike, ReferencePort } from "../src/port.ts";
import { json } from "./helpers.ts";

let info: Mock<typeof console.info>;
beforeEach(() => {
	info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	info.mockRestore();
});

describe("apiOrigin", () => {
	it("answers each host kind's origin", () => {
		expect(apiOrigin("github", "github.com")).toBe("https://api.github.com");
		expect(apiOrigin("github", "acme.ghe.com")).toBe("https://api.acme.ghe.com");
		expect(apiOrigin("github", "github.acme.example")).toBe("https://github.acme.example");
		expect(apiOrigin("gitlab", "gitlab.com")).toBe("https://gitlab.com");
		expect(apiOrigin("gitlab", "gitlab.acme.example")).toBe("https://gitlab.acme.example");
		expect(apiOrigin("linear", "linear.app")).toBe("https://api.linear.app");
	});

	it("the GitHub REST base and GraphQL URL sit on that origin (GHES under /api/v3 and /api/graphql)", () => {
		expect(githubApiBase("github.acme.example")).toBe("https://github.acme.example/api/v3");
		expect(githubGraphqlUrl("github.acme.example")).toBe("https://github.acme.example/api/graphql");
		expect(githubGraphqlUrl("acme.ghe.com")).toBe("https://api.acme.ghe.com/graphql");
		expect(githubGraphqlUrl("github.com")).toBe("https://api.github.com/graphql");
		expect(gitlabApiBase("gitlab.acme.example")).toBe(apiOrigin("gitlab", "gitlab.acme.example"));
	});
});

/** A port that answers every call 200 `{}` with a token for any host,
 * recording each URL that reaches its fetch. */
function recordingPort(kind: "installation" | "private-token" | "linear-api-key"): ReferencePort & { urls: string[] } {
	const urls: string[] = [];
	const fetch: FetchLike = async (input) => {
		urls.push(input instanceof Request ? input.url : input.toString());
		return json(200, {});
	};
	return {
		fetch,
		urls,
		async credential(_provider, host) {
			return { kind, token: "token-x", host, account: "acme" };
		},
	};
}

/** Every read an adapter offers for one host, each run on a fresh port. */
async function everyRead(
	adapter: RefReadAdapter,
	host: string,
	itemUrl: string,
	scope: string,
	kind: "installation" | "private-token" | "linear-api-key",
): Promise<Record<string, string[]>> {
	const ref = adapter.match(new URL(itemUrl));
	if (ref === null) throw new Error(`no match for ${itemUrl}`);
	const reads: Record<string, (port: ReferencePort) => Promise<unknown>> = {
		resolve: (port) => adapter.resolve(ref, port),
	};
	if (adapter.list !== undefined) {
		const list = adapter.list.bind(adapter);
		reads["list"] = (port) => list({ scope, host }, port);
		reads["list text"] = (port) => list({ scope, host, text: "crash", labels: ["a", "b"] }, port);
	}
	if (adapter.search !== undefined) {
		const search = adapter.search.bind(adapter);
		reads["search"] = (port) => search({ query: "", scope, host }, port);
		reads["search issues"] = (port) => search({ query: "", scope, host, include: "issues" }, port);
	}
	if (adapter.scopes !== undefined) {
		const scopes = adapter.scopes.bind(adapter);
		reads["scopes"] = (port) => scopes(port, { host });
	}
	const pulls = adapter.pulls;
	if (pulls !== undefined) {
		const pull = { repo: scope, number: 1, host };
		reads["pull summary"] = (port) => pulls.summary(pull, port);
		reads["pull diff"] = (port) => pulls.diff(pull, port);
		reads["pull files"] = (port) => pulls.files(pull, port);
	}
	const seen: Record<string, string[]> = {};
	for (const [name, read] of Object.entries(reads)) {
		const port = recordingPort(kind);
		await read(port);
		seen[name] = port.urls;
	}
	return seen;
}

describe("every call for host H stays on apiOrigin(H)", () => {
	for (const host of ["github.com", "acme.ghe.com", "github.acme.example"]) {
		it(`GitHub on ${host}`, async () => {
			const adapter = createGithubAdapter({ hosts: host === "github.com" ? [] : [host] });
			const seen = await everyRead(adapter, host, `https://${host}/acme/web/issues/1`, "acme/web", "installation");
			expect(Object.keys(seen).sort()).toEqual(
				["list", "list text", "pull diff", "pull files", "pull summary", "resolve", "scopes", "search", "search issues"].sort(),
			);
			for (const [name, urls] of Object.entries(seen)) {
				expect(urls.length, name).toBeGreaterThan(0);
				for (const url of urls) expect(new URL(url).origin, `${name}: ${url}`).toBe(apiOrigin("github", host));
			}
		});
	}

	for (const host of ["gitlab.com", "gitlab.acme.example"]) {
		it(`GitLab on ${host}`, async () => {
			const adapter = createGitlabAdapter({ hosts: host === "gitlab.com" ? [] : [host] });
			const seen = await everyRead(adapter, host, `https://${host}/g/p/-/issues/1`, "g/p", "private-token");
			expect(Object.keys(seen).sort()).toEqual(["list", "list text", "resolve"]);
			for (const [name, urls] of Object.entries(seen)) {
				expect(urls.length, name).toBeGreaterThan(0);
				for (const url of urls) expect(new URL(url).origin, `${name}: ${url}`).toBe(apiOrigin("gitlab", host));
			}
		});
	}

	it("Linear on linear.app", async () => {
		const seen = await everyRead(linearAdapter, "linear.app", "https://linear.app/acme/issue/ENG-1", "ENG", "linear-api-key");
		expect(Object.keys(seen).sort()).toEqual(["list", "list text", "resolve"]);
		for (const [name, urls] of Object.entries(seen)) {
			expect(urls.length, name).toBeGreaterThan(0);
			for (const url of urls) expect(new URL(url).origin, `${name}: ${url}`).toBe(apiOrigin("linear", "linear.app"));
		}
	});
});
