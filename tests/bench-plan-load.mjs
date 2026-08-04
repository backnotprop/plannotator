#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

class CdpClient {
  constructor(url, commandTimeoutMs) {
    this.url = url;
    this.commandTimeoutMs = commandTimeoutMs;
    this.id = 0;
    this.pending = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ws.close();
        reject(new Error("Timed out connecting to Chrome DevTools."));
      }, this.commandTimeoutMs);
      const settle = (callback) => (event) => {
        clearTimeout(timer);
        callback(event);
      };
      this.ws.addEventListener("open", settle(resolve), { once: true });
      this.ws.addEventListener("error", settle(reject), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    this.ws.addEventListener("close", () => this.rejectPending(new Error("Chrome DevTools connection closed.")));
    this.ws.addEventListener("error", () => this.rejectPending(new Error("Chrome DevTools connection failed.")));
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Chrome DevTools command ${method}.`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.ws?.close();
  }
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const htmlPath = path.resolve(options.html ?? path.join(repoRoot, "apps/hook/dist/index.html"));
const chromePath = options.chrome ?? process.env.CHROME_PATH ?? findChrome();

if (!fs.existsSync(htmlPath)) {
  console.error(`Plan UI not found at ${htmlPath}. Run \`bun run build:hook\` or pass --html <path>.`);
  process.exit(1);
}
if (!chromePath) {
  console.error("Could not find Chrome or Chromium. Set CHROME_PATH or pass --chrome <path>.");
  process.exit(1);
}
try {
  fs.accessSync(chromePath, fs.constants.X_OK);
} catch {
  console.error(`Chrome executable is not accessible: ${chromePath}`);
  process.exit(1);
}

const html = fs.readFileSync(htmlPath);
const htmlSha256 = createHash("sha256").update(html).digest("hex");
const server = http.createServer((request, response) => {
  if (request.url === "/") {
    send(response, "text/html; charset=utf-8", html);
    return;
  }
  if (request.url?.startsWith("/api/plan")) {
    send(response, "application/json", Buffer.from(JSON.stringify(planResponse())));
    return;
  }
  send(response, "application/json", Buffer.from("{}"));
});

let profileDir;
let chrome;
let browser;
try {
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Benchmark server did not bind a TCP port.");

  const debugPort = await getFreePort();
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "plannotator-plan-benchmark-"));
  chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank",
  ], { stdio: "ignore" });
  const chromeFailure = new Promise((_, reject) => {
    chrome.once("error", reject);
    chrome.once("exit", (code, signal) => {
      reject(new Error(`Chrome exited before the benchmark completed (${signal ?? code}).`));
    });
  });

  const version = await Promise.race([
    waitForJson(`http://127.0.0.1:${debugPort}/json/version`, options.timeout),
    chromeFailure,
  ]);
  browser = new CdpClient(version.webSocketDebuggerUrl, options.timeout);
  await browser.connect();

  const results = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const target = await findTarget(debugPort, targetId, options.timeout);
    const page = new CdpClient(target.webSocketDebuggerUrl, options.timeout);
    try {
      await page.connect();
      await preparePage(page);
      await page.send("Network.clearBrowserCache");
      const startedAt = performance.now();
      await page.send("Page.navigate", { url: `http://127.0.0.1:${address.port}/` });
      await waitUntilUsable(page, options.timeout);
      const wallMs = performance.now() - startedAt;
      const snapshot = await evaluate(page, `(() => ({
        navigation: performance.getEntriesByType("navigation")[0]?.toJSON(),
        longTasks: window.__plannotatorLongTasks ?? []
      }))()`);
      const metrics = await readMetrics(page);
      results.push(toResult(run, wallMs, snapshot, metrics));
    } finally {
      page.close();
      await browser.send("Target.closeTarget", { targetId });
    }
  }

  const report = {
    chrome: version.Browser,
    protocolVersion: version["Protocol-Version"],
    htmlPath,
    htmlBytes: html.length,
    htmlSha256,
    cache: "cleared before each run",
    results,
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else printResults(report);
} finally {
  browser?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([onceExit(chrome), delay(2_000)]);
    if (chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill("SIGKILL");
      await onceExit(chrome);
    }
  }
  if (server.listening) await closeServer(server);
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
}

function parseArgs(args) {
  const parsed = { runs: 3, timeout: 30_000, json: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--runs") parsed.runs = positiveInteger(args[++index], "--runs");
    else if (arg === "--timeout") parsed.timeout = positiveInteger(args[++index], "--timeout");
    else if (arg === "--html") parsed.html = requiredValue(args[++index], "--html");
    else if (arg === "--chrome") parsed.chrome = requiredValue(args[++index], "--chrome");
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node tests/bench-plan-load.mjs [options]

Options:
  --runs <count>       Number of isolated cold loads (default: 3)
  --timeout <ms>       Per-navigation and CDP timeout (default: 30000)
  --html <path>        Built plan HTML (default: apps/hook/dist/index.html)
  --chrome <path>      Chrome/Chromium executable (or set CHROME_PATH)
  --json               Print machine-readable results`);
      process.exit(0);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} requires a positive integer.`);
  return parsed;
}

function requiredValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function planResponse() {
  const section = "## Benchmark step\n\nA representative Pi plan paragraph used to detect when rendering is complete.\n\n";
  return {
    plan: `# Browser load benchmark\n\n${section.repeat(30)}`,
    origin: "pi",
    previousPlan: null,
    versionInfo: { version: 1, totalVersions: 1, project: "benchmark" },
    sharingEnabled: false,
    repoInfo: null,
    projectRoot: repoRoot,
    serverConfig: {},
  };
}

function send(response, contentType, body) {
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": body.length,
  });
  response.end(body);
}

async function preparePage(page) {
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Performance.enable");
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__plannotatorLongTasks = [];
      new PerformanceObserver((list) => window.__plannotatorLongTasks.push(
        ...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration }))
      )).observe({ type: "longtask", buffered: true });`,
  });
}

async function waitUntilUsable(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await evaluate(page, `document.readyState === "complete"
      && document.body?.innerText.includes("Browser load benchmark")
      && document.body?.innerText.includes("Approve")`);
    if (ready) return;
    await delay(25);
  }
  throw new Error(`Plan UI did not become usable within ${timeoutMs}ms.`);
}

async function readMetrics(page) {
  const { metrics } = await page.send("Performance.getMetrics");
  return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
}

function toResult(run, wallMs, snapshot, metrics) {
  const navigation = snapshot.navigation ?? {};
  const longTasks = snapshot.longTasks ?? [];
  return {
    run,
    usableMs: round(wallMs),
    responseEndMs: round(navigation.responseEnd ?? 0),
    domInteractiveMs: round(navigation.domInteractive ?? 0),
    loadEndMs: round(navigation.loadEventEnd ?? 0),
    documentTransferBytes: navigation.transferSize ?? 0,
    scriptMs: round((metrics.ScriptDuration ?? 0) * 1000),
    taskMs: round((metrics.TaskDuration ?? 0) * 1000),
    longTaskCount: longTasks.length,
    longTaskTotalMs: round(longTasks.reduce((total, task) => total + task.duration, 0)),
    longTaskMaxMs: round(Math.max(0, ...longTasks.map((task) => task.duration))),
    jsHeapUsedMb: round((metrics.JSHeapUsedSize ?? 0) / 1024 / 1024),
  };
}

function printResults(report) {
  console.log(`Chrome: ${report.chrome} | CDP: ${report.protocolVersion}`);
  console.log(`Plan UI: ${report.htmlPath}`);
  console.log(`HTML: ${(report.htmlBytes / 1024 / 1024).toFixed(2)} MiB | sha256: ${report.htmlSha256}`);
  console.log(`Cache: ${report.cache}`);
  console.table(report.results);
  const average = (key) => round(report.results.reduce((total, result) => total + result[key], 0) / report.results.length);
  console.log(`Average usable: ${average("usableMs")}ms | script: ${average("scriptMs")}ms | long tasks: ${average("longTaskTotalMs")}ms`);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function findChrome() {
  const candidates = process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function findTarget(port, targetId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`, timeoutMs);
    const target = targets.find((candidate) => candidate.id === targetId);
    if (target?.webSocketDebuggerUrl) return target;
    await delay(25);
  }
  throw new Error(`Timed out waiting for Chrome target ${targetId}.`);
}

async function getFreePort() {
  const probe = http.createServer();
  await listen(probe);
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a debugging port.");
  await closeServer(probe);
  return address.port;
}

function listen(target) {
  return new Promise((resolve, reject) => {
    target.once("error", reject);
    target.listen(0, "127.0.0.1", resolve);
  });
}

function closeServer(target) {
  return new Promise((resolve, reject) => target.close((error) => error ? reject(error) : resolve()));
}

async function waitForJson(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(url, Math.max(1, deadline - Date.now()));
    } catch {
      await delay(50);
    }
  }
  throw new Error(`Timed out waiting for ${url}.`);
}

async function fetchJson(url, timeoutMs) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}.`);
  return response.json();
}

async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? "Browser evaluation failed.");
  return result.value;
}

function onceExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
