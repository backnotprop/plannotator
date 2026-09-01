/**
 * /api/doc containment on the Node transport. Each runtime resolves and gates
 * paths in its own handler, so both carry the full set of escape vectors.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { handleDocExistsRequest, handleDocRequest } from "./reference.ts";
import { requestUrl } from "./helpers.ts";

const tempDirs: string[] = [];
let currentRoots: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function writeTempFile(root: string, relativePath: string, content: string): string {
	const full = join(root, relativePath);
	mkdirSync(dirname(full), { recursive: true });
	writeFileSync(full, content);
	return full;
}

function makeEscapeFixture(): { root: string; outside: string } {
	const root = makeTempDir("pi-symlink-root-");
	const outside = makeTempDir("pi-symlink-outside-");
	writeTempFile(outside, "secret.md", "SECRET-MD\n");
	writeTempFile(outside, "secret.html", "<p>SECRET-HTML</p>");
	writeTempFile(outside, "secret.ts", "// SECRET-TS\n");
	writeTempFile(outside, "deep.md", "SECRET-DEEP\n");
	writeTempFile(root, "sibling.md", "sibling\n");
	symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
	symlinkSync(join(outside, "secret.html"), join(root, "link.html"));
	symlinkSync(join(outside, "secret.ts"), join(root, "link.ts"));
	symlinkSync(outside, join(root, "linkdir"));
	currentRoots = [root];
	return { root, outside };
}

describe("pi /api/doc containment", () => {
	let server: Server;
	let base = "";

	beforeAll(async () => {
		server = createServer(async (req, res) => {
			const url = requestUrl(req);
			if (url.pathname === "/api/doc") {
				await handleDocRequest(res, url, { rootPaths: currentRoots });
				return;
			}
			if (url.pathname === "/api/doc/exists") {
				await handleDocExistsRequest(res, req, { rootPaths: currentRoots });
				return;
			}
			res.writeHead(404);
			res.end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("no port");
		base = `http://127.0.0.1:${address.port}`;
	});

	afterAll(() => {
		server.close();
	});

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	const getDoc = (path: string, baseDir?: string) => {
		const url = new URL(`${base}/api/doc`);
		url.searchParams.set("path", path);
		if (baseDir) url.searchParams.set("base", baseDir);
		return fetch(url);
	};

	const escapeVectors: { branch: string; path: (root: string) => string; withBase?: boolean }[] = [
		{ branch: "base-relative document", path: () => "link.md", withBase: true },
		{ branch: "markdown resolver, bare name", path: () => "link.md" },
		{ branch: "markdown resolver, absolute path", path: (root) => join(root, "link.md") },
		{ branch: "raw HTML", path: () => "link.html" },
		{ branch: "code file", path: () => "link.ts" },
		{ branch: "symlinked directory", path: () => "linkdir/deep.md" },
	];

	for (const vector of escapeVectors) {
		test(`denies an escaping symlink via the ${vector.branch} branch`, async () => {
			const { root } = makeEscapeFixture();

			const res = await getDoc(vector.path(root), vector.withBase ? root : undefined);

			expect(res.status).toBe(403);
			expect(await res.text()).not.toContain("SECRET");
		});
	}

	test("ordinary in-root siblings are still served", async () => {
		makeEscapeFixture();

		const res = await getDoc("sibling.md");
		const data = await res.json() as { markdown?: string };

		expect(res.status).toBe(200);
		expect(data.markdown).toBe("sibling\n");
	});

	test("doc/exists reports an escaping symlink as missing, not found", async () => {
		makeEscapeFixture();

		const res = await fetch(`${base}/api/doc/exists`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ paths: ["link.ts"] }),
		});
		const data = await res.json() as { results: Record<string, { status: string }> };

		expect(data.results["link.ts"]).toEqual({ status: "missing" });
	});

	test("refuses a base directory that reaches outside the root through a symlink", async () => {
		const { root } = makeEscapeFixture();

		const res = await getDoc("deep.md", join(root, "linkdir"));

		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("SECRET");
	});

	test("answers 403 for an escaping absolute path whether or not it exists", async () => {
		const { outside } = makeEscapeFixture();

		const existing = await getDoc(join(outside, "secret.md"));
		const absent = await getDoc(join(outside, "absent.md"));

		expect(existing.status).toBe(403);
		expect(absent.status).toBe(403);
	});

	test("serves a bare filename from a root given as a symlink", async () => {
		const real = makeTempDir("pi-symroot-real-");
		const parent = makeTempDir("pi-symroot-parent-");
		const link = join(parent, "docs");
		writeTempFile(real, "note.md", "note\n");
		symlinkSync(real, link);
		currentRoots = [link];

		const res = await getDoc("note.md");
		const data = await res.json() as { markdown?: string };

		expect(res.status).toBe(200);
		expect(data.markdown).toBe("note\n");
	});

	test("rejects an oversized .html with 413 whether or not a base is given", async () => {
		const root = makeTempDir("pi-html-cap-");
		currentRoots = [root];
		writeFileSync(join(root, "huge.html"), `<p>${"x".repeat(2 * 1024 * 1024 + 1)}</p>`);

		const withoutBase = await getDoc("huge.html");
		const withBase = await getDoc("huge.html", root);

		expect(withoutBase.status).toBe(413);
		expect(withBase.status).toBe(413);
		expect((await withBase.json() as { error?: string }).error).toBe("File too large (max 2MB)");
	});
});
