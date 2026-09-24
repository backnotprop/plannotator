/**
 * Vibe Plan Resolver
 *
 * Vibe (Mistral's TUI coding agent) writes plans to
 *   $VIBE_HOME/plans/{timestamp}-{slug}.md   (global dir, NOT per-project)
 * and the plan is NOT carried in the `exit_plan_mode` hook payload
 * (the tool's args model is empty). The pre_tool payload DOES carry
 * `transcript_path`, so we pin the plan by scanning the transcript backward
 * for the last write_file/edit tool result targeting a file under the plans
 * dir, and gate that file. This avoids the two hazards of a bare newest-by-
 * mtime pick on a global dir: two concurrent sessions cross-serving each
 * other's plans, and a stale plan from a failed write reviewing as current.
 *
 * Fallbacks (transcript missing, no plans write found there): newest-by-mtime
 * within a freshness window (PLAN_FRESHNESS_MS). Older than that, fail open —
 * an empty plan must never lock the user out of plan mode.
 *
 * VIBE_HOME resolution mirrors vibe/utils/paths.py:get_vibe_home():
 *   $VIBE_HOME env var → ~/.vibe (default), then appends /plans.
 */

import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";

/** Freshness window for the mtime fallback: a plan older than this is treated
 * as stale (the session's write likely failed) and the gate fails open. */
export const PLAN_FRESHNESS_MS = 10 * 60 * 1000;

function expandTilde(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}

/** Resolve the Vibe plans directory ($VIBE_HOME/plans, default ~/.vibe/plans). */
export function resolveVibePlansDir(vibeHomeOverride?: string): string {
  const vibeHome = vibeHomeOverride
    ? expandTilde(vibeHomeOverride)
    : process.env.VIBE_HOME
      ? expandTilde(process.env.VIBE_HOME)
      : join(homedir(), ".vibe");
  return join(vibeHome, "plans");
}

/**
 * Canonical form of a directory for comparison: resolved (which also drops a
 * trailing slash) and, when it exists, realpath'd so a symlinked VIBE_HOME or
 * a symlinked path segment in the transcript still matches. A path that
 * cannot be realpath'd (missing, unreadable) falls back to its resolved form.
 */
function canonicalDir(dir: string): string {
  const resolved = resolve(dir);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInsidePlansDir(filePath: string, plansDir: string): boolean {
  if (!filePath.endsWith(".md")) return false;
  return canonicalDir(dirname(filePath)) === canonicalDir(plansDir);
}

/**
 * Find the plan file this session wrote, by scanning the Vibe transcript
 * (messages.jsonl) backward for the last write_file/edit tool result whose
 * target lives in the plans dir.
 *
 * Vibe persists tool results as lines with `tool_result.output` shaped by the
 * tool's `project_result`: write_file yields `{ file_path, bytes_written,
 * content }`, edit yields `{ file, old_string, new_string, ... }`. The newest
 * match wins.
 *
 * Returns the absolute plan path, or null when the transcript is missing,
 * unreadable, or contains no plans-dir write.
 */
export function findVibePlanInTranscript(
  transcriptPath: string,
  opts?: { vibeHome?: string },
): string | null {
  const plansDir = resolveVibePlansDir(opts?.vibeHome);
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf-8").split("\n");
  } catch {
    return null;
  }

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.role !== "tool") continue;
    const output = entry?.tool_result?.output;
    if (!output || typeof output !== "object") continue;
    const target: unknown =
      typeof output.file_path === "string" ? output.file_path :
      typeof output.file === "string" ? output.file :
      undefined;
    if (!target) continue;
    if (!isInsidePlansDir(target, plansDir)) continue;
    if (!existsSync(target)) continue;
    return target;
  }
  return null;
}

/**
 * Read the most-recently-modified `*.md` plan from the Vibe plans dir.
 * Returns the file path plus contents, or null when the dir is missing/empty.
 *
 * Concurrency caveat: Vibe's plans dir is global, so two sessions exiting
 * plan mode simultaneously could race. The transcript-pinned resolver above
 * is the primary path; this is its fallback.
 */
export function findNewestVibePlan(
  opts?: { vibeHome?: string; now?: number },
): { path: string; content: string; mtimeMs: number } | null {
  const plansDir = resolveVibePlansDir(opts?.vibeHome);
  if (!existsSync(plansDir)) return null;

  let entries: string[];
  try {
    entries = readdirSync(plansDir);
  } catch {
    return null;
  }

  const mdFiles = entries.filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) return null;

  let newestFile: string | null = null;
  let newestMtime = -1;
  for (const f of mdFiles) {
    try {
      const mtime = statSync(join(plansDir, f)).mtimeMs;
      if (mtime > newestMtime) {
        newestMtime = mtime;
        newestFile = f;
      }
    } catch {
      continue;
    }
  }

  if (!newestFile) return null;
  const planPath = join(plansDir, newestFile);
  if ((opts?.now ?? Date.now()) - newestMtime > PLAN_FRESHNESS_MS) {
    // Stale: the plan predates the freshness window, so the current session's
    // write likely failed. Do not review a yesterday-plan as current.
    return null;
  }

  try {
    return { path: planPath, content: readFileSync(planPath, "utf-8"), mtimeMs: newestMtime };
  } catch {
    return null;
  }
}

/**
 * Resolve the plan content to gate for a Vibe pre_tool/exit_plan_mode hook.
 *
 * Priority: transcript-pinned file (the plan this session actually wrote)
 * > newest-by-mtime plan inside the freshness window. Everything else
 * (no transcript, no pinned write, no fresh plan) returns null so the gate
 * fails open.
 */
export function resolveLatestVibePlan(
  opts?: { vibeHome?: string; transcriptPath?: string; now?: number },
): string | null {
  if (opts?.transcriptPath) {
    const pinned = findVibePlanInTranscript(opts.transcriptPath, opts);
    if (pinned) {
      try {
        return readFileSync(pinned, "utf-8");
      } catch {
        // fall through to the mtime fallback
      }
    }
  }
  return findNewestVibePlan(opts)?.content ?? null;
}
