/**
 * Opt-in background auto-update (#1634).
 *
 * The whole mechanism is "run the normal install script, the way a user does
 * by hand", on a detached background path:
 *
 *   - Only the compiled CLI (apps/hook/server/index.ts) arms it, and only for
 *     a release build (a real `__CLI_VERSION__`) running from the path the
 *     install script manages. OpenCode and Pi never call into this module's
 *     trigger, so their npm servers are unaffected.
 *   - At most once per 24h (`update-state.json` in the data dir), after a
 *     session's server is up, it asks GitHub for the latest stable release.
 *   - When that release is newer and no OTHER Plannotator session is open, it
 *     spawns install.sh / install.ps1 for exactly that tag, fully detached,
 *     with output in `update.log`. A wrapper records the script's exit code in
 *     `update-result.json` and releases `update.lock`.
 *   - The next UI load shows a one-time notice derived from those files
 *     ("Updated to vX" once the running binary is that version, or "Auto-update
 *     failed" with the log path when the script exited non-zero).
 *
 * Nothing here is ever awaited by a caller: `scheduleAutoUpdateCheck` returns
 * immediately and every failure ends in a log line, never a thrown error.
 */

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { loadConfig, resolveAutoUpdate } from "@plannotator/shared/config";
import { listSessions, type SessionInfo } from "./sessions";

export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A lock older than this is from a run that died without cleaning up. */
export const AUTO_UPDATE_LOCK_STALE_MS = 60 * 60 * 1000;

const REPO = "backnotprop/plannotator";
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const INSTALL_SH_URL = "https://plannotator.ai/install.sh";
const INSTALL_PS1_URL = "https://plannotator.ai/install.ps1";

export interface AutoUpdateState {
  /** Epoch ms of the last check that got past the gates (the 24h install window). */
  lastCheckAt?: number;
  /**
   * The last answer GitHub gave for the latest stable release, cached for 24h
   * independently of the install window, so a check that is skipped because
   * other sessions are open does not re-query GitHub on every session start.
   */
  latestRelease?: {
    tag: string;
    fetchedAt: number;
  };
  /** The install this process (or an earlier one) started. */
  pending?: {
    version: string;
    fromVersion: string;
    startedAt: number;
  };
}

export interface AutoUpdateResult {
  version: string;
  exitCode: number;
}

export interface AutoUpdateNotice {
  /** Stable per install attempt, so a client can remember it was shown. */
  id: string;
  kind: "updated" | "failed";
  version: string;
  releaseUrl: string;
  logPath?: string;
}

export function autoUpdatePaths(dataDir: string = getPlannotatorDataDir()) {
  return {
    state: join(dataDir, "update-state.json"),
    result: join(dataDir, "update-result.json"),
    lock: join(dataDir, "update.lock"),
    log: join(dataDir, "update.log"),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Parse a stable `X.Y.Z` / `vX.Y.Z`; anything else (pre-release, junk) is null. */
export function parseStableVersion(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})$/.exec(value.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** -1 / 0 / 1; null when either side is not a stable version. */
export function compareStableVersions(a: string, b: string): number | null {
  const pa = parseStableVersion(a);
  const pb = parseStableVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** True only for a strictly newer stable release: never a downgrade or re-install. */
export function isNewerStableVersion(latest: string, current: string): boolean {
  return compareStableVersions(latest, current) === 1;
}

/** The canonical `X.Y.Z` for a stable version string, or null. */
export function normalizeStableVersion(value: unknown): string | null {
  const parsed = parseStableVersion(value);
  return parsed ? parsed.join(".") : null;
}

/** The cached latest-release tag when it is still fresh, else null. */
export function cachedLatestTag(state: AutoUpdateState, now: number): string | null {
  const cached = state.latestRelease;
  if (!cached || typeof cached !== "object") return null;
  const at = cached.fetchedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now) return null;
  if (now - at >= AUTO_UPDATE_INTERVAL_MS) return null;
  return normalizeStableVersion(cached.tag);
}

export function isCheckDue(state: AutoUpdateState, now: number): boolean {
  const last = state.lastCheckAt;
  if (typeof last !== "number" || !Number.isFinite(last)) return true;
  // A clock that moved backwards must not freeze updates until it catches up.
  if (last > now) return true;
  return now - last >= AUTO_UPDATE_INTERVAL_MS;
}

/** Live sessions that belong to some other Plannotator process. */
export function otherOpenSessions(sessions: SessionInfo[], ownPid: number): SessionInfo[] {
  return sessions.filter((s) => s.pid !== ownPid);
}

export function releaseUrlFor(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version.replace(/^v/, "")}`;
}

export function deriveAutoUpdateNotice(
  state: AutoUpdateState,
  result: AutoUpdateResult | null,
  currentVersion: string,
  logPath: string,
): AutoUpdateNotice | undefined {
  const pending = state.pending;
  if (!pending) return undefined;
  const version = pending.version.replace(/^v/, "");
  const id = `${version}@${pending.startedAt}`;
  const cmp = compareStableVersions(currentVersion, version);
  if (cmp !== null && cmp >= 0) {
    return { id, kind: "updated", version, releaseUrl: releaseUrlFor(version) };
  }
  if (result && result.version.replace(/^v/, "") === version && result.exitCode !== 0) {
    return { id, kind: "failed", version, releaseUrl: releaseUrlFor(version), logPath };
  }
  return undefined;
}

/**
 * Where the install script puts the binary. Auto-update only runs when the
 * running executable IS that file; a binary installed some other way
 * (package manager, custom path, `bun link`) is not the script's to replace.
 */
export function managedBinaryPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(localAppData, "plannotator", "plannotator.exe");
  }
  return join(home, ".local", "bin", "plannotator");
}

export function isManagedBinary(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): boolean {
  const target = managedBinaryPath(platform, env, home);
  const canon = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const a = canon(execPath);
  const b = canon(target);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// ---------------------------------------------------------------------------
// State files
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

export function readAutoUpdateState(dataDir?: string): AutoUpdateState {
  const raw = readJson<AutoUpdateState>(autoUpdatePaths(dataDir).state);
  return raw && typeof raw === "object" ? raw : {};
}

function writeAutoUpdateState(state: AutoUpdateState, dataDir?: string): void {
  const { state: path } = autoUpdatePaths(dataDir);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

function readAutoUpdateResult(dataDir?: string): AutoUpdateResult | null {
  const raw = readJson<AutoUpdateResult>(autoUpdatePaths(dataDir).result);
  if (!raw || typeof raw.version !== "string" || typeof raw.exitCode !== "number") return null;
  return raw;
}

function log(message: string, dataDir?: string): void {
  try {
    const { log: path } = autoUpdatePaths(dataDir);
    mkdirSync(join(path, ".."), { recursive: true });
    appendFileSync(path, `[${new Date().toISOString()}] auto-update: ${message}\n`);
  } catch {
    // Logging is best-effort; auto-update must never surface an error.
  }
}

/** Take update.lock, clearing a stale one. False when another run holds it. */
function acquireLock(lockPath: string): boolean {
  try {
    if (existsSync(lockPath)) {
      // Wall clock, not the injected clock: this compares against a file mtime.
      const age = Date.now() - statSync(lockPath).mtimeMs;
      if (age < AUTO_UPDATE_LOCK_STALE_MS) return false;
      unlinkSync(lockPath);
    }
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface InstallerLaunch {
  version: string;
  logPath: string;
  resultPath: string;
  lockPath: string;
  platform: NodeJS.Platform;
}

export interface AutoUpdateDeps {
  currentVersion: string | undefined;
  execPath: string;
  platform: NodeJS.Platform;
  pid: number;
  dataDir: string;
  now: () => number;
  enabled: () => boolean;
  isManaged: () => boolean;
  fetchLatestTag: () => Promise<string | null>;
  listSessions: () => SessionInfo[];
  launchInstaller: (launch: InstallerLaunch) => void;
}

export type AutoUpdateOutcome =
  | "dev-build"
  | "disabled"
  | "unmanaged"
  | "throttled"
  | "no-release"
  | "up-to-date"
  | "sessions-open"
  | "locked"
  | "launched"
  | "launch-failed";

export async function runAutoUpdateCheck(deps: AutoUpdateDeps): Promise<AutoUpdateOutcome> {
  const current = deps.currentVersion;
  if (!current || !parseStableVersion(current)) return "dev-build";
  if (!deps.enabled()) return "disabled";
  if (!deps.isManaged()) return "unmanaged";

  const paths = autoUpdatePaths(deps.dataDir);
  const state = readAutoUpdateState(deps.dataDir);
  const now = deps.now();
  if (!isCheckDue(state, now)) return "throttled";

  // Claim the window before the network call so concurrent session starts do
  // not all query GitHub.
  writeAutoUpdateState({ ...state, lastCheckAt: now }, deps.dataDir);

  // The tag is untrusted input (it ends up as an installer argument), so it is
  // reduced to a canonical X.Y.Z before anything else sees it.
  let latest = cachedLatestTag(state, now);
  let base: AutoUpdateState = state;
  if (!latest) {
    const fetched = await deps.fetchLatestTag();
    latest = normalizeStableVersion(fetched);
    if (!latest) {
      log(`could not read the latest release (${fetched ?? "no response"})`, deps.dataDir);
      return "no-release";
    }
    base = { ...state, latestRelease: { tag: latest, fetchedAt: now } };
    writeAutoUpdateState({ ...base, lastCheckAt: now }, deps.dataDir);
  }
  if (!isNewerStableVersion(latest, current)) return "up-to-date";

  const others = otherOpenSessions(deps.listSessions(), deps.pid);
  if (others.length > 0) {
    // Do not spend the 24h install window: the next session start retries,
    // answering from the cached release instead of querying GitHub again.
    writeAutoUpdateState({ ...base }, deps.dataDir);
    log(
      `${latest} is available; skipped because ${others.length} other Plannotator session(s) are open`,
      deps.dataDir,
    );
    return "sessions-open";
  }

  if (!acquireLock(paths.lock)) {
    log("another update is already running", deps.dataDir);
    return "locked";
  }

  const version = latest;
  try {
    try {
      unlinkSync(paths.result);
    } catch {}
    writeAutoUpdateState(
      { ...base, lastCheckAt: now, pending: { version, fromVersion: current, startedAt: now } },
      deps.dataDir,
    );
    log(`installing v${version} (from v${current})`, deps.dataDir);
    deps.launchInstaller({
      version: `v${version}`,
      logPath: paths.log,
      resultPath: paths.result,
      lockPath: paths.lock,
      platform: deps.platform,
    });
    return "launched";
  } catch (err) {
    log(`could not start the installer: ${err instanceof Error ? err.message : String(err)}`, deps.dataDir);
    try {
      writeFileSync(paths.result, JSON.stringify({ version, exitCode: -1 }) + "\n");
    } catch {}
    try {
      unlinkSync(paths.lock);
    } catch {}
    return "launch-failed";
  }
}

async function fetchLatestTag(): Promise<string | null> {
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: { accept: "application/vnd.github+json", "user-agent": "plannotator-auto-update" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown };
    if (body.draft === true || body.prerelease === true) return null;
    return typeof body.tag_name === "string" ? body.tag_name : null;
  } catch {
    return null;
  }
}

/**
 * The detached wrapper. It downloads the same script a user pipes by hand,
 * runs it for exactly `version` without prompts, records the exit code, and
 * releases the lock. Inputs travel as environment variables, never
 * interpolated into the command text.
 */
const POSIX_WRAPPER = `
tmp=$(mktemp "\${TMPDIR:-/tmp}/plannotator-install.XXXXXX") || exit 1
code=1
if curl -fsSL "$PLANNOTATOR_UPDATE_SCRIPT_URL" -o "$tmp"; then
  bash "$tmp" --version "$PLANNOTATOR_UPDATE_VERSION" --non-interactive </dev/null
  code=$?
else
  echo "auto-update: could not download $PLANNOTATOR_UPDATE_SCRIPT_URL"
fi
rm -f "$tmp"
printf '{"version":"%s","exitCode":%d}\\n' "$PLANNOTATOR_UPDATE_VERSION" "$code" > "$PLANNOTATOR_UPDATE_RESULT.tmp" && mv -f "$PLANNOTATOR_UPDATE_RESULT.tmp" "$PLANNOTATOR_UPDATE_RESULT"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] auto-update: install.sh exited $code"
rm -f "$PLANNOTATOR_UPDATE_LOCK"
`;

const POWERSHELL_WRAPPER = `
$code = 1
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("plannotator-install-" + [guid]::NewGuid().ToString('N') + ".ps1")
try {
  Invoke-WebRequest -UseBasicParsing -Uri $env:PLANNOTATOR_UPDATE_SCRIPT_URL -OutFile $tmp
  & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tmp -Version $env:PLANNOTATOR_UPDATE_VERSION -NonInteractive
  $code = $LASTEXITCODE
} catch {
  Write-Output "auto-update: $_"
  $code = 1
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
}
[System.IO.File]::WriteAllText($env:PLANNOTATOR_UPDATE_RESULT, ('{"version":"' + $env:PLANNOTATOR_UPDATE_VERSION + '","exitCode":' + [int]$code + '}'))
Write-Output ("[" + (Get-Date).ToUniversalTime().ToString('o') + "] auto-update: install.ps1 exited " + $code)
Remove-Item -Force -ErrorAction SilentlyContinue $env:PLANNOTATOR_UPDATE_LOCK
`;

export function launchInstaller(launch: InstallerLaunch): void {
  const isWindows = launch.platform === "win32";
  const logFd = openSync(launch.logPath, "a");
  try {
    const env = {
      ...process.env,
      PLANNOTATOR_UPDATE_VERSION: launch.version,
      PLANNOTATOR_UPDATE_RESULT: launch.resultPath,
      PLANNOTATOR_UPDATE_LOCK: launch.lockPath,
      PLANNOTATOR_UPDATE_SCRIPT_URL: isWindows ? INSTALL_PS1_URL : INSTALL_SH_URL,
    };
    const child = isWindows
      ? spawn(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_WRAPPER],
          { detached: true, stdio: ["ignore", logFd, logFd], env, windowsHide: true },
        )
      : spawn("/bin/sh", ["-c", POSIX_WRAPPER], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          env,
        });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

let scheduled = false;
let noticeVersion: string | undefined;

/**
 * Fire-and-forget: returns immediately, runs the check on a later tick, and
 * swallows every failure into update.log. Called by the compiled CLI each time
 * a session registers; only the first call per process does anything.
 */
export function scheduleAutoUpdateCheck(currentVersion: string | undefined): void {
  if (scheduled) return;
  scheduled = true;
  const timer = setTimeout(() => {
    const dataDir = getPlannotatorDataDir();
    runAutoUpdateCheck({
      currentVersion,
      execPath: process.execPath,
      platform: process.platform,
      pid: process.pid,
      dataDir,
      now: Date.now,
      enabled: () => resolveAutoUpdate(loadConfig()),
      isManaged: () => isManagedBinary(process.execPath),
      fetchLatestTag,
      listSessions,
      launchInstaller,
    }).catch((err) => log(`check failed: ${err instanceof Error ? err.message : String(err)}`, dataDir));
  }, 0);
  // Never hold a finished CLI process open for the check.
  (timer as { unref?: () => void }).unref?.();
}

/** The compiled CLI turns the post-update notice on for its servers. */
export function enableAutoUpdateNotice(currentVersion: string | undefined): void {
  if (currentVersion && parseStableVersion(currentVersion)) noticeVersion = currentVersion;
}

/**
 * True when this compiled CLI will update itself: auto-update is on and the
 * running binary is the one the install script manages. The UI then drops the
 * redundant "new version available" toast.
 */
export function isAutoUpdateActive(): boolean {
  if (!noticeVersion) return false;
  try {
    return resolveAutoUpdate(loadConfig()) && isManagedBinary(process.execPath);
  } catch {
    return false;
  }
}

/**
 * The fields the compiled CLI's servers add to their initial payload
 * (/api/plan, /api/diff). Empty for OpenCode, Pi, dev runs and binaries the
 * install script does not manage, so those surfaces show no toggle and no
 * notice.
 */
export function getAutoUpdateAdvert(): {
  autoUpdateSupported?: true;
  autoUpdateActive?: true;
  autoUpdateNotice?: AutoUpdateNotice;
} {
  if (!noticeVersion) return {};
  let managed = false;
  try {
    managed = isManagedBinary(process.execPath);
  } catch {}
  const notice = getAutoUpdateNotice();
  return {
    ...(managed && { autoUpdateSupported: true as const }),
    ...(managed && isAutoUpdateActive() && { autoUpdateActive: true as const }),
    ...(notice && { autoUpdateNotice: notice }),
  };
}

/** The notice for the UI, or undefined (always undefined outside the compiled CLI). */
export function getAutoUpdateNotice(): AutoUpdateNotice | undefined {
  if (!noticeVersion) return undefined;
  try {
    const dataDir = getPlannotatorDataDir();
    return deriveAutoUpdateNotice(
      readAutoUpdateState(dataDir),
      readAutoUpdateResult(dataDir),
      noticeVersion,
      autoUpdatePaths(dataDir).log,
    );
  } catch {
    return undefined;
  }
}
