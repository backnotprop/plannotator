// The outbound fetch policy. Ported from the Workspaces suite (main 7379b0195):
//   apps/rooms/test/external-refs-fetch.test.ts
// Workspaces ran these against a Miniflare outbound service
// (test/fixtures/posthog-ingest.js, the redirect-source.example and
// redirect-target.example routes); here the same routes are a fake origin
// behind the port's fetch. The wrapper always calls it with
// redirect: "manual", so the fake answers redirects as a server would.

import { afterEach, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";

import { githubAdapter } from "../src/adapters/github.ts";
import { readPullSummary } from "../src/adapters/github-pull-diff.ts";
import { githubSearch } from "../src/adapters/github-pulls.ts";
import { gitlabAdapter } from "../src/adapters/gitlab.ts";
import { externalRefsFetch, providerFetch } from "../src/fetch.ts";
import type { FetchLike, ProviderCallFields, ReferencePort } from "../src/port.ts";
import { matchExternalRef } from "../src/registry.ts";
import { fakeProvider, json, makePort } from "./helpers.ts";

const SOURCE = "https://redirect-source.example";
const TARGET = "https://redirect-target.example";

/** What reached the redirect target: the credential header it carried. */
let targets: Array<{ privateToken: string | null }>;

const origin: FetchLike = async (input, init) => {
	const request = new Request(input, init);
	const url = new URL(request.url);
	const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
	if (url.origin === SOURCE) {
		switch (url.pathname) {
			case "/__test/credential-redirect":
				return redirect(302, `${TARGET}/__test/credential-redirect`);
			case "/__test/post-redirect":
				return redirect(url.searchParams.get("status") === "308" ? 308 : 307, "/__test/post-redirect/final");
			case "/__test/post-redirect/final":
				return Response.json({
					method: request.method,
					body: await request.text(),
					tokenMatches: request.headers.get("PRIVATE-TOKEN") === "fixture-token",
				});
			case "/__test/post-cross-host":
				return redirect(307, `${TARGET}/__test/credential-redirect`);
			case "/__test/same-origin":
				return redirect(301, "/__test/same-origin/final");
			case "/__test/same-origin/final":
				return new Response(null, { status: request.headers.get("PRIVATE-TOKEN") === "fixture-token" ? 200 : 400 });
			case "/__test/same-origin/then-cross":
				return redirect(302, `${TARGET}/__test/credential-redirect`);
			case "/__test/same-origin/chained":
				return redirect(301, "/__test/same-origin/then-cross");
		}
	}
	if (url.origin === TARGET && url.pathname === "/__test/credential-redirect") {
		targets.push({ privateToken: request.headers.get("PRIVATE-TOKEN") });
		return Response.json({ reached: true });
	}
	return new Response(null, { status: 404 });
};

const call = (input: string | URL | Request, init?: RequestInit) => externalRefsFetch(origin, input, init);

// Bun runs every test file in one process: the console spy is restored after each test.
let info: Mock<typeof console.info>;
beforeEach(() => {
	targets = [];
	info = spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
	info.mockRestore();
});

describe("external reference fetch", () => {
	it("keeps a renamed resource working through a same-origin redirect", async () => {
		const response = await call(`${SOURCE}/__test/same-origin`, { headers: { "PRIVATE-TOKEN": "fixture-token" } });
		expect(response.status).toBe(200);
	});

	it("honors an adapter's explicit decision to refuse even a same-origin redirect", async () => {
		const url = `${SOURCE}/__test/same-origin`;
		const headers = { "PRIVATE-TOKEN": "fixture-token" };
		expect((await call(url, { headers, redirect: "manual" })).status).toBe(301);
		expect((await call(new Request(url, { headers, redirect: "manual" }))).status).toBe(301);
	});

	it("replays a same-origin 307 or 308 POST with its body and credential", async () => {
		for (const status of [307, 308]) {
			const url = `${SOURCE}/__test/post-redirect?status=${status}`;
			const init = { method: "POST", headers: { "PRIVATE-TOKEN": "fixture-token" }, body: "action=fixture" };
			const input = status === 307 ? url : new Request(url, init);
			const response = await call(input, status === 307 ? init : undefined);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ method: "POST", body: "action=fixture", tokenMatches: true });
		}
		const manual = await call(`${SOURCE}/__test/post-redirect`, { method: "POST", body: "action=fixture", redirect: "manual" });
		expect(manual.status).toBe(307);
	});

	it("refuses a cross-origin 307 POST without forwarding its body or credential", async () => {
		const response = await call(`${SOURCE}/__test/post-cross-host`, {
			method: "POST",
			headers: { "PRIVATE-TOKEN": "fixture-token" },
			body: "action=fixture",
		});
		expect(response.status).toBe(307);
		expect(targets).toEqual([]);
	});

	it("blocks a cross-origin redirect after a same-origin hop", async () => {
		const response = await call(`${SOURCE}/__test/same-origin/chained`, { headers: { "PRIVATE-TOKEN": "fixture-token" } });
		expect(response.status).toBe(302);
		expect(targets).toEqual([]);
	});

	it("does not forward a customer token to a provider redirect target", async () => {
		for (const redirect of [undefined, "follow"] as const) {
			const response = await call(`${SOURCE}/__test/credential-redirect`, {
				headers: { "PRIVATE-TOKEN": "fixture-token" },
				...(redirect === undefined ? {} : { redirect }),
			});
			expect(targets).toEqual([]);
			expect(response.status).toBe(302);
		}
	});

	it("stops following after 20 same-origin hops", async () => {
		let hops = 0;
		const loop: FetchLike = async () => {
			hops += 1;
			return new Response(null, { status: 302, headers: { location: `/loop/${hops}` } });
		};
		const response = await externalRefsFetch(loop, `${SOURCE}/loop/0`);
		expect(response.status).toBe(302);
		expect(hops).toBe(21);
	});

	it("keeps an explicit caller cancellation signal", async () => {
		const controller = new AbortController();
		await externalRefsFetch(
			async (_input, init) => {
				const signal = init?.signal;
				expect(signal).toBeDefined();
				controller.abort();
				expect(signal?.aborted).toBe(true);
				return new Response(null, { status: 204 });
			},
			"https://provider.example/api/0/organizations/demo/",
			{ signal: controller.signal },
		);
	});

	it("keeps cancellation from a Request input", async () => {
		const controller = new AbortController();
		await externalRefsFetch(async (_input, init) => {
			controller.abort();
			expect(init?.signal?.aborted).toBe(true);
			return new Response(null, { status: 204 });
		}, new Request("https://provider.example/", { signal: controller.signal }));
	});

	it("logs host, status and duration only: no path, query or credential", async () => {
		info.mockClear();
		const fetcher = providerFetch({ fetch: async () => new Response(null, { status: 204 }) });
		await fetcher("https://provider.example/private/path?token=token-abc", {
			headers: { authorization: "Bearer token-abc" },
		});
		expect(info).toHaveBeenCalledTimes(1);
		const [event, fields] = info.mock.calls[0] ?? [];
		expect(event).toBe("external_ref_provider_call");
		expect(Object.keys(fields as object).sort()).toEqual(["duration_ms", "host", "status"]);
		expect(fields).toMatchObject({ host: "provider.example", status: 204 });
		expect(JSON.stringify(info.mock.calls)).not.toContain("token-abc");
	});

	it("aborts a provider request at the ten-second deadline", async () => {
		// Bun's fake timers do not drive AbortSignal.timeout: the deadline
		// signal is replaced by one the test fires, so no real wait runs.
		const deadline = new AbortController();
		const timeout = spyOn(AbortSignal, "timeout").mockImplementation(() => deadline.signal);
		try {
			const pending = externalRefsFetch(
				async (_input, init) =>
					new Promise((_resolve, reject) => {
						const signal = init?.signal;
						if (signal === undefined || signal === null) {
							reject(new Error("No deadline signal"));
							return;
						}
						signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
				"https://provider.example/",
			);
			expect(timeout).toHaveBeenCalledWith(10_000);
			deadline.abort(new DOMException("t", "TimeoutError"));
			await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
		} finally {
			timeout.mockRestore();
		}
	});
});

describe("the port's user agent and log", () => {
	const refOf = (url: string) => {
		const found = matchExternalRef(new URL(url));
		if (found === null) throw new Error(`no match: ${url}`);
		return found.ref;
	};

	/** A fake GitHub and GitLab answering one issue each, one PR list, and one PR. */
	function forges() {
		const fake = fakeProvider();
		fake.on("GET https://api.github.com/repos/a/b/issues/1", () => json(200, { title: "t", state: "open" }));
		fake.on("GET https://api.github.com/repos/a/b/pulls?state=open&sort=created&direction=desc&per_page=100&page=1", () =>
			json(200, []),
		);
		fake.on("GET https://api.github.com/repos/a/b/pulls/2", () =>
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
		fake.on("GET https://gitlab.com/api/v4/projects/a%2Fb/issues/1", () => json(200, { title: "t", state: "opened" }));
		return fake;
	}

	async function readAll(port: ReferencePort): Promise<void> {
		expect((await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port)).ok).toBe(true);
		expect((await githubSearch({ query: "", scope: "a/b" }, port)).ok).toBe(true);
		expect((await readPullSummary({ repo: "a/b", number: 2 }, port)).ok).toBe(true);
		expect((await gitlabAdapter.resolve(refOf("https://gitlab.com/a/b/-/issues/1"), port)).ok).toBe(true);
	}

	const token = { "github github.com": { kind: "bearer", token: "token-user", host: "github.com" } } as const;

	it("defaults: plannotator-workspaces on every GitHub and GitLab call, and the line goes to console.info", async () => {
		const fake = forges();
		await readAll(makePort(fake.fetch, token));
		expect(fake.calls.map((c) => c.headers.get("user-agent"))).toEqual(Array(4).fill("plannotator-workspaces"));
		expect(info).toHaveBeenCalledTimes(4);
		expect(info.mock.calls.map((c) => c[0])).toEqual(Array(4).fill("external_ref_provider_call"));
	});

	it("a port's userAgent rides every GitHub and GitLab call, and its log takes the line instead of console.info", async () => {
		const fake = forges();
		const lines: Array<[string, ProviderCallFields]> = [];
		await readAll({
			...makePort(fake.fetch, token),
			userAgent: "plannotator-inbox/0.1.0",
			log: (event, fields) => lines.push([event, fields]),
		});
		expect(fake.calls.map((c) => c.headers.get("user-agent"))).toEqual(Array(4).fill("plannotator-inbox/0.1.0"));
		expect(lines.map(([event, fields]) => [event, fields.host, fields.status])).toEqual([
			["external_ref_provider_call", "api.github.com", 200],
			["external_ref_provider_call", "api.github.com", 200],
			["external_ref_provider_call", "api.github.com", 200],
			["external_ref_provider_call", "gitlab.com", 200],
		]);
		expect(info).not.toHaveBeenCalled();
	});

	it("a log that throws never turns an answer into a throw", async () => {
		const fake = forges();
		const port = {
			...makePort(fake.fetch),
			log: () => {
				throw new Error("log sink down");
			},
		};
		expect((await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port)).ok).toBe(true);
	});

	it("a log that is a method keeps its `this`", async () => {
		const fake = forges();
		const port = {
			...makePort(fake.fetch),
			lines: [] as string[],
			log(_event: string, fields: ProviderCallFields): void {
				this.lines.push(fields.host);
			},
		};
		expect((await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port)).ok).toBe(true);
		expect(port.lines).toEqual(["api.github.com"]);
	});

	it("an async log that rejects, as a promise or any thenable, leaves no unhandled rejection", async () => {
		const fake = forges();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const logs = [
				async () => {
					throw new Error("log sink down");
				},
				// A non-native thenable over a rejected promise.
				() => {
					const inner = Promise.reject(new Error("log sink down"));
					return { then: (ok: (v: unknown) => unknown, fail: (e: unknown) => unknown) => inner.then(ok, fail) };
				},
			];
			for (const log of logs) {
				const port = { ...makePort(fake.fetch), log: log as ReferencePort["log"] };
				expect((await githubAdapter.resolve(refOf("https://github.com/a/b/issues/1"), port)).ok).toBe(true);
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});
});
