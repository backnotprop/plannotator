/**
 * The one "is there a newer Plannotator?" check, shared by everything that
 * shows an update notice (the Inbox, the plan / annotate / review servers of
 * the compiled CLI and of Pi, `plannotator update`, the terminal hint) and by
 * background auto-update (packages/server/auto-update.ts).
 *
 * The source is GitHub's "latest release" page redirect
 * (`HEAD github.com/<repo>/releases/latest` → `…/releases/tag/vX.Y.Z`): not
 * under the API's 60 requests per hour per IP, right the moment a release is
 * published, no body. The machine asks at most once every 10 minutes per data
 * dir (an Inbox start or page load: once a minute), and 10 minutes after a
 * failure. When the page fails, the API (`releases/latest`) is the fallback,
 * asked at most once an hour; its rate limit (403/429) holds back only the
 * API, never the page.
 * The answer is cached in `update-state.json` beside auto-update's own state,
 * and the release notes in `update-notes/<version>.json`, so a check made by
 * one process reaches every other one without a second request.
 *
 * Nothing here throws to a caller: a failure is a line in `update.log`. The
 * scheduled check is never awaited on a session's hot path.
 *
 * Off switch: PLANNOTATOR_UPDATE_CHECK=0 or `{ "updateCheck": false }`
 * (resolveUpdateCheck in config.ts). Off means no automatic request at all;
 * an explicit action (`plannotator update`, the Inbox's Check now) still asks.
 *
 * Node-only (node:fs + global fetch), vendored to Pi.
 */

import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPlannotatorDataDir } from "./data-dir";

/** How long a cached answer counts as fresh: one request every 10 minutes at most per data dir. */
export const RELEASE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** After a failed check (or one still in flight): try again no sooner than this, never in a loop. */
export const RELEASE_CHECK_RETRY_MS = 10 * 60 * 1000;
/** An Inbox start or page load asks unless an answer (or an attempt) is younger than this. */
export const RELEASE_CHECK_ON_START_MS = 60 * 1000;
/** The API fallback (when the page fails): asked no more than once an hour. */
export const RELEASE_API_FALLBACK_INTERVAL_MS = 60 * 60 * 1000;
/**
 * After the API refused for its rate limit (403/429): no API request until the
 * time it names, kept between RELEASE_API_FALLBACK_INTERVAL_MS and this; this
 * when it names none. The page source is not held back by it.
 */
export const RELEASE_CHECK_RATE_LIMITED_RETRY_MS = 6 * 60 * 60 * 1000;
/**
 * After the release page itself refused (429, or 403 with a rate-limit
 * answer: an office NAT can meet github.com's limits too): wait the time it
 * names, kept between RELEASE_CHECK_RETRY_MS and this; this when it names none.
 */
export const RELEASE_PAGE_RATE_LIMITED_RETRY_MS = 60 * 60 * 1000;
/**
 * After the check has failed this long without one success (both sources
 * refused, offline, a proxy, a state file that cannot be written), the
 * surfaces say so plainly, with the install command that always works:
 * Settings → About and the sidebar in the Inbox, the Options menu of a review
 * window, the terminal hint. Shorter failures stay quiet (a laptop waking up,
 * a train, a brief outage).
 */
export const RELEASE_CHECK_FAILING_AFTER_MS = 3 * 60 * 60 * 1000;
/**
 * "Can't check" shows only while the latest failure is this recent: a check
 * retries 10 minutes after a failure (at most an hour after the page's rate
 * limit), so an older one means nothing has checked since (the machine
 * slept, checks were off). The run itself (`failingSince`) is kept across
 * such gaps until a check succeeds, each gap counting as at most this much
 * (`failingFor`): a machine that checks only every couple of hours (a review
 * window now and then, a laptop that sleeps a lot) still reaches
 * RELEASE_CHECK_FAILING_AFTER_MS within three failed checks, and one failure
 * right after a week asleep does not.
 */
export const RELEASE_CHECK_FAILURE_RECENT_MS = 90 * 60 * 1000;
/** update.log is moved to update.log.1 (one generation kept) once it passes this. */
export const UPDATE_LOG_MAX_BYTES = 1024 * 1024;
/** Each request gives up after this. */
const RELEASE_CHECK_TIMEOUT_MS = 8_000;
/**
 * One release's notes or images (by its tag): asked again no sooner than
 * this after an answer that carried nothing new (the release body is edited
 * after publishing), and no sooner than the retry after a failure. Kept apart
 * from the release check, which runs every 10 minutes.
 */
export const RELEASE_ASSETS_FETCH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RELEASE_ASSETS_FETCH_RETRY_MS = 6 * 60 * 60 * 1000;
/**
 * A release's notes answered with no "What's New" part while the release is
 * young (published under RELEASE_NOTES_YOUNG_MS ago): GitHub's generated
 * body, read in the minutes before the written notes replaced it. Asked again
 * after this instead of RELEASE_ASSETS_FETCH_INTERVAL_MS, so the "What's new"
 * link shows within the hour, not a day later.
 */
export const RELEASE_NOTES_PENDING_RETRY_MS = 15 * 60 * 1000;
export const RELEASE_NOTES_YOUNG_MS = 2 * 24 * 60 * 60 * 1000;
/** "Remind me tomorrow" in the Inbox. */
export const UPDATE_SNOOZE_MS = 24 * 60 * 60 * 1000;
/** The terminal hint shows at most this often. */
export const UPDATE_HINT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Release notes kept per version (the "What's New in" section onward). */
export const RELEASE_NOTES_MAX_BYTES = 64 * 1024;

const REPO = "backnotprop/plannotator";
export const DEFAULT_RELEASE_API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
/** GitHub's "latest release" link: answers 302 to `/releases/tag/vX.Y.Z`. The primary source. */
export const DEFAULT_RELEASE_PAGE_URL = `https://github.com/${REPO}/releases/latest`;
export const INSTALL_SH_URL = "https://plannotator.ai/install.sh";
export const INSTALL_PS1_URL = "https://plannotator.ai/install.ps1";
export const PI_UPDATE_COMMAND = "pi update --extensions";
export const CLAUDE_PLUGIN_UPDATE_COMMANDS = [
  "claude plugin marketplace update plannotator",
  "claude plugin update plannotator@plannotator",
] as const;

// ---------------------------------------------------------------------------
// Versions
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

export function releaseUrlFor(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version.replace(/^v/, "")}`;
}

// ---------------------------------------------------------------------------
// State (update-state.json, shared with auto-update)
// ---------------------------------------------------------------------------

/** One version's notes fetch (`notesFetch[<version>]`). */
export interface NotesFetchRecord {
  attemptedAt: number;
  failedAt?: number;
  error?: string;
  /**
   * The release's `published_at` (epoch ms), kept when its answer carried no
   * "What's New" part: while it is under RELEASE_NOTES_YOUNG_MS old, the next
   * try waits RELEASE_NOTES_PENDING_RETRY_MS instead of a day.
   */
  publishedAt?: number;
  /**
   * Set on the claim, gone once GitHub answers: a claim still marked was
   * abandoned (its process quit mid-request), and is asked again after
   * RELEASE_NOTES_PENDING_RETRY_MS, not read as an empty answer (24 h).
   */
  inFlight?: boolean;
  /**
   * Set on a failure that may have been the network (not a rate limit, and
   * no release check answered between the failure before it and this one):
   * asked again RELEASE_NOTES_PENDING_RETRY_MS after it once a release check
   * has answered since (the network is back), not after 6 h. One quick retry,
   * then 6 h: a source that keeps failing while the network is up (or a
   * network that drops again before the quick retry) waits 6 h.
   */
  retryOnline?: boolean;
}

export interface UpdateState {
  /** Auto-update's install window (epoch ms of the last check that got past its gates). */
  lastCheckAt?: number;
  /** The last answer GitHub gave for the latest stable release. */
  latestRelease?: {
    tag: string;
    fetchedAt: number;
    /** The release's `published_at`, when GitHub sent one. */
    publishedAt?: string;
  };
  /** The last attempt to ask GitHub: claimed before the request, so concurrent starts ask once. */
  releaseCheck?: {
    attemptedAt: number;
    /** Set when that attempt failed; the next one waits RELEASE_CHECK_RETRY_MS. */
    failedAt?: number;
    error?: string;
    /** Which source answered the last successful check. */
    source?: "page" | "api";
    /** The last time the API fallback was asked (at most once an hour). */
    apiAttemptedAt?: number;
    /**
     * Set when the API refused for its rate limit: no API request before this
     * (at most RELEASE_CHECK_RATE_LIMITED_RETRY_MS after the API attempt). The
     * page source is not held back by it.
     */
    apiRetryAt?: number;
    /** Written by 0.28.30, which had only the API: read as `apiRetryAt`. */
    retryAt?: number;
    /**
     * Set when the release page refused for its rate limit: no request before
     * this (at most RELEASE_PAGE_RATE_LIMITED_RETRY_MS after the attempt),
     * whatever triggers it. Cleared by a success.
     */
    pageRetryAt?: number;
    /**
     * When the current run of failed checks began (cleared by a success, kept
     * across the claim of the next attempt): what "can't check since" names.
     */
    failingSince?: number;
    /**
     * How long the run has been failing as of its latest failure (`failedAt`),
     * each gap between two failures counted as at most
     * RELEASE_CHECK_FAILURE_RECENT_MS: checks hours apart still add up to
     * RELEASE_CHECK_FAILING_AFTER_MS, a sleep counts as no more than that.
     */
    failingFor?: number;
    /** Failed checks in a row; update.log gets a line only when the error changes. */
    failures?: number;
    /** The errors the last logged failure named, whichever source: what "changes" compares. */
    logged?: string;
  };
  /** The install this process (or an earlier one) started. */
  pending?: {
    version: string;
    fromVersion: string;
    startedAt: number;
    /** `person`: Update now / `plannotator update`; absent: background auto-update. */
    by?: "person";
  };
  /** The Inbox's "Remind me tomorrow", shared by every Inbox tab. */
  snooze?: { version: string; until: number };
  /** When the terminal hint last printed. */
  hintShownAt?: number;
  /** The version the Inbox last ran, to tell "just updated" on its first start after. */
  inboxVersion?: string;
  /**
   * The version the Inbox ran before `inboxVersion`, written when a start
   * finds a newer version than the one recorded, and kept until the next
   * update (removed on a downgrade). What's new counts the releases a person
   * skipped from it, so "Also in the releases since X" survives the update.
   */
  inboxPreviousVersion?: string;
  /**
   * The version an Inbox start found newer than `inboxVersion`, kept until its
   * "What's new" link was offered with readable notes: a start on that same
   * version shows the link too, so a restart before the notes were readable
   * does not lose it.
   */
  whatsNewPending?: string;
  /**
   * One release's notes fetched by its tag (fetchReleaseNotesFor), per
   * version: claimed before the request, so concurrent processes ask once.
   */
  notesFetch?: Record<string, NotesFetchRecord>;
  /**
   * The Inbox's fetch of one release's images (packages/server/inbox-whats-new-images.ts),
   * per version, with the same claim and back-off as `notesFetch` (its
   * `inFlight` mark too). Only the Inbox writes it; nothing here fetches an image.
   */
  releaseImagesFetch?: Record<string, Pick<NotesFetchRecord, "attemptedAt" | "failedAt" | "error" | "inFlight">>;
  /**
   * Safe updates: installs of `version` whose download did not match the
   * checksum Plannotator fetched (install.sh exit 113), counted once each.
   * Background auto-update waits 1, then 3, then 7 days (and 7 after that)
   * from the last one before trying that version again; a newer release is
   * tried at once, and Update now / `plannotator update` always try.
   */
  mismatchBackoff?: { version: string; attempts: number; lastAttemptAt: number };
}

export function updateCheckPaths(dataDir: string = getPlannotatorDataDir()) {
  return {
    state: join(dataDir, "update-state.json"),
    notes: join(dataDir, "update-notes"),
    log: join(dataDir, "update.log"),
  };
}

/**
 * This process's own changes that update-state.json could not take (a
 * read-only data dir, a root-owned file, a folder in its place): `base` is the
 * file as it read when the write failed, `mine` the state this process meant
 * to write. Only the fields that differ between them are this process's, so
 * the throttle, the cache and the run of failures live in memory (the machine
 * still checks, every 10 minutes at most per process, and still shows what it
 * learns) while every other field is read from the file as other processes
 * keep it. Every later write tries the file again; the first that lands
 * clears this.
 */
const unwrittenStates = new Map<string, { base: UpdateState; mine: UpdateState }>();
/** The paths whose failed write update.log already named (once per run of failures). */
const unwrittenLogged = new Set<string>();

function readUpdateStateFile(path: string): UpdateState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as UpdateState) : {};
  } catch {
    return {};
  }
}

export function readUpdateState(dataDir?: string): UpdateState {
  const path = updateCheckPaths(dataDir).state;
  const disk = readUpdateStateFile(path);
  const unwritten = unwrittenStates.get(path);
  if (!unwritten) return disk;
  // The file as it is now, with this process's unwritten changes over it.
  const merged: Record<string, unknown> = { ...disk };
  const base = unwritten.base as Record<string, unknown>;
  const mine = unwritten.mine as Record<string, unknown>;
  for (const key of new Set([...Object.keys(base), ...Object.keys(mine)])) {
    if (JSON.stringify(base[key]) === JSON.stringify(mine[key])) continue;
    if (mine[key] === undefined) delete merged[key];
    else merged[key] = structuredClone(mine[key]);
  }
  return merged as UpdateState;
}

/**
 * Atomic write (temp + rename). Never throws: when the file cannot be written
 * this process's changes are kept in memory (see unwrittenStates) and
 * update.log says so once; the next write tries the file again. A caller
 * writes what it read with readUpdateState (patchUpdateState), so a write
 * that lands carries the file's other fields as they are now.
 */
export function writeUpdateState(state: UpdateState, dataDir?: string): void {
  const { state: path } = updateCheckPaths(dataDir);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
    renameSync(tmp, path);
    unwrittenStates.delete(path);
    unwrittenLogged.delete(path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {}
    if (!unwrittenLogged.has(path)) {
      unwrittenLogged.add(path);
      updateLog(`could not write update-state.json (${err instanceof Error ? err.message : String(err)}); keeping this process's changes in memory and trying again on the next write`, dataDir);
    }
    unwrittenStates.set(path, { base: readUpdateStateFile(path), mine: structuredClone(state) });
  }
}

/** Tests only: forget what an unwritable state file kept in memory. */
export function forgetUnwrittenUpdateStateForTests(dataDir?: string): void {
  const path = updateCheckPaths(dataDir).state;
  unwrittenStates.delete(path);
  unwrittenLogged.delete(path);
}

/** Read, change, write: the change sees the file as it is now, not as a caller read it earlier. */
export function patchUpdateState(change: (state: UpdateState) => UpdateState, dataDir?: string): UpdateState {
  const next = change(readUpdateState(dataDir));
  writeUpdateState(next, dataDir);
  return next;
}

export function updateLog(message: string, dataDir?: string, tag = "update-check"): void {
  try {
    const { log: path } = updateCheckPaths(dataDir);
    mkdirSync(join(path, ".."), { recursive: true });
    // Bounded: past the cap the log moves to update.log.1 (replacing the one before).
    try {
      if (statSync(path).size > UPDATE_LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {}
    appendFileSync(path, `[${new Date().toISOString()}] ${tag}: ${message}\n`);
  } catch {
    // Best-effort: a check must never surface an error.
  }
}

/** The cached latest-release version when it is younger than `freshForMs` (10 min), else null. */
export function cachedLatestTag(state: UpdateState, now: number, freshForMs: number = RELEASE_CHECK_INTERVAL_MS): string | null {
  const cached = state.latestRelease;
  if (!cached || typeof cached !== "object") return null;
  const at = cached.fetchedAt;
  if (typeof at !== "number" || !Number.isFinite(at) || at > now) return null;
  if (now - at >= freshForMs) return null;
  return normalizeStableVersion(cached.tag);
}

/** The last known latest release, however old: a failed check leaves the last known state in place. */
export function knownLatestRelease(state: UpdateState): { version: string; fetchedAt: number; publishedAt?: string } | null {
  const cached = state.latestRelease;
  if (!cached || typeof cached !== "object") return null;
  const version = normalizeStableVersion(cached.tag);
  if (!version || typeof cached.fetchedAt !== "number") return null;
  return {
    version,
    fetchedAt: cached.fetchedAt,
    ...(typeof cached.publishedAt === "string" && { publishedAt: cached.publishedAt }),
  };
}

/**
 * Whether a "Remind me tomorrow" still hides `version`: only until its time,
 * and never longer than a day from now, so one written while the clock was
 * ahead cannot hide the update until the clock catches up.
 */
export function isSnoozed(state: UpdateState, version: string, now: number): boolean {
  const snooze = state.snooze;
  if (!snooze || typeof snooze.until !== "number" || !Number.isFinite(snooze.until)) return false;
  if (normalizeStableVersion(snooze.version) !== normalizeStableVersion(version)) return false;
  return snooze.until > now && snooze.until - now <= UPDATE_SNOOZE_MS;
}

/** The check has been failing for a while: since when and why. */
export interface ReleaseCheckFailing {
  since: number;
  error: string;
}

/**
 * The check has failed for at least RELEASE_CHECK_FAILING_AFTER_MS with no
 * success in between (`failingSince`, cleared by any success), or null. A
 * stamp in the future (a clock that moved back) is no failure.
 */
export function releaseCheckFailing(state: UpdateState, now: number): ReleaseCheckFailing | null {
  const check = state.releaseCheck;
  const since = check?.failingSince;
  if (typeof since !== "number" || !Number.isFinite(since) || since > now) return null;
  // Only a run that is still going: the latest attempt failed (or is in
  // flight right after a failure), recently. A laptop that slept since its
  // last failure, or checks turned back on after weeks, has not failed yet:
  // the next check decides, never an old run.
  // An attempt claimed since (in flight, or its process gone mid-request)
  // changes nothing until it answers: a success clears `failingSince`.
  const failedAt = check?.failedAt;
  if (typeof failedAt !== "number" || !Number.isFinite(failedAt) || failedAt > now) return null;
  if (now - failedAt > RELEASE_CHECK_FAILURE_RECENT_MS) return null;
  // How long it has failed: up to its latest failure (gaps capped), then the
  // time since (under RELEASE_CHECK_FAILURE_RECENT_MS here). A state without
  // `failingFor` counts from `failingSince`.
  const upToFailure =
    typeof check?.failingFor === "number" && Number.isFinite(check.failingFor) && check.failingFor >= 0
      ? check.failingFor
      : Math.max(0, failedAt - since);
  if (upToFailure + (now - failedAt) < RELEASE_CHECK_FAILING_AFTER_MS) return null;
  // Another process (one that predates failingSince) may have succeeded since.
  const fetchedAt = state.latestRelease?.fetchedAt;
  if (typeof fetchedAt === "number" && fetchedAt >= since && fetchedAt <= now) return null;
  return { since, error: plainCheckError(typeof check?.error === "string" && check.error ? check.error : "the check failed") };
}

/**
 * The stored reason a check failed (update.log's words: "page: HTTP 200; api:
 * HTTP 403, rate limited"), in words a person reads: "release page didn't
 * answer as expected; GitHub API rate-limited". Any reason it does not know
 * (an older version's) still reads as a reason, never as a status code.
 */
export function plainCheckError(raw: string): string {
  const words = raw
    .split(/;\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const tagged = /^(page|api):\s*([\s\S]*)$/.exec(part);
      const source = tagged?.[1];
      let error = tagged ? tagged[2] : part;
      const limited = /,\s*rate limited$/.test(error);
      error = error.replace(/,\s*rate limited$/, "");
      const who = source === "api" ? "GitHub API" : source === "page" ? "release page" : "GitHub";
      if (error === "no release page source") return "";
      if (error === "the check failed") return error;
      if (limited || error === "HTTP 429") return `${who} rate-limited`;
      if (/^not a stable version|not a stable release/.test(error)) return `${who} named no stable release`;
      if (/^HTTP \d+$|^redirect to|^no tag_name/.test(error)) return `${who} didn't answer as expected`;
      if (/tim(?:ed|e)\s*out|timeout|aborted/i.test(error)) return `${who} took too long to answer`;
      return `couldn't reach ${source ? `the ${who}` : who}`;
    })
    .filter(Boolean);
  return [...new Set(words)].join("; ") || "the check failed";
}

/**
 * Whether it is time to ask: never while the cached answer is younger than
 * `freshForMs` (10 min; an Inbox start passes 1 min), and never within that
 * (at most RELEASE_CHECK_RETRY_MS) of the last attempt, a failure or another
 * process's request still in flight. A stamp in the future (a clock that
 * moved back) never freezes checks.
 */
export function isReleaseCheckDue(state: UpdateState, now: number, freshForMs: number = RELEASE_CHECK_INTERVAL_MS): boolean {
  if (cachedLatestTag(state, now, freshForMs)) return false;
  const check = state.releaseCheck;
  const attempt = check?.attemptedAt;
  if (typeof attempt !== "number" || !Number.isFinite(attempt) || attempt > now) return true;
  // The page asked us to wait (capped, so a wrong header never holds it back for long).
  const pageRetryAt = check?.pageRetryAt;
  if (
    typeof pageRetryAt === "number" &&
    pageRetryAt > now &&
    pageRetryAt - attempt <= RELEASE_PAGE_RATE_LIMITED_RETRY_MS
  ) {
    return false;
  }
  // After a failure: 10 minutes, whatever triggers it (a start or a reload too).
  const failed = typeof check?.failedAt === "number" && check.failedAt >= attempt;
  return now - attempt >= (failed ? RELEASE_CHECK_RETRY_MS : Math.min(freshForMs, RELEASE_CHECK_RETRY_MS));
}

/**
 * Whether the API fallback may be asked now: at most once an hour, and not
 * before the time a rate-limited answer named (capped at 6 h after that API
 * attempt, so a wrong clock or header never holds it back for good).
 */
export function isApiFallbackDue(state: UpdateState, now: number): boolean {
  const check = state.releaseCheck;
  const at = check?.apiAttemptedAt;
  const valid = typeof at === "number" && Number.isFinite(at) && at <= now;
  if (valid && now - at < RELEASE_API_FALLBACK_INTERVAL_MS) return false;
  const retryAt = check?.apiRetryAt ?? check?.retryAt;
  if (typeof retryAt === "number" && Number.isFinite(retryAt) && retryAt > now) {
    const from = valid ? at : typeof check?.attemptedAt === "number" && check.attemptedAt <= now ? check.attemptedAt : now;
    if (retryAt - from <= RELEASE_CHECK_RATE_LIMITED_RETRY_MS) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Release notes
// ---------------------------------------------------------------------------

export interface ReleaseHighlight {
  version: string;
  text: string;
}

export interface ReleaseNotes {
  version: string;
  publishedAt?: string;
  /** Markdown: the release body from "## What's New in" up to "## Install / Update", capped. */
  notes: string;
  /** The release body's "Missed recent releases?" table, newest first. */
  highlights: ReleaseHighlight[];
}

/** Cut a byte cap on a code point boundary. */
function capUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/�+$/, "");
}

/** The part of a release body a person reads as "what's new". */
export function extractReleaseNotes(body: unknown): { notes: string; highlights: ReleaseHighlight[] } {
  if (typeof body !== "string") return { notes: "", highlights: [] };
  const text = body.replace(/\r\n/g, "\n");
  const highlights: ReleaseHighlight[] = [];
  for (const m of text.matchAll(/^\|\s*\[v?(\d+\.\d+\.\d+)\]\([^)]*\)\s*\|\s*(.+?)\s*\|\s*$/gm)) {
    const version = normalizeStableVersion(m[1]);
    if (version && highlights.length < 50) highlights.push({ version, text: m[2]!.slice(0, 500) });
  }
  const start = text.search(/^## What's New in\b/m);
  let notes = start >= 0 ? text.slice(start) : "";
  if (notes) {
    // Drop the heading itself (the page carries its own) and the generic install block.
    notes = notes.replace(/^## What's New in[^\n]*\n+/, "");
    const end = notes.search(/^## Install \/ Update\b/m);
    if (end >= 0) notes = notes.slice(0, end);
  }
  return { notes: capUtf8(notes.trim(), RELEASE_NOTES_MAX_BYTES), highlights };
}

function notesPath(version: string, dataDir?: string): string | null {
  const v = normalizeStableVersion(version);
  return v ? join(updateCheckPaths(dataDir).notes, `${v}.json`) : null;
}

export function writeReleaseNotes(notes: ReleaseNotes, dataDir?: string): void {
  const path = notesPath(notes.version, dataDir);
  if (!path) return;
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(notes) + "\n", "utf-8");
  renameSync(tmp, path);
}

export function readReleaseNotes(version: string, dataDir?: string): ReleaseNotes | null {
  const path = notesPath(version, dataDir);
  if (!path) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ReleaseNotes>;
    if (!raw || typeof raw.notes !== "string" || normalizeStableVersion(raw.version) === null) return null;
    return {
      version: normalizeStableVersion(raw.version)!,
      ...(typeof raw.publishedAt === "string" && { publishedAt: raw.publishedAt }),
      notes: capUtf8(raw.notes, RELEASE_NOTES_MAX_BYTES),
      highlights: Array.isArray(raw.highlights)
        ? raw.highlights.filter(
            (h): h is ReleaseHighlight => !!h && typeof h.version === "string" && typeof h.text === "string",
          )
        : [],
    };
  } catch {
    return null;
  }
}

/** Notes a person can read: a stored file whose "What's New" part is empty counts as missing. */
export function hasReleaseNotesContent(notes: ReleaseNotes | null): notes is ReleaseNotes {
  return !!notes && notes.notes.trim() !== "";
}

/** The first paragraph of the notes, as plain-ish text, for a dialog's summary. */
export function releaseSummary(notes: string): string {
  for (const para of notes.split(/\n{2,}/)) {
    const t = para.trim();
    if (!t || /^(#|[-*]\s|\||```|<)/.test(t)) continue;
    return t.replace(/\s+/g, " ").slice(0, 600);
  }
  return "";
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

export interface FetchedRelease {
  tag: string;
  publishedAt?: string;
  body?: string;
}

export type FetchReleaseResult =
  | { ok: true; release: FetchedRelease }
  | {
      ok: false;
      error: string;
      /** GitHub refused for its rate limit (403/429). */
      rateLimited?: boolean;
      /** How long GitHub asked us to wait (`Retry-After` or `x-ratelimit-reset`), when it said. */
      retryAfterMs?: number;
      /** The source is turned off (no request was made): not a failure of its own. */
      skipped?: boolean;
    };

/**
 * How long a rate-limited answer asks to wait: `Retry-After` (seconds or an
 * HTTP date), else `x-ratelimit-reset` (epoch seconds). Undefined when neither
 * parses to a time in the future.
 */
export function rateLimitWaitMs(headers: Headers, now: number = Date.now()): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at) && at > now) return at - now;
  }
  const reset = headers.get("x-ratelimit-reset")?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const at = Number(reset) * 1000;
    if (at > now) return at - now;
  }
  return undefined;
}

/**
 * The API URL: PLANNOTATOR_UPDATE_API_URL, a testing / proxy knob like
 * PLANNOTATOR_BITBUCKET_API_URL. Only `https:` or loopback `http:` counts;
 * anything else is ignored.
 */
export function releaseApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PLANNOTATOR_UPDATE_API_URL?.trim();
  return raw && isAllowedOverrideUrl(raw) ? raw : DEFAULT_RELEASE_API_URL;
}

/** `https:`, or `http:` on a loopback host. */
export function isAllowedOverrideUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/**
 * The release page URL: PLANNOTATOR_UPDATE_LATEST_URL (`https:` or loopback
 * `http:`, a test fake or a mirror), else GitHub's. Null when only
 * PLANNOTATOR_UPDATE_API_URL is set: a proxy or a test fake for the API means
 * "ask only that", so nothing reaches github.com behind its back.
 */
export function releasePageUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.PLANNOTATOR_UPDATE_LATEST_URL?.trim();
  if (raw && isAllowedOverrideUrl(raw)) return raw;
  const api = env.PLANNOTATOR_UPDATE_API_URL?.trim();
  if (api && isAllowedOverrideUrl(api)) return null;
  return DEFAULT_RELEASE_PAGE_URL;
}

/**
 * The version a "latest release" redirect names, or null. Only the same
 * origin as the request, at exactly the request's path with `latest`
 * replaced by `tag/v<X.Y.Z>`: anything else (a pre-release, `/releases` for a
 * repository with none, a sign-in page, another host) is refused.
 */
export function versionFromLatestRedirect(requestUrl: string, location: string | null | undefined): string | null {
  if (!location) return null;
  try {
    const from = new URL(requestUrl);
    const to = new URL(location, from);
    if (to.origin !== from.origin) return null;
    const base = from.pathname.replace(/\/+$/, "");
    if (!base.endsWith("/latest")) return null;
    const prefix = `${base.slice(0, -"latest".length)}tag/`;
    // GitHub may spell the owner or repository in another case; a mirror
    // (PLANNOTATOR_UPDATE_LATEST_URL) is read exactly as it answers.
    const caseless = from.hostname === "github.com";
    if (!(caseless ? to.pathname.toLowerCase().startsWith(prefix.toLowerCase()) : to.pathname.startsWith(prefix))) return null;
    const tag = decodeURIComponent(to.pathname.slice(prefix.length)).replace(/\/+$/, "");
    if (!/^v?\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(tag)) return null;
    return normalizeStableVersion(tag);
  } catch {
    return null;
  }
}

/**
 * One unauthenticated HEAD of the "latest release" page, read from its
 * redirect without following it. GitHub receives the IP address and this
 * user agent; no version, no cookies.
 */
export async function fetchLatestFromPage(
  url: string | null = releasePageUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<FetchReleaseResult> {
  if (!url) return { ok: false, error: "no release page source", skipped: true };
  try {
    const res = await fetchImpl(url, {
      method: "HEAD",
      redirect: "manual",
      headers: { "user-agent": "plannotator-update-check" },
      signal: AbortSignal.timeout(RELEASE_CHECK_TIMEOUT_MS),
    });
    // A runtime that followed the redirect anyway: read where it landed.
    const version =
      res.status >= 300 && res.status < 400
        ? versionFromLatestRedirect(url, res.headers.get("location"))
        : res.ok && res.redirected
          ? versionFromLatestRedirect(url, res.url)
          : null;
    if (version) return { ok: true, release: { tag: version } };
    if (res.status === 429 || (res.status === 403 && (res.headers.has("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"))) {
      const wait = rateLimitWaitMs(res.headers);
      return { ok: false, error: `HTTP ${res.status}`, rateLimited: true, ...(wait !== undefined && { retryAfterMs: wait }) };
    }
    return { ok: false, error: res.status >= 300 && res.status < 400 ? `redirect to ${String(res.headers.get("location")).slice(0, 120)}` : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One release by its tag (`…/releases/tags/vX.Y.Z`): the release API URL with
 * its last segment (`latest`) replaced, so PLANNOTATOR_UPDATE_API_URL points
 * both requests at the same fake or mirror. Null for a version that is not X.Y.Z.
 */
export function releaseTagApiUrl(version: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const v = normalizeStableVersion(version);
  return v ? new URL(`tags/v${v}`, releaseApiUrl(env)).toString() : null;
}

/** One unauthenticated GET of a release object, read loosely. */
async function fetchReleaseObject(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; release: FetchedRelease; draft: boolean; prerelease: boolean } | Extract<FetchReleaseResult, { ok: false }>> {
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/vnd.github+json", "user-agent": "plannotator-update-check" },
      signal: AbortSignal.timeout(RELEASE_CHECK_TIMEOUT_MS),
    });
    if (res.status === 403 || res.status === 429) {
      const wait = rateLimitWaitMs(res.headers);
      return { ok: false, error: `HTTP ${res.status}`, rateLimited: true, ...(wait !== undefined && { retryAfterMs: wait }) };
    }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; body?: unknown };
    if (typeof body.tag_name !== "string") return { ok: false, error: "no tag_name in the answer" };
    return {
      ok: true,
      draft: body.draft === true,
      prerelease: body.prerelease === true,
      release: {
        tag: body.tag_name,
        ...(typeof body.published_at === "string" && { publishedAt: body.published_at }),
        ...(typeof body.body === "string" && { body: body.body }),
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * One unauthenticated GET. GitHub receives the IP address and this user
 * agent; the version is deliberately not in it.
 */
export async function fetchLatestRelease(
  url: string = releaseApiUrl(),
  fetchImpl: typeof fetch = fetch,
): Promise<FetchReleaseResult> {
  const result = await fetchReleaseObject(url, fetchImpl);
  if (!result.ok) return result;
  if (result.draft || result.prerelease) return { ok: false, error: "the latest release is not a stable release" };
  return { ok: true, release: result.release };
}

/** One unauthenticated GET of the release tagged `vX.Y.Z`, with the same client rules as the release check. */
export async function fetchReleaseByTag(version: string, fetchImpl: typeof fetch = fetch): Promise<FetchReleaseResult> {
  const url = releaseTagApiUrl(version);
  if (!url) return { ok: false, error: "not a stable version" };
  const result = await fetchReleaseObject(url, fetchImpl);
  if (!result.ok) return result;
  if (result.draft) return { ok: false, error: "the release is a draft" };
  return { ok: true, release: result.release };
}

export interface ReleaseCheckDeps {
  dataDir?: string;
  now?: () => number;
  /** The knob (resolveUpdateCheck). Ignored when `force` is set. */
  enabled: () => boolean;
  /** An explicit action (`plannotator update`, Check now): ask now, whatever the throttle or the knob say. */
  force?: boolean;
  /** How young an answer must be to skip asking: 10 min by default; an Inbox start or page load passes 1 min. */
  freshForMs?: number;
  /** The primary source, GitHub's "latest release" redirect (fetchLatestFromPage). */
  fetchReleasePage?: () => Promise<FetchReleaseResult>;
  /** The fallback, the releases API (fetchLatestRelease): asked only when the page fails, at most once an hour. */
  fetchRelease?: () => Promise<FetchReleaseResult>;
}

export type ReleaseCheckOutcome =
  | { outcome: "disabled" }
  | { outcome: "fresh"; version: string | null }
  | { outcome: "checked"; version: string }
  | { outcome: "failed"; error: string };

function formatWait(ms: number): string {
  return ms >= 60 * 60 * 1000 ? `${Math.round((ms / 3_600_000) * 10) / 10}h` : `${Math.round(ms / 60_000)}m`;
}

/**
 * Ask when it is time (or when forced) and cache the answer: the release page
 * first, the API when the page fails and the API is not held back. Never throws.
 */
export async function runReleaseCheck(deps: ReleaseCheckDeps): Promise<ReleaseCheckOutcome> {
  const dataDir = deps.dataDir;
  const now = (deps.now ?? Date.now)();
  if (!deps.force && !deps.enabled()) return { outcome: "disabled" };
  const freshForMs = deps.freshForMs ?? RELEASE_CHECK_INTERVAL_MS;
  let state: UpdateState;
  let previous: UpdateState["releaseCheck"];
  try {
    state = readUpdateState(dataDir);
    previous = state.releaseCheck;
    if (!deps.force && !isReleaseCheckDue(state, now, freshForMs)) {
      return { outcome: "fresh", version: knownLatestRelease(state)?.version ?? null };
    }
    // Claim the attempt before the network call so concurrent starts ask once.
    // The API's own back-off is kept: it is separate from the page's cadence.
    state = patchUpdateState((s) => ({ ...s, releaseCheck: { ...apiBackoff(s), ...failingStreak(s), attemptedAt: now } }), dataDir);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateLog(`could not write update-state.json: ${error}`, dataDir);
    return { outcome: "failed", error };
  }

  // 1. The page: a redirect, no rate limit worth the name.
  const page = await (deps.fetchReleasePage ?? (() => fetchLatestFromPage()))();
  let source: "page" | "api" = "page";
  let result: FetchReleaseResult = page;
  let pageError: string | null = null;
  if (!page.ok) {
    pageError = page.skipped ? null : page.error;
    // 2. The API, when the page failed and the API may be asked now.
    if (deps.force || isApiFallbackDue(state, now)) {
      source = "api";
      try {
        patchUpdateState((s) => ({ ...s, releaseCheck: { ...apiBackoff(s), ...failingStreak(s), attemptedAt: now, apiAttemptedAt: now } }), dataDir);
      } catch {}
      result = await (deps.fetchRelease ?? (() => fetchLatestRelease()))();
    } else if (page.skipped) {
      // Only the API may be asked (a mirror or a test fake) and it is not due:
      // nothing was asked, so nothing failed. A run of failures waiting out
      // the API's back-off is still failing, though: say so (failedAt), so it
      // is not taken for a check that went quiet.
      if (typeof previous?.failingSince === "number") {
        patchUpdateState(
          (s) => ({
            ...s,
            releaseCheck: {
              ...(s.releaseCheck ?? { attemptedAt: now }),
              ...failingRunOf(s, previous, true, now),
              failedAt: now,
              ...(previous.error && { error: previous.error }),
            },
          }),
          dataDir,
        );
      }
      return { outcome: "fresh", version: knownLatestRelease(state)?.version ?? null };
    }
  }

  // The tag is untrusted input (auto-update passes it to an installer), so it
  // is reduced to a canonical X.Y.Z before anything stores it.
  const version = result.ok ? normalizeStableVersion(result.release.tag) : null;
  if (!result.ok || !version) {
    const error = result.ok ? `not a stable version: ${JSON.stringify(result.release.tag).slice(0, 80)}` : result.error;
    const apiAsked = source === "api";
    const rateLimited = apiAsked && !result.ok && result.rateLimited === true;
    const apiWait = rateLimited
      ? Math.min(
          Math.max(!result.ok && result.retryAfterMs !== undefined ? result.retryAfterMs : RELEASE_CHECK_RATE_LIMITED_RETRY_MS, RELEASE_API_FALLBACK_INTERVAL_MS),
          RELEASE_CHECK_RATE_LIMITED_RETRY_MS,
        )
      : 0;
    const parts = [pageError && `page: ${pageError}`, apiAsked ? `api: ${error}${rateLimited ? ", rate limited" : ""}` : !pageError && error].filter(Boolean);
    const summary = (parts.join("; ") || error).slice(0, 200);
    // The release page asked us to wait (an office NAT can meet github.com's limits too).
    const pageWait =
      !page.ok && page.rateLimited === true
        ? Math.min(Math.max(page.retryAfterMs ?? RELEASE_PAGE_RATE_LIMITED_RETRY_MS, RELEASE_CHECK_RETRY_MS), RELEASE_PAGE_RATE_LIMITED_RETRY_MS)
        : 0;
    const failedBefore = typeof previous?.failedAt === "number" && previous.failedAt >= previous.attemptedAt;
    const failures = failedBefore ? (previous?.failures ?? 1) + 1 : 1;
    // One line per change of error, not one per check: an offline machine
    // would otherwise add a line every 10 minutes. Compared by the errors
    // alone, so the API being asked or not (hourly) is no change.
    const logged = pageError || error;
    if (!failedBefore || previous?.logged !== logged) {
      const notes = [
        rateLimited && `the API is not asked again for ${formatWait(apiWait)}`,
        failedBefore && `${failures - 1} failed check${failures - 1 === 1 ? "" : "s"} before this one`,
      ].filter(Boolean);
      updateLog(
        `could not read the latest release (${summary}); next try in ${formatWait(pageWait || RELEASE_CHECK_RETRY_MS)}${notes.length ? `; ${notes.join("; ")}` : ""}`,
        dataDir,
      );
    }
    try {
      patchUpdateState(
        (s) => ({
          ...s,
          releaseCheck: {
            ...apiBackoff(s),
            attemptedAt: now,
            failedAt: now,
            error: summary,
            // The run of failures began at the first one (kept across claims; a success clears it).
            ...failingRunOf(s, previous, failedBefore, now),
            failures,
            logged,
            ...(rateLimited && { apiRetryAt: now + apiWait }),
            ...(pageWait > 0 && { pageRetryAt: now + pageWait }),
          },
        }),
        dataDir,
      );
    } catch {}
    return { outcome: "failed", error };
  }
  const release = result.release;
  if (typeof previous?.failedAt === "number" && previous.failedAt >= previous.attemptedAt) {
    const n = previous.failures ?? 1;
    updateLog(`the latest release answered again (${version}) after ${n} failed check${n === 1 ? "" : "s"}`, dataDir);
  }
  if (source === "api") {
    try {
      const { notes, highlights } = extractReleaseNotes(release.body);
      writeReleaseNotes({ version, ...(release.publishedAt && { publishedAt: release.publishedAt }), notes, highlights }, dataDir);
    } catch (err) {
      updateLog(`could not save the release notes: ${err instanceof Error ? err.message : String(err)}`, dataDir);
    }
  }
  try {
    patchUpdateState(
      (s) => {
        // The page names no publish date: keep the one already known for this version.
        const publishedAt =
          release.publishedAt ?? (normalizeStableVersion(s.latestRelease?.tag) === version ? s.latestRelease?.publishedAt : undefined);
        return {
          ...s,
          latestRelease: { tag: version, fetchedAt: now, ...(publishedAt && { publishedAt }) },
          releaseCheck: { ...apiBackoff(s), attemptedAt: now, source },
          // A newer version clears an older snooze.
          ...(s.snooze && s.snooze.version !== version ? { snooze: undefined } : {}),
        };
      },
      dataDir,
    );
  } catch {}
  return { outcome: "checked", version };
}

/** The current run of failures (and its error), carried across the claim of the next attempt. */
function failingStreak(state: UpdateState): Pick<NonNullable<UpdateState["releaseCheck"]>, "failingSince" | "failingFor" | "error" | "failedAt"> {
  const check = state.releaseCheck;
  if (typeof check?.failingSince !== "number") return {};
  return {
    failingSince: check.failingSince,
    ...(typeof check.failingFor === "number" && { failingFor: check.failingFor }),
    ...(typeof check.error === "string" && { error: check.error }),
    // When the run's last failure was (earlier than the new attempt, so the
    // back-off rules read the attempt as in flight, not failed).
    ...(typeof check.failedAt === "number" && { failedAt: check.failedAt }),
  };
}

/**
 * The run of failures that this one continues: when it began (kept across
 * any gap between checks, hours apart or a sleep, until a check succeeds,
 * which clears it) and how long it has failed as of now, each gap since the
 * previous failure counted as at most RELEASE_CHECK_FAILURE_RECENT_MS.
 * Whether it shows is releaseCheckFailing's call. A state written by a
 * version without `failingSince` (or another process's claim in between)
 * counts from the earlier failure it records.
 */
function failingRunOf(
  state: UpdateState,
  previous: UpdateState["releaseCheck"],
  failedBefore: boolean,
  now: number,
): { failingSince: number; failingFor: number } {
  const check = state.releaseCheck;
  const recorded = check?.failingSince ?? previous?.failingSince;
  let since: number | null = null;
  if (typeof recorded === "number" && Number.isFinite(recorded) && recorded <= now) since = recorded;
  else if (failedBefore && typeof previous?.failedAt === "number" && previous.failedAt <= now) since = previous.failedAt;
  if (since === null) return { failingSince: now, failingFor: 0 };
  const lastFailure = check?.failedAt ?? previous?.failedAt;
  const last = typeof lastFailure === "number" && Number.isFinite(lastFailure) && lastFailure >= since && lastFailure <= now ? lastFailure : since;
  const before = check?.failingFor ?? previous?.failingFor;
  const upToLast = typeof before === "number" && Number.isFinite(before) && before >= 0 ? before : last - since;
  return { failingSince: since, failingFor: upToLast + Math.min(now - last, RELEASE_CHECK_FAILURE_RECENT_MS) };
}

/** The API fallback's own back-off, carried across every write of `releaseCheck`. */
function apiBackoff(state: UpdateState): Pick<NonNullable<UpdateState["releaseCheck"]>, "apiAttemptedAt" | "apiRetryAt"> {
  const check = state.releaseCheck;
  const retryAt = check?.apiRetryAt ?? check?.retryAt;
  return {
    ...(typeof check?.apiAttemptedAt === "number" && { apiAttemptedAt: check.apiAttemptedAt }),
    ...(typeof retryAt === "number" && { apiRetryAt: retryAt }),
  };
}

/**
 * Fire-and-forget: returns at once, runs on a later unref'd tick, and logs
 * every failure. For hot paths (a session start, the Inbox's health tick).
 */
export function scheduleReleaseCheck(deps: ReleaseCheckDeps, then?: (outcome: ReleaseCheckOutcome) => void): void {
  const timer = setTimeout(() => {
    runReleaseCheck(deps)
      .then((outcome) => then?.(outcome))
      .catch((err) => updateLog(`check failed: ${err instanceof Error ? err.message : String(err)}`, deps.dataDir));
  }, 0);
  (timer as { unref?: () => void }).unref?.();
}

// ---------------------------------------------------------------------------
// One release's notes, by its tag
// ---------------------------------------------------------------------------

/** How many versions `notesFetch` remembers. */
const NOTES_FETCH_REMEMBERED = 10;

/** The record names a release young enough for the quick retry (a clock far off either way does not). */
function isYoungRelease(record: NotesFetchRecord, now: number): boolean {
  const published = record.publishedAt;
  return typeof published === "number" && Number.isFinite(published) && Math.abs(now - published) < RELEASE_NOTES_YOUNG_MS;
}

/**
 * A release check answered after `at` (the network is up again since then).
 * An answer dated after `now` (the clock moved back) does not count.
 */
function releaseCheckAnsweredAfter(state: UpdateState, at: number, now: number): boolean {
  const answered = state.latestRelease?.fetchedAt;
  return typeof answered === "number" && answered > at && answered <= now;
}

/**
 * Whether one version's notes may be asked for now: once, then after a
 * failure no sooner than 6 h (15 minutes once the network is back, see
 * `retryOnline`), after an answer that carried no "What's New" part no
 * sooner than 15 minutes while the release is under 2 days old (the release
 * body is edited after publishing), else 24 h. A claim nobody answered (its
 * process quit) waits 15 minutes. Never sooner than 15 minutes, never in a loop.
 */
export function isNotesFetchDue(state: UpdateState, version: string, now: number): boolean {
  const record = state.notesFetch?.[version];
  const at = record?.attemptedAt;
  if (!record || typeof at !== "number" || !Number.isFinite(at) || at > now) return true;
  const wait = record.failedAt
    ? record.retryOnline && releaseCheckAnsweredAfter(state, record.failedAt, now)
      ? RELEASE_NOTES_PENDING_RETRY_MS
      : RELEASE_ASSETS_FETCH_RETRY_MS
    : record.inFlight || isYoungRelease(record, now)
      ? RELEASE_NOTES_PENDING_RETRY_MS
      : RELEASE_ASSETS_FETCH_INTERVAL_MS;
  return now - at >= wait;
}

export interface ReleaseNotesFetchDeps {
  version: string;
  dataDir?: string;
  now?: () => number;
  /** The knob (resolveUpdateCheck): off, nothing is asked. */
  enabled: () => boolean;
  fetchRelease?: (version: string) => Promise<FetchReleaseResult>;
}

export type ReleaseNotesFetchOutcome =
  | { outcome: "present"; notes: ReleaseNotes }
  | { outcome: "disabled" | "not-due" }
  | { outcome: "fetched"; notes: ReleaseNotes }
  | { outcome: "failed"; error: string };

/**
 * The notes for one version, fetched by its tag when they are missing (a
 * release installed before the release check saw it, or a check made before the
 * release existed) or stored without a "What's New" part (saved before the
 * release body was edited). Saved to `update-notes/<version>.json` like the
 * release check's. Never throws.
 */
export async function fetchReleaseNotesFor(deps: ReleaseNotesFetchDeps): Promise<ReleaseNotesFetchOutcome> {
  const dataDir = deps.dataDir;
  const version = normalizeStableVersion(deps.version);
  if (!version) return { outcome: "failed", error: "not a stable version" };
  const stored = readReleaseNotes(version, dataDir);
  if (hasReleaseNotesContent(stored)) return { outcome: "present", notes: stored };
  if (!deps.enabled()) return { outcome: "disabled" };
  const now = (deps.now ?? Date.now)();
  const record = (patch: NotesFetchRecord) =>
    patchUpdateState((s) => {
      const entries = Object.entries({ ...(s.notesFetch ?? {}), [version]: patch })
        .filter(([, r]) => r && typeof r.attemptedAt === "number")
        .sort((a, b) => b[1].attemptedAt - a[1].attemptedAt)
        .slice(0, NOTES_FETCH_REMEMBERED);
      return { ...s, notesFetch: Object.fromEntries(entries) };
    }, dataDir);
  let pendingBefore = false;
  let previous: NotesFetchRecord | undefined;
  let state: UpdateState;
  try {
    state = readUpdateState(dataDir);
    if (!isNotesFetchDue(state, version, now)) return { outcome: "not-due" };
    // Claim the attempt before the network call so concurrent processes ask
    // once. Marked in flight, so an attempt that never finished (the process
    // quit) is tried again on the quick cadence, not in a day.
    previous = state.notesFetch?.[version];
    pendingBefore = !!previous && !previous.failedAt && isYoungRelease(previous, now);
    record({ attemptedAt: now, inFlight: true, ...(pendingBefore && { publishedAt: previous!.publishedAt }) });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateLog(`could not write update-state.json: ${error}`, dataDir);
    return { outcome: "failed", error };
  }
  const result = await (deps.fetchRelease ?? ((v: string) => fetchReleaseByTag(v)))(version);
  const tag = result.ok ? normalizeStableVersion(result.release.tag) : null;
  if (!result.ok || tag !== version) {
    const error = result.ok ? `the release answered for ${JSON.stringify(result.release.tag).slice(0, 80)}` : result.error;
    // Maybe the network (a laptop waking, a VPN): asked again 15 minutes after,
    // once a release check answers. Not after a rate limit, and not when this
    // source failed before with a release check answering since (it keeps
    // failing while the network is up: 6 h).
    const retryOnline = !(!result.ok && result.rateLimited) && !(previous?.failedAt && releaseCheckAnsweredAfter(state, previous.failedAt, now));
    updateLog(`could not read the release notes for ${version} (${error}); next try in ${retryOnline ? "15m once online, else 6h" : "6h"}`, dataDir);
    try {
      record({ attemptedAt: now, failedAt: now, error: error.slice(0, 200), ...(retryOnline && { retryOnline }) });
    } catch {}
    return { outcome: "failed", error };
  }
  const release = result.release;
  const { notes, highlights } = extractReleaseNotes(release.body);
  const saved: ReleaseNotes = { version, ...(release.publishedAt && { publishedAt: release.publishedAt }), notes, highlights };
  try {
    writeReleaseNotes(saved, dataDir);
  } catch (err) {
    updateLog(`could not save the release notes: ${err instanceof Error ? err.message : String(err)}`, dataDir);
  }
  if (!notes) {
    // GitHub's generated body, read before the written notes replaced it (or
    // a release with none): a young release is asked again in 15 minutes.
    const published = release.publishedAt ? Date.parse(release.publishedAt) : NaN;
    const pending: NotesFetchRecord = { attemptedAt: now, ...(Number.isFinite(published) && { publishedAt: published }) };
    try {
      record(pending);
    } catch {}
    // One line per version, not one per retry.
    if (isYoungRelease(pending, now) && !pendingBefore) {
      updateLog(`the release notes for ${version} have no "What's New" part yet; next try in ${formatWait(RELEASE_NOTES_PENDING_RETRY_MS)}`, dataDir);
    }
  } else {
    // Answered: no longer in flight (it matters only when the notes could not be saved).
    try {
      record({ attemptedAt: now });
    } catch {}
  }
  // The release page names no publish date: take this answer's for the latest release.
  if (release.publishedAt) {
    try {
      patchUpdateState((s) => {
        const latest = s.latestRelease;
        if (!latest || latest.publishedAt || normalizeStableVersion(latest.tag) !== version) return s;
        return { ...s, latestRelease: { ...latest, publishedAt: release.publishedAt } };
      }, dataDir);
    } catch {}
  }
  return { outcome: "fetched", notes: saved };
}

// ---------------------------------------------------------------------------
// Remembered install flags (install-flags.json, written by the installers)
// ---------------------------------------------------------------------------

/**
 * The install-affecting command-line flags the installers remember in
 * `install-flags.json` (written by install.sh / install.ps1 / install.cmd after
 * a successful run), as neutral ids with their spelling per installer. This is
 * the strict allowlist: anything else in the file is dropped.
 */
export const INSTALL_FLAG_SPELLINGS = {
  minimal: { posix: "--minimal", powershell: "-Minimal" },
  "no-minimal": { posix: "--no-minimal", powershell: "-NoMinimal" },
  "verify-attestation": { posix: "--verify-attestation", powershell: "-VerifyAttestation" },
  "skip-attestation": { posix: "--skip-attestation", powershell: "-SkipAttestation" },
  "with-call-flow": { posix: "--with-call-flow", powershell: "-WithCallFlow" },
  "with-t3": { posix: "--with-t3", powershell: null },
  "without-t3": { posix: "--without-t3", powershell: null },
  "skip-codex": { posix: "--skip-codex", powershell: "-SkipCodex" },
  "skip-gemini": { posix: "--skip-gemini", powershell: "-SkipGemini" },
  "skip-kiro": { posix: "--skip-kiro", powershell: "-SkipKiro" },
  "skip-vibe": { posix: "--skip-vibe", powershell: "-SkipVibe" },
  "skip-opencode": { posix: "--skip-opencode", powershell: "-SkipOpencode" },
  "skip-qwen": { posix: "--skip-qwen", powershell: "-SkipQwen" },
  "skip-skills": { posix: "--skip-skills", powershell: "-SkipSkills" },
  "skip-claude-plugin": { posix: "--skip-claude-plugin", powershell: "-SkipClaudePlugin" },
} as const;

export type InstallFlagId = keyof typeof INSTALL_FLAG_SPELLINGS;

const MUTUALLY_EXCLUSIVE: Array<[InstallFlagId, InstallFlagId]> = [
  ["minimal", "no-minimal"],
  ["verify-attestation", "skip-attestation"],
  ["with-t3", "without-t3"],
];

function isInstallFlagId(value: unknown): value is InstallFlagId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(INSTALL_FLAG_SPELLINGS, value);
}

export interface InstallFlagsRead {
  flags: InstallFlagId[];
  /** Why the file could not be used as-is, for update.log. */
  problem?: string;
}

/**
 * Validate the parsed contents of install-flags.json. Known ids are kept in
 * allowlist order without duplicates; unknown entries are dropped; a
 * mutually-exclusive pair (which no installer writes) drops both sides.
 */
export function parseInstallFlags(raw: unknown): InstallFlagsRead {
  if (!raw || typeof raw !== "object" || !Array.isArray((raw as { flags?: unknown }).flags)) {
    return { flags: [], problem: "install-flags.json is malformed" };
  }
  const entries = (raw as { flags: unknown[] }).flags;
  const present = new Set<InstallFlagId>();
  let dropped = 0;
  for (const entry of entries) {
    if (isInstallFlagId(entry)) present.add(entry);
    else dropped++;
  }
  for (const [a, b] of MUTUALLY_EXCLUSIVE) {
    if (present.has(a) && present.has(b)) {
      present.delete(a);
      present.delete(b);
      dropped += 2;
    }
  }
  const flags = (Object.keys(INSTALL_FLAG_SPELLINGS) as InstallFlagId[]).filter((id) => present.has(id));
  return dropped > 0
    ? { flags, problem: `dropped ${dropped} unrecognized or conflicting install-flags.json entr${dropped === 1 ? "y" : "ies"}` }
    : { flags };
}

/** Read install-flags.json; a missing or unreadable file means no flags. */
export function readInstallFlags(dataDir?: string): InstallFlagsRead {
  const path = join(dataDir ?? getPlannotatorDataDir(), "install-flags.json");
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { flags: [], problem: "no install-flags.json; running the installer with default flags" };
  }
  try {
    return parseInstallFlags(JSON.parse(text));
  } catch {
    return { flags: [], problem: "install-flags.json is malformed; running the installer with default flags" };
  }
}

/** The flags spelled for the installer the platform runs. */
export function installerFlagArgs(flags: readonly InstallFlagId[], platform: NodeJS.Platform): string[] {
  const key = platform === "win32" ? "powershell" : "posix";
  return flags.filter(isInstallFlagId).flatMap((id) => {
    const spelling = INSTALL_FLAG_SPELLINGS[id][key];
    return spelling === null ? [] : [spelling];
  });
}

/**
 * The install command a person runs by hand, carrying the remembered flags so
 * pasting it does not reset `install-flags.json` to the defaults.
 */
export function installCommandFor(platform: NodeJS.Platform, flags: readonly InstallFlagId[] = []): string {
  const args = installerFlagArgs(flags, platform);
  if (platform === "win32") {
    return args.length > 0
      ? `& ([scriptblock]::Create((irm ${INSTALL_PS1_URL}))) ${args.join(" ")}`
      : `irm ${INSTALL_PS1_URL} | iex`;
  }
  return args.length > 0 ? `curl -fsSL ${INSTALL_SH_URL} | bash -s -- ${args.join(" ")}` : `curl -fsSL ${INSTALL_SH_URL} | bash`;
}

// ---------------------------------------------------------------------------
// The advert: what a server tells its page
// ---------------------------------------------------------------------------

/**
 * What updating means for the host that launched this server:
 *  - `script`: the binary the install script manages; one click runs it.
 *  - `copy`: a binary the script does not manage; the page offers the command.
 *  - `pi`: the Pi extension (npm): `pi update --extensions`, then `/reload` in Pi.
 *  - `opencode`: the install script again (it clears OpenCode's plugin cache), then `opencode2 reload` (OpenCode 1: restart it).
 */
export type UpdateAction = "script" | "copy" | "pi" | "opencode";

export interface UpdateAdvert {
  version: string;
  current: string;
  releaseUrl: string;
  action: UpdateAction;
  /** The command a person runs (with remembered flags); present for every action. */
  command: string;
  publishedAt?: string;
}

export function buildUpdateAdvert(input: {
  state: UpdateState;
  current: string | undefined;
  action: UpdateAction;
  platform: NodeJS.Platform;
  flags?: readonly InstallFlagId[];
}): UpdateAdvert | null {
  const current = normalizeStableVersion(input.current);
  if (!current) return null;
  const latest = knownLatestRelease(input.state);
  if (!latest || !isNewerStableVersion(latest.version, current)) return null;
  return {
    version: latest.version,
    current,
    releaseUrl: releaseUrlFor(latest.version),
    action: input.action,
    command: input.action === "pi" ? PI_UPDATE_COMMAND : installCommandFor(input.platform, input.flags ?? []),
    ...(latest.publishedAt && { publishedAt: latest.publishedAt }),
  };
}

/**
 * What a server tells its page when checking has failed for hours
 * (`updateCheckFailing`, beside `updateAvailable`, never with it): when it
 * began, why, and the command that updates without the check.
 */
export interface UpdateCheckFailingAdvert {
  since: string;
  error: string;
  command: string;
}

export function buildUpdateCheckFailing(state: UpdateState, now: number, command: string): UpdateCheckFailingAdvert | null {
  const failing = releaseCheckFailing(state, now);
  return failing ? { since: new Date(failing.since).toISOString(), error: failing.error.slice(0, 200), command } : null;
}

/**
 * The terminal hint (stderr, TTY only, at most once a day), read from the
 * cache. Returns the line to print and records that it printed, or null.
 */
export function takeUpdateHint(input: {
  current: string | undefined;
  enabled: boolean;
  now: number;
  dataDir?: string;
  platform?: NodeJS.Platform;
  /** The running binary is the install script's. False (brew, nix, a copy): it updates the way it was installed. Default true. */
  managed?: boolean;
}): string | null {
  if (!input.enabled) return null;
  const current = normalizeStableVersion(input.current);
  if (!current) return null;
  try {
    const state = readUpdateState(input.dataDir);
    const latest = knownLatestRelease(state);
    const newer = !!latest && isNewerStableVersion(latest.version, current);
    // Checking has failed for hours: say so, with the command that always works.
    const failing = newer ? null : releaseCheckFailing(state, input.now);
    if (!newer && !failing) return null;
    const last = state.hintShownAt;
    if (typeof last === "number" && last <= input.now && input.now - last < UPDATE_HINT_INTERVAL_MS) return null;
    patchUpdateState((s) => ({ ...s, hintShownAt: input.now }), input.dataDir);
    if (failing) {
      const since = `${new Date(failing.since).toISOString().slice(0, 16).replace("T", " ")} UTC`;
      if (input.managed === false) {
        return `Plannotator can't check for updates since ${since} (${failing.error}). This copy was not installed by the install script: update it the way you installed it.`;
      }
      const command = installCommandFor(input.platform ?? process.platform, readInstallFlags(input.dataDir).flags);
      return `Plannotator can't check for updates since ${since} (${failing.error}). To update: ${command}`;
    }
    return `Plannotator ${latest!.version} is available (you have ${current}). Update: plannotator update`;
  } catch {
    return null;
  }
}
