/**
 * Annotate server (Pi/Node): embedded local documents
 *
 * Node mirror of `annotate embedded local documents` in
 * packages/server/annotate-html-assets.test.ts. The decision logic is shared
 * (`resolveHtmlAssetRoute` in packages/shared/html-assets.ts, vendored here),
 * so what this pins is the Node transport over it: the sandbox CSP and nosniff
 * reach the wire, a framed miss renders an HTML document rather than the app,
 * and the traversal guard still holds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>PLANNOTATOR_APP_SHELL</body></html>";

describe("pi annotate server: embedded local documents", () => {
	let savedPort: string | undefined;
	let savedRemote: string | undefined;
	let savedHistoryFlag: string | undefined;

	beforeEach(() => {
		savedPort = process.env.PLANNOTATOR_PORT;
		savedRemote = process.env.PLANNOTATOR_REMOTE;
		savedHistoryFlag = process.env.PLANNOTATOR_ANNOTATE_HISTORY;
		delete process.env.PLANNOTATOR_PORT;
		process.env.PLANNOTATOR_REMOTE = "0";
		process.env.PLANNOTATOR_ANNOTATE_HISTORY = "0";
	});

	afterEach(() => {
		if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
		else process.env.PLANNOTATOR_PORT = savedPort;
		if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
		else process.env.PLANNOTATOR_REMOTE = savedRemote;
		if (savedHistoryFlag === undefined) delete process.env.PLANNOTATOR_ANNOTATE_HISTORY;
		else process.env.PLANNOTATOR_ANNOTATE_HISTORY = savedHistoryFlag;
	});

	// realpath: containment realpaths the root but keeps a missing target's
	// lexical path, which on macOS's symlinked tmpdir would never match.
	const siteDir = (label: string) =>
		realpathSync(mkdtempSync(join(tmpdir(), `plannotator-pi-embed-${label}-`)));

	async function withSession(
		label: string,
		run: (ctx: { url: string; base: string }) => Promise<void>,
	): Promise<void> {
		const dir = siteDir(label);
		const pagePath = join(dir, "page.html");
		// The src is assigned by script from data-src, the shape a serve-time
		// attribute rewrite cannot reach and the <base href> covers.
		const html =
			'<!doctype html><html><head></head><body><iframe data-src="embed.html"></iframe></body></html>';
		writeFileSync(pagePath, html, "utf-8");
		writeFileSync(join(dir, "embed.html"), "<html><body>EMBEDDED_SIBLING</body></html>", "utf-8");

		const server = await startAnnotateServer({
			markdown: "",
			filePath: pagePath,
			htmlContent: MINIMAL_HTML,
			rawHtml: html,
			renderHtml: true,
		});
		try {
			const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { rawHtml?: string };
			const base = plan.rawHtml?.match(/<base href="([^"]+)"/)?.[1];
			expect(base).toMatch(/^\/api\/html-assets\/[0-9a-f]{16}\/$/);
			await run({ url: server.url, base: base! });
		} finally {
			server.stop();
		}
	}

	test("serves a sibling document with the sandbox CSP and preserves its query string", async () => {
		await withSession("serve", async ({ url, base }) => {
			const response = await fetch(`${url}${base}embed.html?step=result`, {
				headers: { "sec-fetch-dest": "iframe" },
			});
			expect(response.status).toBe(200);
			expect(response.headers.get("content-type")).toContain("text/html");
			expect(response.headers.get("content-security-policy")).toBe("sandbox allow-scripts");
			expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			expect(await response.text()).toContain("EMBEDDED_SIBLING");
		});
	});

	// The bug: the catch-all answering a nested-document request with the
	// editor app, so every embed rendered a second Plannotator.
	test("a framed request for an unknown path gets a 404 document, never the app", async () => {
		await withSession("framed", async ({ url }) => {
			const response = await fetch(`${url}/prototype-slash.html`, {
				headers: { "sec-fetch-dest": "iframe" },
			});
			expect(response.status).toBe(404);
			expect(response.headers.get("content-type")).toContain("text/html");
			const body = await response.text();
			expect(body).toContain("prototype-slash.html");
			expect(body).not.toContain("PLANNOTATOR_APP_SHELL");
		});
	});

	test("an ordinary top-level navigation still gets the app shell", async () => {
		await withSession("spa", async ({ url }) => {
			const response = await fetch(`${url}/some/spa/route`, {
				headers: { "sec-fetch-dest": "document" },
			});
			expect(await response.text()).toContain("PLANNOTATOR_APP_SHELL");
		});
	});

	test("refuses an embed that climbs out of the annotated file's directory", async () => {
		await withSession("escape", async ({ url, base }) => {
			for (const spelling of ["../../etc/hosts.html", "%2e%2e/secret.html"]) {
				const response = await fetch(`${url}${base}${spelling}`, {
					headers: { "sec-fetch-dest": "iframe" },
				});
				expect(response.status).toBeGreaterThanOrEqual(400);
			}
		});
	});
});
