/**
 * The person's real Plannotator data directory, and the refusals that keep
 * every test and dev script out of it.
 *
 * "Real" means every place Plannotator would use when PLANNOTATOR_DATA_DIR is
 * unset (`getDefaultPlannotatorDataDir`: ~/.plannotator when it exists, else
 * $XDG_DATA_HOME/plannotator, else ~/.plannotator), worked out for BOTH the
 * home in $HOME and the account's home from the password database, because a
 * test that points HOME at a temp folder must still never reach the account's
 * own ~/.plannotator. ~/.plannotator and $XDG_DATA_HOME/plannotator are both
 * refused whichever one the product would pick today, and so is any folder
 * inside one of them. Paths compare after `realpath` (as far as they exist)
 * and case-insensitively on macOS and Windows, whose default file systems are.
 *
 * Node-safe (no Bun APIs): the Playwright specs run it under node.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { getDefaultPlannotatorDataDir } from "../../packages/shared/data-dir";

let accountHomeCache: string | null | undefined;

/**
 * The account's home from the password database, whatever $HOME says. Node's
 * `userInfo().homedir` reads it, but Bun's returns $HOME, so on POSIX ask the
 * shell too: `~user` expands through getpwnam, never through $HOME.
 */
export function accountHome(): string | null {
  if (accountHomeCache !== undefined) return accountHomeCache;
  let home: string | null = null;
  if (process.platform !== "win32") {
    const out = spawnSync("/bin/sh", ["-c", 'eval echo "~$(id -un)"'], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).stdout?.trim();
    if (out && isAbsolute(out)) home = out;
  }
  if (!home) {
    try {
      home = userInfo().homedir || null;
    } catch {
      home = null;
    }
  }
  accountHomeCache = home;
  return home;
}

/** Every home this process could mean: $HOME (as `homedir()` reads it) and the account's. */
function homes(): string[] {
  const found = new Set<string>();
  for (const home of [homedir(), process.env.HOME, accountHome()]) {
    if (home && isAbsolute(home)) found.add(home);
  }
  return [...found];
}

/** The real data directories, as written (not resolved). */
export function realDataDirs(): string[] {
  const dirs = new Set<string>();
  for (const home of homes()) {
    dirs.add(join(home, ".plannotator"));
    dirs.add(getDefaultPlannotatorDataDir(home));
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg && isAbsolute(xdg)) dirs.add(join(xdg, "plannotator"));
  return [...dirs];
}

/**
 * `path` with its longest existing prefix resolved through symlinks. A
 * dangling symlink on the way (a link to a data dir that does not exist yet)
 * is followed to its target, so it cannot hide what it points at.
 */
function canonical(path: string, depth = 0): string {
  let head = resolve(path);
  const tail: string[] = [];
  for (;;) {
    let link = false;
    try {
      link = lstatSync(head).isSymbolicLink();
    } catch {
      // Nothing here: try the parent.
      const parent = dirname(head);
      if (parent === head) break;
      tail.unshift(basename(head));
      head = parent;
      continue;
    }
    if (link && !existsSync(head) && depth < 40) {
      return canonical(join(resolve(dirname(head), readlinkSync(head)), ...tail), depth + 1);
    }
    try {
      head = realpathSync(head);
    } catch {
      // Unreadable: compare as written.
    }
    break;
  }
  const full = tail.length > 0 ? join(head, ...tail) : head;
  return process.platform === "darwin" || process.platform === "win32" ? full.toLowerCase() : full;
}

/** Expand `~` the way Plannotator expands PLANNOTATOR_DATA_DIR, against every home. */
function expansions(dir: string): string[] {
  const trimmed = dir.trim();
  if (trimmed === "~") return homes();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return homes().map((home) => join(home, trimmed.slice(2)));
  return [resolve(trimmed)];
}

/** `dir` is a real data directory or inside one. */
export function isRealDataDir(dir: string): boolean {
  const reals = realDataDirs().map(canonical);
  return expansions(dir).some((candidate) => {
    const path = canonical(candidate);
    return reals.some((real) => path === real || path.startsWith(`${real}${sep}`));
  });
}

/** Throw unless `dir` is set and is not (inside) the person's real data directory. Returns `dir`. */
export function refuseRealDataDir(dir: string | undefined, what: string): string {
  if (!dir || !dir.trim()) {
    throw new Error(`${what}: no data directory. Set PLANNOTATOR_DATA_DIR to a scratch folder; tests and dev scripts never use the default ~/.plannotator.`);
  }
  if (isRealDataDir(dir)) {
    throw new Error(`${what}: refusing ${dir}, the real Plannotator data directory (${realDataDirs().join(", ")}). Use a scratch folder.`);
  }
  return dir;
}

/**
 * Throw unless PLANNOTATOR_DATA_DIR is set and is not the real data directory.
 * Every Inbox test helper calls it before it starts, signals or removes
 * anything, so a test run that skipped the bunfig preload (run from a folder
 * without one, or by absolute path) fails instead of reaching ~/.plannotator.
 */
export function assertSandboxedDataDir(what = "Plannotator test"): string {
  return refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, what);
}
