/**
 * "Open Plannotator at plannotator.localhost" (#2184) through the Pi (node:http)
 * servers, the mirror of packages/server/cookie-host-config.test.ts: POST
 * /api/config `{ cookieHost }` writes or removes `urlHost:
 * "plannotator.localhost"`, never replaces another `urlHost`, is refused and
 * not advertised in remote mode, and a live app session stays on localhost.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./generated/config.ts";
import { startAnnotateServer, startPlanReviewServer, startReviewServer } from "./server.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_URL_HOST"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-cookie-host-config-"));
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_REMOTE = "0";
	delete process.env.PLANNOTATOR_PORT;
	delete process.env.PLANNOTATOR_URL_HOST;
});

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dataDir, { recursive: true, force: true });
});

const configFile = () => join(dataDir, "config.json");
const base = (server: { port: number }) => `http://127.0.0.1:${server.port}`;
const post = (server: { port: number }, body: unknown) =>
	fetch(`${base(server)}/api/config`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const servers = {
	plan: { start: () => startPlanReviewServer({ plan: "# Plan", origin: "pi", htmlContent: MINIMAL_HTML }), path: "/api/plan" },
	review: { start: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML }), path: "/api/diff" },
	annotate: { start: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML }), path: "/api/plan" },
};

describe("cookieHost on the Pi servers", () => {
	for (const [name, { start, path }] of Object.entries(servers)) {
		test(`${name}: on writes urlHost, off removes it; another urlHost is never replaced`, async () => {
			writeFileSync(configFile(), JSON.stringify({ displayName: "tater" }));
			const server = await start();
			const serverConfig = async () =>
				((await (await fetch(`${base(server)}${path}`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
			try {
				expect((await serverConfig()).cookieHost).toEqual({ on: false });
				expect((await post(server, { cookieHost: true })).status).toBe(200);
				expect(loadConfig()).toEqual({ displayName: "tater", urlHost: "plannotator.localhost" });
				expect((await post(server, { cookieHost: false })).status).toBe(200);
				expect(loadConfig()).toEqual({ displayName: "tater" });

				writeFileSync(configFile(), JSON.stringify({ urlHost: "my-machine.tailnet.ts.net" }));
				const before = readFileSync(configFile(), "utf8");
				expect((await serverConfig()).cookieHost).toEqual({ on: false, urlHost: "my-machine.tailnet.ts.net" });
				const refused = await post(server, { cookieHost: true });
				expect(refused.status).toBe(409);
				expect((await refused.json()).code).toBe("cookie_host_url_host_in_use");
				expect(readFileSync(configFile(), "utf8")).toBe(before);
			} finally {
				server.stop();
			}
		});
	}

	test("remote mode: not advertised, and a write is refused", async () => {
		process.env.PLANNOTATOR_REMOTE = "1";
		const probe = Bun.serve({ port: 0, hostname: "0.0.0.0", fetch: () => new Response("") });
		process.env.PLANNOTATOR_PORT = String(probe.port);
		probe.stop(true);
		const server = await servers.plan.start();
		try {
			const config = ((await (await fetch(`${base(server)}/api/plan`)).json()) as { serverConfig: Record<string, unknown> }).serverConfig;
			expect(config.cookieHost).toBeUndefined();
			const res = await post(server, { cookieHost: true });
			expect(res.status).toBe(403);
			expect(loadConfig().urlHost).toBeUndefined();
		} finally {
			server.stop();
		}
	});

	test("with a localhost subdomain configured, a document session opens there and a live app session stays on localhost", async () => {
		process.env.PLANNOTATOR_URL_HOST = "plannotator.localhost";
		const app = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response("<html><head><title>app</title></head><body>app</body></html>", { headers: { "Content-Type": "text/html" } }),
		});
		const doc = await servers.annotate.start();
		const targetUrl = `http://127.0.0.1:${app.port}`;
		const live = await startAnnotateServer({
			markdown: "",
			filePath: targetUrl,
			htmlContent: MINIMAL_HTML,
			mode: "annotate-app",
			sourceInfo: targetUrl,
			sharingEnabled: false,
			liveApp: { targetUrl, bridgeScript: "/* bridge */", bridgeBootstrap: "/* bootstrap */", annotationCss: ".pn-live {}" },
		});
		try {
			expect(doc.url).toBe(`http://plannotator.localhost:${doc.port}`);
			expect(live.url).toBe(`http://localhost:${live.port}`);
		} finally {
			doc.stop();
			live.stop();
			app.stop(true);
		}
	});
});
