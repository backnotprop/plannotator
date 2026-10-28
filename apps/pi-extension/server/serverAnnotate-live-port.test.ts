/**
 * Pi annotate server with PLANNOTATOR_LIVE_PORT (#2145): the vendored Node
 * live proxy honors the variable inside a live session, and a proxy that
 * cannot bind fails the start without leaving the editor's listener (or the
 * proxy's) open. Mirrors the Bun annotate case in
 * packages/server/live-proxy-port.test.ts; the Node transport itself is
 * covered in a real node process by packages/shared/live-proxy-node-port.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	accepts,
	canBind,
	closeServer,
	occupyConsecutivePorts,
	partlyBusyRange,
	reserveFreePort,
} from "../../../tests/helpers/live-port.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

const ENV_KEYS = ["PLANNOTATOR_LIVE_PORT", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let app: ReturnType<typeof Bun.serve>;

beforeEach(() => {
	savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.PLANNOTATOR_REMOTE = "0";
	app = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () =>
			new Response("<html><head></head><body>app</body></html>", {
				headers: { "Content-Type": "text/html" },
			}),
	});
});

afterEach(() => {
	app.stop(true);
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
});

function startLiveServer() {
	const targetUrl = `http://127.0.0.1:${app.port}`;
	return startAnnotateServer({
		markdown: "",
		filePath: targetUrl,
		htmlContent: "<html><body>editor</body></html>",
		mode: "annotate-app",
		sourceInfo: targetUrl,
		sharingEnabled: false,
		liveApp: {
			targetUrl,
			bridgeScript: "/* bridge */",
			bridgeBootstrap: "/* bootstrap */",
			annotationCss: "",
		},
	});
}

describe("pi annotate server: PLANNOTATOR_LIVE_PORT", () => {
	test("a range whose first port is busy puts the proxy on the next", async () => {
		// The editor gets a port of its own: on an OS that hands out ports in
		// order, a random editor port would be the range's freed second port.
		const editorPort = await reserveFreePort();
		const range = await partlyBusyRange(2, 1);
		try {
			process.env.PLANNOTATOR_PORT = String(editorPort);
			process.env.PLANNOTATOR_LIVE_PORT = `${range.start}-${range.end}`;
			const server = await startLiveServer();
			try {
				expect(server.liveProxyPort).toBe(range.start + 1);
				const plan = (await (await fetch(`${server.url}/api/plan`)).json()) as { appUrl: string };
				expect(plan.appUrl).toBe(`http://localhost:${range.start + 1}/`);
				const res = await fetch(`http://127.0.0.1:${range.start + 1}/`);
				expect(await res.text()).toContain("app");
			} finally {
				server.stop();
			}
		} finally {
			await range.release();
		}
	});

	test("every port busy rejects and leaves no listener open, the editor's included", async () => {
		const editorPort = await reserveFreePort();
		const { start, servers } = await occupyConsecutivePorts(2);
		try {
			process.env.PLANNOTATOR_PORT = String(editorPort);
			process.env.PLANNOTATOR_LIVE_PORT = `${start}-${start + 1}`;
			let thrown: unknown;
			try {
				await startLiveServer();
			} catch (error) {
				thrown = error;
			}
			expect((thrown as Error | undefined)?.name).toBe("LiveProxyPortInUseError");
			expect((thrown as Error).message).toContain(
				`every port in PLANNOTATOR_LIVE_PORT ${start}-${start + 1} is already in use`,
			);
			// Give the closing listener a moment, then nothing may answer there.
			await Bun.sleep(50);
			expect(await accepts("127.0.0.1", editorPort)).toBe(false);
			expect(await canBind(editorPort)).toBe(true);
		} finally {
			await Promise.all(servers.map(closeServer));
		}
	});
});
