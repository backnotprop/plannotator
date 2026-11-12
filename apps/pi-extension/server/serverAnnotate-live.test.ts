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
			expect(plan.appUrl).toMatch(/^http:\/\/localhost:\d+\/$/);
			expect(plan.rawHtml).toBeUndefined();
			expect(plan.renderAs).toBeUndefined();
			expect(plan.previousPlan).toBeUndefined();
			expect(plan.versionInfo).toBeUndefined();
			expect(plan.diffCurrent).toBeUndefined();
			expect((plan.agentTerminal as { enabled: boolean }).enabled).toBe(false);

			const appUrl = plan.appUrl as string;
			const bridge = await (await fetch(`${appUrl}__plannotator__/bridge.js`)).text();
			expect(bridge).toContain(String(plan.liveToken));
			const localhostAt = bridge.indexOf(`http://localhost:${server.port}`);
			const loopbackAt = bridge.indexOf(`http://127.0.0.1:${server.port}`);
			expect(localhostAt).toBeGreaterThanOrEqual(0);
			expect(loopbackAt).toBeGreaterThan(localhostAt);
			expect(bridge).toContain(".pn-live {}");
			expect(bridge.indexOf("/* bootstrap body */")).toBeLessThan(bridge.indexOf("/* bridge body */"));

			const page = await (await fetch(appUrl)).text();
			expect(page).toContain('<script src="/__plannotator__/bridge.js"></script>');
		} finally {
			server.stop();
			app.stop(true);
		}
	});

	test("a pathful target URL keeps its path and query in appUrl", async () => {
		const app = startFakeApp();
		const targetUrl = `http://127.0.0.1:${app.port}/admin/settings?tab=2`;
		const server = await startLiveServer(targetUrl);
		try {
			const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { appUrl: string };
			expect(plan.appUrl).toMatch(/^http:\/\/localhost:\d+\/admin\/settings\?tab=2$/);
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
