import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRepoInfo as getPiRepoInfo } from "../../apps/pi-extension/server/project";
import { getRepoInfo } from "./repo";

test("both runtimes report the branch of a repository before its first commit", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "plannotator-unborn-"));
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch", "new-project"], { cwd });

    expect(await getRepoInfo(cwd)).toMatchObject({ branch: "new-project" });
    expect(getPiRepoInfo(cwd)).toMatchObject({ branch: "new-project" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
