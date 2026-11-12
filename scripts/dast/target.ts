import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { startAnnotateServer } from "../../packages/server/annotate";
import { startInboxServer } from "../../packages/server/inbox";
import { getPlannotatorDataDir } from "../../packages/shared/data-dir";
import { refuseRealDataDir } from "../../tests/helpers/real-data-dir";

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

refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, "scripts/dast/target.ts");
const inboxDataDir = getPlannotatorDataDir();

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

const scanTarget = Bun.serve({
  hostname: "0.0.0.0",
  port: SCAN_PORT,
  async fetch(request) {
    const sourceUrl = new URL(request.url);
    if (
      !readOnlyMethods.has(request.method) ||
      !(forwardedPaths.has(sourceUrl.pathname) || sourceUrl.pathname.startsWith("/assets/"))
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

const inbox = await startInboxServer({
  dataDir: inboxDataDir,
  version: "dast",
  binaryPath: null,
  phones: true,
  htmlContent: readFileSync(resolve("apps/hook/dist/inbox.html"), "utf8"),
});
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
  "/api/inbox/device/health",
  "/api/inbox/device/threads",
  "/api/inbox/device/settings",
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
