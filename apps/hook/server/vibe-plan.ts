/**
 * Vibe Plan Resolver
 *
 * Vibe (Mistral's TUI coding agent) writes plans to
 *   $VIBE_HOME/plans/{timestamp}-{slug}.md   (global dir, NOT per-project)
 * and the plan is NOT carried in the `exit_plan_mode` hook payload
 * (the tool's args model is empty). The pre_tool hook only tells us the
 * tool is about to fire, so we resolve the plan by picking the newest
 * `*.md` file in the plans directory by mtime.
 *
 * VIBE_HOME resolution mirrors vibe/utils/paths.py:get_vibe_home():
 *   $VIBE_HOME env var → ~/.vibe (default), then appends /plans.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
 * Read the most-recently-modified `*.md` plan from the Vibe plans dir.
 * Returns the file contents, or null when the dir is missing/empty.
 *
 * Concurrency caveat: Vibe's plans dir is global, so two sessions exiting
 * plan mode simultaneously could race. Newest-by-mtime is the best
 * available heuristic since the hook carries no plan path.
 */
export function resolveLatestVibePlan(opts?: { vibeHome?: string }): string | null {
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

  try {
    return readFileSync(join(plansDir, newestFile), "utf-8");
  } catch {
    return null;
  }
}
