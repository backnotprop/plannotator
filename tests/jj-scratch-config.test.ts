/**
 * jj tests never write to the developer's config folder.
 *
 * jj keeps a `<config dir>/jj/repos/<id>/` entry for every repository it
 * opens, and the test suite makes throwaway repos by the hundred: before
 * tests/helpers/jj-scratch-config.ts, each run left them in the real config
 * folder. This file proves the folder jj resolves under the helper is the
 * helper's temp folder (for a test's own spawn and for both review runtimes'
 * jj children), and fails on a test file that spawns jj without the helper.
 *
 * It never reads or lists the real config folder: it asks jj where its repo
 * config lives and checks that path.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { runtime as bunJjRuntime } from "../packages/server/jj";
import { jjRuntime as piJjRuntime } from "../apps/pi-extension/server/vcs";
import { useScratchJjConfig } from "./helpers/jj-scratch-config";
import { stripComments } from "./helpers/real-inbox-scan";

const jjConfig = useScratchJjConfig();
const hasJj = Bun.which("jj") !== null;

/** A spawn of jj (Bun or node:child_process, or a file's own `run("jj", …)`) other than `jj --version`, which opens no repo. */
const JJ_SPAWN = /\b(?:spawn|spawnSync|execFile|execFileSync|run)\(\s*\[?\s*["'`]jj["'`]\s*(?:,|\])(?!\s*\[?\s*["'`]--version["'`])/;

/** Whether a test file's source spawns jj without calling useScratchJjConfig. */
function spawnsJjWithoutScratchConfig(source: string): boolean {
  const code = stripComments(source);
  return JJ_SPAWN.test(code) && !/\buseScratchJjConfig\(\)/.test(code);
}

describe("the scratch jj config folder", () => {
  test.skipIf(!hasJj)("jj, and both review runtimes' jj, keep this repo's config under the temp folder", async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-jj-guard-repo-")));
    try {
      const jj = (args: string[]) => spawnSync("jj", args, { cwd: repo, encoding: "utf-8", env: jjConfig.env() });
      expect(jj(["git", "init", "."]).status).toBe(0);
      const own = jj(["config", "path", "--repo"]);
      expect(own.status).toBe(0);

      const reposRoot = join(jjConfig.dir, "jj", "repos") + sep;
      expect(own.stdout.trim().startsWith(reposRoot)).toBe(true);
      for (const runtime of [bunJjRuntime, piJjRuntime]) {
        const result = await runtime.runJj(["config", "path", "--repo"], { cwd: repo });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe(own.stdout.trim());
      }
      // Not vacuous: jj really records the repo there, once.
      expect(readdirSync(reposRoot)).toHaveLength(1);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  test("a test that resets XDG_CONFIG_HOME in its own teardown…", () => {
    delete process.env.XDG_CONFIG_HOME;
  });

  test("…does not take the next test's jj back to the home folder", () => {
    expect(process.env.XDG_CONFIG_HOME).toBe(jjConfig.dir);
  });
});

describe("every test file that runs jj uses the scratch config", () => {
  test("the scan flags a jj spawn without the helper, and nothing else", () => {
    expect(spawnsJjWithoutScratchConfig('Bun.spawnSync(["jj", ...args], { cwd })')).toBe(true);
    expect(spawnsJjWithoutScratchConfig('spawnSync("jj", ["git", "init"], { cwd })')).toBe(true);
    expect(spawnsJjWithoutScratchConfig('run("jj", repo, ["commit"])')).toBe(true);
    expect(spawnsJjWithoutScratchConfig('const c = useScratchJjConfig();\nspawnSync("jj", args, { env: c.env() })')).toBe(false);
    expect(spawnsJjWithoutScratchConfig('Bun.spawnSync(["jj", "--version"])')).toBe(false);
    expect(spawnsJjWithoutScratchConfig('// spawnSync("jj", args)\nvcs.vcsOwnsDiffType("jj", id)')).toBe(false);
  });

  test("no test file in the repo spawns jj without it", () => {
    const root = resolve(import.meta.dir, "..");
    const offenders: string[] = [];
    for (const file of new Bun.Glob("{apps,packages,tests,scripts}/**/*.test.{ts,tsx}").scanSync({ cwd: root })) {
      if (file.split("/").some((part) => part === "node_modules" || part === "generated")) continue;
      if (spawnsJjWithoutScratchConfig(readFileSync(join(root, file), "utf8"))) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
