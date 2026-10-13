/**
 * Pi mirror of packages/server/vscode-proxy-writes.test.ts: the write
 * endpoints' same-origin guard accepts the VS Code cookie proxy's shape
 * (Origin = proxy, Host = server, Sec-Fetch-Site: same-origin) and still
 * refuses other sites.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./generated/config.ts";
import { startReviewServer } from "./server.ts";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-vscode-proxy-writes-"));
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_REMOTE = "0";
	delete process.env.PLANNOTATOR_PORT;
});

afterEach(() => {
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dataDir, { recursive: true, force: true });
});

function send(url: string, path: string, headers: Record<string, string>, body: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = http.request(new URL(path, url), { method: "POST", headers: { "content-type": "text/plain", ...headers } }, (res) => {
			res.resume();
			res.on("end", () => resolve(res.statusCode ?? 0));
		});
		req.on("error", reject);
		req.end(body);
	});
}

const WRITES: Array<[string, string]> = [
	["/api/config", JSON.stringify({ agentTool: true })],
	["/api/review-progress?snapshot=none", JSON.stringify({})],
	["/api/call-flow/install", "not json"],
];

describe("write endpoints behind the VS Code cookie proxy (Pi review server)", () => {
	test("the proxy shape is accepted; cross-site, same-site and Origin null are refused", async () => {
		const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
		try {
			const host = new URL(server.url).host;
			const foreign: Array<Record<string, string>> = [
				{ origin: "https://evil.example", "sec-fetch-site": "cross-site" },
				{ origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" },
				{ origin: "null", "sec-fetch-site": "same-origin" },
			];
			for (const headers of foreign) {
				for (const [path, body] of WRITES) {
					expect([path, headers.origin, await send(server.url, path, { host, ...headers }, body)]).toEqual([path, headers.origin, 403]);
				}
			}
			expect(loadConfig()).toEqual({});
			for (const [path, body] of WRITES) {
				const status = await send(server.url, path, { host, origin: "http://127.0.0.1:53111", "sec-fetch-site": "same-origin" }, body);
				expect([path, status === 403]).toEqual([path, false]);
			}
			expect(loadConfig().agentTool).toBe(true);
		} finally {
			server.stop();
		}
	});
});
