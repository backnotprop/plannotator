/**
 * The VS Code extension panel loads Plannotator through its cookie proxy
 * (apps/vscode-extension/src/cookie-proxy.ts): the page's origin is the
 * proxy's (`http://127.0.0.1:<proxy port>`) and the proxy rewrites Host to the
 * server's. The same-origin guard on the write endpoints must still accept
 * those writes, or VS Code settings, viewed-file progress and the CallDiff
 * install silently stop working, while a page on another site stays refused.
 *
 * Requests go through node:http so the Host and Sec-Fetch-Site headers are
 * exactly what a browser behind the proxy sends. The Pi mirror is
 * apps/pi-extension/vscode-proxy-writes.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCookieProxy } from "../../apps/vscode-extension/src/cookie-proxy";
import { loadConfig } from "./config";
import { startReviewServer } from "./review";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-vscode-proxy-writes-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_REMOTE = "0";
  process.env.PLANNOTATOR_AI = "disabled";
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

/** The write endpoints, each with a body that never starts real work. */
const WRITES: Array<[string, string]> = [
  ["/api/config", JSON.stringify({ agentTool: true })],
  ["/api/review-progress?snapshot=none", JSON.stringify({})],
  // Not JSON: the install answers 400 after the origin check, starting nothing.
  ["/api/call-flow/install", "not json"],
];

describe("write endpoints behind the VS Code cookie proxy (Bun review server)", () => {
  test("an older extension's proxy shape (Origin = proxy, Host = server, Sec-Fetch-Site: same-origin) is accepted", async () => {
    const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
    try {
      const host = new URL(server.url).host;
      for (const [path, body] of WRITES) {
        const status = await send(server.url, path, { host, origin: "http://127.0.0.1:53111", "sec-fetch-site": "same-origin" }, body);
        expect([path, status === 403]).toEqual([path, false]);
      }
      expect(loadConfig().agentTool).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("other sites stay refused: cross-site, same-site, Origin null", async () => {
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
    } finally {
      server.stop();
    }
  });

  test("through the real cookie proxy, a write from the panel's page is accepted (Origin re-anchored)", async () => {
    const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML });
    const proxy = await createCookieProxy({ loadCookies: () => "", onSaveCookies: () => undefined });
    try {
      const panelUrl = proxy.rewriteUrl(server.url);
      const panelOrigin = new URL(panelUrl).origin;
      // No Sec-Fetch-Site: the proxy's Origin rewrite alone must carry it.
      expect(await send(panelUrl, "/api/config", { origin: panelOrigin }, JSON.stringify({ agentTool: true }))).toBe(200);
      expect(loadConfig().agentTool).toBe(true);
      // A foreign Origin is forwarded untouched and refused.
      expect(await send(panelUrl, "/api/config", { origin: "https://evil.example" }, JSON.stringify({ agentTool: false }))).toBe(403);
      expect(loadConfig().agentTool).toBe(true);
    } finally {
      proxy.server.close();
      server.stop();
    }
  });
});
