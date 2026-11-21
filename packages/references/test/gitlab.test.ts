// The GitLab read adapter. Ported from the Workspaces suite (main 7379b0195):
//   apps/rooms/test/external-refs-providers.test.ts  "gitlab — resolve through the route"
// The form-connect cases (the /api/v4/user probe, the http/IP/localhost
// refusals) are connect side and stay in Workspaces.

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

import { gitlabAdapter } from "../src/adapters/gitlab.ts";
import type { ReferenceCredential } from "../src/port.ts";
import { matchExternalRef } from "../src/registry.ts";
import { fakeProvider, json, makePort } from "./helpers.ts";

function gitlabItemPayload(over: Record<string, unknown> = {}): unknown {
	return {
		iid: 259606,
		title: "Fix the pipeline cache",
		state: "opened",
		author: { username: "mara" },
		created_at: "2026-06-01T10:00:00.000Z",
		updated_at: "2026-07-22T09:14:00.000Z",
		...over,
	};
}

function refOf(url: string) {
	const found = matchExternalRef(new URL(url));
	if (found === null) throw new Error(`no match: ${url}`);
	return found.ref;
}

const pat: ReferenceCredential = { kind: "private-token", token: "token-gl", host: "gitlab.com" };

// Bun runs every test file in one process: the console spy is restored after each test.
let info: Mock<typeof console.info>;
beforeEach(() => {
	info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	info.mockRestore();
});

describe("gitlab resolve", () => {
	const ISSUE = "GET https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab/issues/259606";

	it("PUBLIC RUNG ON: no credential reads gitlab.com unauthenticated, the %2F-encoded project path asserted", async () => {
		const gl = fakeProvider();
		gl.on(ISSUE, ({ headers, url }) => {
			expect(headers.get("PRIVATE-TOKEN")).toBeNull();
			expect(headers.get("authorization")).toBeNull();
			expect(url).toContain("gitlab-org%2Fgitlab");
			return json(200, gitlabItemPayload());
		});
		const port = makePort(gl.fetch);
		expect(await gitlabAdapter.resolve(refOf("https://gitlab.com/gitlab-org/gitlab/-/issues/259606"), port)).toEqual({
			ok: true,
			facts: {
				ref: {
					provider: "gitlab",
					key: "gitlab-org/gitlab#259606",
					url: "https://gitlab.com/gitlab-org/gitlab/-/issues/259606",
				},
				kind: "issue",
				shortId: "gitlab#259606",
				title: "Fix the pipeline cache",
				state: { label: "Open", tone: "open" },
				author: "mara",
				createdAt: "2026-06-01T10:00:00.000Z",
				updatedAt: "2026-07-22T09:14:00.000Z",
			},
		});
		expect(port.asked).toEqual(["gitlab gitlab.com"]);
		expect(gl.calls).toHaveLength(1);
	});

	it("a private-token credential reads with PRIVATE-TOKEN; pins the state table opened/closed/merged/locked", async () => {
		const gl = fakeProvider();
		const port = makePort(gl.fetch, { "gitlab gitlab.com": pat });
		const cases = [
			{ form: "issues", iid: 1, state: "opened", want: { label: "Open", tone: "open" }, kind: "issue" },
			{ form: "issues", iid: 2, state: "closed", want: { label: "Closed", tone: "closed" }, kind: "issue" },
			{ form: "merge_requests", iid: 3, state: "merged", want: { label: "Merged", tone: "done" }, kind: "change" },
			{ form: "merge_requests", iid: 4, state: "locked", want: { label: "Locked", tone: "open" }, kind: "change" },
			{ form: "merge_requests", iid: 5, state: "closed", want: { label: "Closed", tone: "closed" }, kind: "change" },
		] as const;
		for (const c of cases) {
			gl.on(`GET https://gitlab.com/api/v4/projects/acme%2Fapi/${c.form}/${c.iid}`, ({ headers }) => {
				expect(headers.get("PRIVATE-TOKEN")).toBe("token-gl");
				expect(headers.get("authorization")).toBeNull();
				return json(200, gitlabItemPayload({ iid: c.iid, state: c.state }));
			});
			const ref = refOf(`https://gitlab.com/acme/api/-/${c.form}/${c.iid}`);
			const result = await gitlabAdapter.resolve(ref, port);
			if (!result.ok) throw new Error(`${c.form}/${c.iid}: ${result.reason}`);
			expect(result.facts.state, `${c.form} ${c.state}`).toEqual(c.want);
			expect(result.facts.kind).toBe(c.kind);
			expect(result.facts.shortId).toBe(`api${c.form === "issues" ? "#" : "!"}${c.iid}`);
			expect(gitlabAdapter.kindOf?.(ref)).toBe(c.kind);
		}
	});

	it("a bearer credential (an OAuth token, such as glab's) rides Authorization: Bearer", async () => {
		const gl = fakeProvider();
		gl.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/1", ({ headers }) => {
			expect(headers.get("authorization")).toBe("Bearer token-oauth");
			expect(headers.get("PRIVATE-TOKEN")).toBeNull();
			return json(200, gitlabItemPayload());
		});
		const port = makePort(gl.fetch, { "gitlab gitlab.com": { kind: "bearer", token: "token-oauth", host: "gitlab.com" } });
		expect((await gitlabAdapter.resolve(refOf("https://gitlab.com/a/b/-/issues/1"), port)).ok).toBe(true);
	});

	it("a 401 on the token is credential-dead; an unauthenticated 404, 401 or 403 stays a quiet not_linked", async () => {
		const gl = fakeProvider();
		gl.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/1", () => json(401, { message: "401 Unauthorized" }));
		const port = makePort(gl.fetch, { "gitlab gitlab.com": pat });
		expect(await gitlabAdapter.resolve(refOf("https://gitlab.com/a/b/-/issues/1"), port)).toEqual({
			ok: false,
			reason: "not_resolvable",
			credentialDead: true,
		});

		const anon = makePort(gl.fetch);
		expect(await gitlabAdapter.resolve(refOf("https://gitlab.com/p/q/-/issues/2"), anon)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		expect(await gitlabAdapter.resolve(refOf("https://gitlab.com/a/b/-/issues/1"), anon)).toEqual({
			ok: false,
			reason: "not_linked",
		});
		gl.on("GET https://gitlab.com/api/v4/projects/p%2Fq/issues/3", () => json(403, { message: "403 Forbidden" }));
		expect(await gitlabAdapter.resolve(refOf("https://gitlab.com/p/q/-/issues/3"), port)).toEqual({
			ok: false,
			reason: "not_linked",
		});
	});

	it("a 429 or 5xx is not_resolvable, never rateLimited (GitLab does not set the flag); an unknown state word is not_resolvable", async () => {
		const gl = fakeProvider();
		gl.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/1", () => json(429, { message: "Retry later" }));
		gl.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/2", () => json(503, { message: "down" }));
		gl.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/3", () => json(200, gitlabItemPayload({ state: "archived" })));
		const port = makePort(gl.fetch);
		for (const n of [1, 2, 3]) {
			expect(await gitlabAdapter.resolve(refOf(`https://gitlab.com/a/b/-/issues/${n}`), port)).toEqual({
				ok: false,
				reason: "not_resolvable",
			});
		}
	});

	it("a credential for another instance never leaves it: a gitlab.com URL rides the public rung", async () => {
		const gl = fakeProvider();
		gl.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/1", ({ headers }) => {
			expect(headers.get("PRIVATE-TOKEN")).toBeNull();
			return json(200, gitlabItemPayload());
		});
		const port = makePort(gl.fetch, async () => ({ kind: "private-token", token: "token-self", host: "gitlab.example.com" }));
		expect((await gitlabAdapter.resolve(refOf("https://gitlab.com/a/b/-/issues/1"), port)).ok).toBe(true);
		expect(gl.calls.map((c) => c.url)).toEqual(["https://gitlab.com/api/v4/projects/a%2Fb/issues/1"]);
	});

	it("the port's unavailable answer passes through with its credentialDead, and no fetch runs", async () => {
		const gl = fakeProvider();
		for (const credentialDead of [true, false]) {
			const port = makePort(gl.fetch, { "gitlab gitlab.com": { kind: "unavailable", credentialDead } });
			expect(await gitlabAdapter.resolve(refOf("https://gitlab.com/a/b/-/issues/1"), port)).toEqual({
				ok: false,
				reason: "not_resolvable",
				credentialDead,
			});
		}
		expect(gl.calls).toHaveLength(0);
	});
});
