import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { homedir } from "node:os";

export const PLAN_FRESHNESS_MS = 10 * 60 * 1000;

function expandTilde(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}

export function resolveVibePlansDir(vibeHomeOverride?: string): string {
  const vibeHome = vibeHomeOverride
    ? expandTilde(vibeHomeOverride)
    : process.env.VIBE_HOME
      ? expandTilde(process.env.VIBE_HOME)
      : join(homedir(), ".vibe");
  return join(vibeHome, "plans");
}

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
    const target: string | undefined =
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
    return null;
  }

  try {
    return { path: planPath, content: readFileSync(planPath, "utf-8"), mtimeMs: newestMtime };
  } catch {
    return null;
  }
}

export function resolveLatestVibePlan(
  opts?: { vibeHome?: string; transcriptPath?: string; now?: number },
): string | null {
  if (opts?.transcriptPath) {
    const pinned = findVibePlanInTranscript(opts.transcriptPath, opts);
    if (pinned) {
      try {
        return readFileSync(pinned, "utf-8");
      } catch {
      }
    }
  }
  return findNewestVibePlan(opts)?.content ?? null;
}
