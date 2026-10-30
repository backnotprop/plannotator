/**
 * The Inbox's update control (design: .product/approved/plannotator-updates/,
 * §4.2-4.4 and the owner's answers): one sidebar button whose state the
 * server works out from what is on this machine.
 *
 *   available   a newer stable release exists (the shared release check) and
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
 * The Inbox is long-lived and one per machine, so it also runs the release
 * check (never awaited by a request, never in a dev run, never while
 * PLANNOTATOR_UPDATE_CHECK is off): at start and on a page load when the
 * answer is over a minute old, and on its health tick when it is over 10
 * minutes old. It re-reads the cache on that tick, so a check another process
 * made reaches it without a second request.
 */

import { spawn } from "node:child_process";
import type { InboxUpdate } from "@plannotator/core/inbox-types";
import { statSync } from "node:fs";
import { loadConfig, parseAutoUpdateEnv, parseUpdateCheckEnv, resolveAutoUpdate, resolveUpdateCheck } from "@plannotator/shared/config";
import {
  CLAUDE_PLUGIN_UPDATE_COMMANDS,
  compareStableVersions,
  fetchReleaseNotesFor,
  hasReleaseNotesContent,
  installCommandFor,
  installerFlagArgs,
  isNewerStableVersion,
  isNotesFetchDue,
  isSnoozed,
  knownLatestRelease,
  normalizeStableVersion,
  patchUpdateState,
  plainCheckError,
  readInstallFlags,
  readReleaseNotes,
  readUpdateState,
  releaseCheckFailing,
  releaseSummary,
  RELEASE_CHECK_ON_START_MS,
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
  reapDeadUpdateLock,
  startManualUpdate,
  type InstallerLaunch,
  type ManualUpdateOutcome,
  UPDATE_PREPARE_FAILED,
} from "./auto-update";
import { listSessions as defaultListSessions, type SessionInfo } from "./sessions";
import { lastRunLog, stagingFailureIn, tlsFailureIn, type UpdateTlsFailure } from "./update-log";
import { fetchReleaseImagesFor, storedReleaseImageSources } from "./inbox-whats-new-images";

/** While an install runs, the binary is probed this often (the design's 2 s). */
export const INBOX_UPDATING_TICK_MS = 2_000;

/** The failure dialog's facts; a failed download also says whether it failed at TLS (update.log). */
export function failureDetails(
  exitCode: number,
  log: string,
  platform: NodeJS.Platform = process.platform,
): NonNullable<InboxUpdateDetails["failure"]> {
  const run = exitCode === UPDATE_PREPARE_FAILED ? lastRunLog(log) : "";
  const prepare = stagingFailureIn(run);
  if (prepare) return { exit_code: exitCode, log, prepare };
  const tls = tlsFailureIn(run);
  return { exit_code: exitCode, log, ...(tls && { tls }), ...(tls === "untrusted" && platform === "darwin" && { release_first: true as const }) };
}

export type { InboxUpdate };
export type InboxUpdateState = InboxUpdate["state"];

/** What the update dialog, the failure dialog and Settings → About read (GET /api/inbox/update). */
export interface InboxUpdateDetails {
  update: InboxUpdate | null;
  current: string;
  /**
   * This Inbox started on a newer version than the one before it: the "What's
   * new in X" link. Null while its notes are neither saved nor fetchable.
   */
  updated: string | null;
  latest: { version: string; fetched_at: string; published_at: string | null } | null;
  check: {
    on: boolean;
    env: boolean | null;
    last_attempt_at: string | null;
    error: string | null;
    /**
     * Checking has failed for hours (RELEASE_CHECK_FAILING_AFTER_MS) with no
     * success: since when and why. Settings → About says so with `command`.
     * Additive; null otherwise.
     */
    failing: { since: string; error: string } | null;
    /** When the latest attempt failed (null: it did not, or none was made). Additive. */
    last_failed_at: string | null;
  };
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
  /**
   * `tls` (additive, exit 75 only): the download failed at TLS, as
   * update-prepare reported in update.log. `untrusted`: point
   * NODE_EXTRA_CA_CERTS at the network's root. `revoked`: a blocked key, so
   * never the install command over this network. `release_first` (additive,
   * `untrusted` on macOS only): the release page comes before the install
   * command, since macOS curl still trusts emSign G3. `prepare` (additive,
   * exit 75 only): the update was downloaded but the temp folder could not
   * hold it; the plain reason ("the temp folder /tmp is full (ENOSPC)").
   */
  failure: { exit_code: number; log: string; tls?: UpdateTlsFailure; release_first?: true; prepare?: string } | null;
  log: string;
  snoozed_until: string | null;
}

export interface WhatsNew {
  version: string;
  current: string;
  published_at: string | null;
  release_url: string;
  notes: string;
  /**
   * The version `skipped` counts from: the one this Inbox runs, or, for a
   * release it already runs, the one it ran before the update. Null for a
   * development build. Added after `current`, which stays the running version.
   */
  since: string | null;
  /** One-line highlights of the releases between `since` and this one, newest first. */
  skipped: ReleaseHighlight[];
  /**
   * The image sources (as the notes write them) saved on this computer, which
   * the page loads from /api/inbox/whats-new/image. Any other image in the
   * notes is drawn as its alt text, never fetched. Additive.
   */
  images: string[];
}

export interface InboxUpdatesOptions {
  dataDir: string;
  /** The running binary's version; `dev` or anything not X.Y.Z turns the whole control off. */
  version: string;
  /** The binary to probe for "ready"; null: no probe. */
  binaryPath: string | null;
  healthTickMs: number;
  now?: () => number;
  /** The release check's primary source (the "latest release" redirect). Default: GitHub's. */
  fetchReleasePage?: () => Promise<FetchReleaseResult>;
  /** The release check's fallback, the API. */
  fetchRelease?: () => Promise<FetchReleaseResult>;
  /** One release by its tag, for notes a version needs and the release check never saved. */
  fetchReleaseTag?: (version: string) => Promise<FetchReleaseResult>;
  /** How long the What's new route waits for those notes (WHATS_NEW_WAIT_MS). */
  whatsNewWaitMs?: number;
  /** The fetch the release notes' images go through (inbox-whats-new-images.ts). Default: global fetch. */
  fetchImage?: typeof fetch;
  launchInstaller?: (launch: InstallerLaunch) => void;
  isManaged?: () => boolean;
  listSessions?: () => SessionInfo[];
  probeVersion?: (binaryPath: string) => Promise<string | null>;
  /** The button's model changed. */
  onChange: () => void;
}

/** How long GET /api/inbox/whats-new waits for a release's notes before answering "still fetching". */
export const WHATS_NEW_WAIT_MS = 3_000;

/** What the What's new route answers: the notes, still fetching, or nothing for that version. */
export type WhatsNewAnswer = { kind: "notes"; notes: WhatsNew } | { kind: "loading" } | { kind: "missing" };

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
  if (isSnoozed(input.state, latest.version, input.now)) return null;
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
  // before it, or a later start on that version whose link was not yet
  // offered with readable notes (whatsNewPending). Shown as a quiet link for
  // the life of this process, while its notes are saved or can be fetched
  // (computeUpdatedLink).
  let updated: string | null = null;
  // The version the Inbox ran before this one (inboxPreviousVersion), kept
  // across restarts until the next update: What's new counts the releases a
  // person skipped from it, not from the version they now run.
  let previous: string | null = null;
  if (release) {
    try {
      const state = readUpdateState(options.dataDir);
      const before = state.inboxVersion;
      const newer = !!before && compareStableVersions(options.version, before) === 1;
      if (newer || (before === options.version && state.whatsNewPending === options.version)) updated = normalizeStableVersion(options.version);
      if (before !== options.version) {
        patchUpdateState((s) => {
          const next: typeof s = { ...s, inboxVersion: options.version };
          if (newer) {
            next.inboxPreviousVersion = before;
            next.whatsNewPending = options.version;
          } else if (before) delete next.inboxPreviousVersion;
          return next;
        }, options.dataDir);
      }
      const kept = newer ? before : before === options.version ? state.inboxPreviousVersion : undefined;
      const keptVersion = normalizeStableVersion(kept);
      if (keptVersion && isNewerStableVersion(options.version, keptVersion)) previous = keptVersion;
    } catch {}
  }

  const checksOn = () => {
    try {
      return resolveUpdateCheck(loadConfig());
    } catch {
      return true;
    }
  };

  // One release's notes fetched by its tag, once per version at a time: a
  // version installed outside the Inbox (the install script run by hand)
  // before the release check saw it has none saved (fetchReleaseNotesFor).
  const notesInFlight = new Map<string, Promise<void>>();

  /**
   * The versions whose notes this Inbox may fetch: the one it runs, the
   * newest known release, the binary on disk, an install in progress. A
   * request for any other version reads only what is saved.
   */
  const fetchableVersion = (version: string): boolean => {
    if (!release) return false;
    const state = readUpdateState(options.dataDir);
    const known = [options.version, knownLatestRelease(state)?.version, onDisk, state.pending?.version];
    return known.some((v) => normalizeStableVersion(v) === version);
  };

  const ensureNotes = (version: string): Promise<void> => {
    const running = notesInFlight.get(version);
    if (running) return running;
    if (!fetchableVersion(version)) return Promise.resolve();
    const job = fetchReleaseNotesFor({
      version,
      dataDir: options.dataDir,
      now,
      enabled: checksOn,
      ...(options.fetchReleaseTag && { fetchRelease: options.fetchReleaseTag }),
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        notesInFlight.delete(version);
        if (!stopped) refresh();
      });
    notesInFlight.set(version, job);
    return job;
  };

  // The images a release's saved notes show, copied beside them once per
  // version at a time (inbox-whats-new-images.ts: GitHub's hosts only, the
  // release check's claim and back-off, never while update checks are off).
  const imagesInFlight = new Map<string, Promise<void>>();
  const ensureImages = (version: string): Promise<void> => {
    const running = imagesInFlight.get(version);
    if (running) return running;
    if (!fetchableVersion(version)) return Promise.resolve();
    const job = fetchReleaseImagesFor({
      version,
      dataDir: options.dataDir,
      now,
      enabled: checksOn,
      ...(options.fetchImage && { fetchImpl: options.fetchImage }),
    })
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => imagesInFlight.delete(version));
    imagesInFlight.set(version, job);
    return job;
  };

  // Set once this run offered the link with readable notes (whatsNewPending is then removed).
  let whatsNewOffered = false;
  /** The link shows while the notes are saved, being fetched, or can be fetched now. */
  const computeUpdatedLink = (): string | null => {
    if (!updated) return null;
    try {
      if (hasReleaseNotesContent(readReleaseNotes(updated, options.dataDir))) {
        // Offered with readable notes: a later start on this version no longer shows it.
        if (!whatsNewOffered) {
          whatsNewOffered = true;
          try {
            if (readUpdateState(options.dataDir).whatsNewPending === options.version) {
              patchUpdateState((s) => {
                const next = { ...s };
                delete next.whatsNewPending;
                return next;
              }, options.dataDir);
            }
          } catch {}
        }
        return updated;
      }
      if (!checksOn()) return null;
      if (notesInFlight.has(updated)) return updated;
      return isNotesFetchDue(readUpdateState(options.dataDir), updated, now()) ? updated : null;
    } catch {
      return null;
    }
  };
  let updatedLink: string | null = null;

  /**
   * Checking has failed for hours with no success (update-state.json, or this
   * process's memory of it when the file cannot be written): the sidebar's
   * quiet "Can't check for updates" and Settings → General and About. Null in
   * a development build and while update checks are off.
   */
  const failing = (): { since: number; error: string } | null => {
    if (!release || !checksOn()) return null;
    try {
      return releaseCheckFailing(readUpdateState(options.dataDir), now());
    } catch {
      return null;
    }
  };
  let failingModel: string | null = null;
  const failingWire = () => {
    const f = failing();
    return f ? { since: new Date(f.since).toISOString(), error: f.error } : null;
  };

  const compute = (): InboxUpdate | null => {
    if (release) {
      // A wrapper killed outright (or a restart mid-install) left update.lock:
      // record it as failed and release it, so "Updating…" never spins on.
      try {
        reapDeadUpdateLock(options.dataDir);
      } catch {}
    }
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
    const link = computeUpdatedLink();
    const failingNext = JSON.stringify(failingWire());
    if (JSON.stringify(next) !== JSON.stringify(model) || link !== updatedLink || failingNext !== failingModel) {
      model = next;
      updatedLink = link;
      failingModel = failingNext;
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

  const sources = {
    ...(options.fetchReleasePage && { fetchReleasePage: options.fetchReleasePage }),
    ...(options.fetchRelease && { fetchRelease: options.fetchRelease }),
  };

  /** `freshForMs`: how young an answer must be to skip asking (start and page loads: 1 min). */
  const tick = async (freshForMs?: number) => {
    if (ticking || stopped) return;
    ticking = true;
    try {
      await probeBinary();
      if (release) {
        // Answers from the cache within its window, so this asks at most once
        // every 10 minutes (once a minute for a start or a page load), and 10
        // minutes after a failure.
        await runReleaseCheck({
          dataDir: options.dataDir,
          now,
          enabled: checksOn,
          ...(freshForMs !== undefined && { freshForMs }),
          ...sources,
        });
        // The update dialog's summary: the notes of a newer release the
        // redirect named (it carries none), fetched once per version (throttled).
        const latest = knownLatestRelease(readUpdateState(options.dataDir))?.version;
        if (latest && isNewerStableVersion(latest, options.version) && !hasReleaseNotesContent(readReleaseNotes(latest, options.dataDir))) {
          void ensureNotes(latest);
        }
        // The "What's new" link's notes, when this run started on a newer
        // version and they are still missing (throttled per version).
        if (updated && !hasReleaseNotesContent(readReleaseNotes(updated, options.dataDir))) await ensureNotes(updated);
        // Their images, off the tick (a release's images can take a while).
        // A no-op once stored, and throttled per version when not.
        for (const version of new Set([knownLatestRelease(readUpdateState(options.dataDir))?.version, updated])) {
          if (version && hasReleaseNotesContent(readReleaseNotes(version, options.dataDir))) void ensureImages(version);
        }
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
      // An in-process server (OpenCode) keeps no binary open: not "running on" this version.
      sessions = listSessions().filter((s) => !s.host);
    } catch {}
    const snooze = state.snooze;
    const failingNow = failing();
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
        error: state.releaseCheck?.failedAt ? plainCheckError(state.releaseCheck.error ?? "the check failed") : null,
        failing: failingNow ? { since: new Date(failingNow.since).toISOString(), error: failingNow.error } : null,
        // The latest attempt failed (its time), for "Last check failed <time>". Additive.
        last_failed_at:
          typeof state.releaseCheck?.failedAt === "number" && state.releaseCheck.failedAt >= state.releaseCheck.attemptedAt
            ? new Date(state.releaseCheck.failedAt).toISOString()
            : null,
      },
      auto_update: { on: resolveAutoUpdate(config), env: parseAutoUpdateEnv() ?? null, supported: release && isManaged() },
      summary: notes ? releaseSummary(notes.notes) : "",
      flags: installerFlagArgs(flags, process.platform),
      command: installCommandFor(process.platform, flags),
      plugin_command: flags.includes("skip-claude-plugin") ? CLAUDE_PLUGIN_UPDATE_COMMANDS.join(" && ") : null,
      sessions: sessions.map((s) => ({ mode: s.mode, project: s.project, label: s.label, started_at: s.startedAt })),
      failure: current?.state === "failed" && result ? failureDetails(result.exitCode, paths.log) : null,
      log: paths.log,
      snoozed_until: snooze && isSnoozed(state, snooze.version, now()) ? new Date(snooze.until).toISOString() : null,
    };
  };

  return {
    /** The button's model (null: nothing to show). */
    current: () => model,
    /** The "What's new in X" link (null: none, or its notes are neither saved nor fetchable). */
    updated: () => updatedLink,
    /** Checking has failed for hours (null: it has not, or checks are off): the sidebar's quiet row. */
    checkFailing: failingWire,
    /** Work the state out again now (a setting changed). */
    refresh,
    details,
    start() {
      if (!release && !options.binaryPath) return;
      model = compute();
      updatedLink = computeUpdatedLink();
      failingModel = JSON.stringify(failingWire());
      // Every start asks (unless someone asked in the last minute): a restart
      // never waits out an old answer.
      void tick(RELEASE_CHECK_ON_START_MS);
      tickTimer = setInterval(() => void tick(), options.healthTickMs);
    },
    /**
     * A page load: ask when the answer is over a minute old. Fire-and-forget;
     * the button follows through the event stream when the answer changes.
     */
    nudge() {
      if (stopped || !release) return;
      void tick(RELEASE_CHECK_ON_START_MS);
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
        ...sources,
      });
      refresh();
      // In plain words, from both sources' answers as stored ("release page didn't answer as expected; GitHub API rate-limited").
      if (outcome.outcome !== "failed") return { ok: true };
      return { ok: false, error: plainCheckError(readUpdateState(options.dataDir).releaseCheck?.error ?? outcome.error) };
    },
    /**
     * The What's new page's notes. Notes that are missing, or saved without a
     * "What's New" part, are fetched by the release's tag first (once per
     * version, throttled, never while update checks are off), waiting at most
     * `waitMs`; past that the answer is `loading` and the page asks again.
     */
    async whatsNew(version: string, waitMs: number = options.whatsNewWaitMs ?? WHATS_NEW_WAIT_MS): Promise<WhatsNewAnswer> {
      const v = normalizeStableVersion(version);
      if (!v) return { kind: "missing" };
      const deadline = Date.now() + waitMs;
      const waitFor = async (job: Promise<void>) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([job, new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, deadline - Date.now()))))]);
        clearTimeout(timer);
      };
      if (!hasReleaseNotesContent(readReleaseNotes(v, options.dataDir))) await waitFor(ensureNotes(v));
      // The notes' images, within the same wait; past it the page shows what is stored.
      if (hasReleaseNotesContent(readReleaseNotes(v, options.dataDir))) await waitFor(ensureImages(v));
      const notes = readReleaseNotes(v, options.dataDir);
      if (!hasReleaseNotesContent(notes) && notesInFlight.has(v)) return { kind: "loading" };
      if (!notes) return { kind: "missing" };
      // The releases in between count from the version this Inbox ran before
      // an update when the page shows a release it already runs (or an older
      // one); for a newer release, from the version it runs now.
      const running = normalizeStableVersion(options.version);
      const from = previous && running && !isNewerStableVersion(v, running) ? previous : running;
      return {
        kind: "notes",
        notes: {
          version: v,
          current: options.version,
          since: from,
          published_at: notes.publishedAt ?? null,
          release_url: releaseUrlFor(v),
          notes: notes.notes,
          // The releases a person skipped: newer than `since`, older than this one.
          skipped: from
            ? notes.highlights.filter((h) => isNewerStableVersion(h.version, from) && isNewerStableVersion(v, h.version))
            : [],
          images: storedReleaseImageSources(v, notes.notes, options.dataDir),
        },
      };
    },
  };
}

export type InboxUpdates = ReturnType<typeof createInboxUpdates>;
