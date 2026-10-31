// The Linear read adapter. Ported from the Workspaces suite (main 7379b0195):
//   apps/rooms/test/external-refs-providers.test.ts  "linear — resolve, refresh custody, and state tables"
// The refresh cases (single-flight, the rotated pair persisted, a refused or
// transient refresh) test the token custody that is now the port's; here
// they become the port's two unavailable answers. The OAuth connect cases
// stay in Workspaces.

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

import { githubAdapter } from "../src/adapters/github.ts";
import { gitlabAdapter } from "../src/adapters/gitlab.ts";
import { linearAdapter } from "../src/adapters/linear.ts";
import type { ExternalRefState } from "../src/contract.ts";
import type { ReferenceCredential } from "../src/port.ts";
import { matchExternalRef } from "../src/registry.ts";
import { fakeProvider, json, makePort } from "./helpers.ts";

const GRAPHQL = "POST https://api.linear.app/graphql";
const acme: ReferenceCredential = { kind: "bearer", token: "token-lin", host: "linear.app", account: "acme" };

function refOf(url: string) {
	const found = matchExternalRef(new URL(url));
	if (found === null) throw new Error(`no match: ${url}`);
	return found.ref;
}

/** Arm the GraphQL endpoint: Bearer asserted, then `answer` builds `data`. */
function armGraphql(
	lin: ReturnType<typeof fakeProvider>,
	token: string,
	answer: (query: string, variables: Record<string, string>) => unknown,
): void {
	lin.on(GRAPHQL, ({ headers, body }) => {
		if (headers.get("authorization") !== `Bearer ${token}`) return json(401, { errors: [] });
		expect(headers.get("content-type")).toBe("application/json");
		const parsed = JSON.parse(body ?? "{}") as { query: string; variables: Record<string, string> };
		return json(200, { data: answer(parsed.query, parsed.variables) });
	});
}

// Bun runs every test file in one process: the console spy is restored after each test.
let info: Mock<typeof console.info>;
beforeEach(() => {
	info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	info.mockRestore();
});

describe("linear resolve", () => {
	it("resolves an issue over GraphQL (Bearer + identifier asserted); the workspace's own state word, type-mapped tone", async () => {
		const lin = fakeProvider();
		armGraphql(lin, "token-lin", (query, variables) => {
			expect(query).toContain("issue(id: $id)");
			expect(variables).toEqual({ id: "ENG-123" });
			return {
				issue: {
					identifier: "ENG-123",
					title: "Rate limit the export",
					createdAt: "2026-06-01T10:00:00.000Z",
					updatedAt: "2026-07-22T09:14:00.000Z",
					state: { name: "In Review", type: "started" },
					assignee: { name: "Mara" },
					creator: { name: "Josie" },
				},
			};
		});
		const port = makePort(lin.fetch, { "linear linear.app": acme });
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-123/rate-limit-export"), port)).toEqual({
			ok: true,
			facts: {
				ref: { provider: "linear", key: "acme/ENG-123", url: "https://linear.app/acme/issue/ENG-123" },
				kind: "issue",
				shortId: "ENG-123",
				title: "Rate limit the export",
				state: { label: "In Review", tone: "open" },
				author: "Mara",
				createdAt: "2026-06-01T10:00:00.000Z",
				updatedAt: "2026-07-22T09:14:00.000Z",
			},
		});
	});

	it("pins the three state tables: issue types, project types (paused → open), and the stateless document", async () => {
		const lin = fakeProvider();
		const port = makePort(lin.fetch, { "linear linear.app": acme });
		const issueCases: Array<[string, ExternalRefState["tone"]]> = [
			["triage", "open"],
			["backlog", "open"],
			["unstarted", "open"],
			["started", "open"],
			["completed", "done"],
			["canceled", "closed"],
		];
		for (const [i, [type, tone]] of issueCases.entries()) {
			const identifier = `T${i}-1`;
			armGraphql(lin, "token-lin", () => ({ issue: { identifier, title: "t", state: { name: type, type } } }));
			const result = await linearAdapter.resolve(refOf(`https://linear.app/acme/issue/${identifier}`), port);
			expect(result.ok && result.facts.state?.tone, `issue ${type}`).toBe(tone);
		}

		const projectCases: Array<[string, ExternalRefState["tone"]]> = [
			["backlog", "open"],
			["planned", "open"],
			["started", "open"],
			["paused", "open"],
			["completed", "done"],
			["canceled", "closed"],
		];
		for (const [i, [type, tone]] of projectCases.entries()) {
			armGraphql(lin, "token-lin", (query) => {
				expect(query).toContain("project(id: $id)");
				return { project: { name: "Q3 rate limits", status: { name: type, type }, updatedAt: "2026-07-22T09:14:00.000Z" } };
			});
			const ref = refOf(`https://linear.app/acme/project/q3-limits-slug${i}abc/overview`);
			const result = await linearAdapter.resolve(ref, port);
			if (!result.ok) throw new Error(`project ${type}: ${result.reason}`);
			expect(result.facts.kind).toBe("project");
			expect(result.facts.shortId).toBe("Project");
			expect(result.facts.state?.tone, `project ${type}`).toBe(tone);
			expect(linearAdapter.kindOf?.(ref)).toBe("project");
		}

		armGraphql(lin, "token-lin", (query, variables) => {
			expect(query).toContain("documents(filter: { slugId: { eq: $slugId } }");
			expect(variables).toEqual({ slugId: "38359beef67c" });
			return {
				documents: {
					nodes: [{ title: "RFC: permission gateway", updatedAt: "2026-07-20T08:00:00.000Z", creator: { name: "Josie" } }],
				},
			};
		});
		const docRef = refOf("https://linear.app/acme/document/rfc-permission-gateway-38359beef67c");
		expect(await linearAdapter.resolve(docRef, port)).toEqual({
			ok: true,
			facts: {
				ref: {
					provider: "linear",
					key: "acme/document/38359beef67c",
					url: "https://linear.app/acme/document/rfc-permission-gateway-38359beef67c",
				},
				kind: "doc",
				shortId: "Doc",
				title: "RFC: permission gateway",
				author: "Josie",
				updatedAt: "2026-07-20T08:00:00.000Z",
			},
		});
		expect(linearAdapter.kindOf?.(docRef)).toBe("doc");
	});

	it("THE WORKSPACE-BINDING PIN: a foreign-workspace URL is not_linked with ZERO provider fetches", async () => {
		const lin = fakeProvider();
		armGraphql(lin, "token-lin", () => ({
			issue: { identifier: "ENG-123", title: "Acme internal work", state: { name: "Todo", type: "unstarted" } },
		}));
		const port = makePort(lin.fetch, { "linear linear.app": acme });
		expect(await linearAdapter.resolve(refOf("https://linear.app/zebra/issue/ENG-123"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		expect(lin.calls).toHaveLength(0);

		// A credential with no account binds to no workspace and reads nothing.
		const unbound = makePort(lin.fetch, { "linear linear.app": { kind: "bearer", token: "token-lin", host: "linear.app" } });
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-123"), unbound)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		expect(lin.calls).toHaveLength(0);

		// The bound workspace still answers normally.
		const own = await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-123"), port);
		expect(own.ok && own.facts.title).toBe("Acme internal work");
	});

	it("NO public rung: no credential answers not_linked with zero fetches", async () => {
		const lin = fakeProvider();
		const port = makePort(lin.fetch);
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-1"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		expect(lin.calls).toHaveLength(0);
		expect(port.asked).toEqual(["linear linear.app"]);
	});

	it("a 401 on the token is credential-dead; a 429 or 5xx is not_resolvable without rateLimited; null data is not_linked", async () => {
		const lin = fakeProvider();
		const port = makePort(lin.fetch, { "linear linear.app": acme });
		lin.on(GRAPHQL, () => json(401, { errors: [{ message: "Authentication required" }] }));
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-1"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: true,
		});
		lin.on(GRAPHQL, () => json(429, { errors: [{ message: "ratelimited" }] }));
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-1"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
		});
		lin.on(GRAPHQL, () => json(200, { data: null, errors: [{ message: "Entity not found" }] }));
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-1"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		lin.on(GRAPHQL, () => json(200, { data: { issue: null } }));
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-1"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
	});

	it("the port's refresh outcome passes through: refused = credentialDead true, transient = false, no GraphQL call", async () => {
		const lin = fakeProvider();
		for (const credentialDead of [true, false]) {
			const port = makePort(lin.fetch, { "linear linear.app": { kind: "unavailable", credentialDead } });
			expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-1"), port)).toEqual({
				ok: false,
				reason: "not_resolvable",
				credentialDead,
			});
		}
		expect(lin.calls).toHaveLength(0);
	});

	it("a private-token or another host's credential is never sent to Linear", async () => {
		const lin = fakeProvider();
		for (const credential of [
			{ kind: "private-token", token: "token-x", host: "linear.app", account: "acme" },
			{ kind: "bearer", token: "token-x", host: "linear.example", account: "acme" },
		] as const) {
			const port = makePort(lin.fetch, async () => credential);
			expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-1"), port)).toEqual({
				ok: false,
				reason: "not_linked",
			});
		}
		expect(lin.calls).toHaveLength(0);
	});
});

describe("linear personal API keys (the linear-api-key kind)", () => {
	const apiKey: ReferenceCredential = { kind: "linear-api-key", token: "key-lin", host: "linear.app", account: "acme" };

	/** Linear's own rule: a personal key is the bare header value, and a
	 * `Bearer`-prefixed key is refused with 401 (read as credentialDead). */
	function armPersonalKey(lin: ReturnType<typeof fakeProvider>): void {
		lin.on(GRAPHQL, ({ headers }) =>
			headers.get("authorization") === "key-lin"
				? json(200, {
						data: {
							issue: {
								identifier: "ENG-7",
								title: "Import the backlog",
								state: { name: "Todo", type: "unstarted" },
								creator: { name: "Josie" },
							},
						},
					})
				: json(401, { errors: [{ message: "Authentication required" }] }),
		);
	}

	it("resolves a canned issue, and the request carries the key with no Bearer prefix", async () => {
		const lin = fakeProvider();
		armPersonalKey(lin);
		const port = makePort(lin.fetch, { "linear linear.app": apiKey });
		const result = await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-7"), port);
		expect(result).toMatchObject({
			ok: true,
			facts: { kind: "issue", shortId: "ENG-7", title: "Import the backlog", state: { label: "Todo", tone: "open" } },
		});
		expect(lin.calls.map((c) => c.headers.get("authorization"))).toEqual(["key-lin"]);
	});

	it("needs the workspace account like bearer: no account, or a foreign workspace, reads nothing with zero fetches", async () => {
		const lin = fakeProvider();
		armPersonalKey(lin);
		const unbound = makePort(lin.fetch, {
			"linear linear.app": { kind: "linear-api-key", token: "key-lin", host: "linear.app" },
		});
		expect(await linearAdapter.resolve(refOf("https://linear.app/acme/issue/ENG-7"), unbound)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		const port = makePort(lin.fetch, { "linear linear.app": apiKey });
		expect(await linearAdapter.resolve(refOf("https://linear.app/zebra/issue/ENG-7"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		expect(lin.calls).toHaveLength(0);
	});

	it("GitHub and GitLab never send a Linear key", async () => {
		const forge = fakeProvider();
		forge.on("GET https://api.github.com/repos/a/b/issues/1", () => json(200, { title: "t", state: "open" }));
		forge.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/1", () => json(200, { title: "t", state: "opened" }));
		const port = makePort(forge.fetch, async (_provider, host) => ({ kind: "linear-api-key", token: "key-lin", host, account: "acme" }));
		expect((await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port)).ok).toBe(true);
		expect((await gitlabAdapter.resolve(refOf("https://gitlab.com/a/b/-/issues/1"), port)).ok).toBe(true);
		expect(forge.calls.map((c) => [c.headers.get("authorization"), c.headers.get("PRIVATE-TOKEN")])).toEqual([
			[null, null],
			[null, null],
		]);
	});
});
