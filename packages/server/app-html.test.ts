/**
 * #1617: Bun app-HTML routes serve the page compressed to network-reachable
 * sessions (remote mode, --tailscale) and exactly as before to local ones.
 * Nothing else changes shape: API JSON, the framed-embed 404 (#1561), and the
 * VS Code cookie proxy's identity path.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCookieProxy, type CookieProxy } from "../../apps/vscode-extension/src/cookie-proxy";
import { normalizeGoalSetupBundle } from "@plannotator/shared/goal-setup";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";
import {
  expectAppHtmlNegotiation,
  expectUncompressedLocalPage,
  makeAppHtml,
  rawRequest,
} from "../../tests/helpers/app-html";
import { startPlannotatorServer } from "./index";
import { startAnnotateServer } from "./annotate";
import { startReviewServer } from "./review";
import { startGoalSetupServer } from "./goal-setup";

const environment = createTestEnvironment(
  ["PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_DATA_DIR", "PLANNOTATOR_BROWSER"],
  "plannotator-app-html-",
);

async function isolate(remote: boolean): Promise<void> {
  environment.reset();
  process.env.PLANNOTATOR_DATA_DIR = environment.makeTempDir();
  process.env.PLANNOTATOR_BROWSER = "/usr/bin/true";
  process.env.PLANNOTATOR_REMOTE = remote ? "1" : "0";
  if (remote) {
    // Remote mode would otherwise bind the fixed 19432.
    const { start, servers } = await occupyConsecutivePorts(1);
    await closeServer(servers[0]);
    process.env.PLANNOTATOR_PORT = String(start);
  }
}

afterEach(() => environment.restore());

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-old
+new
`;

describe("Bun app HTML: remote sessions negotiate compression", () => {
  test("plan server", async () => {
    await isolate(true);
    const html = makeAppHtml("bun-plan");
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: html });
    try {
      await expectAppHtmlNegotiation(`${server.url}/`, html);
      await expectAppHtmlNegotiation(`${server.url}/some/spa/route`, html);
      // API JSON stays uncompressed.
      const api = await rawRequest(`${server.url}/api/plan`, { headers: { "accept-encoding": "br, gzip" } });
      expect(api.headers["content-encoding"]).toBeUndefined();
      expect(JSON.parse(api.body.toString("utf8")).plan).toBe("# Plan");
    } finally {
      await server.stop();
    }
  });

  test("annotate server, with the framed-embed 404 unchanged", async () => {
    await isolate(true);
    const html = makeAppHtml("bun-annotate");
    const server = await startAnnotateServer({
      markdown: "# Doc",
      filePath: join(tmpdir(), "app-html-doc.md"),
      htmlContent: html,
    });
    try {
      await expectAppHtmlNegotiation(`${server.url}/`, html);
      const framed = await rawRequest(`${server.url}/missing-embed.html`, {
        headers: { "sec-fetch-dest": "iframe", "accept-encoding": "br, gzip" },
      });
      expect(framed.status).toBe(404);
      expect(framed.headers["content-encoding"]).toBeUndefined();
      expect(framed.body.toString("utf8")).toContain("missing-embed.html");
    } finally {
      server.stop();
    }
  });

  test("review server", async () => {
    await isolate(true);
    const html = makeAppHtml("bun-review");
    const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: html });
    try {
      await expectAppHtmlNegotiation(`${server.url}/`, html);
    } finally {
      server.stop();
    }
  });

  test("goal setup server", async () => {
    await isolate(true);
    const html = makeAppHtml("bun-goal");
    const server = await startGoalSetupServer({
      bundle: normalizeGoalSetupBundle({ stage: "interview", title: "Goal", questions: [{ id: "q", prompt: "Q?" }] }),
      htmlContent: html,
      origin: "claude-code",
    });
    try {
      await expectAppHtmlNegotiation(`${server.url}/`, html);
    } finally {
      server.stop();
    }
  });
});

describe("Bun app HTML: --tailscale sessions compress while staying local", () => {
  // tailscale serve proxies from 127.0.0.1, so only the session flag can tell.
  test("review server", async () => {
    await isolate(false);
    const html = makeAppHtml("bun-review-tailnet");
    const server = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: html, tailnetPublished: true });
    try {
      await expectAppHtmlNegotiation(`${server.url}/`, html);
    } finally {
      server.stop();
    }
  });

  test("annotate server", async () => {
    await isolate(false);
    const html = makeAppHtml("bun-annotate-tailnet");
    const server = await startAnnotateServer({
      markdown: "# Doc",
      filePath: join(tmpdir(), "app-html-tailnet.md"),
      htmlContent: html,
      tailnetPublished: true,
    });
    try {
      await expectAppHtmlNegotiation(`${server.url}/`, html);
    } finally {
      server.stop();
    }
  });
});

describe("Bun app HTML: local sessions are unchanged", () => {
  test("plan, annotate, review and goal setup serve the original page", async () => {
    await isolate(false);
    const plan = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: makeAppHtml("l-plan") });
    const annotate = await startAnnotateServer({
      markdown: "# Doc",
      filePath: join(tmpdir(), "app-html-local.md"),
      htmlContent: makeAppHtml("l-annotate"),
    });
    const review = await startReviewServer({ rawPatch: PATCH, gitRef: "HEAD", htmlContent: makeAppHtml("l-review") });
    const goal = await startGoalSetupServer({
      bundle: normalizeGoalSetupBundle({ stage: "interview", title: "Goal", questions: [{ id: "q", prompt: "Q?" }] }),
      htmlContent: makeAppHtml("l-goal"),
      origin: "claude-code",
    });
    try {
      await expectUncompressedLocalPage(`${plan.url}/`, makeAppHtml("l-plan"));
      await expectUncompressedLocalPage(`${annotate.url}/`, makeAppHtml("l-annotate"));
      await expectUncompressedLocalPage(`${review.url}/`, makeAppHtml("l-review"));
      await expectUncompressedLocalPage(`${goal.url}/`, makeAppHtml("l-goal"));
    } finally {
      await plan.stop();
      annotate.stop();
      review.stop();
      goal.stop();
    }
  });
});

describe("VS Code cookie proxy in front of a compressing server", () => {
  let proxy: CookieProxy | undefined;
  afterEach(() => {
    proxy?.server.close();
    proxy = undefined;
  });

  test("a webview asking for br still gets plain, injectable HTML", async () => {
    // Remote (compressing) upstream, the worst case for the proxy.
    await isolate(true);
    const html = makeAppHtml("bun-vscode-proxy");
    const server = await startPlannotatorServer({ plan: "# Plan", origin: "claude-code", htmlContent: html });
    try {
      proxy = await createCookieProxy({ loadCookies: () => "plannotator-identity=tater", onSaveCookies: () => {} });
      const proxiedUrl = proxy.rewriteUrl(`${server.url}/`);
      // What the Electron webview sends.
      const res = await rawRequest(proxiedUrl, { headers: { "accept-encoding": "gzip, deflate, br, zstd" } });
      expect(res.status).toBe(200);
      expect(res.headers["content-encoding"]).toBeUndefined();
      const text = res.body.toString("utf8");
      // The proxy's injection landed and the app page follows intact.
      expect(text).toContain("Object.defineProperty(document,\"cookie\"");
      expect(text).toContain(html.slice(html.indexOf("<body>")));
    } finally {
      await server.stop();
    }
  });
});
