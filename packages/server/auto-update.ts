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

import { UPDATE_EXIT_CHECKSUM_MISMATCH, UPDATE_EXIT_DOWNLOAD_FAILED } from "@plannotator/core/update-exit-codes";
import { lastRunLog, stagingFailureIn } from "./update-log";
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
import { homedir, hostname, uptime } from "node:os";
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
/**
 * The wrapper's exit code when the running binary could not download the
 * install script or the checksums (update-prepare.ts): nothing ran, nothing
 * changed, try again later (sysexits EX_TEMPFAIL; curl, whose exit codes
 * install.sh can pass on, never uses it).
 */
export const UPDATE_PREPARE_FAILED = UPDATE_EXIT_DOWNLOAD_FAILED;
/**
 * The recorded result when install.sh stopped because the binary did not
 * match PLANNOTATOR_EXPECTED_SHA256, before it replaced anything. install.sh
 * exits with it AND first writes the wrapper's marker file; the wrapper
 * records it only when that marker exists and turns any other exit with this
 * number into 1, so "nothing was changed" is never claimed for another error
 * (install.sh runs under `set -e`; curl's own codes stay below 100).
 */
export const UPDATE_CHECKSUM_MISMATCH = UPDATE_EXIT_CHECKSUM_MISMATCH;
/** Auto-update's wait before retrying a version whose download did not match: 1, 3, then 7 days. */
export const MISMATCH_BACKOFF_DAYS: readonly number[] = [1, 3, 7];
/** A lock older than this is from a run that died without cleaning up. */
export const AUTO_UPDATE_LOCK_STALE_MS = 60 * 60 * 1000;
/** A lock whose installer still runs holds past the hour, up to this (a hung install never holds for good). */
export const AUTO_UPDATE_LOCK_LIVE_MAX_MS = 24 * 60 * 60 * 1000;

/** auto-update's view of update-state.json (the shared state file). */
export type AutoUpdateState = UpdateState;

export interface AutoUpdateResult {
  version: string;
  exitCode: number;
}

export interface AutoUpdateNotice {
  /** Stable per install attempt (per version for a mismatch), so a client can remember it was shown. */
  id: string;
  kind: "updated" | "failed";
  version: string;
  releaseUrl: string;
  logPath?: string;
  /**
   * Why a failed install failed, when it is one of the safe-update outcomes:
   * `mismatch` (the download did not match the checksum Plannotator fetched)
   * or `download` (Plannotator could not download the update), or `prepare`
   * (downloaded, but the temp folder could not hold it). Additive.
   */
  reason?: "mismatch" | "download" | "prepare";
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

/**
 * Live sessions that belong to some other Plannotator process. A server inside
 * a host's process (`host`, OpenCode) does not run the binary, so it never
 * holds an update back.
 */
export function otherOpenSessions(sessions: SessionInfo[], ownPid: number): SessionInfo[] {
  return sessions.filter((s) => s.pid !== ownPid && !s.host);
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
    // A background run that could not download anything changed nothing:
    // update.log only, and the next window tries again. Never a notice.
    if (result.exitCode === UPDATE_PREPARE_FAILED && pending.by !== "person") return undefined;
    // A 75 whose download worked but whose temp folder could not hold it
    // (update-prepare's staging line in this run's log) is `prepare`.
    const reason =
      result.exitCode === UPDATE_CHECKSUM_MISMATCH
        ? "mismatch"
        : result.exitCode === UPDATE_PREPARE_FAILED
          ? stagingFailureIn(lastRunLog(logPath))
            ? "prepare"
            : "download"
          : undefined;
    return {
      // A mismatch shows once per version, however many retries the back-off makes.
      id: reason === "mismatch" ? `${version}@mismatch` : id,
      kind: "failed",
      version,
      releaseUrl: releaseUrlFor(version),
      logPath,
      ...(reason && { reason }),
    };
  }
  return undefined;
}

/** How long auto-update waits after the `attempts`-th mismatching download of one version. */
export function mismatchBackoffMs(attempts: number): number {
  const days = MISMATCH_BACKOFF_DAYS[Math.min(Math.max(attempts, 1), MISMATCH_BACKOFF_DAYS.length) - 1]!;
  return days * AUTO_UPDATE_INTERVAL_MS;
}

/**
 * Count a finished install whose download did not match (UPDATE_CHECKSUM_MISMATCH) into
 * `mismatchBackoff`, once per install attempt (`pending.startedAt`). Returns
 * the back-off as it stands. Pure.
 */
export function noteMismatchResult(state: AutoUpdateState, result: AutoUpdateResult | null): AutoUpdateState["mismatchBackoff"] {
  const backoff = state.mismatchBackoff;
  if (!result || result.exitCode !== UPDATE_CHECKSUM_MISMATCH) return backoff;
  const version = result.version.replace(/^v/, "");
  const pending = state.pending;
  if (!pending || pending.version.replace(/^v/, "") !== version) return backoff;
  if (backoff && backoff.version === version && backoff.lastAttemptAt === pending.startedAt) return backoff;
  const attempts = backoff && backoff.version === version && Number.isFinite(backoff.attempts) ? backoff.attempts + 1 : 1;
  return { version, attempts, lastAttemptAt: pending.startedAt };
}

/** Whether background auto-update holds back `latest` for now. Pure. */
export function isMismatchBackedOff(backoff: AutoUpdateState["mismatchBackoff"], latest: string, now: number): boolean {
  if (!backoff || backoff.version !== latest.replace(/^v/, "")) return false;
  const at = backoff.lastAttemptAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now) return false;
  return now - at < mismatchBackoffMs(backoff.attempts);
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
 * Who holds a lock, as launchInstaller writes it right after the spawn and
 * the detached POSIX wrapper again first thing (POSIX_WRAPPER): the wrapper's
 * pid, its process group (it is the group's leader, so the installer it runs
 * and that installer's children are in it too; Windows judges the pid only),
 * and the machine it runs on. A lock in any other form (the bare pid the
 * taker writes, the foreground `plannotator update`, an older binary) keeps
 * the hour's rule only.
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
 * A holder line written on this machine (same host, boot and pid namespace)
 * is "alive" while a process is left in its group (Windows: while its pid
 * runs) and "gone" when none is. Anything else, or anything unreadable, is
 * "unknown" and keeps the hour's rule. A wrapper killed alone leaves its
 * installer in the group: still alive.
 */
function judgeLockHolder(content: string): "alive" | "gone" | "unknown" {
  const holder = parseUpdateLockHolder(content);
  if (!holder || !holder.host) return "unknown";
  const machine = thisLockMachine();
  if (holder.host.toLowerCase() !== machine.host.toLowerCase()) return "unknown";
  if (holder.boot !== machine.boot || holder.pidns !== machine.pidns) return "unknown";
  try {
    process.kill(process.platform === "win32" ? holder.pid : -holder.group, 0);
    return "alive";
  } catch (err) {
    // EPERM: the group exists, under another user.
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ESRCH" ? "gone" : code === "EPERM" ? "alive" : "unknown";
  }
}

/** The holder is certainly gone (judgeLockHolder), past the handoff grace. */
function lockHolderGone(content: string, mtimeMs: number, now: number = Date.now()): boolean {
  if (now - mtimeMs < UPDATE_LOCK_HANDOFF_MS) return false;
  return judgeLockHolder(content) === "gone";
}

/**
 * Whether a lock still holds: its holder is not certainly gone, and it is
 * within its hour, or past it while its installer still runs (a slow
 * download), so a second installer never starts beside the first. Past the
 * hour, that ends at AUTO_UPDATE_LOCK_LIVE_MAX_MS, and a lock with no boot id
 * (macOS) must be from this boot (its group id may be reused since). Windows
 * keeps the hour: it reuses a bare pid too soon to trust it for longer.
 */
function lockHeld(lock: { mtimeMs: number; content: string }, now: number = Date.now()): boolean {
  if (lockHolderGone(lock.content, lock.mtimeMs, now)) return false;
  if (!lockExpired(lock.mtimeMs, now)) return true;
  if (process.platform === "win32" || Math.abs(now - lock.mtimeMs) >= AUTO_UPDATE_LOCK_LIVE_MAX_MS) return false;
  if (!parseUpdateLockHolder(lock.content)?.boot && lock.mtimeMs <= now - uptime() * 1000) return false;
  return judgeLockHolder(lock.content) === "alive";
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
 * A lock that no longer holds (its holder is gone, or it expired): record the
 * install it was running as failed (exit -1, unless the wrapper recorded a
 * result for it) and release it, so the Inbox shows Failed with the log and
 * Try again, never "Updating…" and then nothing. True when it reaped one.
 */
export function reapDeadUpdateLock(dataDir?: string): boolean {
  const paths = autoUpdatePaths(dataDir);
  const lock = readLock(paths.lock);
  if (!lock || lockHeld(lock)) return false;
  if (!removeJudgedLock(paths.lock, lock)) return false;
  const pending = normalizeStableVersion(readAutoUpdateState(dataDir).pending?.version);
  const result = readAutoUpdateResult(dataDir);
  if (pending && normalizeStableVersion(result?.version) !== pending) {
    try {
      writeFileSync(paths.result, JSON.stringify({ version: pending, exitCode: -1 }) + "\n");
    } catch {}
  }
  log("the update stopped without finishing; the lock is released", dataDir);
  return true;
}

/** Take update.lock, clearing an expired one or one whose holder is gone. False when another run holds it. */
export function acquireUpdateLock(lockPath: string): boolean {
  try {
    const lock = readLock(lockPath);
    if (lock) {
      // Wall clock, not the injected clock: this compares against a file mtime.
      if (lockHeld(lock)) return false;
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

/** True while an install holds update.lock (lockHeld). */
export function isUpdateLockHeld(dataDir?: string): boolean {
  const lock = readLock(autoUpdatePaths(dataDir).lock);
  return !!lock && lockHeld(lock);
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
  /** Who runs `update-prepare` (POSIX). Default: this process (updatePrepareInvocation). Tests point it at a source entry. */
  prepare?: { binary: string; entry: string };
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
  | "backed-off"
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

  // Safe updates: a version whose download did not match the checksum
  // Plannotator fetched waits 1, 3, then 7 days before the background tries
  // it again (the 24 h window is spent: one check a day, never a loop).
  const backoff = noteMismatchResult(state, readAutoUpdateResult(deps.dataDir));
  if (backoff !== state.mismatchBackoff) patchUpdateState((s) => ({ ...s, mismatchBackoff: backoff }), deps.dataDir);
  if (isMismatchBackedOff(backoff, latest, now)) {
    log(
      `v${latest} is held back until ${new Date(backoff!.lastAttemptAt + mismatchBackoffMs(backoff!.attempts)).toISOString()}: its last download did not match the checksum Plannotator fetched`,
      deps.dataDir,
    );
    return "backed-off";
  }

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
 * The detached POSIX wrapper (safe updates, step 1). It never downloads with
 * the shell's curl: it asks the running Plannotator (`update-prepare`, its own
 * fetch, update-prepare.ts) to download the install script and the expected
 * checksums into a private temp dir, then runs that script for exactly
 * `version` without prompts plus the remembered install flags, with
 * PLANNOTATOR_EXPECTED_SHA256 so the script refuses a binary that does not
 * match (UPDATE_CHECKSUM_MISMATCH, before it replaces anything). It records the exit code,
 * removes the temp dir and releases the lock. When the download step fails
 * nothing runs and the result is UPDATE_PREPARE_FAILED (75).
 *
 * Inputs travel as environment variables or argv entries, never interpolated
 * into the command text: the flags are the wrapper's own positional
 * parameters (`"$@"`). The staged dir comes from our own binary's stdout and
 * is only used (or removed) when it is a single absolute path whose last part
 * is plannotator-update-*.
 */
const POSIX_WRAPPER = `
# Detached (auto-update, Update now): the lock names this wrapper's process
# group (it leads it, so the installer and its children are in it) and this
# machine, so an install that is gone shows as failed at once instead of
# "Updating…" for the lock's hour. The foreground \`plannotator update\` keeps
# the lock its own process wrote.
own_lock=""
if [ "\${PLANNOTATOR_UPDATE_DETACHED:-}" = 1 ]; then
  printf 'pid=%s group=%s host=%s boot=%s pidns=%s\\n' "$$" "$$" "$(uname -n 2>/dev/null)" \
    "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" "$(readlink /proc/$$/ns/pid 2>/dev/null)" > "$PLANNOTATOR_UPDATE_LOCK"
else
  own_lock=$(cat "$PLANNOTATOR_UPDATE_LOCK" 2>/dev/null)
fi
# Remove the lock only while it is still this run's: its line names this
# wrapper, or it is what the lock held when this wrapper started. Never a lock
# another install took.
release_lock() {
  lock_now=$(cat "$PLANNOTATOR_UPDATE_LOCK" 2>/dev/null)
  case "$lock_now" in
    "pid=$$ "*) rm -f "$PLANNOTATOR_UPDATE_LOCK" ;;
    *) if [ -n "$own_lock" ] && [ "$lock_now" = "$own_lock" ]; then rm -f "$PLANNOTATOR_UPDATE_LOCK"; fi ;;
  esac
}
update_dir=""
code=1
cleanup() {
  [ -n "$update_dir" ] && rm -rf "$update_dir"
}
record() {
  printf '{"version":"%s","exitCode":%d}\\n' "$PLANNOTATOR_UPDATE_VERSION" "$1" > "$PLANNOTATOR_UPDATE_RESULT.tmp" && mv -f "$PLANNOTATOR_UPDATE_RESULT.tmp" "$PLANNOTATOR_UPDATE_RESULT"
}
# Interrupted (Ctrl-C on plannotator update, a TERM): record 130 and release
# the lock now, so the next update does not wait an hour for a stale lock.
on_signal() {
  trap '' INT TERM HUP
  cleanup
  record 130
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] update: interrupted"
  release_lock
  exit 130
}
trap on_signal INT TERM HUP
if [ -n "$PLANNOTATOR_UPDATE_ENTRY" ]; then
  prepared=$("$PLANNOTATOR_UPDATE_BINARY" "$PLANNOTATOR_UPDATE_ENTRY" update-prepare "$PLANNOTATOR_UPDATE_VERSION" </dev/null) || prepared=""
else
  prepared=$("$PLANNOTATOR_UPDATE_BINARY" update-prepare "$PLANNOTATOR_UPDATE_VERSION" </dev/null) || prepared=""
fi
# Used (and later removed) only when it is an absolute path on one line whose
# last part is plannotator-update-* (a case pattern's * crosses slashes, so
# the last part is checked on its own).
case "$prepared" in
  *"
"*|*/) ;;
  /*) case "\${prepared##*/}" in
        plannotator-update-?*) update_dir="$prepared" ;;
      esac ;;
esac
if [ -n "$update_dir" ] && [ -f "$update_dir/install.sh" ]; then
  # Written only when NODE_EXTRA_CA_CERTS is set: curl's own roots plus that
  # certificate, so install.sh's curl trusts what Plannotator's fetch did.
  if [ -f "$update_dir/curl-ca-bundle.pem" ]; then
    export CURL_CA_BUNDLE="$update_dir/curl-ca-bundle.pem"
  fi
  PLANNOTATOR_EXPECTED_SHA256=$(cat "$update_dir/expected-sha256" 2>/dev/null) PLANNOTATOR_UPDATE_MISMATCH_FILE="$update_dir/checksum-mismatch" bash "$update_dir/install.sh" --version "$PLANNOTATOR_UPDATE_VERSION" --non-interactive "$@" </dev/null
  code=$?
  # A mismatch is only what install.sh's pin check marked as one.
  if [ -f "$update_dir/checksum-mismatch" ]; then
    code=113
  elif [ "$code" -eq 113 ]; then
    code=1
  fi
else
  code=75
  # update-prepare already said why (download, certificate, temp folder).
  echo "update: nothing ran; nothing was changed"
fi
cleanup
# The log line first: a reader that sees the new result also finds this run's
# part of update.log (deriveAutoUpdateNotice tells "prepare" from "download" there).
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] update: install.sh exited $code"
record "$code"
release_lock
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
# The lock is removed at the end only while it is still this run's: a line
# naming this process (launchInstaller writes it), or what it held when this
# run started. Never a lock another install took.
$ownLock = [string](Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $env:PLANNOTATOR_UPDATE_LOCK)
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
  $lockNow = [string](Get-Content -Raw -ErrorAction SilentlyContinue -LiteralPath $env:PLANNOTATOR_UPDATE_LOCK)
  if ($lockNow.StartsWith("pid=$PID ") -or ($ownLock -ne '' -and $lockNow -ceq $ownLock)) {
    Remove-Item -Force -ErrorAction SilentlyContinue -LiteralPath $env:PLANNOTATOR_UPDATE_LOCK
  }
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

/**
 * How the POSIX wrapper reaches `update-prepare`: the compiled binary is its
 * own entry; a source run (`bun …/index.ts`, the process tests' entries)
 * passes its script as the first argument.
 */
export function updatePrepareInvocation(main: string = typeof Bun !== "undefined" ? Bun.main : process.argv[1] ?? ""): {
  binary: string;
  entry: string;
} {
  const normalized = main.replace(/\\/g, "/");
  const compiled = normalized.startsWith("/$bunfs/") || /^\/?[A-Za-z]:\/(?:\$bunfs|~BUN)\//i.test(normalized);
  return { binary: process.execPath, entry: compiled ? "" : main };
}

function installerEnv(launch: InstallerLaunch): { file: string; args: string[]; env: NodeJS.ProcessEnv } {
  const { file, args, env: commandEnv } = installerCommand(launch.platform, launch.flags);
  const prepare = launch.prepare ?? updatePrepareInvocation();
  return {
    file,
    args,
    env: {
      ...process.env,
      PLANNOTATOR_UPDATE_VERSION: launch.version,
      PLANNOTATOR_UPDATE_RESULT: launch.resultPath,
      PLANNOTATOR_UPDATE_LOCK: launch.lockPath,
      // Windows only: its wrapper still downloads install.ps1 itself (Windows
      // blocks the leaked eMudhra keys in its own certificate store).
      PLANNOTATOR_UPDATE_SCRIPT_URL: installScriptUrl(launch.platform),
      // POSIX: the binary that runs `update-prepare` (this one).
      PLANNOTATOR_UPDATE_BINARY: prepare.binary,
      PLANNOTATOR_UPDATE_ENTRY: prepare.entry,
      // A stalled skills clone gives up after a minute instead of holding the
      // lock (a live install holds it past the hour; the person's own values win).
      GIT_HTTP_LOW_SPEED_LIMIT: process.env.GIT_HTTP_LOW_SPEED_LIMIT || "1",
      GIT_HTTP_LOW_SPEED_TIME: process.env.GIT_HTTP_LOW_SPEED_TIME || "60",
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
    // A spawn that fails after returning (no pid): Failed with Try again at once.
    child.on("error", (err) => {
      if (child.pid === undefined) abortLaunch(launch.version, err, join(launch.logPath, ".."));
    });
    if (child.pid !== undefined) {
      // Name the wrapper in the lock from the first moment (its group on
      // POSIX, its pid on Windows), so an install killed at any point is
      // judged gone at once (reapDeadUpdateLock) instead of after the hour.
      const m = thisLockMachine();
      try {
        writeFileSync(launch.lockPath, `pid=${child.pid} group=${child.pid} host=${m.host} boot=${m.boot} pidns=${m.pidns}\n`);
      } catch {}
    }
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
  ctx: { port: number | null | undefined; exposed: boolean; serverSession: string; localHostname?: string | null },
): Promise<Response> | null {
  if (url.pathname !== "/api/update") return null;
  return (async () => {
    if (req.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
    if (!isLoopbackHostHeader(req.headers.get("host"), ctx.port, ctx.localHostname)) {
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
