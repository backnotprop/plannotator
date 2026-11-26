/**
 * `/plannotator-themes.js` on the Pi (node:http) plan, review and annotate servers: the
 * script every page links in its head, so a custom theme is in the first
 * frame. The failures these guard: a server that answers the page for this
 * path instead (the SPA fallback: the theme never loads), a cached answer (a
 * theme added since would not show on reload), and a script that does not
 * carry the theme added in the data dir, or a theme's code colours not
 * answered on `?syntax=<id>` (or put in the script every page waits for).
 * The Bun mirror is packages/server/custom-themes-route.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCustomTheme } from "./generated/theme-files.ts";
import { startAnnotateServer, startPlanReviewServer, startReviewServer } from "./server.ts";

const MINIMAL_HTML = '<html><head><script  src="/plannotator-themes.js"></script></head><body>Plannotator</body></html>';
const PATCH = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI"] as const;
const saved: Record<string, string | undefined> = {};
let dataDir: string;

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-pi-custom-themes-route-"));
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
});

const servers = {
  plan: () => startPlanReviewServer({ plan: "# Plan", origin: "opencode", htmlContent: MINIMAL_HTML }),
  review: () => startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: MINIMAL_HTML, origin: "opencode" }),
  annotate: () => startAnnotateServer({ markdown: "# Test", filePath: join(dataDir, "t.md"), htmlContent: MINIMAL_HTML, origin: "opencode" }),
};

describe("the custom themes script on the Pi servers", () => {
  for (const [name, start] of Object.entries(servers)) {
    test(`${name}: a script, never cached, carrying the themes in the data dir`, async () => {
      const server = await start();
      try {
        const empty = await fetch(`${server.url}/plannotator-themes.js`);
        expect(empty.status).toBe(200);
        expect(empty.headers.get("content-type")).toStartWith("text/javascript");
        expect(empty.headers.get("cache-control")).toBe("no-store");
        expect(await empty.text()).not.toContain(".theme-");
        // The page itself: with no custom theme, no themes tag (no request, nothing added).
        const bare = await (await fetch(`${server.url}/`)).text();
        expect(bare).toBe("<html><head></head><body>Plannotator</body></html>");
        saveCustomTheme(dataDir, { plannotatorTheme: 1, id: "harbor", name: "Harbor", dark: { background: "#0f1419" } });
        const body = await (await fetch(`${server.url}/plannotator-themes.js`)).text();
        expect(body).toContain(".theme-harbor {");
        expect(body).toContain("--background: #0f1419;");
        // ...and with one, the script is written into the page: still no request.
        const page = await (await fetch(`${server.url}/`)).text();
        expect(page).toContain(".theme-harbor {");
        expect(page).not.toContain('src="/plannotator-themes.js"');
        // Code colours: asked for when code first renders, never in the script.
        expect((await fetch(`${server.url}/plannotator-themes.js?syntax=harbor`)).status).toBe(404);
        saveCustomTheme(dataDir, { plannotatorTheme: 1, id: "mono", name: "Mono", dark: { background: "#272822", syntax: [{ scope: "keyword", foreground: "#f92672" }] } });
        const syntax = await fetch(`${server.url}/plannotator-themes.js?syntax=mono`);
        expect(syntax.status).toBe(200);
        expect(syntax.headers.get("content-type")).toStartWith("application/json");
        expect((await syntax.json()).dark.rules).toEqual([{ scope: "keyword", foreground: "#f92672" }]);
        expect(await (await fetch(`${server.url}/plannotator-themes.js`)).text()).not.toContain("#f92672");
      } finally {
        server.stop();
      }
    });
  }
});
