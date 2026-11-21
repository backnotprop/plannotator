/**
 * What's new's releases panel (design of record
 * .product/approved/inbox-whats-new-tldr/): the newest releases with their
 * dates and TL;DRs, from one request to GitHub's releases API a day.
 *
 *  - The list: `GET …/releases?per_page=20` (fetchReleaseList, the release
 *    check's client rules), asked when What's new opens and the last answer
 *    is over a day old (an hour after a failure; a rate limit waits what
 *    GitHub names, an hour to 6 h). Never while update checks are off.
 *    Cached in `update-notes/releases.json` (versions, dates, body stamps),
 *    so the panel works offline and `uninstall --purge` removes it.
 *  - Each listed release's notes are saved to `update-notes/<v>.json` from
 *    the same answer when none are saved yet, so opening one needs no request
 *    of its own. Notes saved WITHOUT a TL;DR are written again once when the
 *    list's body differs from the one they were read from (`stamp`): a TL;DR
 *    added to an older release later reaches people who saved it before.
 *    Notes that have a TL;DR are left as saved.
 *  - The panel's rows are the listed releases and the notes saved on this
 *    computer (newest first, at most PANEL_ROWS, the running version always
 *    in). A row's words come from its TL;DR; the client falls back to its
 *    line in the newest saved "Missed recent releases?" table, then the
 *    first sentence of its notes, then "No summary".
 *
 * Bun-only, like the rest of the Inbox.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  compareStableVersions,
  fetchReleaseList,
  hasReleaseNotesContent,
  normalizeStableVersion,
  readReleaseNotes,
  releaseNotesFrom,
  releaseSummary,
  updateCheckPaths,
  updateLog,
  writeReleaseNotes,
  type FetchReleaseListResult,
  type TldrLine,
} from "@plannotator/shared/update-check";

/** A successful list is asked for again after a day. */
export const RELEASE_LIST_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** A failed one (offline, a 5xx) after an hour. */
export const RELEASE_LIST_RETRY_MS = 60 * 60 * 1000;
/** A rate-limited one waits what GitHub names, kept between an hour and this. */
export const RELEASE_LIST_RATE_LIMITED_MAX_MS = 6 * 60 * 60 * 1000;
/** The panel's rows at most (the running version is always one of them). */
export const PANEL_ROWS = 30;
/** Saved notes read for the panel's rows and fallback lines, newest first. */
const NOTES_READ = 40;

export interface ReleaseListCache {
  /** The last request (claimed before it is made). */
  attemptedAt: number;
  /** The last request that answered. */
  fetchedAt?: number;
  /** Set when the last request failed. */
  failedAt?: number;
  error?: string;
  /** No request before this (a failure's or a rate limit's wait). */
  retryAt?: number;
  /** The last answer's releases, newest first. */
  releases: { version: string; publishedAt?: string; stamp?: string }[];
}

export function releaseListPath(dataDir: string): string {
  return join(updateCheckPaths(dataDir).notes, "releases.json");
}

export function readReleaseList(dataDir: string): ReleaseListCache | null {
  try {
    const raw = JSON.parse(readFileSync(releaseListPath(dataDir), "utf-8")) as Partial<ReleaseListCache>;
    if (!raw || typeof raw.attemptedAt !== "number" || !Number.isFinite(raw.attemptedAt)) return null;
    const releases = Array.isArray(raw.releases)
      ? raw.releases.flatMap((r) => {
          const version = normalizeStableVersion(r?.version);
          if (!version) return [];
          return [{ version, ...(typeof r.publishedAt === "string" && { publishedAt: r.publishedAt }), ...(typeof r.stamp === "string" && { stamp: r.stamp }) }];
        })
      : [];
    return {
      attemptedAt: raw.attemptedAt,
      ...(typeof raw.fetchedAt === "number" && { fetchedAt: raw.fetchedAt }),
      ...(typeof raw.failedAt === "number" && { failedAt: raw.failedAt }),
      ...(typeof raw.error === "string" && { error: raw.error }),
      ...(typeof raw.retryAt === "number" && { retryAt: raw.retryAt }),
      releases,
    };
  } catch {
    return null;
  }
}

function writeReleaseList(cache: ReleaseListCache, dataDir: string): void {
  const path = releaseListPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** Whether the list may be asked for now: a day after an answer, an hour after a failure, never before a rate limit's wait. */
export function isReleaseListDue(cache: ReleaseListCache | null, now: number): boolean {
  if (!cache) return true;
  const at = cache.attemptedAt;
  // A clock moved back: ask, rather than wait out a date in the future.
  if (at > now) return true;
  if (typeof cache.retryAt === "number" && cache.retryAt > now && cache.retryAt - at <= RELEASE_LIST_RATE_LIMITED_MAX_MS) return false;
  const failed = typeof cache.failedAt === "number" && cache.failedAt >= at;
  return now - at >= (failed ? RELEASE_LIST_RETRY_MS : RELEASE_LIST_INTERVAL_MS);
}

/** The last request failed (the panel and the notes page say "Can't reach GitHub" from it). */
export function releaseListFailing(cache: ReleaseListCache | null): boolean {
  return !!cache && typeof cache.failedAt === "number" && cache.failedAt >= cache.attemptedAt;
}

export interface ReleaseListDeps {
  dataDir: string;
  now?: () => number;
  /** The knob (resolveUpdateCheck): off, nothing is asked. */
  enabled: () => boolean;
  /** The person's Try again: ask now, whatever the throttle says (`enabled` still applies). */
  force?: boolean;
  fetchList?: () => Promise<FetchReleaseListResult>;
}

export type ReleaseListOutcome =
  | { outcome: "disabled" | "not-due" }
  | { outcome: "fetched"; versions: string[]; written: string[] }
  | { outcome: "failed"; error: string };

/**
 * Ask for the newest releases when it is time, cache the list and save the
 * notes it brings (see the header). Never throws.
 */
export async function refreshReleaseList(deps: ReleaseListDeps): Promise<ReleaseListOutcome> {
  if (!deps.enabled()) return { outcome: "disabled" };
  const now = (deps.now ?? Date.now)();
  const before = readReleaseList(deps.dataDir);
  if (!deps.force && !isReleaseListDue(before, now)) return { outcome: "not-due" };
  const keep = before?.releases ?? [];
  try {
    writeReleaseList({ ...(before ?? { releases: [] }), attemptedAt: now, releases: keep }, deps.dataDir);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateLog(`could not write ${releaseListPath(deps.dataDir)}: ${error}`, deps.dataDir, "whats-new");
    return { outcome: "failed", error };
  }
  const result = await (deps.fetchList ?? (() => fetchReleaseList()))();
  if (!result.ok) {
    const wait = result.rateLimited
      ? Math.min(Math.max(result.retryAfterMs ?? RELEASE_LIST_RETRY_MS, RELEASE_LIST_RETRY_MS), RELEASE_LIST_RATE_LIMITED_MAX_MS)
      : RELEASE_LIST_RETRY_MS;
    try {
      writeReleaseList(
        {
          attemptedAt: now,
          ...(before?.fetchedAt !== undefined && { fetchedAt: before.fetchedAt }),
          failedAt: now,
          error: result.error.slice(0, 200),
          ...(result.rateLimited && { retryAt: now + wait }),
          releases: keep,
        },
        deps.dataDir,
      );
    } catch {}
    // One line per run of failures, not one per hour.
    if (!releaseListFailing(before) || before?.error !== result.error.slice(0, 200)) {
      updateLog(`could not read the release list (${result.error}); next try in ${Math.round(wait / 60_000)}m`, deps.dataDir, "whats-new");
    }
    return { outcome: "failed", error: result.error };
  }
  const written: string[] = [];
  const releases: ReleaseListCache["releases"] = [];
  for (const release of result.releases) {
    const version = normalizeStableVersion(release.tag);
    if (!version || releases.some((r) => r.version === version)) continue;
    const fresh = releaseNotesFrom(version, release);
    releases.push({ version, ...(release.publishedAt && { publishedAt: release.publishedAt }), stamp: fresh.stamp });
    if (!fresh.notes) continue; // GitHub's generated body (the written notes come later): nothing to read yet.
    const saved = readReleaseNotes(version, deps.dataDir);
    const missing = !hasReleaseNotesContent(saved);
    // Saved without a TL;DR, from another body than this one: written again, once (the stamps then match).
    const backfilled = !missing && (saved.tldr?.length ?? 0) === 0 && saved.stamp !== fresh.stamp;
    if (!missing && !backfilled) continue;
    try {
      writeReleaseNotes(fresh, deps.dataDir);
      written.push(version);
    } catch (err) {
      updateLog(`could not save the release notes for ${version}: ${err instanceof Error ? err.message : String(err)}`, deps.dataDir, "whats-new");
    }
  }
  releases.sort((a, b) => compareStableVersions(b.version, a.version) ?? 0);
  try {
    writeReleaseList({ attemptedAt: now, fetchedAt: now, releases }, deps.dataDir);
  } catch {}
  if (releaseListFailing(before)) updateLog(`the release list answered again (${releases.length} releases)`, deps.dataDir, "whats-new");
  return { outcome: "fetched", versions: releases.map((r) => r.version), written };
}

/** One release in the panel (GET /api/inbox/whats-new/releases). */
export interface WhatsNewRelease {
  version: string;
  published_at: string | null;
  /** Its TL;DR (empty: none). */
  tldr: TldrLine[];
  /** Its line in the newest saved "Missed recent releases?" table, and the release whose notes carry it. */
  listed: { text: string; in: string } | null;
  /** The first sentence of its saved notes. */
  sentence: string | null;
  /** Its notes are saved on this computer (they open offline). */
  saved: boolean;
}

export interface WhatsNewReleases {
  /** The newest release this computer knows of (the panel's Latest card); null with no rows. */
  latest: string | null;
  /** The version this Inbox runs (`dev` for a development build). */
  current: string;
  /** Newest first. */
  releases: WhatsNewRelease[];
  /** The list is being asked for now: the page asks again shortly. */
  refreshing: boolean;
  /** The last request for the list failed (offline, GitHub refused). */
  offline: boolean;
  /** When the list last answered (ISO); null: never. */
  fetched_at: string | null;
}

/** The versions whose notes are saved here, newest first. */
function savedVersions(dataDir: string): string[] {
  try {
    return readdirSync(updateCheckPaths(dataDir).notes)
      .flatMap((name) => {
        const m = /^(\d+\.\d+\.\d+)\.json$/.exec(name);
        const v = m ? normalizeStableVersion(m[1]) : null;
        return v ? [v] : [];
      })
      .sort((a, b) => compareStableVersions(b, a) ?? 0);
  } catch {
    return [];
  }
}

/** The first sentence of the notes' opening paragraph, as plain text (no links, no bold), or null. */
export function firstSentence(notes: string): string | null {
  const para = releaseSummary(notes)
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!para) return null;
  const m = /^(.{8,280}?[.!?])(?=\s|$)/.exec(para);
  if (m) return m[1]!;
  return para.length > 200 ? `${para.slice(0, 199).trimEnd()}…` : para;
}

/** The panel's model, from the cached list and the notes saved here (no request). */
export function whatsNewReleases(
  dataDir: string,
  input: {
    current: string;
    refreshing: boolean;
    /** Versions to show though neither listed nor saved: the newest release the release check knows of, the one running. */
    known?: (string | null | undefined)[];
  },
): WhatsNewReleases {
  const cache = readReleaseList(dataDir);
  const listed = new Map((cache?.releases ?? []).map((r) => [r.version, r]));
  const saved = savedVersions(dataDir);
  const notes = new Map(saved.slice(0, NOTES_READ).map((v) => [v, readReleaseNotes(v, dataDir)]));
  const current = normalizeStableVersion(input.current);
  const known = (input.known ?? []).flatMap((v) => {
    const n = normalizeStableVersion(v);
    return n ? [n] : [];
  });
  const all = [...new Set([...listed.keys(), ...saved, ...known])].sort((a, b) => compareStableVersions(b, a) ?? 0);
  let rows = all.slice(0, PANEL_ROWS);
  if (current && all.includes(current) && !rows.includes(current)) rows = [...rows, current];
  // A row's table line: the newest saved notes whose "Missed recent releases?" table names it.
  const tableLine = (version: string): WhatsNewRelease["listed"] => {
    for (const [from, n] of notes) {
      const hit = n?.highlights.find((h) => h.version === version);
      if (hit) return { text: hit.text, in: from };
    }
    return null;
  };
  const releases = rows.map((version): WhatsNewRelease => {
    const n = notes.get(version) ?? (saved.includes(version) ? readReleaseNotes(version, dataDir) : null);
    const has = hasReleaseNotesContent(n);
    return {
      version,
      published_at: listed.get(version)?.publishedAt ?? n?.publishedAt ?? null,
      tldr: n?.tldr ?? [],
      listed: tableLine(version),
      sentence: has ? firstSentence(n.notes) : null,
      saved: has,
    };
  });
  return {
    latest: releases[0]?.version ?? null,
    current: input.current,
    releases,
    refreshing: input.refreshing,
    offline: releaseListFailing(cache),
    fetched_at: typeof cache?.fetchedAt === "number" ? new Date(cache.fetchedAt).toISOString() : null,
  };
}

/** The cached list names this version (the What's new route may fetch its notes by its tag). */
export function releaseListNames(dataDir: string, version: string): boolean {
  return readReleaseList(dataDir)?.releases.some((r) => r.version === version) ?? false;
}
