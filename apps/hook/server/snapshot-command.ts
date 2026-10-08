/**
 * `plannotator snapshot`: Plannotator Snapshots, the native capture HUD.
 * Hidden until launch (HIDDEN_SUBCOMMANDS in cli.ts).
 *
 *   plannotator snapshot [--app] [--session <host>:<id>] [--no-capture]
 *       Start the hub and the Plannotator Snapshots app if needed and open the
 *       capture overlay for a Screen Capture (with --app: take an App Capture,
 *       the frontmost window plus its text). With --session (the Claude Code
 *       mod passes its own), that session receives the send. Returns at once.
 *   plannotator snapshot --wait [--app]
 *       The same, then wait as a "waiting command" destination: print the
 *       message when the person presses Send, and exit 0. For agents without
 *       async delivery (Codex, Gemini, Copilot, Claude Code without the mod).
 *   plannotator snapshot add <image | ->     register an image file (or stdin) as a snapshot
 *   plannotator snapshot add --screen        capture the main display with `screencapture` and register it
 *   plannotator snapshot open                open the HUD in the browser (fallback)
 *   plannotator snapshot status              hub, app and connected sessions
 *   plannotator snapshot hub [--background]  run the hub here, or detached
 *   plannotator snapshot stop                stop the hub
 *   plannotator snapshot install-app [--force]
 *                                            install the embedded app into ~/Applications
 *                                            (never over a newer build unless --force)
 */

import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import {
  acquireSnapshotsStartLock,
  runningSnapshotsHub,
  snapshotsDir,
  waitFor,
  type SnapshotsHubEntry,
} from "@plannotator/shared/snapshots/registry";
import { startSnapshotsHubServer } from "@plannotator/server/snapshots/server";
import { openBrowser } from "@plannotator/server/browser";
import { detectProjectName } from "@plannotator/server/project";
import { getCliVersion } from "./cli";
import { installedAppPath, installEmbeddedApp, rememberForApp, resolveSnapshotsApp, SNAPSHOTS_APP_NAME, snapshotsAppUrl } from "./snapshots-app";

// @ts-ignore - Bun import attribute for text
import hudHtml from "../dist/snapshots-hud.html" with { type: "text" };
const hudHtmlContent = hudHtml as unknown as string;

const HUB_START_TIMEOUT_MS = 15_000;


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
  const dir = snapshotsDir(dataDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const log = openSync(join(dir, "hub.out"), "a", 0o600);
  const [command, ...rest] = selfCommand();
  const child = spawn(command!, [...rest, "snapshot", "hub"], {
    detached: true,
    cwd: dir,
    stdio: ["ignore", log, log],
    env: { ...process.env, PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_SNAPSHOTS_LOCK_HELD: "1" },
  });
  child.unref();
  closeSync(log);
}

export async function ensureSnapshotsHub(dataDir: string): Promise<SnapshotsHubEntry> {
  const running = await runningSnapshotsHub(dataDir);
  if (running) return running;
  const release = acquireSnapshotsStartLock(dataDir);
  if (release) {
    try {
      spawnDetachedHub(dataDir);
    } catch (error) {
      release();
      throw error;
    }
  }
  try {
    const entry = await waitFor(() => runningSnapshotsHub(dataDir), HUB_START_TIMEOUT_MS);
    if (!entry) throw new Error(`The Plannotator Snapshots hub did not start; see ${join(snapshotsDir(dataDir), "hub.out")}.`);
    return entry;
  } finally {
    release?.();
  }
}

async function serveHub(dataDir: string): Promise<never> {
  const lockHeld = process.env.PLANNOTATOR_SNAPSHOTS_LOCK_HELD === "1";
  delete process.env.PLANNOTATOR_SNAPSHOTS_LOCK_HELD;
  const release = lockHeld ? null : acquireSnapshotsStartLock(dataDir);
  if (!lockHeld && !release) {
    const entry = await waitFor(() => runningSnapshotsHub(dataDir), HUB_START_TIMEOUT_MS);
    if (entry) {
      process.stderr.write(`Plannotator Snapshots hub: ${entry.url}\n`);
      process.exit(0);
    }
    fail("Another Plannotator Snapshots hub is starting and did not come up; try again.");
  }
  const existing = await runningSnapshotsHub(dataDir);
  if (existing) {
    release?.();
    process.stderr.write(`Plannotator Snapshots hub: ${existing.url}\n`);
    process.exit(0);
  }
  let server: ReturnType<typeof startSnapshotsHubServer>;
  try {
    server = startSnapshotsHubServer({
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
  process.stderr.write(`Plannotator Snapshots hub: ${server.entry.url}\n`);
  return new Promise<never>(() => {});
}

async function hubFetch(entry: SnapshotsHubEntry, path: string, body?: unknown, method = "POST"): Promise<Response> {
  return fetch(`${entry.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${entry.token}`, "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// --- The app (snapshots-app.ts) -------------------------------------------------------


/**
 * Hand the app a command through its URL scheme. LaunchServices starts the
 * app when it is not running, as its OWN responsible process (never a child
 * of this terminal), so its Screen Recording grant is its own and nothing
 * running in this terminal inherits it.
 */
function openSnapshotsApp(app: string, action: "capture" | "show", kind: "app" | "region", dataDir: string): void {
  rememberForApp(dataDir, selfCommand());
  const result = spawnSync("/usr/bin/open", ["-g", "-a", app, snapshotsAppUrl(action, kind)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not open ${SNAPSHOTS_APP_NAME}: ${result.stderr.trim() || `exit ${result.status}`}`);
}

// --- Waiting command (cli-wait) ------------------------------------------------------

async function waitForSend(dataDir: string, entry: SnapshotsHubEntry): Promise<never> {
  const sessionId = `wait-${process.pid}-${Math.random().toString(16).slice(2, 8)}`;
  const cwd = process.cwd();
  const origin = process.env.PLANNOTATOR_ORIGIN?.trim();
  const hello = {
    host: "cli-wait",
    sessionId,
    processId: `${hostname()}:${process.pid}`,
    cwd,
    project: (await detectProjectName(cwd)) ?? basename(cwd),
    title: origin ? `${origin} · plannotator snapshot --wait` : "plannotator snapshot --wait",
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
      const fresh = (await runningSnapshotsHub(dataDir)) ?? null;
      if (!fresh) fail("The Plannotator Snapshots hub was quit before anything was sent.");
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

async function addSnapshot(dataDir: string, args: string[]): Promise<never> {
  const entry = await ensureSnapshotsHub(dataDir);
  let file: string;
  let kind = "region";
  if (args[0] === "--screen") {
    const incoming = join(snapshotsDir(dataDir), "incoming");
    mkdirSync(incoming, { recursive: true, mode: 0o700 });
    file = join(incoming, `screen-${Date.now()}.png`);
    const result = spawnSync("/usr/sbin/screencapture", ["-x", "-m", "-t", "png", file], { encoding: "utf8" });
    if (result.status !== 0 || !existsSync(file)) fail(`screencapture failed: ${result.stderr.trim() || `exit ${result.status}`}`);
    kind = "display";
  } else if (args[0] === "-" || !args[0]) {
    const incoming = join(snapshotsDir(dataDir), "incoming");
    mkdirSync(incoming, { recursive: true, mode: 0o700 });
    file = join(incoming, `stdin-${Date.now()}.png`);
    writeFileSync(file, new Uint8Array(await Bun.stdin.arrayBuffer()), { mode: 0o600 });
  } else {
    file = resolve(args[0]);
    if (!existsSync(file)) fail(`No such file: ${args[0]}`);
  }
  const response = await hubFetch(entry, "/api/snapshots/capture", { file, kind });
  const body = (await response.json()) as { snapshot?: { id: string }; collectionId?: string; error?: string };
  if (!response.ok || !body.snapshot) fail(body.error ?? `The hub refused the snapshot (${response.status}).`);
  process.stdout.write(`${body.snapshot.id} (collection ${body.collectionId})\n`);
  process.exit(0);
}

// --- Entry ------------------------------------------------------------------------------

function parseSession(value: string | undefined): { host: string; sessionId: string } | null {
  if (!value) return null;
  const index = value.indexOf(":");
  if (index <= 0) return null;
  return { host: value.slice(0, index), sessionId: value.slice(index + 1) };
}

export async function runSnapshotCommand(args: string[]): Promise<never> {
  const dataDir = getPlannotatorDataDir();
  const sub = args[0];

  if (sub === "hub") {
    if (args.includes("--background")) {
      try {
        const entry = await ensureSnapshotsHub(dataDir);
        process.stdout.write(`${entry.url}\n`);
        process.exit(0);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    }
    return serveHub(dataDir);
  }
  if (sub === "add") return addSnapshot(dataDir, args.slice(1));
  if (sub === "stop") {
    const entry = await runningSnapshotsHub(dataDir);
    if (!entry) {
      process.stdout.write("The Plannotator Snapshots hub is not running.\n");
      process.exit(0);
    }
    await hubFetch(entry, "/api/snapshots/stop", {}).catch(() => undefined);
    process.stdout.write("Stopped the Plannotator Snapshots hub.\n");
    process.exit(0);
  }
  if (sub === "install-app") {
    let app: ReturnType<typeof installEmbeddedApp>;
    try {
      app = installEmbeddedApp({ force: args.includes("--force") });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    if (!app) fail(`This build of plannotator has no embedded ${SNAPSHOTS_APP_NAME} app.`);
    if (app.outcome === "newer-installed") process.stderr.write(`A newer ${SNAPSHOTS_APP_NAME} is installed; kept it (--force replaces it).\n`);
    else if (app.outcome === "current") process.stderr.write(`${SNAPSHOTS_APP_NAME} is up to date.\n`);
    process.stdout.write(`${app.path}\n`);
    process.exit(0);
  }
  if (sub === "status") {
    const entry = await runningSnapshotsHub(dataDir);
    const app = process.env.PLANNOTATOR_SNAPSHOTS_APP?.trim() || (existsSync(installedAppPath()) ? installedAppPath() : null);
    const lines = [`Hub: ${entry ? `${entry.url} (pid ${entry.pid})` : "not running"}`, `App: ${app ?? "not installed"}`];
    if (entry) {
      const state = (await (await hubFetch(entry, "/api/snapshots/state", undefined, "GET")).json()) as {
        connections: Array<{ host: string; project: string; sessionId: string; busy: boolean }>;
        collection: { snapshots: string[] } | null;
      };
      lines.push(`Sessions: ${state.connections.length === 0 ? "none" : ""}`);
      for (const c of state.connections) lines.push(`  ${c.host} · ${c.project || "?"} (${c.sessionId})${c.busy ? " · working" : ""}`);
      lines.push(`Open collection: ${state.collection ? `${state.collection.snapshots.length} snapshot(s)` : "none"}`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exit(0);
  }
  if (sub === "open") {
    const entry = await ensureSnapshotsHub(dataDir);
    const attach = (await (await hubFetch(entry, "/api/snapshots/attach", {})).json()) as { hudToken: string };
    const url = `${entry.url}/hud#t=${attach.hudToken}`;
    await openBrowser(url);
    process.stdout.write(`${entry.url}/hud\n`);
    process.exit(0);
  }

  // Capture (the default), optionally waiting for the send.
  let wait = false;
  let appCapture = false;
  let capture = true;
  let session: { host: string; sessionId: string } | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--wait") wait = true;
    else if (arg === "--app") appCapture = true;
    else if (arg === "--no-capture") capture = false;
    else if (arg === "--session") session = parseSession(args[++i]);
    else if (arg?.startsWith("--session=")) session = parseSession(arg.slice("--session=".length));
    else fail(`Unknown snapshot option: ${arg}\nRun 'plannotator snapshot --help' for usage.`);
  }
  if (process.platform !== "darwin") {
    fail("Plannotator Snapshots runs on macOS for now. Elsewhere, add images with 'plannotator snapshot add <file>' and open the HUD with 'plannotator snapshot open'.");
  }

  let entry: SnapshotsHubEntry;
  try {
    entry = await ensureSnapshotsHub(dataDir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (session) await hubFetch(entry, "/api/snapshots/summon", session).catch(() => undefined);

  const app = resolveSnapshotsApp();
  if (!app) {
    fail(
      `${SNAPSHOTS_APP_NAME} is not installed. Run 'plannotator snapshot add --screen' to capture the screen without it, or 'plannotator snapshot open' for the browser HUD.`,
    );
  }
  try {
    openSnapshotsApp(app, capture ? "capture" : "show", appCapture ? "app" : "region", dataDir);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (wait) return waitForSend(dataDir, entry);
  process.stdout.write(
    session
      ? "Plannotator Snapshots is open: drag a box around what you mean, mark it, and press ⌘↩. The snapshots arrive in this session as a message.\n"
      : "Plannotator Snapshots is open: drag a box around what you mean, mark it, and press ⌘↩.\n",
  );
  process.exit(0);
}

