/**
 * Tripwires — Bun server helpers.
 *
 * Runtime glue for the pure tripwire evaluation logic in
 * @plannotator/shared/tripwires. Two layers are resolved and merged: a global,
 * per-project file under `<dataDir>/tripwires/<key>.json` (keyed by remote
 * identity, or the git-common-dir for remote-less repos) and the repo-local
 * `.plannotator/tripwires.json`. Every helper fails open (returns null / empty)
 * so a missing repo, missing config, or unreadable global file never breaks
 * code review.
 *
 * The Pi extension has mirror helpers using node:child_process at
 * apps/pi-extension/server/serverReview.ts.
 */

import { $ } from "bun";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  normalizeRemoteIdentity,
  mergeTripwiresConfigs,
  parseTripwiresConfig,
  parseTripwiresConfigDetailed,
  type TripwiresConfig,
  type TripwireDiagnostic,
} from "@plannotator/shared/tripwires";
import { getPlannotatorDataDir } from "@plannotator/shared/data-dir";

/**
 * Resolve the git repository root for a working directory. Returns null when
 * the directory is not inside a git repo (or git is unavailable).
 */
export async function repoRootFromCwd(cwd: string): Promise<string | null> {
  try {
    const result = await $`git rev-parse --show-toplevel`.cwd(cwd).quiet().nothrow();
    if (result.exitCode === 0) {
      const root = result.stdout.toString().trim();
      return root || null;
    }
  } catch {
    // Not in a git repo
  }
  return null;
}

/**
 * Read `.plannotator/tripwires.json` from a repo root. Returns null on miss or
 * any read error (fail-open).
 */
export function readTripwiresFile(root: string): string | null {
  try {
    const path = `${root}/.plannotator/tripwires.json`;
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Resolve the `origin` remote URL for a working directory. Returns null when
 * there is no remote (or git is unavailable). Used to derive a stable project
 * identity so the global tripwires file follows a repo across clones/worktrees.
 */
export async function remoteUrlFromCwd(cwd: string): Promise<string | null> {
  try {
    const result = await $`git remote get-url origin`.cwd(cwd).quiet().nothrow();
    if (result.exitCode === 0) {
      const url = result.stdout.toString().trim();
      return url || null;
    }
  } catch {
    // No remote / not a git repo
  }
  return null;
}

/**
 * Resolve the canonical per-repo base directory shared across linked worktrees.
 * Uses `git rev-parse --git-common-dir` (which resolves to the shared `.git`
 * across all worktrees, unlike `--show-toplevel` which is per-worktree), then
 * takes its parent. Used only for the remote-less identity fallback so all
 * worktrees of one repo collapse to a single global key. Returns null when not
 * in a git repo.
 */
export async function repoKeyBaseFromCwd(cwd: string): Promise<string | null> {
  try {
    const result = await $`git rev-parse --path-format=absolute --git-common-dir`
      .cwd(cwd)
      .quiet()
      .nothrow();
    if (result.exitCode === 0) {
      const commonDir = result.stdout.toString().trim();
      if (commonDir) return dirname(commonDir);
    }
    // `--path-format=absolute` was added in git 2.31 (2021); on older git the
    // command above errors. Fall back to the plain (possibly relative)
    // common-dir resolved against cwd, so distinct remote-less repos never
    // collapse onto one shared global key (worktree-sharing is then best-effort).
    const fallback = await $`git rev-parse --git-common-dir`.cwd(cwd).quiet().nothrow();
    if (fallback.exitCode === 0) {
      const commonDir = fallback.stdout.toString().trim();
      if (commonDir) return dirname(resolve(cwd, commonDir));
    }
  } catch {
    // Not in a git repo
  }
  return null;
}

/** Hash a project identity into a short, filesystem-safe key. */
export function projectKeyFromIdentity(identity: string): string {
  return createHash("sha256").update(identity).digest("hex").slice(0, 16);
}

/** Absolute path of the global tripwires file for a project key. */
export function globalTripwiresPath(key: string): string {
  return join(getPlannotatorDataDir(), "tripwires", `${key}.json`);
}

/**
 * Read the global tripwires file for a project key. Returns null on miss or any
 * read error (fail-open).
 */
export function readGlobalTripwiresFile(key: string): string | null {
  try {
    const path = globalTripwiresPath(key);
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Lazily create the global tripwires file (`{ "rules": [] }`) the first time a
 * project is reviewed, so users have a discoverable file to populate. Write-once
 * and race-tolerant: if the file appears between the exists-check and the write
 * (another concurrent session), the EEXIST is swallowed; any other error is
 * logged but never thrown (fail-open).
 */
export function ensureGlobalTripwiresFile(key: string): void {
  try {
    const path = globalTripwiresPath(key);
    if (existsSync(path)) return;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{\n  "rules": []\n}\n`, { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EEXIST: a concurrent session created it first — that's fine.
    if (code === "EEXIST") return;
    console.error("[tripwires] failed to create global file:", err);
  }
}

/**
 * Write the global tripwires file for a project key. Unlike review-time reads
 * this is an explicit user action (`tripwires add`), so failures THROW for the
 * CLI to report rather than failing open.
 */
export function writeGlobalTripwiresFile(key: string, json: string): string {
  const path = globalTripwiresPath(key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, "utf-8");
  return path;
}

/**
 * Write the repo-committed tripwires file. Only called from the explicit
 * `tripwires add --repo` path — this is the ONE place Plannotator creates
 * `.plannotator/` inside a repo, and only because the user asked. Throws on
 * failure (explicit action, not fail-open).
 */
export function writeRepoTripwiresFile(root: string, json: string): string {
  const path = join(root, ".plannotator", "tripwires.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, json, "utf-8");
  return path;
}

/**
 * Resolve the merged (global + repo) tripwires config for a working directory.
 * Global rules come first, repo rules are appended (see
 * {@link mergeTripwiresConfigs}). The global file is auto-created once if
 * missing. Returns the merged config plus the repo root, project key, and any
 * error-level diagnostics from the global layer (the caller decides logging).
 */
export async function resolveMergedTripwires(cwd: string): Promise<{
  config: TripwiresConfig;
  root: string | null;
  key: string | null;
  globalDiagnostics: TripwireDiagnostic[];
}> {
  const root = await repoRootFromCwd(cwd);
  const remote = await remoteUrlFromCwd(cwd);
  const keyBase = await repoKeyBaseFromCwd(cwd);
  const identity = normalizeRemoteIdentity(remote, keyBase);
  const key = projectKeyFromIdentity(identity);

  ensureGlobalTripwiresFile(key);
  const globalParsed = parseTripwiresConfigDetailed(readGlobalTripwiresFile(key));
  const repo = root ? parseTripwiresConfig(readTripwiresFile(root)) : { rules: [] };

  return {
    config: mergeTripwiresConfigs(globalParsed.config, repo),
    root,
    key,
    globalDiagnostics: globalParsed.diagnostics,
  };
}
