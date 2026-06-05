/**
 * Tripwires runtime-glue tests (Bun server).
 *
 * Run: bun test packages/server/tripwires.test.ts
 *
 * Focus: repoKeyBaseFromCwd's git<2.31 fallback. The original implementation
 * only ran `git rev-parse --path-format=absolute --git-common-dir`; that flag
 * was added in git 2.31 (2021) and errors on older git, so the glue returned
 * null and every remote-less repo collapsed onto the same `local:` identity /
 * shared global tripwires file. The fallback resolves the plain (relative)
 * common-dir against cwd so distinct repos stay on distinct keys.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyBaseFromCwd } from "./tripwires";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function initRepo(): string {
  const dir = makeTempDir("plannotator-tw-repo-");
  // Remote-less repo (no `origin`) — this is what hits the common-dir fallback.
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a PATH shim whose `git` rejects `--path-format=absolute` (simulating
 * git < 2.31) but forwards every other invocation to the real git, then run
 * `fn` with that shim prepended to PATH.
 */
async function withOldGit<T>(fn: () => Promise<T>): Promise<T> {
  const shimDir = makeTempDir("plannotator-tw-oldgit-");
  const realGit = execFileSync("which", ["git"]).toString().trim();
  const shim = join(shimDir, "git");
  writeFileSync(
    shim,
    `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--path-format=absolute" ]; then
    echo "error: unknown option \`path-format=absolute'" 1>&2
    exit 129
  fi
done
exec ${JSON.stringify(realGit)} "$@"
`,
  );
  chmodSync(shim, 0o755);

  const prevPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${prevPath}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = prevPath;
  }
}

describe("repoKeyBaseFromCwd", () => {
  test("returns a per-repo base on modern git", async () => {
    const repo = initRepo();
    const base = await repoKeyBaseFromCwd(repo);
    expect(base).not.toBeNull();
  });

  test("git<2.31 fallback keeps distinct remote-less repos on distinct bases", async () => {
    const repoA = initRepo();
    const repoB = initRepo();

    await withOldGit(async () => {
      const baseA = await repoKeyBaseFromCwd(repoA);
      const baseB = await repoKeyBaseFromCwd(repoB);

      // The whole point: neither collapses to null (which would yield the shared
      // `local:` identity), and the two repos never share a base.
      expect(baseA).not.toBeNull();
      expect(baseB).not.toBeNull();
      expect(baseA).not.toBe(baseB);
    });
  });

  test("returns null outside a git repo", async () => {
    const notARepo = makeTempDir("plannotator-tw-nonrepo-");
    expect(await repoKeyBaseFromCwd(notARepo)).toBeNull();
  });
});
