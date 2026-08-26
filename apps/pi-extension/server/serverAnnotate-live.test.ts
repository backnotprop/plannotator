/**
 * Annotate server (Pi/Node): live app mode (annotate-app)
 *
 * Node mirror of packages/server/annotate.test.ts's "live app mode" describe
 * block — the same session contract (live /api/plan payload, composed bridge
 * served by the loopback proxy, per-target draft identity, no version
 * history, guarded shutdown) over apps/pi-extension/server/serverAnnotate.ts
 * and the vendored Node live-proxy transport, plus the remote hard-off that
 * Pi enforces server-side.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAnnotateServer } from "./serverAnnotate.ts";
import { liveAppDraftIdentity } from "../generated/live-proxy-core.ts";

const MINIMAL_HTML = "<html><body>editor</body></html>";

describe("pi annotate server: live app mode (annotate-app)", () => {
	let savedPort: string | undefined;
	let savedRemote: string | undefined;

	beforeEach(() => {
		savedPort = process.env.PLANNOTATOR_PORT;
		savedRemote = process.env.PLANNOTATOR_REMOTE;
		delete process.env.PLANNOTATOR_PORT;
		process.env.PLANNOTATOR_REMOTE = "0";
	});

	afterEach(() => {
		if (savedPort === undefined) delete process.env.PLANNOTATOR_PORT;
		else process.env.PLANNOTATOR_PORT = savedPort;
		if (savedRemote === undefined) delete process.env.PLANNOTATOR_REMOTE;
		else process.env.PLANNOTATOR_REMOTE = savedRemote;
	});

	function startFakeApp() {
		return Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () =>
				new Response("<html><head><title>app</title></head><body>app</body></html>", {
					headers: { "Content-Type": "text/html" },
				}),
		});
	}

	async function startLiveServer(targetUrl: string) {
		return startAnnotateServer({
			markdown: "",
			filePath: targetUrl,
			htmlContent: MINIMAL_HTML,
			mode: "annotate-app",
			sourceInfo: targetUrl,
			sharingEnabled: false,
			liveApp: {
				targetUrl,
				bridgeScript: "/* bridge body */",
				bridgeBootstrap: "/* bootstrap body */",
				annotationCss: ".pn-live {}",
			},
		});
	}

	test("/api/plan returns the live payload and the proxy serves the composed bridge", async () => {
		const app = startFakeApp();
		const targetUrl = `http://127.0.0.1:${app.port}`;
		const server = await startLiveServer(targetUrl);

		try {
			const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as Record<string, unknown>;
			expect(plan.mode).toBe("annotate-app");
			expect(plan.origin).toBe("pi");
			expect(plan.filePath).toBe(targetUrl);
			expect(plan.targetUrl).toBe(targetUrl);
			expect(plan.liveToken).toMatch(/^[0-9a-f]{32}$/);
			expect(plan.sharingEnabled).toBe(false);
			expect(plan.convertHtml).toBe(false);
			// appUrl is the live loopback proxy under its LOCALHOST spelling (so
			// the framed app is same-site with the editor and shares the dev
			// app's host-only localhost cookies), never an advertised-host URL.
			expect(plan.appUrl).toMatch(/^http:\/\/localhost:\d+\/$/);
			// No srcdoc payloads, no version fields.
			expect(plan.rawHtml).toBeUndefined();
			expect(plan.renderAs).toBeUndefined();
			expect(plan.previousPlan).toBeUndefined();
			expect(plan.versionInfo).toBeUndefined();
			expect(plan.diffCurrent).toBeUndefined();
			// Agent terminal stays unavailable for live sessions.
			expect((plan.agentTerminal as { enabled: boolean }).enabled).toBe(false);

			// The proxy serves the composed bridge body: config prelude with the
			// session token and both editor origin forms (localhost first), then
			// bootstrap, then bridge.
			const appUrl = plan.appUrl as string;
			const bridge = await (await fetch(`${appUrl}__plannotator__/bridge.js`)).text();
			expect(bridge).toContain(String(plan.liveToken));
			const localhostAt = bridge.indexOf(`http://localhost:${server.port}`);
			const loopbackAt = bridge.indexOf(`http://127.0.0.1:${server.port}`);
			expect(localhostAt).toBeGreaterThanOrEqual(0);
			expect(loopbackAt).toBeGreaterThan(localhostAt);
			expect(bridge).toContain(".pn-live {}");
			expect(bridge.indexOf("/* bootstrap body */")).toBeLessThan(bridge.indexOf("/* bridge body */"));

			// The proxied page carries the injected bridge script tag.
			const page = await (await fetch(appUrl)).text();
			expect(page).toContain('<script src="/__plannotator__/bridge.js"></script>');
		} finally {
			server.stop();
			app.stop(true);
		}
	});

	test("a pathful target URL keeps its path and query in appUrl", async () => {
		// Annotating http://localhost:5173/admin/settings must open that page,
		// not the app root.
		const app = startFakeApp();
		const targetUrl = `http://127.0.0.1:${app.port}/admin/settings?tab=2`;
		const server = await startLiveServer(targetUrl);
		try {
			const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { appUrl: string };
			expect(plan.appUrl).toMatch(/^http:\/\/localhost:\d+\/admin\/settings\?tab=2$/);
			// The advertised page is reachable through the proxy under the
			// localhost Host spelling.
			const res = await fetch(plan.appUrl);
			expect(res.status).toBe(200);
		} finally {
			server.stop();
			app.stop(true);
		}
	});

	test("version endpoints report no history for live sessions", async () => {
		const app = startFakeApp();
		const server = await startLiveServer(`http://127.0.0.1:${app.port}`);
		try {
			const versions = (await (await fetch(`${server.url}/api/plan/versions`)).json()) as {
				slug: string | null;
				versions: unknown[];
			};
			expect(versions.slug).toBeNull();
			expect(versions.versions).toEqual([]);
			const version = await fetch(`${server.url}/api/plan/version?v=1`);
			expect(version.status).toBe(404);
		} finally {
			server.stop();
			app.stop(true);
		}
	});

	test("stop() closes the proxy port with the server", async () => {
		const app = startFakeApp();
		const server = await startLiveServer(`http://127.0.0.1:${app.port}`);
		const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { appUrl: string };
		// Reachable while running.
		expect((await fetch(plan.appUrl)).status).toBe(200);
		server.stop();
		await Bun.sleep(50);
		let closed = false;
		try {
			await fetch(plan.appUrl, { signal: AbortSignal.timeout(1000) });
		} catch {
			closed = true;
		}
		expect(closed).toBe(true);
		app.stop(true);
	});

	test("remote sessions refuse live app mode outright", async () => {
		// Defense in depth behind the command-side check: a live proxy relays
		// the user's authenticated dev app, and a remote Pi session is
		// reachable beyond loopback. No override env var exists on purpose.
		const app = startFakeApp();
		process.env.PLANNOTATOR_REMOTE = "1";
		try {
			await expect(startLiveServer(`http://127.0.0.1:${app.port}`)).rejects.toThrow(
				"Live app annotation is unavailable in remote mode",
			);
		} finally {
			process.env.PLANNOTATOR_REMOTE = "0";
			app.stop(true);
		}
	});

	describe("draft isolation between live sessions", () => {
		// A live session holds no document text (markdown is "" by
		// construction), so keying its draft by content would give every live
		// session on the machine the one hash of the empty string. The target
		// is the identity, shared with the Bun server via liveAppDraftIdentity.
		const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
		let draftDataDir: string;

		beforeEach(() => {
			draftDataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-live-draft-"));
			process.env.PLANNOTATOR_DATA_DIR = draftDataDir;
		});

		afterEach(() => {
			if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
			else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
			rmSync(draftDataDir, { recursive: true, force: true });
		});

		async function saveDraft(server: { url: string }, feedback: string): Promise<void> {
			const res = await fetch(`${server.url}/api/draft`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ feedback, annotations: [] }),
			});
			expect(res.status).toBe(200);
		}

		async function loadDraft(server: { url: string }): Promise<{ feedback?: string } | null> {
			const res = await fetch(`${server.url}/api/draft`);
			if (res.status === 404) return null;
			expect(res.status).toBe(200);
			return (await res.json()) as { feedback?: string };
		}

		test("two live sessions on different targets keep independent drafts", async () => {
			const appX = startFakeApp();
			const appY = startFakeApp();
			const serverX = await startLiveServer(`http://127.0.0.1:${appX.port}`);
			const serverY = await startLiveServer(`http://127.0.0.1:${appY.port}`);
			try {
				await saveDraft(serverX, "notes for X");
				await saveDraft(serverY, "notes for Y");

				// Neither session sees the other's text, in either direction.
				expect((await loadDraft(serverX))?.feedback).toBe("notes for X");
				expect((await loadDraft(serverY))?.feedback).toBe("notes for Y");
				expect(readdirSync(join(draftDataDir, "drafts")).length).toBe(2);
			} finally {
				serverX.stop();
				serverY.stop();
				appX.stop(true);
				appY.stop(true);
			}
		});

		test("the same target recovers its draft after a restart", async () => {
			const app = startFakeApp();
			const targetUrl = `http://127.0.0.1:${app.port}`;
			const first = await startLiveServer(targetUrl);
			try {
				await saveDraft(first, "survives the crash");
			} finally {
				first.stop();
			}
			// Same target, spelled with a trailing slash the way a browser would
			// hand it back: the draft is the point of the key, so it must survive.
			const second = await startLiveServer(`${targetUrl}/`);
			try {
				expect((await loadDraft(second))?.feedback).toBe("survives the crash");
			} finally {
				second.stop();
				app.stop(true);
			}
		});

		test("the vendored identity matches the Bun server's normalization", () => {
			const a = liveAppDraftIdentity("http://127.0.0.1:5173");
			expect(liveAppDraftIdentity("http://127.0.0.1:5173/")).toBe(a);
			expect(liveAppDraftIdentity("http://127.0.0.1:5174")).not.toBe(a);
			expect(liveAppDraftIdentity("http://127.0.0.1:5173/admin/")).toBe(
				liveAppDraftIdentity("http://127.0.0.1:5173/admin"),
			);
			expect(liveAppDraftIdentity("not a url")).toBe("not a url");
		});
	});
});
