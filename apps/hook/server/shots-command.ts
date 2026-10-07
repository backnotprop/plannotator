/**
 * `plannotator screenshot`: Plannotator Shots, the native screenshot HUD.
 * Hidden until launch (HIDDEN_SUBCOMMANDS in cli.ts).
 *
 *   plannotator screenshot [--app] [--session <host>:<id>] [--no-capture]
 *       Start the hub and the Plannotator Shots app if needed and open the
 *       capture overlay. With --session (the Claude Code mod passes its own),
 *       that session receives the send. Returns at once.
 *   plannotator screenshot --wait [--app]
 *       The same, then wait as a "waiting command" destination: print the
 *       message when the person presses Send, and exit 0. For agents without
 *       async delivery (Codex, Gemini, Copilot, Claude Code without the mod).
 *   plannotator screenshot add <image | ->     register an image file (or stdin) as a shot
 *   plannotator screenshot add --screen        capture the main display with `screencapture` and register it
 *   plannotator screenshot open                open the HUD in the browser (fallback)
 *   plannotator screenshot status              hub, app and connected sessions
 *   plannotator screenshot hub [--background]  run the hub here, or detached
 *   plannotator screenshot stop                stop the hub
 *   plannotator screenshot install-app         install the embedded app into ~/Applications
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  acquireShotsStartLock,
  runningShotsHub,
  shotsDir,
  waitFor,
  type ShotsHubEntry,
} from "@plannotator/shared/shots/registry";
import { startShotsHubServer } from "@plannotator/server/shots/server";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { getCliVersion } from "./cli";

// @ts-ignore - Bun import attribute for text
import hudHtml from "../dist/shots-hud.html" with { type: "text" };
const hudHtmlContent = hudHtml as unknown as string;

export const SHOTS_APP_NAME = "Plannotator Shots";
export const SHOTS_BUNDLE_ID = "ai.plannotator.shots";
const HUB_START_TIMEOUT_MS = 15_000;

declare global {
  // Set by the darwin entry (index-darwin.ts): the embedded, zipped app and its build stamp.
  // eslint-disable-next-line no-var
  var __PLANNOTATOR_SHOTS_APP_ZIP__: string | undefined;
  // eslint-disable-next-line no-var
  var __PLANNOTATOR_SHOTS_APP_BUILD__: string | undefined;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** The argv that runs this same CLI: the compiled binary, or bun plus the entry script. */
function selfCommand(): string[] {
  const script = process.argv[1];
  if (script && /\.(?:[cm]?[jt]s)$/.test(script) && existsSync(script)) return [process.execPath, resolve(script)];
  return [process.execPath];
}

// --- The hub -------------------------------------------------------------------

function spawnDetachedHub(dataDir: string): void {
  const dir = shotsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, "hub.out"), "a", 0o600);
  const [command, ...rest] = selfCommand();
  const child = spawn(command!, [...rest, "screenshot", "hub"], {
    detached: true,
    cwd: dir,
    stdio: ["ignore", log, log],
    env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_SHOTS_LOCK_HELD: "1" },
  });
  child.unref();
  closeSync(log);
}

export async function ensureShotsHub(dataDir: string): Promise<ShotsHubEntry> {
  const running = await runningShotsHub(dataDir);
  if (running) return running;
  const release = acquireShotsStartLock(dataDir);
  if (release) {
    try {
      spawnDetachedHub(dataDir);
    } catch (error) {
      release();
      throw error;
    }
  }
  try {
    const entry = await waitFor(() => runningShotsHub(dataDir), HUB_START_TIMEOUT_MS);
    if (!entry) throw new Error(`The Plannotator Shots hub did not start; see ${join(shotsDir(dataDir), "hub.out")}.`);
    return entry;
  } finally {
    release?.();
  }
}

async function serveHub(dataDir: string): Promise<never> {
  const lockHeld = process.env.PLANNOTATOR_SHOTS_LOCK_HELD === "1";
  delete process.env.PLANNOTATOR_SHOTS_LOCK_HELD;
  const release = lockHeld ? null : acquireShotsStartLock(dataDir);
  if (!lockHeld && !release) {
    const entry = await waitFor(() => runningShotsHub(dataDir), HUB_START_TIMEOUT_MS);
    if (entry) {
      process.stderr.write(`Plannotator Shots hub: ${entry.url}\n`);
      process.exit(0);
    }
    fail("Another Plannotator Shots hub is starting and did not come up; try again.");
  }
  const existing = await runningShotsHub(dataDir);
  if (existing) {
    release?.();
    process.stderr.write(`Plannotator Shots hub: ${existing.url}\n`);
    process.exit(0);
  }
  let server: ReturnType<typeof startShotsHubServer>;
  try {
    server = startShotsHubServer({
      dataDir,
      version: getCliVersion() ?? "dev",
      htmlContent: hudHtmlContent,
      cli: selfCommand(),
      onStop: () => shutdown(0),
    });
  } finally {
    release?.();
  }
  function shutdown(code: number): never {
    server.stop();
    process.exit(code);
  }
  process.once("SIGINT", () => shutdown(130));
  process.once("SIGTERM", () => shutdown(143));
  process.stderr.write(`Plannotator Shots hub: ${server.entry.url}\n`);
  return new Promise<never>(() => {});
}

async function hubFetch(entry: ShotsHubEntry, path: string, body?: unknown, method = "POST"): Promise<Response> {
  return fetch(`${entry.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${entry.token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// --- The app ---------------------------------------------------------------------

/** `~/Applications/Plannotator Shots.app`, where the CLI installs the embedded app. */
export function installedAppPath(): string {
  return join(homedir(), "Applications", `${SHOTS_APP_NAME}.app`);
}

function bundleBuildOf(appPath: string): string | null {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", join(appPath, "Contents", "Info.plist")], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** Install (or update) the embedded app when its build differs from the installed one. Returns the app path, or null without an embedded app. */
export function installEmbeddedApp(): string | null {
  const zip = globalThis.__PLANNOTATOR_SHOTS_APP_ZIP__;
  const build = globalThis.__PLANNOTATOR_SHOTS_APP_BUILD__;
  if (!zip) return null;
  const target = installedAppPath();
  if (existsSync(target) && build && bundleBuildOf(target) === build) return target;
  const staging = mkdtempSync(join(tmpdir(), "plannotator-shots-"));
  try {
    const zipFile = join(staging, "app.zip");
    writeFileSync(zipFile, readFileSync(zip));
    const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", zipFile, staging], { encoding: "utf8" });
    if (unzip.status !== 0) throw new Error(`Could not unpack ${SHOTS_APP_NAME}: ${unzip.stderr.trim()}`);
    const staged = join(staging, `${SHOTS_APP_NAME}.app`);
    if (!existsSync(staged)) throw new Error(`The embedded ${SHOTS_APP_NAME} archive has no app.`);
    mkdirSync(join(homedir(), "Applications"), { recursive: true });
    if (existsSync(target)) {
      // A running app is asked to quit first (never launched just to be told so);
      // the old bundle is moved aside, never half-replaced.
      const running = spawnSync("/usr/bin/pgrep", ["-f", join(target, "Contents", "MacOS")], { encoding: "utf8" });
      if (running.status === 0) spawnSync("/usr/bin/open", ["-g", "-a", target, "plannotator-shots://quit"], { stdio: "ignore" });
      const aside = `${target}.old-${process.pid}`;
      renameSync(target, aside);
      renameSync(staged, target);
      rmSync(aside, { recursive: true, force: true });
    } else {
      renameSync(staged, target);
    }
    return target;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The app to launch: a dev build named by PLANNOTATOR_SHOTS_APP, the embedded one, or one already installed. */
export function resolveShotsApp(): string | null {
  const dev = process.env.PLANNOTATOR_SHOTS_APP?.trim();
  if (dev && existsSync(dev)) return resolve(dev);
  const installed = installEmbeddedApp();
  if (installed) return installed;
  return existsSync(installedAppPath()) ? installedAppPath() : null;
}

/**
 * Hand the app a command through its URL scheme. LaunchServices starts the
 * app when it is not running, as its OWN responsible process (never a child
 * of this terminal), so its Screen Recording grant is its own and nothing
 * running in this terminal inherits it.
 */
function openShotsApp(app: string, action: "capture" | "show", params: Record<string, string>): void {
  const query = new URLSearchParams(params).toString();
  const result = spawnSync("/usr/bin/open", ["-g", "-a", app, `plannotator-shots://${action}?${query}`], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not open ${SHOTS_APP_NAME}: ${result.stderr.trim() || `exit ${result.status}`}`);
}

// --- Waiting command (cli-wait) ------------------------------------------------------

async function waitForSend(dataDir: string, entry: ShotsHubEntry): Promise<never> {
  const sessionId = `wait-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const cwd = process.cwd();
  const origin = process.env.PLANNOTATOR_ORIGIN?.trim();
  const hello = {
    host: "cli-wait",
    sessionId,
    processId: `${hostname()}:${process.pid}`,
    cwd,
    project: (await detectProjectName(cwd)) ?? basename(cwd),
    title: origin ? `${origin} · plannotator screenshot --wait` : "plannotator screenshot --wait",
    lastHumanInputAt: Date.now(),
    capabilities: { deliver: true, ask: { turn: false, transient: false } },
    protocol: 1,
  };
  let current = entry;
  let connectionId: string | null = null;
  const bye = async () => {
    if (!connectionId) return;
    await hubFetch(current, `/api/connections/${connectionId}/bye`, {}).catch(() => undefined);
  };
  process.once("SIGINT", () => void bye().finally(() => process.exit(130)));
  process.once("SIGTERM", () => void bye().finally(() => process.exit(143)));
  for (;;) {
    if (!connectionId) {
      const fresh = (await runningShotsHub(dataDir)) ?? null;
      if (!fresh) fail("The Plannotator Shots hub was quit before anything was sent.");
      current = fresh;
      const response = await hubFetch(current, "/api/connections/hello", hello).catch(() => null);
      if (!response?.ok) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      connectionId = ((await response.json()) as { connectionId: string }).connectionId;
    }
    const poll = await hubFetch(current, `/api/connections/${connectionId}/poll`, { status: "ready", modes: { turn: false, transient: false }, waitMs: 20_000 }).catch(
      () => null,
    );
    if (!poll || poll.status === 401 || poll.status === 404) {
      connectionId = null;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    const body = (await poll.json().catch(() => ({}))) as { commands?: Array<Record<string, unknown>>; closing?: boolean };
    for (const command of body.commands ?? []) {
      if (command.type !== "deliver" || typeof command.text !== "string") continue;
      await hubFetch(current, `/api/connections/${connectionId}/event`, { type: "delivered", sendId: command.sendId }).catch(() => undefined);
      process.stdout.write(`${command.text}\n`);
      await bye();
      process.exit(0);
    }
    if (body.closing) connectionId = null;
  }
}

// --- add -----------------------------------------------------------------------------

async function addShot(dataDir: string, args: string[]): Promise<never> {
  const entry = await ensureShotsHub(dataDir);
  let file: string;
  let kind = "region";
  if (args[0] === "--screen") {
    const incoming = join(shotsDir(dataDir), "incoming");
    mkdirSync(incoming, { recursive: true, mode: 0o700 });
    file = join(incoming, `screen-${Date.now()}.png`);
    const result = spawnSync("/usr/sbin/screencapture", ["-x", "-m", "-t", "png", file], { encoding: "utf8" });
    if (result.status !== 0 || !existsSync(file)) fail(`screencapture failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    kind = "display";
  } else if (args[0] === "-" || !args[0]) {
    const incoming = join(shotsDir(dataDir), "incoming");
    mkdirSync(incoming, { recursive: true, mode: 0o700 });
    file = join(incoming, `stdin-${Date.now()}.png`);
    writeFileSync(file, new Uint8Array(await Bun.stdin.arrayBuffer()), { mode: 0o600 });
  } else {
    file = resolve(args[0]);
    if (!existsSync(file)) fail(`No such file: ${args[0]}`);
  }
  const response = await hubFetch(entry, "/api/shots/capture", { file, kind });
  const body = (await response.json()) as { shot?: { id: string }; collectionId?: string; error?: string };
  if (!response.ok || !body.shot) fail(body.error ?? `The hub refused the shot (${response.status}).`);
  process.stdout.write(`${body.shot.id} (collection ${body.collectionId})\n`);
  process.exit(0);
}

// --- Entry ------------------------------------------------------------------------------

function parseSession(value: string | undefined): { host: string; sessionId: string } | null {
  if (!value) return null;
  const index = value.indexOf(":");
  if (index <= 0) return null;
  return { host: value.slice(0, index), sessionId: value.slice(index + 1) };
}

export async function runShotsCommand(args: string[]): Promise<never> {
  const dataDir = getPlannotatorDataDir();
  const sub = args[0];

  if (sub === "hub") {
    if (args.includes("--background")) {
      try {
        const entry = await ensureShotsHub(dataDir);
        process.stdout.write(`${entry.url}\n`);
        process.exit(0);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    return serveHub(dataDir);
  }
  if (sub === "add") return addShot(dataDir, args.slice(1));
  if (sub === "stop") {
    const entry = await runningShotsHub(dataDir);
    if (!entry) {
      process.stdout.write("The Plannotator Shots hub is not running.\n");
      process.exit(0);
    }
    await hubFetch(entry, "/api/shots/stop", {}).catch(() => undefined);
    process.stdout.write("Stopped the Plannotator Shots hub.\n");
    process.exit(0);
  }
  if (sub === "install-app") {
    const app = installEmbeddedApp();
    if (!app) fail(`This build of plannotator has no embedded ${SHOTS_APP_NAME} app.`);
    process.stdout.write(`${app}\n`);
    process.exit(0);
  }
  if (sub === "status") {
    const entry = await runningShotsHub(dataDir);
    const app = process.env.PLANNOTATOR_SHOTS_APP?.trim() || (existsSync(installedAppPath()) ? installedAppPath() : null);
    const lines = [`Hub: ${entry ? `${entry.url} (pid ${entry.pid})` : "not running"}`, `App: ${app ?? "not installed"}`];
    if (entry) {
      const state = (await (await hubFetch(entry, "/api/shots/state", undefined, "GET")).json()) as {
        connections: Array<{ host: string; project: string; sessionId: string; busy: boolean }>;
        collection: { shots: string[] } | null;
      };
      lines.push(`Sessions: ${state.connections.length === 0 ? "none" : ""}`);
      for (const c of state.connections) lines.push(`  ${c.host} · ${c.project || "?"} (${c.sessionId})${c.busy ? " · working" : ""}`);
      lines.push(`Open collection: ${state.collection ? `${state.collection.shots.length} shot(s)` : "none"}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(0);
  }
  if (sub === "open") {
    const entry = await ensureShotsHub(dataDir);
    const attach = (await (await hubFetch(entry, "/api/shots/attach", {})).json()) as { hudToken: string };
    const url = `${entry.url}/hud#t=${attach.hudToken}`;
    await openBrowser(url);
    process.stdout.write(`${entry.url}/hud\n`);
    process.exit(0);
  }

  // Capture (the default), optionally waiting for the send.
  let wait = false;
  let appShot = false;
  let capture = true;
  let session: { host: string; sessionId: string } | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--wait") wait = true;
    else if (arg === "--app") appShot = true;
    else if (arg === "--no-capture") capture = false;
    else if (arg === "--session") session = parseSession(args[++i]);
    else if (arg?.startsWith("--session=")) session = parseSession(arg.slice("--session=".length));
    else fail(`Unknown screenshot option: ${arg}\nRun 'plannotator screenshot --help' for usage.`);
  }
  if (process.platform !== "darwin") {
    fail("Plannotator Shots runs on macOS for now. Elsewhere, add images with 'plannotator screenshot add <file>' and open the HUD with 'plannotator screenshot open'.");
  }

  let entry: ShotsHubEntry;
  try {
    entry = await ensureShotsHub(dataDir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (session) await hubFetch(entry, "/api/shots/summon", session).catch(() => undefined);

  const app = resolveShotsApp();
  if (!app) {
    fail(
      `${SHOTS_APP_NAME} is not installed. Run 'plannotator screenshot add --screen' to capture the screen without it, or 'plannotator screenshot open' for the browser HUD.`,
    );
  }
  try {
    openShotsApp(app, capture ? "capture" : "show", {
      kind: appShot ? "app" : "region",
      dataDir,
      cli: JSON.stringify(selfCommand()),
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (wait) return waitForSend(dataDir, entry);
  process.stdout.write(
    session
      ? "Plannotator Shots is open: drag a box around what you mean, mark it, and press ⌘↩. The shots arrive in this session as a message.\n"
      : "Plannotator Shots is open: drag a box around what you mean, mark it, and press ⌘↩.\n",
  );
  process.exit(0);
}

