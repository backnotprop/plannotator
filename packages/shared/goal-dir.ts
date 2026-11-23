/**
 * Where /goal packages live (`plannotator setup-goal dir <slug>`).
 *
 * Root, highest wins:
 *   PLANNOTATOR_GOALS_DIR env var  →  config.goalsDir  →  default `goals`
 *
 * A relative root resolves against the working directory, `~` and `~/x` against
 * the home directory.
 */

import { mkdirSync } from "fs";
import { homedir } from "os";
import { isAbsolute, join, resolve } from "path";
import { loadConfig, type PlannotatorConfig } from "./config";

export const DEFAULT_GOALS_DIR = "goals";

export interface GoalDirContext {
  config: Pick<PlannotatorConfig, "goalsDir">;
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
}

function nonBlank(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

export function resolveGoalsRoot(
  config: Pick<PlannotatorConfig, "goalsDir">,
  ctx: Pick<GoalDirContext, "env" | "cwd" | "home"> = { env: process.env, cwd: process.cwd(), home: homedir() },
): string {
  const raw = nonBlank(ctx.env.PLANNOTATOR_GOALS_DIR) ?? nonBlank(config.goalsDir) ?? DEFAULT_GOALS_DIR;
  if (raw === "~") return ctx.home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return resolve(ctx.home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(ctx.cwd, raw);
}

/** Null when the slug is usable as one folder name, else the reason it is not. */
export function validateGoalSlug(slug: string): string | null {
  if (slug.trim() === "") return "the goal slug is empty";
  if (slug === "." || slug === "..") return `the goal slug cannot be "${slug}"`;
  if (/[\\/]/.test(slug)) return "the goal slug cannot contain a path separator";
  return null;
}

/** Creates `<root>/<slug>` (mkdir -p) and returns its absolute path. Throws on an invalid slug. */
export function ensureGoalDir(
  slug: string,
  ctx: GoalDirContext = { config: loadConfig(), env: process.env, cwd: process.cwd(), home: homedir() },
): string {
  const problem = validateGoalSlug(slug);
  if (problem) throw new Error(problem);
  const dir = join(resolveGoalsRoot(ctx.config, ctx), slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}
