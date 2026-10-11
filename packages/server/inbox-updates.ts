/**
 * The Inbox's update control (design: .product/approved/plannotator-updates/,
 * §4.2-4.4 and the owner's answers): one sidebar button whose state the
 * server works out from what is on this machine.
 *
 *   available   a newer stable release exists (the shared daily check) and
 *               nothing newer is installed yet; not snoozed for that version.
 *   updating    the install script runs (update.lock is held): the person
 *               pressed Update now, ran `plannotator update`, or auto-update
 *               started it.
 *   ready       the binary on disk is another version than this Inbox runs
 *               (the existing restart-to-update signal).
 *   failed      an install the PERSON started exited non-zero
 *               (update-result.json); a background failure stays out of the
 *               sidebar.
 *
 * The Inbox is long-lived and one per machine, so it also runs the daily
 * release check (never awaited by a request, never in a dev run, never while
 * PLANNOTATOR_UPDATE_CHECK is off). It re-reads the cache on its health tick,
 * so a check another process made reaches it without a second request.
 */

import { spawn } from "node:child_process";
import type { InboxUpdate } from "@plannotator/core/inbox-types";
import { statSync } from "node:fs";
import { loadConfig, parseAutoUpdateEnv, parseUpdateCheckEnv, resolveAutoUpdate, resolveUpdateCheck } from "@plannotator/shared/config";
import {
  CLAUDE_PLUGIN_UPDATE_COMMANDS,
  compareStableVersions,
  installCommandFor,
  installerFlagArgs,
  isNewerStableVersion,
  knownLatestRelease,
  normalizeStableVersion,
  patchUpdateState,
  readInstallFlags,
  readReleaseNotes,
  readUpdateState,
  releaseSummary,
  releaseUrlFor,
  runReleaseCheck,
  UPDATE_SNOOZE_MS,
  type FetchReleaseResult,
  type ReleaseHighlight,
} from "@plannotator/shared/update-check";
import {
  autoUpdatePaths,
  isManagedBinary,
  isUpdateLockHeld,
  launchInstaller as defaultLaunchInstaller,
  readAutoUpdateResult,
  startManualUpdate,
  type InstallerLaunch,
  type ManualUpdateOutcome,
} from "./auto-update";
import { listSessions as defaultListSessions, type SessionInfo } from "./sessions";

/** While an install runs, the binary is probed this often (the design's 2 s). */
export const INBOX_UPDATING_TICK_MS = 2_000;

export type { InboxUpdate };
export type InboxUpdateState = InboxUpdate["state"];

/** What the update dialog, the failure dialog and Settings → About read (GET /api/inbox/update). */
export interface InboxUpdateDetails {
  update: InboxUpdate | null;
  current: string;
  /** This Inbox started on a newer version than the one before it: the "What's new in X" link. */
  updated: string | null;
  latest: { version: string; fetched_at: string; published_at: string | null } | null;
  check: { on: boolean; env: boolean | null; last_attempt_at: string | null; error: string | null };
  auto_update: { on: boolean; env: boolean | null; supported: boolean };
  /** The first paragraph of the release notes. */
  summary: string;
  /** The remembered install flags as the installer spells them (`--skip-gemini`). */
  flags: string[];
  /** The install command a person runs by hand, with those flags. */
  command: string;
  /** The Claude Code plugin is the person's to update (`--skip-claude-plugin` was remembered). */
  plugin_command: string | null;
  /** Open Plannotator sessions, which keep their old binary. */
  sessions: { mode: SessionInfo["mode"]; project: string; label: string; started_at: string }[];
  failure: { exit_code: number; log: string } | null;
  log: string;
  snoozed_until: string | null;
}

export interface WhatsNew {
  version: string;
  current: string;
  published_at: string | null;
  release_url: string;
  notes: string;
  /** One-line highlights of the releases between the running version and this one, newest first. */
  skipped: ReleaseHighlight[];
}

export interface InboxUpdatesOptions {
  dataDir: string;
  /** The running binary's version; `dev` or anything not X.Y.Z turns the whole control off. */
  version: string;
  /** The binary to probe for "ready"; null: no probe. */
  binaryPath: string | null;
  healthTickMs: number;
  now?: () => number;
  fetchRelease?: () => Promise<FetchReleaseResult>;
  launchInstaller?: (launch: InstallerLaunch) => void;
  isManaged?: () => boolean;
  listSessions?: () => SessionInfo[];
  probeVersion?: (binaryPath: string) => Promise<string | null>;
  /** The button's model changed. */
  onChange: () => void;
}

/** The installed binary's version (`plannotator X` on stdout), or null. */
export async function probeBinaryVersion(binaryPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryPath, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null);
    }, 5000);
    child.stdout?.on("data", (chunk) => (out += chunk));
    child.on("error", () => finish(null));
    child.on("close", (code) => {
      const match = /^plannotator\s+(\S+)/.exec(out.trim());
      finish(code === 0 && match ? match[1]! : null);
    });
  });
}

/**
 * The button's state from the facts on this machine. Pure, for the tests.
 * `onDisk` is the probed version of the installed binary (null: unknown or
 * the same file).
 */
export function deriveInboxUpdate(input: {
  current: string;
  onDisk: string | null;
  checksOn: boolean;
  managed: boolean;
  lockHeld: boolean;
  state: ReturnType<typeof readUpdateState>;
  result: { version: string; exitCode: number } | null;
  now: number;
}): InboxUpdate | null {
  const current = normalizeStableVersion(input.current);
  if (!current) return null;
  const latest = knownLatestRelease(input.state);
  const base = (version: string, state: InboxUpdateState): InboxUpdate => ({
    available: true,
    state,
    version,
    current,
    action: input.managed ? "script" : "copy",
    releaseUrl: releaseUrlFor(version),
    ...(latest?.version === version && latest.publishedAt ? { publishedAt: latest.publishedAt } : {}),
  });
  // Ready: today's signal, a different binary on disk than this process runs.
  if (input.onDisk && input.onDisk !== input.current) {
    return base(normalizeStableVersion(input.onDisk) ?? input.onDisk, "ready");
  }
  const pending = input.state.pending;
  const pendingVersion = normalizeStableVersion(pending?.version);
  if (input.lockHeld) return base(pendingVersion ?? latest?.version ?? current, "updating");
  if (
    pending?.by === "person" &&
    pendingVersion &&
    isNewerStableVersion(pendingVersion, current) &&
    input.result &&
    normalizeStableVersion(input.result.version) === pendingVersion &&
    input.result.exitCode !== 0
  ) {
    return base(pendingVersion, "failed");
  }
  if (!input.checksOn || !latest || !isNewerStableVersion(latest.version, current)) return null;
  const snooze = input.state.snooze;
  if (snooze && normalizeStableVersion(snooze.version) === latest.version && snooze.until > input.now) return null;
  return base(latest.version, "available");
}

export function createInboxUpdates(options: InboxUpdatesOptions) {
  const now = options.now ?? Date.now;
  const release = normalizeStableVersion(options.version) !== null;
  const isManaged = options.isManaged ?? (() => (options.binaryPath ? isManagedBinary(options.binaryPath) : false));
  const listSessions = options.listSessions ?? defaultListSessions;
  const probe = options.probeVersion ?? probeBinaryVersion;
  let onDisk: string | null = null;
  let probedSignature: string | null = null;
  let model: InboxUpdate | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let fastTimer: ReturnType<typeof setTimeout> | null = null;
  let ticking = false;
  let stopped = false;

  // "Just updated": this Inbox runs a newer version than the one that ran
  // before it. Shown as a quiet link for the life of this process.
  let updated: string | null = null;
  // No Inbox ran on this machine before this one (a release build): a fresh
  // install, which the one-time sound dialog skips (inbox.ts).
  let firstRun = false;
  if (release) {
    try {
      const before = readUpdateState(options.dataDir).inboxVersion;
      firstRun = !before;
      if (before && compareStableVersions(options.version, before) === 1) updated = normalizeStableVersion(options.version);
      if (before !== options.version) patchUpdateState((s) => ({ ...s, inboxVersion: options.version }), options.dataDir);
    } catch {}
  }

  const checksOn = () => {
    try {
      return resolveUpdateCheck(loadConfig());
    } catch {
      return true;
    }
  };

  const compute = (): InboxUpdate | null => {
    if (!release) {
      // A source run keeps only the old signal: a different binary on disk.
      return onDisk && onDisk !== options.version
        ? { available: true, state: "ready", version: onDisk, current: options.version, action: "copy", releaseUrl: releaseUrlFor(onDisk) }
        : null;
    }
    return deriveInboxUpdate({
      current: options.version,
      onDisk,
      checksOn: checksOn(),
      managed: isManaged(),
      lockHeld: isUpdateLockHeld(options.dataDir),
      state: readUpdateState(options.dataDir),
      result: readAutoUpdateResult(options.dataDir),
      now: now(),
    });
  };

  const refresh = () => {
    const next = compute();
    if (JSON.stringify(next) !== JSON.stringify(model)) {
      model = next;
      options.onChange();
    }
    // While an install runs, look at the binary every 2 s.
    if (!stopped && next?.state === "updating" && !fastTimer) {
      fastTimer = setTimeout(() => {
        fastTimer = null;
        void tick();
      }, INBOX_UPDATING_TICK_MS);
      (fastTimer as { unref?: () => void }).unref?.();
    }
  };

  const probeBinary = async () => {
    if (!options.binaryPath) return;
    let signature: string;
    try {
      const stat = statSync(options.binaryPath);
      signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    } catch {
      return;
    }
    // Running the compiled binary costs ~0.2 s of CPU and a ~440 MB peak RSS,
    // so it runs only when the file on disk changed since the last probe.
    if (signature === probedSignature) return;
    probedSignature = signature;
    const version = await probe(options.binaryPath);
    if (version === null) probedSignature = null;
    onDisk = version;
  };

  const tick = async () => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await probeBinary();
      if (release) {
        // The daily check: answers from the cache within its window, so this
        // asks GitHub at most once a day (6 h after a failure).
        await runReleaseCheck({
          dataDir: options.dataDir,
          now,
          enabled: checksOn,
          ...(options.fetchRelease && { fetchRelease: options.fetchRelease }),
        });
      }
      refresh();
    } catch {
      // A tick never throws.
    } finally {
      ticking = false;
    }
  };

  const details = (): InboxUpdateDetails => {
    const config = loadConfig();
    const state = readUpdateState(options.dataDir);
    const latest = knownLatestRelease(state);
    const flags = readInstallFlags(options.dataDir).flags;
    const notes = latest ? readReleaseNotes(latest.version, options.dataDir) : null;
    const result = readAutoUpdateResult(options.dataDir);
    const paths = autoUpdatePaths(options.dataDir);
    const current = model ?? compute();
    let sessions: SessionInfo[] = [];
    try {
      sessions = listSessions();
    } catch {}
    const snooze = state.snooze;
    return {
      update: current,
      current: options.version,
      updated,
      latest: latest
        ? { version: latest.version, fetched_at: new Date(latest.fetchedAt).toISOString(), published_at: latest.publishedAt ?? null }
        : null,
      check: {
        on: resolveUpdateCheck(config),
        env: parseUpdateCheckEnv() ?? null,
        last_attempt_at: state.releaseCheck?.attemptedAt ? new Date(state.releaseCheck.attemptedAt).toISOString() : null,
        error: state.releaseCheck?.failedAt ? state.releaseCheck.error ?? "the check failed" : null,
      },
      auto_update: { on: resolveAutoUpdate(config), env: parseAutoUpdateEnv() ?? null, supported: release && isManaged() },
      summary: notes ? releaseSummary(notes.notes) : "",
      flags: installerFlagArgs(flags, process.platform),
      command: installCommandFor(process.platform, flags),
      plugin_command: flags.includes("skip-claude-plugin") ? CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ") : null,
      sessions: sessions.map((s) => ({ mode: s.mode, project: s.project, label: s.label, started_at: s.startedAt })),
      failure: current?.state === "failed" && result ? { exit_code: result.exitCode, log: paths.log } : null,
      log: paths.log,
      snoozed_until: snooze && snooze.until > now() ? new Date(snooze.until).toISOString() : null,
    };
  };

  return {
    /** The button's model (null: nothing to show). */
    current: () => model,
    updated: () => updated,
    /** No Inbox had run on this machine before this one (release builds only). */
    firstRun: () => firstRun,
    /** Work the state out again now (a setting changed). */
    refresh,
    details,
    start() {
      if (!release && !options.binaryPath) return;
      model = compute();
      void tick();
      tickTimer = setInterval(() => void tick(), options.healthTickMs);
    },
    stop() {
      stopped = true;
      if (tickTimer) clearInterval(tickTimer);
      if (fastTimer) clearTimeout(fastTimer);
    },
    /** Update now: the install script for the newest release, once (update.lock). */
    updateNow(): ManualUpdateOutcome {
      const outcome = startManualUpdate({
        currentVersion: release ? options.version : undefined,
        dataDir: options.dataDir,
        now,
        platform: process.platform,
        isManaged,
        launchInstaller: options.launchInstaller ?? defaultLaunchInstaller,
      });
      refresh();
      return outcome;
    },
    /** Remind me tomorrow: hide the button for this version for 24 h, for every tab. */
    snooze(): boolean {
      const version = model?.state === "available" ? model.version : null;
      if (!version) return false;
      patchUpdateState((s) => ({ ...s, snooze: { version, until: now() + UPDATE_SNOOZE_MS } }), options.dataDir);
      refresh();
      return true;
    },
    /** Check now: an explicit request, allowed even with automatic checks off. */
    async checkNow(): Promise<{ ok: boolean; error?: string }> {
      if (!release) return { ok: false, error: "This is a development build; there is no release to compare with." };
      const outcome = await runReleaseCheck({
        dataDir: options.dataDir,
        now,
        enabled: () => true,
        force: true,
        ...(options.fetchRelease && { fetchRelease: options.fetchRelease }),
      });
      refresh();
      return outcome.outcome === "failed" ? { ok: false, error: outcome.error } : { ok: true };
    },
    whatsNew(version: string): WhatsNew | null {
      const v = normalizeStableVersion(version);
      if (!v) return null;
      const notes = readReleaseNotes(v, options.dataDir);
      if (!notes) return null;
      const from = normalizeStableVersion(options.version);
      return {
        version: v,
        current: options.version,
        published_at: notes.publishedAt ?? null,
        release_url: releaseUrlFor(v),
        notes: notes.notes,
        // The releases a person skipped: newer than the one they run, older than this one.
        skipped: from
          ? notes.highlights.filter((h) => isNewerStableVersion(h.version, from) && isNewerStableVersion(v, h.version))
          : [],
      };
    },
  };
}

export type InboxUpdates = ReturnType<typeof createInboxUpdates>;
