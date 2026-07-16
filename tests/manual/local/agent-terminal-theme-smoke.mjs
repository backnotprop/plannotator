#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

class CdpClient {
  constructor(url) {
    this.url = url;
    this.id = 0;
    this.pending = new Map();
    this.events = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      if (message.method) {
        const waiters = this.events.get(message.method) ?? [];
        this.events.set(message.method, []);
        for (const resolve of waiters) resolve(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
  }

  waitEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
      const waiters = this.events.get(method) ?? [];
      waiters.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      this.events.set(method, waiters);
    });
  }

  close() {
    this.ws?.close();
  }
}

const DEFAULT_URL = "http://127.0.0.1:54146/";
const DEFAULT_THEMES = [
  "plannotator",
  "catppuccin",
  "simple",
  "claude-plus",
  "adwaita",
  "andromeeda",
  "rose-pine",
  "tokyo-night",
];

const args = parseArgs(process.argv.slice(2));
const repoRoot = path.resolve(new URL("../../..", import.meta.url).pathname);
const themeRegistryPath = path.join(repoRoot, "packages/ui/utils/themeRegistry.ts");
const themeRegistry = readThemeRegistry(themeRegistryPath);
const url = args.url ?? DEFAULT_URL;
const requestedMode = args.mode ?? "light";
const themes = args.all
  ? themeRegistry.map((theme) => theme.id)
  : (args.themes ?? DEFAULT_THEMES);

const chromePath = findChrome();
if (!chromePath) {
  console.error("Could not find Chrome. Set CHROME_PATH=/path/to/chrome.");
  process.exit(1);
}

const port = await getFreePort();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "plannotator-terminal-theme-smoke-"));
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--no-default-browser-check",
  "--window-size=2200,1300",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  "about:blank",
], { stdio: "ignore" });

let browser;
let page;
try {
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`);
  browser = new CdpClient(version.webSocketDebuggerUrl);
  await browser.connect();

  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const target = targets.find((item) => item.id === targetId);
  if (!target?.webSocketDebuggerUrl) throw new Error("Could not find Chrome target websocket.");

  page = new CdpClient(target.webSocketDebuggerUrl);
  await page.connect();
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 2200,
    height: 1300,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await navigate(page, url);

  const results = [];
  for (const themeId of themes) {
    const themeInfo = themeRegistry.find((theme) => theme.id === themeId);
    if (!themeInfo) {
      results.push({
        theme: themeId,
        support: "unknown",
        expected: "unknown",
        actual: "unknown",
        terminalBg: "unknown",
        luminance: null,
        ok: false,
        reason: "theme not found in BUILT_IN_THEMES",
      });
      continue;
    }

    const result = await measureTheme({
      page,
      themeId,
      mode: requestedMode,
      modeSupport: themeInfo.modeSupport,
    });
    results.push(result);
  }

  printResults({ url, requestedMode, results });
  const failures = results.filter((result) => !result.ok);
  process.exitCode = failures.length > 0 ? 1 : 0;
} finally {
  page?.close();
  browser?.close();
  chrome.kill("SIGTERM");
  await delay(250);
  fs.rmSync(profileDir, { recursive: true, force: true });
}

async function measureTheme({ page, themeId, mode, modeSupport }) {
  await setThemeCookies(page, themeId, mode);
  await reload(page);
  await delay(900);

  const openResult = await evaluate(page, `(() => {
    if (document.querySelector('[data-annotate-agent-terminal="true"]')) return 'already-open';
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.title === 'Agent' || candidate.textContent.trim() === 'Agent');
    if (!button) return 'missing-agent-button';
    button.click();
    return 'opened';
  })()`);

  await delay(300);
  const startResult = await evaluate(page, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim().includes('Start'));
    if (!button) return 'missing-start-button';
    if (button.disabled) return 'start-disabled';
    button.click();
    return 'started';
  })()`);

  const snapshot = await waitForSnapshot(page);
  await stopAgent(page);

  if (!snapshot) {
    return {
      theme: themeId,
      support: modeSupport,
      expected: expectedMode(mode, modeSupport),
      actual: "missing",
      terminalBg: "missing",
      luminance: null,
      ok: false,
      reason: `terminal did not mount (${openResult}, ${startResult})`,
    };
  }

  const actualMode = snapshot.htmlClass.includes(" light") ? "light" : "dark";
  const expected = expectedMode(mode, modeSupport);
  const luminance = relativeLuminance(parseRgb(snapshot.shellBg));
  const bgMatchesMode = expected === "light" ? luminance >= 0.5 : luminance < 0.5;
  const classMatchesMode = actualMode === expected;

  return {
    theme: themeId,
    support: modeSupport,
    expected,
    actual: actualMode,
    appBg: snapshot.appBg,
    codeBg: snapshot.codeBg,
    terminalBg: snapshot.shellBg,
    luminance: Number(luminance.toFixed(3)),
    ok: classMatchesMode && bgMatchesMode,
    reason: classMatchesMode
      ? (bgMatchesMode ? "" : `terminal background is ${luminance < 0.5 ? "dark" : "light"}`)
      : `html class resolved to ${actualMode}`,
  };
}

async function waitForSnapshot(page) {
  for (let index = 0; index < 30; index += 1) {
    const snapshot = await evaluate(page, `(() => {
      const root = document.documentElement;
      const aside = document.querySelector('[data-annotate-agent-terminal="true"]');
      const shell = aside?.querySelector('.webtui-shell');
      const shellHost = shell?.parentElement;
      if (!aside || !shellHost) return null;
      const rootStyle = getComputedStyle(root);
      const shellStyle = getComputedStyle(shellHost);
      return {
        htmlClass: root.className,
        appBg: rootStyle.getPropertyValue('--background').trim(),
        codeBg: rootStyle.getPropertyValue('--code-bg').trim(),
        shellVar: shellStyle.getPropertyValue('--webtui-background').trim(),
        shellBg: shellStyle.backgroundColor,
      };
    })()`);
    if (snapshot) return snapshot;
    await delay(300);
  }
  return null;
}

async function setThemeCookies(page, themeId, mode) {
  await evaluate(page, `(() => {
    document.cookie = 'plannotator-theme=${mode}; path=/; max-age=31536000; SameSite=Lax';
    document.cookie = 'plannotator-color-theme=${themeId}; path=/; max-age=31536000; SameSite=Lax';
  })()`);
}

async function stopAgent(page) {
  await evaluate(page, `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent.trim().includes('Stop'));
    button?.click();
  })()`).catch(() => null);
  await delay(700);
}

function expectedMode(mode, modeSupport) {
  if (modeSupport === "dark-only") return "dark";
  if (modeSupport === "light-only") return "light";
  return mode;
}

function printResults({ url, requestedMode, results }) {
  console.log(`Agent terminal theme smoke`);
  console.log(`URL: ${url}`);
  console.log(`Requested mode: ${requestedMode}`);
  console.log("");
  for (const result of results) {
    const status = result.ok ? "PASS" : "FAIL";
    console.log([
      status.padEnd(4),
      result.theme.padEnd(18),
      `support=${result.support}`.padEnd(18),
      `expected=${result.expected}`.padEnd(15),
      `actual=${result.actual}`.padEnd(13),
      `terminal=${result.terminalBg}`.padEnd(28),
      `lum=${result.luminance ?? "n/a"}`,
      result.reason ? `- ${result.reason}` : "",
    ].filter(Boolean).join("  "));
  }
  const failures = results.filter((result) => !result.ok);
  console.log("");
  console.log(`${results.length - failures.length} passed, ${failures.length} failed`);
}

async function navigate(page, targetUrl) {
  const loaded = page.waitEvent("Page.loadEventFired", 15000).catch(() => null);
  await page.send("Page.navigate", { url: targetUrl });
  await loaded;
}

async function reload(page) {
  const loaded = page.waitEvent("Page.loadEventFired", 15000).catch(() => null);
  await page.send("Page.reload", { ignoreCache: true });
  await loaded;
}

async function evaluate(page, expression) {
  const result = await page.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return result.result.value;
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (arg === "--all") parsed.all = true;
    else if (arg.startsWith("--url=")) parsed.url = arg.slice("--url=".length);
    else if (arg.startsWith("--mode=")) parsed.mode = arg.slice("--mode=".length);
    else if (arg.startsWith("--themes=")) parsed.themes = arg.slice("--themes=".length).split(",");
  }
  if (parsed.mode && parsed.mode !== "dark" && parsed.mode !== "light") {
    throw new Error("--mode must be dark or light");
  }
  return parsed;
}

function readThemeRegistry(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const themes = [];
  const pattern = /id: '([^']+)'[\s\S]*?modeSupport: '([^']+)'/g;
  for (const match of source.matchAll(pattern)) {
    themes.push({ id: match[1], modeSupport: match[2] });
  }
  return themes;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) resolve(address.port);
        else reject(new Error("Could not allocate a port"));
      });
    });
    server.on("error", reject);
  });
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
  return response.json();
}

async function waitForJson(url) {
  let lastError;
  for (let index = 0; index < 100; index += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRgb(value) {
  const match = String(value).match(/rgba?\(\s*([\d.]+)(?:,|\s)\s*([\d.]+)(?:,|\s)\s*([\d.]+)/i);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function relativeLuminance([r, g, b]) {
  const convert = (channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b);
}
