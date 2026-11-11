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

export const RELEASE_LIST_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const RELEASE_LIST_RETRY_MS = 60 * 60 * 1000;
export const RELEASE_LIST_RATE_LIMITED_MAX_MS = 6 * 60 * 60 * 1000;
export const PANEL_ROWS = 30;
const NOTES_READ = 40;

export interface ReleaseListCache {
  attemptedAt: number;
  fetchedAt?: number;
  failedAt?: number;
  error?: string;
  retryAt?: number;
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

export function isReleaseListDue(cache: ReleaseListCache | null, now: number): boolean {
  if (!cache) return true;
  const at = cache.attemptedAt;
  // A clock moved back: ask, rather than wait out a date in the future.
  if (at > now) return true;
  if (typeof cache.retryAt === "number" && cache.retryAt > now && cache.retryAt - at <= RELEASE_LIST_RATE_LIMITED_MAX_MS) return false;
  const failed = typeof cache.failedAt === "number" && cache.failedAt >= at;
  return now - at >= (failed ? RELEASE_LIST_RETRY_MS : RELEASE_LIST_INTERVAL_MS);
}

export function releaseListFailing(cache: ReleaseListCache | null): boolean {
  return !!cache && typeof cache.failedAt === "number" && cache.failedAt >= cache.attemptedAt;
}

export interface ReleaseListDeps {
  dataDir: string;
  now?: () => number;
  enabled: () => boolean;
  force?: boolean;
  fetchList?: () => Promise<FetchReleaseListResult>;
}

export type ReleaseListOutcome =
  | { outcome: "disabled" | "not-due" }
  | { outcome: "fetched"; versions: string[]; written: string[] }
  | { outcome: "failed"; error: string };

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
    if (!fresh.notes) continue;
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

export interface WhatsNewRelease {
  version: string;
  published_at: string | null;
  tldr: TldrLine[];
  listed: { text: string; in: string } | null;
  sentence: string | null;
  saved: boolean;
}

export interface WhatsNewReleases {
  latest: string | null;
  current: string;
  releases: WhatsNewRelease[];
  refreshing: boolean;
  offline: boolean;
  fetched_at: string | null;
}

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

export function whatsNewReleases(
  dataDir: string,
  input: {
    current: string;
    refreshing: boolean;
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

export function releaseListNames(dataDir: string, version: string): boolean {
  return readReleaseList(dataDir)?.releases.some((r) => r.version === version) ?? false;
}
