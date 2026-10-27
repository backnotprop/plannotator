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
 *     session's server is up, it reads the latest stable release from the
 *     shared update check (@plannotator/shared/update-check), which asks
 *     GitHub only when its cache is stale and never while update checks are
 *     off (PLANNOTATOR_UPDATE_CHECK=0).
 *   - When that release is newer and no OTHER Plannotator session is open, it
 *     spawns install.sh / install.ps1 for exactly that tag, fully detached,
 *     with output in `update.log`. A wrapper records the script's exit code in
 *     `update-result.json` and releases `update.lock`.
 *   - The next UI load shows a one-time notice derived from those files
 *     ("Updated to vX" once the running binary is that version, or "Auto-update
 *     failed" with the log path when the script exited non-zero).
 *
 * Update now (the Inbox, a review window, `plannotator update`) runs the same
 * wrapper with the same lock, log and result file, without the 24h window and
 * without the open-sessions gate: `beginManualUpdate` / `startManualUpdate`.
 *
 * Nothing here is ever awaited by a caller: `scheduleAutoUpdateCheck` returns
 * immediately and every failure ends in a log line, never a thrown error.
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  linkSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { join, posix, win32 } from "node:path";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";
import { loadConfig, resolveAutoUpdate, resolveUpdateCheck } from "@plannotator/shared/config";
import {
  buildUpdateAdvert,
  cachedLatestTag,
  compareStableVersions,
  INSTALL_FLAG_SPELLINGS,
  INSTALL_PS1_URL,
  INSTALL_SH_URL,
  installerFlagArgs,
  isAllowedOverrideUrl,
  isNewerStableVersion,
  installCommandFor,
  PI_UPDATE_COMMAND,
  knownLatestRelease,
  normalizeStableVersion,
  parseStableVersion,
  patchUpdateState,
  releaseCheckFailing,
  readInstallFlags,
  readUpdateState,
  releaseUrlFor,
  runReleaseCheck,
  updateLog,
  type FetchReleaseResult,
  type InstallFlagId,
  buildUpdateCheckFailing,
  type UpdateAction,
  type UpdateAdvert,
  type UpdateCheckFailingAdvert,
  type UpdateState,
} from "@plannotator/shared/update-check";
import { isSameOriginOrNoOrigin } from "@plannotator/shared/request-origin";
import { isLoopbackHostHeader } from "@plannotator/shared/loopback-host";
import { checkServerSession, serverSessionMismatchBody } from "@plannotator/shared/server-session";
import { listLiveSessions, listSessions, type SessionInfo } from "./sessions";

// The version helpers and the install-flag allowlist moved to
// @plannotator/shared/update-check (vendored to Pi); re-exported so existing
// importers keep working.
export {
  cachedLatestTag,
  compareStableVersions,
  INSTALL_FLAG_SPELLINGS,
  installerFlagArgs,
  isNewerStableVersion,
  normalizeStableVersion,
  parseInstallFlags,
  parseStableVersion,
  readInstallFlags,
  releaseUrlFor,
  type InstallFlagId,
  type InstallFlagsRead,
} from "@plannotator/shared/update-check";

export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A lock older than this is from a run that died without cleaning up. */
export const AUTO_UPDATE_LOCK_STALE_MS = 60 * 60 * 1000;

/** auto-update's view of update-state.json (the shared state file). */
export type AutoUpdateState = UpdateState;

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
    installFlags: join(dataDir, "install-flags.json"),
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

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
  // HOME as the environment says it now (os.homedir() may be fixed at startup).
  home: string = (platform !== "win32" && env.HOME) || homedir(),
): string {
  // Join with the TARGET platform's separator, not the host's.
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || win32.join(home, "AppData", "Local");
    return win32.join(localAppData, "plannotator", "plannotator.exe");
  }
  return posix.join(home, ".local", "bin", "plannotator");
}

export function isManagedBinary(
  execPath: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  // HOME as the environment says it now (os.homedir() may be fixed at startup).
  home: string = (platform !== "win32" && env.HOME) || homedir(),
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
  return readUpdateState(dataDir);
}

export function readAutoUpdateResult(dataDir?: string): AutoUpdateResult | null {
  const raw = readJson<AutoUpdateResult>(autoUpdatePaths(dataDir).result);
  if (!raw || typeof raw.version !== "string" || typeof raw.exitCode !== "number") return null;
  return raw;
}

function log(message: string, dataDir?: string): void {
  updateLog(message, dataDir, "auto-update");
}

/**
 * A grace after the wrapper wrote the lock before its holder may be judged
 * gone (it is a fresh process group; nothing should race it, but a lock is
 * never reaped in the instant it was written).
 */
export const UPDATE_LOCK_HANDOFF_MS = 5_000;

/**
 * Whether a lock with this mtime is past its life: older than an hour, or
 * more than an hour in the FUTURE (the clock moved back after it was taken),
 * so a lock can never hold "Updating…" until a wrong clock catches up.
 */
function lockExpired(mtimeMs: number, now: number = Date.now()): boolean {
  const age = now - mtimeMs;
  return age >= AUTO_UPDATE_LOCK_STALE_MS || age <= -AUTO_UPDATE_LOCK_STALE_MS;
}

/**
 * Who holds a lock, as the detached POSIX wrapper writes it first thing
 * (POSIX_WRAPPER): its pid, its process group (it is the group's leader, so
 * the installer it runs and that installer's children are in it too), and
 * the machine it runs on. A lock in any other form (the bare pid the taker
 * writes, a wrapper from before this, the foreground `plannotator update`,
 * Windows) keeps the hour's rule only.
 */
export interface UpdateLockHolder {
  pid: number;
  group: number;
  host: string;
  boot: string;
  pidns: string;
}

export function parseUpdateLockHolder(content: string): UpdateLockHolder | null {
  const m = /^pid=(\d+) group=(\d+) host=(\S*) boot=(\S*) pidns=(\S*)\s*$/.exec(content);
  if (!m) return null;
  const pid = Number(m[1]);
  const group = Number(m[2]);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(group) || group <= 1) return null;
  return { pid, group, host: m[3]!, boot: m[4]!, pidns: m[5]! };
}

function readTrimmed(path: string): string {
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

/** This machine as the wrapper names it (uname -n, Linux's boot id and pid namespace). */
export function thisLockMachine(): { host: string; boot: string; pidns: string } {
  let pidns = "";
  try {
    pidns = readlinkSync("/proc/self/ns/pid");
  } catch {}
  return { host: hostname(), boot: readTrimmed("/proc/sys/kernel/random/boot_id"), pidns };
}

/**
 * The holder is certainly gone: written by a wrapper on this machine (same
 * host, boot and pid namespace; anything else, or anything unreadable, is
 * unknown and keeps the hour's rule), and no process is left in its group.
 * A wrapper killed alone leaves its installer in the group: still held.
 */
function lockHolderGone(content: string, mtimeMs: number, now: number = Date.now(), machine = thisLockMachine()): boolean {
  if (process.platform === "win32") return false;
  if (now - mtimeMs < UPDATE_LOCK_HANDOFF_MS) return false;
  const holder = parseUpdateLockHolder(content);
  if (!holder || !holder.host) return false;
  if (holder.host.toLowerCase() !== machine.host.toLowerCase()) return false;
  if (holder.boot !== machine.boot || holder.pidns !== machine.pidns) return false;
  try {
    process.kill(-holder.group, 0);
    return false;
  } catch (err) {
    // EPERM: the group exists, under another user.
    return (err as NodeJS.ErrnoException)?.code === "ESRCH";
  }
}

/**
 * Remove the lock only if it is still the one judged (same inode and content):
 * renamed aside first, so a lock another process took in between is never
 * deleted; if it was not ours, it is put back (link, never over a newer one).
 */
export function removeJudgedLock(lockPath: string, judged: { ino: number; content: string }): boolean {
  const aside = `${lockPath}.reaped.${process.pid}.${Math.random().toString(36).slice(2)}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return false;
  }
  let same = false;
  try {
    same = statSync(aside).ino === judged.ino && readFileSync(aside, "utf-8") === judged.content;
  } catch {}
  if (!same) {
    try {
      linkSync(aside, lockPath);
    } catch {}
  }
  try {
    unlinkSync(aside);
  } catch {}
  return same;
}

/** The lock as it is now, or null when there is none. */
function readLock(lockPath: string): { ino: number; mtimeMs: number; content: string } | null {
  try {
    const stat = statSync(lockPath);
    return { ino: stat.ino, mtimeMs: stat.mtimeMs, content: readFileSync(lockPath, "utf-8") };
  } catch {
    return null;
  }
}

/**
 * A lock whose holder is gone (lockHolderGone): record the install it was
 * running as failed (exit -1, unless the wrapper recorded a result for it)
 * and release it, so the Inbox shows Failed with the log and Try again at once
 * instead of "Updating…" for the rest of the hour. True when it reaped one.
 */
export function reapDeadUpdateLock(dataDir?: string): boolean {
  const paths = autoUpdatePaths(dataDir);
  const lock = readLock(paths.lock);
  if (!lock || !lockHolderGone(lock.content, lock.mtimeMs)) return false;
  if (!removeJudgedLock(paths.lock, lock)) return false;
  const pending = normalizeStableVersion(readAutoUpdateState(dataDir).pending?.version);
  const result = readAutoUpdateResult(dataDir);
  if (pending && normalizeStableVersion(result?.version) !== pending) {
    try {
      writeFileSync(paths.result, JSON.stringify({ version: pending, exitCode: -1 }) + "\n");
    } catch {}
  }
  log("the update stopped without finishing (its process group is gone); the lock is released", dataDir);
  return true;
}

/** Take update.lock, clearing an expired one or one whose holder is gone. False when another run holds it. */
export function acquireUpdateLock(lockPath: string): boolean {
  try {
    const lock = readLock(lockPath);
    if (lock) {
      // Wall clock, not the injected clock: this compares against a file mtime.
      if (!lockExpired(lock.mtimeMs) && !lockHolderGone(lock.content, lock.mtimeMs)) return false;
      if (!removeJudgedLock(lockPath, lock)) return false;
    }
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

/**
 * True while an install holds update.lock: not past its hour (either way, see
 * lockExpired), and its holder not certainly gone.
 */
export function isUpdateLockHeld(dataDir?: string): boolean {
  const lock = readLock(autoUpdatePaths(dataDir).lock);
  return !!lock && !lockExpired(lock.mtimeMs) && !lockHolderGone(lock.content, lock.mtimeMs);
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
  /** Validated remembered install flags (see readInstallFlags). */
  flags: InstallFlagId[];
}

export interface AutoUpdateDeps {
  currentVersion: string | undefined;
  execPath: string;
  platform: NodeJS.Platform;
  pid: number;
  dataDir: string;
  now: () => number;
  /** The auto-update knob (resolveAutoUpdate). */
  enabled: () => boolean;
  /** The update-check knob (resolveUpdateCheck): auto-update needs the check. Default: on. */
  checksEnabled?: () => boolean;
  isManaged: () => boolean;
  /** The release check's primary source (the "latest release" redirect). Default: GitHub's. */
  fetchReleasePage?: () => Promise<FetchReleaseResult>;
  /** Ask the API; the release (with its notes) or why not. Preferred over fetchLatestTag. */
  fetchRelease?: () => Promise<FetchReleaseResult>;
  /** Ask GitHub for the tag only (older seam, kept for tests). */
  fetchLatestTag?: () => Promise<string | null>;
  listSessions: () => SessionInfo[];
  launchInstaller: (launch: InstallerLaunch) => void;
}

export type AutoUpdateOutcome =
  | "dev-build"
  | "disabled"
  | "checks-off"
  | "unmanaged"
  | "throttled"
  | "no-release"
  | "up-to-date"
  | "sessions-open"
  | "locked"
  | "launched"
  | "launch-failed";

function releaseFetcher(deps: Pick<AutoUpdateDeps, "fetchRelease" | "fetchLatestTag">): () => Promise<FetchReleaseResult> {
  if (deps.fetchRelease) return deps.fetchRelease;
  const fetchTag = deps.fetchLatestTag;
  return async () => {
    const tag = fetchTag ? await fetchTag() : null;
    return tag === null ? { ok: false, error: "no response" } : { ok: true, release: { tag } };
  };
}

export async function runAutoUpdateCheck(deps: AutoUpdateDeps): Promise<AutoUpdateOutcome> {
  const current = deps.currentVersion;
  if (!current || !parseStableVersion(current)) return "dev-build";
  if (!deps.enabled()) return "disabled";
  if (deps.checksEnabled && !deps.checksEnabled()) return "checks-off";
  if (!deps.isManaged()) return "unmanaged";

  const paths = autoUpdatePaths(deps.dataDir);
  const state = readAutoUpdateState(deps.dataDir);
  const now = deps.now();
  if (!isCheckDue(state, now)) return "throttled";

  // Claim the window before the network call so concurrent session starts do
  // not all query GitHub.
  patchUpdateState((s) => ({ ...s, lastCheckAt: now }), deps.dataDir);
  // Give the window back when nothing was installed for a reason that is not
  // "checked and up to date": the next session start retries (the release
  // check's own 10-minute backoff still bounds the requests).
  const restoreWindow = () =>
    patchUpdateState((s) => {
      const next = { ...s };
      if (state.lastCheckAt === undefined) delete next.lastCheckAt;
      else next.lastCheckAt = state.lastCheckAt;
      return next;
    }, deps.dataDir);

  // The shared release check answers from its 10-minute cache, or asks GitHub once
  // (it reduces the tag to a canonical X.Y.Z, since the tag ends up as an
  // installer argument).
  let latest = cachedLatestTag(state, now);
  if (!latest) {
    const checked = await runReleaseCheck({
      dataDir: deps.dataDir,
      now: () => now,
      enabled: () => true,
      ...(deps.fetchReleasePage && { fetchReleasePage: deps.fetchReleasePage }),
      fetchRelease: releaseFetcher(deps),
    });
    latest = checked.outcome === "checked" ? checked.version : null;
    if (!latest) {
      // The check failed (or waits out its back-off), but an earlier one
      // already named a newer release: install that one. Without this, a
      // check that keeps failing would leave auto-update "active" (the
      // review toast steps aside for it) while it never installs.
      const known = knownLatestRelease(readAutoUpdateState(deps.dataDir));
      if (known && isNewerStableVersion(known.version, current)) {
        latest = known.version;
        log(`could not check for a newer release; installing ${latest}, the newest one known`, deps.dataDir);
      } else {
        restoreWindow();
        return "no-release";
      }
    }
  }
  if (!isNewerStableVersion(latest, current)) return "up-to-date";

  const others = otherOpenSessions(deps.listSessions(), deps.pid);
  if (others.length > 0) {
    // Do not spend the 24h install window: the next session start retries,
    // answering from the cached release while it is under 10 minutes old, and
    // otherwise through the release check's own throttle.
    restoreWindow();
    log(
      `${latest} is available; skipped because ${others.length} other Plannotator session(s) are open`,
      deps.dataDir,
    );
    return "sessions-open";
  }

  if (!acquireUpdateLock(paths.lock)) {
    log("another update is already running", deps.dataDir);
    return "locked";
  }

  const version = latest;
  try {
    try {
      unlinkSync(paths.result);
    } catch {}
    patchUpdateState(
      (s) => ({ ...s, lastCheckAt: now, pending: { version, fromVersion: current, startedAt: now } }),
      deps.dataDir,
    );
    const remembered = readInstallFlags(deps.dataDir);
    if (remembered.problem) log(remembered.problem, deps.dataDir);
    const flagNote = remembered.flags.length > 0 ? ` with ${remembered.flags.join(", ")}` : "";
    log(`installing v${version} (from v${current})${flagNote}`, deps.dataDir);
    deps.launchInstaller({
      version: `v${version}`,
      logPath: paths.log,
      resultPath: paths.result,
      lockPath: paths.lock,
      platform: deps.platform,
      flags: remembered.flags,
    });
    return "launched";
  } catch (err) {
    abortLaunch(version, err, deps.dataDir);
    return "launch-failed";
  }
}

/** A launch that never started: record a failed result and release the lock. */
function abortLaunch(version: string, err: unknown, dataDir?: string): void {
  const paths = autoUpdatePaths(dataDir);
  log(`could not start the installer: ${err instanceof Error ? err.message : String(err)}`, dataDir);
  try {
    writeFileSync(paths.result, JSON.stringify({ version: version.replace(/^v/, ""), exitCode: -1 }) + "\n");
  } catch {}
  try {
    unlinkSync(paths.lock);
  } catch {}
}

// ---------------------------------------------------------------------------
// Update now (the Inbox, a review window's toast, `plannotator update`)
// ---------------------------------------------------------------------------

export interface ManualUpdateDeps {
  currentVersion: string | undefined;
  dataDir: string;
  now: () => number;
  platform: NodeJS.Platform;
  isManaged: () => boolean;
}

export type ManualUpdateBegin =
  | { outcome: "ready"; launch: InstallerLaunch; fromVersion: string }
  | { outcome: "dev-build" | "unmanaged" | "no-release" | "up-to-date" | "locked" };

/**
 * The person asked for the update: the same installer, lock, log, result file
 * and pinned tag as auto-update, without its 24h throttle and without its
 * "other sessions are open" gate (open sessions keep running their old
 * binary; the person was told). The version is always the newest release the
 * machine knows about, never one a caller names, so a request can never pick
 * a downgrade.
 */
export function beginManualUpdate(deps: ManualUpdateDeps): ManualUpdateBegin {
  const current = deps.currentVersion;
  if (!current || !parseStableVersion(current)) return { outcome: "dev-build" };
  if (!deps.isManaged()) return { outcome: "unmanaged" };
  const latest = knownLatestRelease(readAutoUpdateState(deps.dataDir));
  if (!latest) return { outcome: "no-release" };
  if (!isNewerStableVersion(latest.version, current)) return { outcome: "up-to-date" };
  const paths = autoUpdatePaths(deps.dataDir);
  if (!acquireUpdateLock(paths.lock)) {
    log("Update now: another update is already running", deps.dataDir);
    return { outcome: "locked" };
  }
  const now = deps.now();
  try {
    unlinkSync(paths.result);
  } catch {}
  patchUpdateState(
    (s) => ({ ...s, pending: { version: latest.version, fromVersion: current, startedAt: now, by: "person" } }),
    deps.dataDir,
  );
  const remembered = readInstallFlags(deps.dataDir);
  if (remembered.problem) log(remembered.problem, deps.dataDir);
  const flagNote = remembered.flags.length > 0 ? ` with ${remembered.flags.join(", ")}` : "";
  log(`Update now: installing v${latest.version} (from v${current})${flagNote}`, deps.dataDir);
  return {
    outcome: "ready",
    fromVersion: current,
    launch: {
      version: `v${latest.version}`,
      logPath: paths.log,
      resultPath: paths.result,
      lockPath: paths.lock,
      platform: deps.platform,
      flags: remembered.flags,
    },
  };
}

export type ManualUpdateOutcome =
  | { outcome: "launched"; version: string }
  | { outcome: "launch-failed"; version: string }
  | { outcome: "dev-build" | "unmanaged" | "no-release" | "up-to-date" | "locked" };

/** Update now, detached: what the Inbox and a review window's Update button run. */
export function startManualUpdate(
  deps: ManualUpdateDeps & { launchInstaller: (launch: InstallerLaunch) => void },
): ManualUpdateOutcome {
  const begun = beginManualUpdate(deps);
  if (begun.outcome !== "ready") return begun;
  const version = begun.launch.version.replace(/^v/, "");
  try {
    deps.launchInstaller(begun.launch);
    return { outcome: "launched", version };
  } catch (err) {
    abortLaunch(version, err, deps.dataDir);
    return { outcome: "launch-failed", version };
  }
}

/** startManualUpdate for this process: the compiled CLI's own binary and data dir. */
export function startManualUpdateForThisBinary(currentVersion: string | undefined): ManualUpdateOutcome {
  return startManualUpdate({
    currentVersion,
    dataDir: getPlannotatorDataDir(),
    now: Date.now,
    platform: process.platform,
    isManaged: () => isManagedBinary(process.execPath),
    launchInstaller,
  });
}

/**
 * The detached wrapper. It downloads the same script a user pipes by hand,
 * runs it for exactly `version` without prompts plus the remembered install
 * flags, records the exit code, and releases the lock. Inputs travel as
 * environment variables or argv entries, never interpolated into the command
 * text: on POSIX the flags are the wrapper's own positional parameters
 * (`"$@"`).
 */
const POSIX_WRAPPER = `
# Detached (auto-update, Update now): the lock names this wrapper's process
# group (it leads it, so the installer and its children are in it) and this
# machine, so an install that is gone shows as failed at once instead of
# "Updating…" for the lock's hour. The foreground \`plannotator update\` keeps
# the lock its own process wrote.
if [ "\${PLANNOTATOR_UPDATE_DETACHED:-}" = 1 ]; then
  printf 'pid=%s group=%s host=%s boot=%s pidns=%s\\n' "$$" "$$" "$(uname -n 2>/dev/null)" \
    "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" "$(readlink /proc/$$/ns/pid 2>/dev/null)" > "$PLANNOTATOR_UPDATE_LOCK"
fi
tmp=$(mktemp "\${TMPDIR:-/tmp}/plannotator-install.XXXXXX") || exit 1
code=1
# Interrupted (Ctrl-C on plannotator update, a TERM): record 130 and release
# the lock now, so the next update does not wait an hour for a stale lock.
on_signal() {
  trap '' INT TERM HUP
  rm -f "$tmp"
  printf '{"version":"%s","exitCode":130}\\n' "$PLANNOTATOR_UPDATE_VERSION" > "$PLANNOTATOR_UPDATE_RESULT.tmp" && mv -f "$PLANNOTATOR_UPDATE_RESULT.tmp" "$PLANNOTATOR_UPDATE_RESULT"
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] update: interrupted"
  rm -f "$PLANNOTATOR_UPDATE_LOCK"
  exit 130
}
trap on_signal INT TERM HUP
if curl -fsSL --connect-timeout 30 --speed-limit 1 --speed-time 60 "$PLANNOTATOR_UPDATE_SCRIPT_URL" -o "$tmp"; then
  bash "$tmp" --version "$PLANNOTATOR_UPDATE_VERSION" --non-interactive "$@" </dev/null
  code=$?
else
  echo "update: could not download $PLANNOTATOR_UPDATE_SCRIPT_URL"
fi
rm -f "$tmp"
printf '{"version":"%s","exitCode":%d}\\n' "$PLANNOTATOR_UPDATE_VERSION" "$code" > "$PLANNOTATOR_UPDATE_RESULT.tmp" && mv -f "$PLANNOTATOR_UPDATE_RESULT.tmp" "$PLANNOTATOR_UPDATE_RESULT"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] update: install.sh exited $code"
rm -f "$PLANNOTATOR_UPDATE_LOCK"
`;

// The allowlist the Windows wrapper re-checks each flag against. Built from the
// constant table above, never from input.
const POWERSHELL_ALLOWED_FLAGS = Object.values(INSTALL_FLAG_SPELLINGS)
  .map((s) => `'${s.powershell}'`)
  .join(",");

/**
 * Windows: the remembered switches arrive space-separated in
 * PLANNOTATOR_UPDATE_FLAGS, are re-checked against the allowlist, and are
 * splatted as an array, so they are never parsed as script text.
 */
const POWERSHELL_WRAPPER = `
# 130 until the installer finished: a Ctrl-C stops the pipeline, and the
# finally block below still records it and releases the lock.
$code = 130
$allowedFlags = @(${POWERSHELL_ALLOWED_FLAGS})
$installFlags = @()
if ($env:PLANNOTATOR_UPDATE_FLAGS) {
  foreach ($f in $env:PLANNOTATOR_UPDATE_FLAGS.Split(' ', [System.StringSplitOptions]::RemoveEmptyEntries)) {
    if ($allowedFlags -ccontains $f) { $installFlags += $f }
  }
}
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("plannotator-install-" + [guid]::NewGuid().ToString('N') + ".ps1")
try {
  Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri $env:PLANNOTATOR_UPDATE_SCRIPT_URL -OutFile $tmp
  & powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $tmp -Version $env:PLANNOTATOR_UPDATE_VERSION -NonInteractive @installFlags
  $code = $LASTEXITCODE
} catch {
  Write-Output "update: $_"
  $code = 1
} finally {
  Remove-Item -Force -ErrorAction SilentlyContinue $tmp
  [System.IO.File]::WriteAllText($env:PLANNOTATOR_UPDATE_RESULT, ('{"version":"' + $env:PLANNOTATOR_UPDATE_VERSION + '","exitCode":' + [int]$code + '}'))
  Write-Output ("[" + (Get-Date).ToUniversalTime().ToString('o') + "] update: install.ps1 exited " + $code)
  Remove-Item -Force -ErrorAction SilentlyContinue $env:PLANNOTATOR_UPDATE_LOCK
}
`;

/**
 * The detached process to spawn. Windows gets the wrapper as
 * -EncodedCommand (base64 UTF-16LE), so its quotes and newlines never go
 * through command-line quoting at all, and the flags as an env var; POSIX gets
 * the flags as argv after the `sh -c` script (`$0` is a fixed label).
 */
export function installerCommand(
  platform: NodeJS.Platform,
  flags: readonly InstallFlagId[] = [],
): { file: string; args: string[]; env: Record<string, string> } {
  const flagArgs = installerFlagArgs(flags, platform);
  if (platform === "win32") {
    return {
      file: "powershell.exe",
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        Buffer.from(POWERSHELL_WRAPPER, "utf16le").toString("base64"),
      ],
      env: { PLANNOTATOR_UPDATE_FLAGS: flagArgs.join(" ") },
    };
  }
  return { file: "/bin/sh", args: ["-c", POSIX_WRAPPER, "plannotator-auto-update", ...flagArgs], env: {} };
}

/**
 * The install script the wrapper downloads. PLANNOTATOR_INSTALL_SCRIPT_URL is
 * a testing / mirror knob (`https:` or loopback `http:` only; anything else is
 * ignored), like PLANNOTATOR_UPDATE_API_URL for the release check.
 */
export function installScriptUrl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PLANNOTATOR_INSTALL_SCRIPT_URL?.trim();
  if (raw && isAllowedOverrideUrl(raw)) return raw;
  return platform === "win32" ? INSTALL_PS1_URL : INSTALL_SH_URL;
}

function installerEnv(launch: InstallerLaunch): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { file, args, env: commandEnv } = installerCommand(launch.platform, launch.flags);
  return {
    file,
    args,
    env: {
      ...process.env,
      PLANNOTATOR_UPDATE_VERSION: launch.version,
      PLANNOTATOR_UPDATE_RESULT: launch.resultPath,
      PLANNOTATOR_UPDATE_LOCK: launch.lockPath,
      PLANNOTATOR_UPDATE_SCRIPT_URL: installScriptUrl(launch.platform),
      ...commandEnv,
    },
  };
}

export function launchInstaller(launch: InstallerLaunch): void {
  const logFd = openSync(launch.logPath, "a");
  try {
    const { file, args, env } = installerEnv(launch);
    const child = spawn(file, args, {
      detached: true,
      // Its own process group: the wrapper writes it into update.lock (POSIX_WRAPPER).
      stdio: ["ignore", logFd, logFd],
      env: { ...env, PLANNOTATOR_UPDATE_DETACHED: "1" },
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(logFd);
  }
}

/**
 * `plannotator update`: the same wrapper, in the foreground, its output shown
 * as it runs and appended to update.log. Resolves to the install script's exit
 * code (from update-result.json, which the wrapper writes), or -1.
 */
export function runInstallerForeground(
  launch: InstallerLaunch,
  write: (chunk: string) => void,
  options: { onSpawn?: (child: ReturnType<typeof spawn>) => void } = {},
): Promise<number> {
  return new Promise((resolve) => {
    // While the installer runs, an INT or TERM to this process is passed to
    // the wrapper (whose trap records 130 and releases the lock) instead of
    // killing this process first; a Ctrl-C reaches both already.
    const forward = (signal: NodeJS.Signals) => () => {
      try {
        child?.kill(signal);
      } catch {}
    };
    const onInt = forward("SIGINT");
    const onTerm = forward("SIGTERM");
    const unhook = () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
    };
    const { file, args, env } = installerEnv(launch);
    const tee = (chunk: Buffer | string) => {
      const text = chunk.toString();
      write(text);
      try {
        appendFileSync(launch.logPath, text);
      } catch {}
    };
    let child: ReturnType<typeof spawn> | undefined;
    try {
      child = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
    } catch (err) {
      abortLaunch(launch.version, err, join(launch.logPath, ".."));
      resolve(-1);
      return;
    }
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
    options.onSpawn?.(child);
    child.stdout?.on("data", tee);
    child.stderr?.on("data", tee);
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      unhook();
      const raw = readJson<AutoUpdateResult>(launch.resultPath);
      if (raw && typeof raw.exitCode === "number") {
        resolve(raw.exitCode);
        return;
      }
      abortLaunch(launch.version, new Error("the installer ended without a result"), join(launch.logPath, ".."));
      resolve(-1);
    };
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      unhook();
      abortLaunch(launch.version, err, join(launch.logPath, ".."));
      resolve(-1);
    });
    // "exit", not "close": a wrapper killed outright can leave its own children
    // holding the pipes open, and the lock must not wait for them.
    child.on("exit", finish);
  });
}

// ---------------------------------------------------------------------------
// CLI wiring
// ---------------------------------------------------------------------------

let scheduled = false;
let noticeVersion: string | undefined;

/**
 * Fire-and-forget: returns immediately, runs on a later tick, and swallows
 * every failure into update.log. Called by the compiled CLI each time a
 * session registers; only the first call per process does anything.
 *
 * First the shared release check (the update notices: at most once every 10
 * minutes per machine, 10 minutes after a failure, never when
 * PLANNOTATOR_UPDATE_CHECK is off), then opt-in auto-update, which answers
 * from that same cache.
 */
export function scheduleAutoUpdateCheck(currentVersion: string | undefined): void {
  if (scheduled) return;
  scheduled = true;
  // No check at all in dev/source runs.
  if (!currentVersion || !parseStableVersion(currentVersion)) return;
  const timer = setTimeout(() => {
    const dataDir = getPlannotatorDataDir();
    void (async () => {
      const config = loadConfig();
      const checksOn = resolveUpdateCheck(config);
      await runReleaseCheck({ dataDir, enabled: () => checksOn });
      await runAutoUpdateCheck({
        currentVersion,
        execPath: process.execPath,
        platform: process.platform,
        pid: process.pid,
        dataDir,
        now: Date.now,
        enabled: () => resolveAutoUpdate(config),
        checksEnabled: () => checksOn,
        isManaged: () => isManagedBinary(process.execPath),
        listSessions,
        launchInstaller,
      });
    })().catch((err) => log(`check failed: ${err instanceof Error ? err.message : String(err)}`, dataDir));
  }, 0);
  // Never hold a finished CLI process open for the check.
  (timer as { unref?: () => void }).unref?.();
}

/** The compiled CLI turns the post-update notice on for its servers. */
export function enableAutoUpdateNotice(currentVersion: string | undefined): void {
  if (currentVersion && parseStableVersion(currentVersion)) noticeVersion = currentVersion;
}

/** Tests only: set or clear the version enableAutoUpdateNotice recorded (restore it in finally). */
export function setCliNoticeVersionForTests(version: string | undefined): void {
  noticeVersion = version;
}

/** The release version the compiled CLI runs, once enableAutoUpdateNotice saw it. */
export function cliNoticeVersion(): string | undefined {
  return noticeVersion;
}

/**
 * True when this compiled CLI will update itself: auto-update is on and the
 * running binary is the one the install script manages. The UI then drops the
 * redundant "new version available" toast.
 */
export function isAutoUpdateActive(): boolean {
  if (!noticeVersion) return false;
  try {
    const config = loadConfig();
    if (!(resolveAutoUpdate(config) && resolveUpdateCheck(config) && isManagedBinary(process.execPath))) return false;
    const dataDir = getPlannotatorDataDir();
    return autoUpdateCanInstall({
      lockHeld: isUpdateLockHeld(dataDir),
      windowOpen: isCheckDue(readAutoUpdateState(dataDir), Date.now()),
      sessions: listLiveSessions(),
      ownPid: process.pid,
    });
  } catch {
    return false;
  }
}

/**
 * Whether auto-update can actually install now: an install is running, or its
 * 24 h window has elapsed and no other Plannotator session is open. It skips
 * every start that finds another session, and installs at most once a day,
 * so without these a person would be neither updated nor told for up to a
 * day, or for good while a session is always open. Pure, for the tests.
 */
export function autoUpdateCanInstall(input: { lockHeld: boolean; windowOpen: boolean; sessions: SessionInfo[]; ownPid: number }): boolean {
  if (input.lockHeld) return true;
  return input.windowOpen && otherOpenSessions(input.sessions, input.ownPid).length === 0;
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

/** What updating means for a server the compiled CLI started for `origin`. */
export function updateActionFor(origin: string | null | undefined, managed: boolean, exposed = false): UpdateAction {
  if (origin === "opencode") return "opencode";
  if (origin === "pi") return "pi";
  // A session other devices can reach (remote mode, --tailscale) never offers
  // to start the installer: it shows the command instead.
  return managed && !exposed ? "script" : "copy";
}

/**
 * The update notice the compiled CLI's servers add to their payload:
 * `updateAvailable` when the machine knows of a newer stable release and
 * update checks are on. Read from the cache only: never a network call.
 */
export function getUpdateAdvert(
  origin?: string | null,
  options: { exposed?: boolean } = {},
): { updateAvailable?: UpdateAdvert; updateCheckFailing?: UpdateCheckFailingAdvert } {
  if (!noticeVersion) return {};
  try {
    if (!resolveUpdateCheck(loadConfig())) return {};
    const dataDir = getPlannotatorDataDir();
    const state = readAutoUpdateState(dataDir);
    const flags = readInstallFlags(dataDir).flags;
    const action = updateActionFor(origin, isManagedBinary(process.execPath), options.exposed === true);
    const advert = buildUpdateAdvert({ state, current: noticeVersion, action, platform: process.platform, flags });
    if (advert) return { updateAvailable: advert };
    const failing = buildUpdateCheckFailing(state, Date.now(), action === "pi" ? PI_UPDATE_COMMAND : installCommandFor(process.platform, flags));
    return failing ? { updateCheckFailing: failing } : {};
  } catch {
    return {};
  }
}


/**
 * POST /api/update on the compiled CLI's plan, review and annotate servers:
 * the review toast's (and the Options menu's) Update. The same Update now as
 * the Inbox: the install script for the newest known release, detached, once
 * (update.lock). Null for any other path.
 *
 * Starting an installer is this computer's decision, so it answers only a
 * loopback Host naming this server's port (a LAN or tailnet device reaching a
 * remote-mode or --tailscale session never can), never while the session is
 * exposed beyond this computer (its advert says `copy` then), never a
 * cross-origin page, and a tab left open on an older session gets 409.
 */
export function handleUpdateRoute(
  req: Request,
  url: URL,
  ctx: { port: number | null | undefined; exposed: boolean; serverSession: string },
): Promise<Response> | null {
  if (url.pathname !== "/api/update") return null;
  return (async () => {
    if (req.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
    if (!isLoopbackHostHeader(req.headers.get("host"), ctx.port)) {
      return Response.json({ error: "Update answers only this computer.", code: "forbidden_host" }, { status: 403 });
    }
    if (!isSameOriginOrNoOrigin(req.headers.get("origin"), url.host, req.headers.get("sec-fetch-site"))) {
      return Response.json({ error: "Cross-origin requests are not accepted." }, { status: 403 });
    }
    if (ctx.exposed) {
      return Response.json(
        { error: "This session is reachable from other devices, so it does not start the installer. Run the install command instead.", code: "update_exposed" },
        { status: 403 },
      );
    }
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {}
    if (checkServerSession(body, ctx.serverSession) === "mismatch") return Response.json(serverSessionMismatchBody(), { status: 409 });
    const result = startManualUpdateForThisBinary(noticeVersion);
    if (result.outcome === "launched") return Response.json({ ok: true, version: result.version });
    const refused: Record<string, string> = {
      locked: "An update is already running.",
      unmanaged: "This copy of Plannotator was not installed by the install script, so it can't update itself.",
      "dev-build": "This is a development build; there is nothing to update.",
      "no-release": "No newer release is known yet.",
      "up-to-date": "Plannotator is up to date.",
      "launch-failed": "The install script could not be started; see update.log.",
    };
    return Response.json(
      { error: refused[result.outcome] ?? "The update could not start.", code: `update_${result.outcome.replace(/-/g, "_")}` },
      { status: 409 },
    );
  })();
}
