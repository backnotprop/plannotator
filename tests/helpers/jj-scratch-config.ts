/**
 * A scratch config folder for every jj process a test file starts.
 *
 * jj records each repository it opens in its config folder: a
 * `<config dir>/jj/repos/<id>/` entry (and `workspaces/<id>/`) for its
 * per-repo secure config. jj-vcs/jj cli/src/config.rs takes `<config dir>`
 * from `etcetera::choose_base_strategy().config_dir()`: on macOS and Linux
 * `$XDG_CONFIG_HOME` when it is set, else `$HOME/.config`; on Windows the
 * home's `AppData\Roaming`. `JJ_CONFIG` moves only the user config files, not
 * that folder. Tests make throwaway repos by the hundred, so without this
 * every run leaves entries in the developer's real config folder.
 *
 * `useScratchJjConfig()` sets XDG_CONFIG_HOME to one temp folder for the
 * file's tests: set in beforeAll (repos built there get it too), set again
 * before each test (a file's own afterEach may restore the variable), and
 * restored and removed in afterAll. The review runtimes copy the live
 * `process.env` into their jj children (packages/server/jj.ts `childEnv()`,
 * the Pi runtime's async spawn), so they inherit it. `env()` is the
 * environment for a test's own jj spawns: pass it explicitly, because a Bun
 * or synchronous spawn without `env` can start from the environment the
 * process started with. On Windows XDG_CONFIG_HOME is not read; the preload's
 * scratch USERPROFILE covers it.
 *
 * tests/jj-scratch-config.test.ts proves the folder jj resolves is this one,
 * and fails on a test file that spawns jj without calling this.
 */
import { afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface ScratchJjConfig {
  /** The folder jj uses as its config dir (`<dir>/jj/repos/…`). Set once beforeAll has run. */
  readonly dir: string;
  /** A copy of the live `process.env` with XDG_CONFIG_HOME pointed at `dir`, and `extra` laid over it. */
  env(extra?: Readonly<Record<string, string | undefined>>): Record<string, string | undefined>;
}

/** Call at the top of a test file (or a describe) whose tests run jj. */
export function useScratchJjConfig(): ScratchJjConfig {
  let dir: string | null = null;
  let saved: string | undefined;

  const scratch = (): string => {
    if (!dir) throw new Error("useScratchJjConfig: the scratch jj config folder exists only while the file's tests run");
    return dir;
  };

  beforeAll(() => {
    saved = process.env.XDG_CONFIG_HOME;
    dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-jj-config-")));
    process.env.XDG_CONFIG_HOME = dir;
  });
  beforeEach(() => {
    process.env.XDG_CONFIG_HOME = scratch();
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  return {
    get dir() {
      return scratch();
    },
    env(extra) {
      const env: Record<string, string | undefined> = { ...process.env, XDG_CONFIG_HOME: scratch() };
      for (const [key, value] of Object.entries(extra ?? {})) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
      return env;
    },
  };
}
