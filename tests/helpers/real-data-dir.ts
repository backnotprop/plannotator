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
 * A relocated data dir (PLANNOTATOR_DATA_DIR=/custom in the person's shell) is
 * just as real, and cannot be told from a test's by its path, so the refusals
 * accept only scratch folders: inside the OS temp dir (or /tmp), or the test
 * sandbox the preload marked (`isScratchDataDir`).
 *
 * Node-safe (no Bun APIs): the Playwright specs run it under node.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync, realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
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

/**
 * The marker the test preload (tests/setup/feedback-archive-off.ts) and the
 * import-time sandbox (tests/setup/sandbox-data-dir.ts) set to the temp data
 * dir they made: a data dir at or inside it is a sandbox whatever TMPDIR says.
 */
export const TEST_SANDBOX_ENV = "PLANNOTATOR_TEST_SANDBOX";

/** The folders a scratch data dir lives under: the OS temp dir, $TMPDIR, /tmp and /var/tmp. */
function scratchRoots(): string[] {
  const roots = new Set<string>([tmpdir()]);
  if (process.env.TMPDIR && isAbsolute(process.env.TMPDIR)) roots.add(process.env.TMPDIR);
  if (process.platform !== "win32") {
    roots.add("/tmp");
    roots.add("/var/tmp");
  }
  const marker = process.env[TEST_SANDBOX_ENV]?.trim();
  if (marker && isAbsolute(marker)) roots.add(marker);
  return [...roots].map(canonical);
}

/**
 * `dir` is a scratch folder: strictly inside a temp root (or at/inside the
 * sandbox marker) and not a real data dir. A data dir anywhere else may be
 * the person's own: PLANNOTATOR_DATA_DIR=/custom in their shell IS their
 * real Inbox, so "not ~/.plannotator" is not enough.
 */
export function isScratchDataDir(dir: string): boolean {
  if (isRealDataDir(dir)) return false;
  const marker = process.env[TEST_SANDBOX_ENV]?.trim();
  const markerPath = marker && isAbsolute(marker) ? canonical(marker) : null;
  const roots = scratchRoots();
  return expansions(dir).every((candidate) => {
    const path = canonical(candidate);
    if (markerPath && (path === markerPath || path.startsWith(`${markerPath}${sep}`))) return true;
    return roots.some((root) => path.startsWith(`${root}${sep}`));
  });
}

/**
 * Throw unless `dir` is set and is a scratch folder (see `isScratchDataDir`):
 * never the person's real data directory, default or relocated. Returns `dir`.
 */
export function refuseRealDataDir(dir: string | undefined, what: string): string {
  if (!dir || !dir.trim()) {
    throw new Error(`${what}: no data directory. Set PLANNOTATOR_DATA_DIR to a scratch folder; tests and dev scripts never use the default ~/.plannotator.`);
  }
  if (isRealDataDir(dir)) {
    throw new Error(`${what}: refusing ${dir}, the real Plannotator data directory (${realDataDirs().join(", ")}). Use a scratch folder.`);
  }
  if (!isScratchDataDir(dir)) {
    throw new Error(`${what}: refusing ${dir}: not a scratch folder (inside ${tmpdir()} or /tmp). A data dir anywhere else may be a real Inbox.`);
  }
  return dir;
}

/**
 * Throw unless PLANNOTATOR_DATA_DIR is set and is a scratch folder. Every
 * Inbox test helper calls it before it starts, signals or removes anything,
 * so a test that pointed the env somewhere real fails instead of reaching it.
 */
export function assertSandboxedDataDir(what = "Plannotator test"): string {
  return refuseRealDataDir(process.env.PLANNOTATOR_DATA_DIR, what);
}

/**
 * Throw unless `configDir` is a scratch folder to set as CLAUDE_CONFIG_DIR. A test of anything that writes Claude
 * Code's global config goes through this, so it can never name the person's own `~/.claude.json` or `~/.claude`.
 * Returns `configDir`.
 */
export function refuseRealClaudeConfig(configDir: string, what: string): string {
  const path = canonical(configDir);
  const own = homes().map(canonical);
  if (own.some((home) => path === home || path === canonical(join(home, ".claude")))) {
    throw new Error(`${what}: refusing ${configDir}, the person's own Claude Code config. Use a scratch folder.`);
  }
  if (!isScratchDataDir(configDir)) throw new Error(`${what}: refusing ${configDir}: not a scratch folder (inside ${tmpdir()} or /tmp).`);
  return configDir;
}
