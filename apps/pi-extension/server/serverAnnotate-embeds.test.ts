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
import { HTML_ASSET_SUBRESOURCE_CSP } from "../generated/html-assets.ts";
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
		writeFileSync(join(dir, "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', "utf-8");
		writeFileSync(join(dir, "logo.png"), "png-bytes", "utf-8");

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

	// An SVG opened directly is a scriptable document on the session's origin;
	// every non-HTML asset gets the sandbox, the PNG too (an <img> load ignores it).
	test("serves an SVG asset and a PNG with the sandbox CSP and nosniff", async () => {
		await withSession("svg", async ({ url, base }) => {
			const svg = await fetch(`${url}${base}chart.svg`);
			expect(svg.status).toBe(200);
			expect(svg.headers.get("content-type")).toBe("image/svg+xml");
			expect(svg.headers.get("content-security-policy")).toBe(HTML_ASSET_SUBRESOURCE_CSP);
			expect(svg.headers.get("x-content-type-options")).toBe("nosniff");
			const png = await fetch(`${url}${base}logo.png`);
			expect(png.status).toBe(200);
			expect(png.headers.get("content-security-policy")).toBe(HTML_ASSET_SUBRESOURCE_CSP);
			expect(png.headers.get("x-content-type-options")).toBe("nosniff");
		});
	});

	test("every non-HTML asset carries the sandbox CSP and nosniff: an SVG or XML opened as a document runs no script here", async () => {
		const dir = siteDir("svg");
		const pagePath = join(dir, "page.html");
		const html = '<!doctype html><html><body><img src="chart.svg"></body></html>';
		writeFileSync(pagePath, html, "utf-8");
		writeFileSync(join(dir, "chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/plan")</script></svg>', "utf-8");
		writeFileSync(join(dir, "data.xml"), '<html xmlns="http://www.w3.org/1999/xhtml"><script>1</script></html>', "utf-8");
		writeFileSync(join(dir, "logo.png"), Buffer.from("89504e470d0a1a0a", "hex"));
		const server = await startAnnotateServer({ markdown: "", filePath: pagePath, htmlContent: MINIMAL_HTML, rawHtml: html, renderHtml: true });
		try {
			const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { rawHtml?: string };
			const base = plan.rawHtml!.match(/<base href="([^"]+)"/)![1];
			for (const [name, type] of [
				["chart.svg", "image/svg+xml"],
				["data.xml", "application/xml; charset=utf-8"],
				["logo.png", "image/png"],
			] as const) {
				const response = await fetch(`${server.url}${base}${name}`);
				expect([name, response.status, response.headers.get("content-type")]).toEqual([name, 200, type]);
				expect([name, response.headers.get("content-security-policy")]).toEqual([
					name,
					"sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:",
				]);
				expect(response.headers.get("x-content-type-options")).toBe("nosniff");
			}
		} finally {
			server.stop();
		}
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

	// The #1561 regression: the guard keyed on Sec-Fetch-Dest alone, so the app
	// document 404'd too — and the VS Code extension frames the session URL.
	test("a framed request for the app document still gets the app shell", async () => {
		await withSession("framed-root", async ({ url }) => {
			for (const path of ["/", "/?x=1"]) {
				const response = await fetch(`${url}${path}`, {
					headers: { "sec-fetch-dest": "iframe" },
				});
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("PLANNOTATOR_APP_SHELL");
			}
		});
	});

	test("a framed path under a directory is a file reference; a bare word is not", async () => {
		await withSession("framed-shape", async ({ url }) => {
			const nested = await fetch(`${url}/assets/frame`, {
				headers: { "sec-fetch-dest": "iframe" },
			});
			expect(nested.status).toBe(404);
			const bare = await fetch(`${url}/settings`, {
				headers: { "sec-fetch-dest": "iframe" },
			});
			expect(bare.status).toBe(200);
			expect(await bare.text()).toContain("PLANNOTATOR_APP_SHELL");
		});
	});

	test("a plain request for a missing path still gets the app, as before #1561", async () => {
		await withSession("plain-miss", async ({ url }) => {
			const response = await fetch(`${url}/prototype-slash.html`);
			expect(response.status).toBe(200);
			expect(await response.text()).toContain("PLANNOTATOR_APP_SHELL");
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
