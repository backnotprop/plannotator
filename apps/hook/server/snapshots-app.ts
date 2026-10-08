/**
 * Plannotator Snapshots.app as the CLI sees it: where it is installed, which
 * build to keep, and how the CLI tells it things. No HTML or server imports,
 * so it is testable on its own (snapshots-app.test.ts).
 *
 * The app answers `plannotator-snapshots://`, which any process or web page
 * can open, so a URL carries only an action and a capture kind. Where the data
 * lives and which binary starts the hub go into the app's own defaults
 * (`defaults write ai.plannotator.snapshots`), which only a local process can
 * write; the app also checks that binary before it runs it.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const SNAPSHOTS_APP_NAME = "Plannotator Snapshots";
export const SNAPSHOTS_BUNDLE_ID = "ai.plannotator.snapshots";

declare global {
  // Set by the darwin entry (index-darwin.ts): the embedded, zipped app and its build stamp.
  // eslint-disable-next-line no-var
  var __PLANNOTATOR_SNAPSHOTS_APP_ZIP__: string | undefined;
  // eslint-disable-next-line no-var
  var __PLANNOTATOR_SNAPSHOTS_APP_BUILD__: string | undefined;
}

/** `~/Applications/Plannotator Snapshots.app`, where the CLI installs the embedded app. */
export function installedAppPath(): string {
  return join(homedir(), "Applications", `${SNAPSHOTS_APP_NAME}.app`);
}

function bundleBuildOf(appPath: string): string | null {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", join(appPath, "Contents", "Info.plist")], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

/**
 * Order two app build stamps (`CFBundleVersion`): release builds are
 * `<version>.<run number>` (0.29.0.812), local builds a UTC timestamp
 * (20261008124501). Compared numerically, segment by segment; a missing
 * segment counts as 0. A local build therefore sorts above every release,
 * which keeps a developer's own build in place (`install-app --force` replaces it).
 */
export function compareBuildStamps(a: string, b: string): number {
  const parts = (stamp: string) => stamp.split(/[^0-9]+/).filter(Boolean).map((part) => BigInt(part));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const x = left[index] ?? 0n;
    const y = right[index] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export type AppInstallOutcome = "installed" | "updated" | "current" | "newer-installed";

export interface InstallAppOptions {
  /** The zipped app and its build stamp (default: the ones embedded in this binary). */
  zip?: string;
  build?: string;
  /** Where `Applications/` is (default: the home folder). */
  home?: string;
  /** Replace the installed app whatever its build. */
  force?: boolean;
  /** How long to wait for a running app to quit before it is replaced. */
  quitTimeoutMs?: number;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The app's executable is running (its path as `pgrep -f` sees it). */
function appRunning(appPath: string): boolean {
  const pattern = `^${escapeRegExp(join(appPath, "Contents", "MacOS"))}/`;
  return spawnSync("/usr/bin/pgrep", ["-f", pattern], { encoding: "utf8" }).status === 0;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Ask a running app to quit, and wait until it has: a bundle is never replaced under a running app. */
function quitRunningApp(appPath: string, timeoutMs: number): void {
  if (!appRunning(appPath)) return;
  spawnSync("/usr/bin/open", ["-g", "-a", appPath, "plannotator-snapshots://quit"], { stdio: "ignore" });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    sleepMs(100);
    if (!appRunning(appPath)) return;
  }
  throw new Error(`${SNAPSHOTS_APP_NAME} did not quit; quit it from its menu-bar item and run 'plannotator snapshot install-app' again.`);
}

/**
 * Install (or update) the embedded app. Nothing happens when the installed
 * app has the same build, or a NEWER one (an older plannotator never
 * downgrades it), unless `force`. A running app is asked to quit, and the
 * install waits until it has before the bundle is replaced; the old bundle is
 * moved aside, never half-replaced. Null without an embedded app.
 */
export function installEmbeddedApp(options: InstallAppOptions = {}): { path: string; outcome: AppInstallOutcome } | null {
  const zip = options.zip ?? globalThis.__PLANNOTATOR_SNAPSHOTS_APP_ZIP__;
  const build = options.build ?? globalThis.__PLANNOTATOR_SNAPSHOTS_APP_BUILD__;
  if (!zip) return null;
  const applications = join(options.home ?? homedir(), "Applications");
  const target = join(applications, `${SNAPSHOTS_APP_NAME}.app`);
  const exists = existsSync(target);
  if (exists && !options.force && build) {
    const installed = bundleBuildOf(target);
    if (installed) {
      const order = compareBuildStamps(build, installed);
      if (order === 0) return { path: target, outcome: "current" };
      if (order < 0) return { path: target, outcome: "newer-installed" };
    }
  }
  const staging = mkdtempSync(join(tmpdir(), "plannotator-snapshots-"));
  try {
    const zipFile = join(staging, "app.zip");
    writeFileSync(zipFile, readFileSync(zip));
    const unzip = spawnSync("/usr/bin/ditto", ["-x", "-k", zipFile, staging], { encoding: "utf8" });
    if (unzip.status !== 0) throw new Error(`Could not unpack ${SNAPSHOTS_APP_NAME}: ${unzip.stderr.trim()}`);
    const staged = join(staging, `${SNAPSHOTS_APP_NAME}.app`);
    if (!existsSync(staged)) throw new Error(`The embedded ${SNAPSHOTS_APP_NAME} archive has no app.`);
    mkdirSync(applications, { recursive: true });
    if (exists) {
      quitRunningApp(target, options.quitTimeoutMs ?? 10_000);
      const aside = `${target}.old-${process.pid}`;
      renameSync(target, aside);
      renameSync(staged, target);
      rmSync(aside, { recursive: true, force: true });
      return { path: target, outcome: "updated" };
    }
    renameSync(staged, target);
    return { path: target, outcome: "installed" };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The app to launch: a dev build named by PLANNOTATOR_SNAPSHOTS_APP, the embedded one, or one already installed. */
export function resolveSnapshotsApp(): string | null {
  const dev = process.env.PLANNOTATOR_SNAPSHOTS_APP?.trim();
  if (dev && existsSync(dev)) return resolve(dev);
  const installed = installEmbeddedApp();
  if (installed) return installed.path;
  return existsSync(installedAppPath()) ? installedAppPath() : null;
}

/**
 * Tell the app where Plannotator's data is and which binary starts the hub,
 * in the app's own defaults. Never in its URL: any process or web page can
 * open `plannotator-snapshots://`, and the app runs that binary.
 */
export function snapshotsAppDefaultsArgv(dataDir: string, cli: string[]): string[][] {
  return [
    ["write", SNAPSHOTS_BUNDLE_ID, "dataDir", "-string", dataDir],
    ["write", SNAPSHOTS_BUNDLE_ID, "cli", "-array", ...cli.flatMap((arg) => ["-string", arg])],
  ];
}

/** Save the data dir and the CLI's argv in the app's defaults, before the app is opened. */
export function rememberForApp(dataDir: string, cli: string[]): void {
  for (const argv of snapshotsAppDefaultsArgv(dataDir, cli)) {
    const result = spawnSync("/usr/bin/defaults", argv, { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`Could not save ${SNAPSHOTS_APP_NAME}'s settings: ${result.stderr.trim() || `exit ${result.status}`}`);
  }
}

/** `plannotator-snapshots://<action>?kind=…`: an action and a capture kind, nothing else. */
export function snapshotsAppUrl(action: "capture" | "show", kind: "app" | "region"): string {
  return action === "capture" ? `plannotator-snapshots://capture?kind=${kind}` : "plannotator-snapshots://show";
}
