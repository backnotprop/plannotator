import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startAnnotateServer } from "../../packages/server/annotate";
import { startInboxServer } from "../../packages/server/inbox";

const SCAN_PORT = 19432;
const SENTINEL_PORT = 19433;
const APP_PORT = 19434;
const INBOX_SCAN_PORT = 19435;

if (process.env.PLANNOTATOR_DAST_ISOLATED !== "1") {
  throw new Error(
    "Refusing to start the DAST target without PLANNOTATOR_DAST_ISOLATED=1. " +
      "Run it only inside the workflow's internal Docker network.",
  );
}

// These are defense-in-depth defaults for the test target. The Docker network
// is the primary outbound boundary; the application is also configured so an
// accidentally reached feature cannot invoke agents, share content, persist
// review data, open a browser, or install optional runtimes.
Object.assign(process.env, {
  PLANNOTATOR_REMOTE: "0",
  PLANNOTATOR_PORT: String(APP_PORT),
  PLANNOTATOR_AI: "disabled",
  PLANNOTATOR_SHARE: "disabled",
  PLANNOTATOR_JINA: "0",
  PLANNOTATOR_ANNOTATE_HISTORY: "0",
  PLANNOTATOR_GUIDE_HISTORY: "0",
  PLANNOTATOR_TODO_PROVIDER: "off",
  PLANNOTATOR_GLIMPSE: "0",
  PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
  PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL: "1",
  PLANNOTATOR_SKIP_SEM_INSTALL: "1",
  PLANNOTATOR_FILE_BROWSER_MAX_FILES: "64",
  BROWSER: "true",
  // The read-only guards below forward the scanner's Host
  // (`plannotator-dast-target:<port>`) unchanged; every server's Host
  // allowlist refuses names it does not know, so name this one.
  PLANNOTATOR_ALLOWED_HOSTS: "plannotator-dast-target",
});

const htmlPath = resolve("apps/hook/dist/index.html");
const htmlContent = readFileSync(htmlPath, "utf8");

const application = await startAnnotateServer({
  markdown: [
    "# Disposable DAST fixture",
    "",
    "This document exists only inside an isolated GitHub Actions runner.",
    "",
    "- It contains no credentials or user data.",
    "- Submitting feedback is outside the passive scan scope.",
  ].join("\n"),
  filePath: "dast-fixture.md",
  htmlContent,
  mode: "annotate-last",
  origin: "claude-code",
  sharingEnabled: false,
  gate: false,
  project: "dast-fixture",
});

const forwardedPaths = new Set([
  "/",
  "/api/plan",
  "/api/ai/capabilities",
  "/api/definitely-missing",
]);
const readOnlyMethods = new Set(["GET", "HEAD"]);

// Place a read-only route guard in front of the real annotate server. ZAP's
// baseline spider requests crawler metadata such as /robots.txt and
// /sitemap.xml; the application's browser fallback correctly serves the SPA
// for those paths, but feeding the 20+ MiB bundle back to a static spider is
// both wasteful and misleading. The guard also makes it impossible for this
// passive workflow to reach state-changing application endpoints.
const scanTarget = Bun.serve({
  hostname: "0.0.0.0",
  port: SCAN_PORT,
  async fetch(request) {
    const sourceUrl = new URL(request.url);
    if (
      !readOnlyMethods.has(request.method) ||
      !forwardedPaths.has(sourceUrl.pathname)
    ) {
      return new Response("Not found", {
        status:
          request.method === "GET" || request.method === "HEAD" ? 404 : 405,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Plannotator-DAST-Guard": "blocked",
        },
      });
    }

    const upstreamUrl = new URL(request.url);
    upstreamUrl.hostname = "127.0.0.1";
    upstreamUrl.port = String(APP_PORT);
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
    });
    const headers = new Headers(response.headers);
    headers.set("X-Plannotator-DAST-Guard", "forwarded");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
});

// The Plannotator Inbox, seeded with one thread that asks a question, behind
// the same kind of read-only guard. It always binds loopback itself.
// binaryPath null: no restart-to-update probe of the bun binary every minute.
const inbox = await startInboxServer({ version: "dast", binaryPath: null });
const inboxProject = inbox.store.ensureProject({ name: "dast-fixture", root: "/workspace" });
const inboxThread = inbox.store.sendMessage({
  project_id: inboxProject.id,
  author: { kind: "agent", host: "dast", session: null, name: "DAST fixture" },
  body: [
    "Disposable DAST fixture message.",
    "",
    ":::question",
    "Does the passive scan reach this card?",
    "",
    "- [ ] Yes",
    "- [ ] No",
    ":::",
  ].join("\n"),
});
const inboxForwardedPaths = new Set([
  "/",
  "/api/inbox/health",
  "/api/inbox/projects",
  "/api/inbox/threads",
  `/api/inbox/threads/${inboxThread.message.thread_id}`,
  "/api/definitely-missing",
]);
const inboxScanTarget = Bun.serve({
  hostname: "0.0.0.0",
  port: INBOX_SCAN_PORT,
  async fetch(request) {
    const sourceUrl = new URL(request.url);
    if (!readOnlyMethods.has(request.method) || !inboxForwardedPaths.has(sourceUrl.pathname)) {
      return new Response("Not found", {
        status: request.method === "GET" || request.method === "HEAD" ? 404 : 405,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "X-Plannotator-DAST-Guard": "blocked",
        },
      });
    }
    const upstreamUrl = new URL(request.url);
    upstreamUrl.hostname = "127.0.0.1";
    upstreamUrl.port = String(inbox.port);
    const response = await fetch(upstreamUrl, {
      method: request.method,
      headers: request.headers,
      redirect: "manual",
    });
    const headers = new Headers(response.headers);
    headers.set("X-Plannotator-DAST-Guard", "forwarded");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
});

// A harmless detector-health target. Its deliberately absent defensive
// headers should trigger ZAP rule 10020 (anti-clickjacking header missing).
// It is separate from the application report and never enters a product build.
const sentinel = Bun.serve({
  hostname: "0.0.0.0",
  port: SENTINEL_PORT,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (pathname === "/healthz") {
      return new Response("ok", {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(
      "<!doctype html><html><head><title>ZAP detector health</title></head>" +
        "<body><h1>Controlled passive-scan fixture</h1></body></html>",
      { headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  },
});

console.log(
  JSON.stringify({
    event: "dast-target-ready",
    applicationPort: application.port,
    scanPort: scanTarget.port,
    sentinelPort: sentinel.port,
    inboxScanPort: inboxScanTarget.port,
    inboxPort: inbox.port,
    inboxThread: inboxThread.message.thread_id,
  }),
);

await new Promise<void>((resolveShutdown) => {
  const shutdown = () => resolveShutdown();
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});

sentinel.stop(true);
inboxScanTarget.stop(true);
inbox.stop();
scanTarget.stop(true);
application.stop();
