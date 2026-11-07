// The read-side registry. Workspaces pins its registry through the adapter
// suites and a tripwire on its import graph (apps/rooms/test/
// external-refs-tripwire.test.ts, main 7379b0195); the order and
// composition cases here are new for the package, which exposes
// createReferenceRegistry. The boundary case is this package's tripwire:
// the cut stays cut.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "bun:test";

import type { RefReadAdapter } from "../src/contract.ts";
import {
	adapterFor,
	allAdapters,
	createReferenceRegistry,
	matchCodeLinkUrl,
	matchExternalRef,
	matchExternalRefCandidates,
	REFERENCE_ADAPTERS,
} from "../src/registry.ts";
import { integrationPickerPresentation } from "../src/picker-modes.ts";

describe("the registry", () => {
	it("registers github, gitlab and linear, in that match order", () => {
		expect(allAdapters().map((a) => a.provider)).toEqual(["github", "gitlab", "linear"]);
		expect(REFERENCE_ADAPTERS.map((a) => a.provider)).toEqual(["github", "gitlab", "linear"]);
		expect(adapterFor("gitlab")?.provider).toBe("gitlab");
		expect(adapterFor("bitbucket")).toBeNull();
		expect(adapterFor("nope")).toBeNull();
	});

	it("every registered adapter sets kindOf, and it agrees with the matched URL form", () => {
		for (const adapter of allAdapters()) expect(adapter.kindOf, adapter.provider).toBeTypeOf("function");
		const kind = (url: string) => {
			const found = matchExternalRef(new URL(url));
			return found?.adapter.kindOf?.(found.ref);
		};
		expect(kind("https://github.com/a/b/pull/1")).toBe("change");
		expect(kind("https://github.com/a/b/issues/1")).toBe("issue");
		expect(kind("https://gitlab.com/a/b/-/merge_requests/1")).toBe("change");
		expect(kind("https://gitlab.com/a/b/-/work_items/1")).toBe("issue");
		expect(kind("https://linear.app/acme/issue/ENG-1")).toBe("issue");
	});

	it("one adapter claims each URL today; a URL nobody claims is null", () => {
		expect(matchExternalRefCandidates(new URL("https://github.com/a/b/issues/1"))).toHaveLength(1);
		expect(matchExternalRef(new URL("https://example.com/a/b/issues/1"))).toBeNull();
		expect(matchExternalRefCandidates(new URL("https://example.com/"))).toEqual([]);
	});

	it("composes: an appended adapter is asked after the built-ins, and an overlapping claim falls through in order", () => {
		const shadow: RefReadAdapter = {
			provider: "bitbucket",
			match: (url) =>
				url.hostname === "github.com" || url.hostname === "bitbucket.org"
					? { provider: "bitbucket", key: url.pathname, url: url.href }
					: null,
			resolve: async () => ({ ok: false, reason: "not_linked" }),
			matchCodeLink: (url) => (url.hostname === "bitbucket.org" ? { kind: "repo", repoPath: "w/r", url: url.href } : null),
		};
		const registry = createReferenceRegistry([...REFERENCE_ADAPTERS, shadow]);
		const github = new URL("https://github.com/a/b/issues/1");
		expect(registry.matchExternalRef(github)?.adapter.provider).toBe("github");
		expect(registry.matchExternalRefCandidates(github).map((c) => c.adapter.provider)).toEqual(["github", "bitbucket"]);
		expect(registry.matchExternalRef(new URL("https://bitbucket.org/w/r"))?.adapter.provider).toBe("bitbucket");
		expect(registry.matchCodeLinkUrl(new URL("https://bitbucket.org/w/r"))?.provider).toBe("bitbucket");
		expect(registry.adapterFor("bitbucket")).toBe(shadow);
		// The default registry is untouched.
		expect(adapterFor("bitbucket")).toBeNull();
		expect(matchCodeLinkUrl(new URL("https://bitbucket.org/w/r"))).toBeNull();
	});

	it("matchCodeLinkUrl skips adapters outside the code-link providers", () => {
		const outsider: RefReadAdapter = {
			provider: "linear",
			match: () => null,
			resolve: async () => ({ ok: false, reason: "not_linked" }),
			matchCodeLink: (url) => ({ kind: "repo", repoPath: "x/y", url: url.href }),
		};
		expect(createReferenceRegistry([outsider]).matchCodeLinkUrl(new URL("https://linear.app/x/y"))).toBeNull();
	});
});

describe("picker modes", () => {
	it("GitHub and Linear carry their paste rows; GitLab falls to the paste default; an explicit picker wins", () => {
		expect(integrationPickerPresentation({ id: "github" })).toEqual({
			objects: "Issues and pull requests",
			discovery: { kind: "paste" },
		});
		expect(integrationPickerPresentation({ id: "linear" })).toEqual({
			objects: "Issues, projects and documents",
			discovery: { kind: "paste" },
		});
		expect(integrationPickerPresentation({ id: "gitlab" })).toEqual({
			objects: "References",
			discovery: { kind: "paste" },
		});
		const custom = { objects: "Issues", discovery: { kind: "browse" as const, filterLoadedResults: true } };
		expect(integrationPickerPresentation({ id: "github", picker: custom })).toBe(custom);
	});
});

describe("the cut stays cut", () => {
	const src = fileURLToPath(new URL("../src", import.meta.url));
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else if (path.endsWith(".ts")) files.push(path);
		}
	};
	walk(src);

	it("no source file reads env, mints a JWT, runs an auth flow, or reaches Workspaces runtime code", () => {
		expect(files.length).toBeGreaterThan(10);
		for (const file of files) {
			// Code only: the provenance comments name what was cut.
			const text = readFileSync(file, "utf8")
				.replace(/\/\*[\s\S]*?\*\//g, "")
				.replace(/^\s*\/\/.*$/gm, "");
			for (const banned of [
				"process.env",
				"Bun.env",
				"import.meta.env",
				"Deno.env",
				"require(",
				"env.vars",
				"appOrigin",
				"jose",
				"SignJWT",
				"importPKCS8",
				"updateSecret",
				"OrgConnectionHandle",
				"AdapterEnv",
				"cloudflare:",
				"hono",
				"kysely",
				"API_KEY_PEPPER",
				"CLIENT_SECRET",
				"PRIVATE_KEY",
			]) {
				expect(text.includes(banned), `${file} contains ${banned}`).toBe(false);
			}
			// Auth-flow words, any case. The one exception is the literal "oauth"
			// in the Linear grammar's reserved workspace slugs (a URL it refuses).
			const code = text.replace(/RESERVED_WORKSPACES = new Set\(\["oauth", /u, "RESERVED_WORKSPACES = new Set([");
			for (const word of ["refresh_token", "client_secret", "grant_type", "/login/oauth", "oauth"]) {
				expect(code.toLowerCase().includes(word), `${file} contains ${word}`).toBe(false);
			}
			// Static imports in both quote styles, and side-effect imports.
			const imports = [...text.matchAll(/\bfrom\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']/gm)].map(
				(m) => m[1] ?? m[2] ?? "",
			);
			for (const spec of imports) {
				expect(spec.startsWith(".") || spec === "@plannotator/core/diff-paths", `${file} imports ${spec}`).toBe(true);
			}
			// import(...) only as a relative literal (contract.ts names types
			// with it); never a computed or package specifier.
			for (const m of text.matchAll(/\bimport\s*\(\s*([^)]*)\)/g)) {
				expect(/^["']\.\.?\/[^"']+["']$/u.test((m[1] ?? "").trim()), `${file}: ${m[0]}`).toBe(true);
			}
			// The global fetch would skip the port's host gate and the redirect
			// policy: a bare `fetch(`, or through a global object. Every file,
			// fetch.ts included; `port.fetch(`, `api.fetch(` and `fetcher(` pass.
			expect(/(?<![.\w$])fetch\s*\(/u.test(text), `${file} calls the global fetch`).toBe(false);
			expect(
				/\b(?:globalThis|self|window|global)\s*(?:\.\s*fetch|\[\s*["']fetch["']\s*\])/u.test(text),
				`${file} reaches the global fetch through a global object`,
			).toBe(false);
		}
	});

	it("every source file names its Workspaces source and the main commit in its first two lines", () => {
		for (const file of files) {
			const [first, second] = readFileSync(file, "utf8").split("\n");
			expect(first?.startsWith("// Source: "), file).toBe(true);
			expect(first?.includes("7379b0195de140adc00b4496eefe553a3eec803e"), file).toBe(true);
			expect(second?.startsWith("// "), file).toBe(true);
		}
	});
});
