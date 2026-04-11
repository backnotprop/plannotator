/**
 * VCS Detection Tests
 *
 * Tests for VCS provider detection and the workspace root fallback behavior.
 * Run: bun test packages/server/vcs.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { detectManagedVcs, detectVcs } from "./vcs";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function initRepo(dir: string, initialBranch = "main"): void {
  git(dir, ["init"]);
  git(dir, ["branch", "-M", initialBranch]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test User"]);
  writeFileSync(join(dir, "README.md"), "# Test\n", "utf-8");
  git(dir, ["add", "README.md"]);
  git(dir, ["commit", "-m", "initial"]);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("vcs detection", () => {
  describe("detectManagedVcs", () => {
    it("returns git provider when inside a git repo", async () => {
      const repoDir = makeTempDir("plannotator-vcs-git-");
      initRepo(repoDir);

      const provider = await detectManagedVcs(repoDir);

      expect(provider).not.toBeNull();
      expect(provider?.id).toBe("git");
    });

    it("returns null when not in any VCS repo", async () => {
      const nonVcsDir = makeTempDir("plannotator-vcs-none-");
      // Just create a regular file, no git init
      writeFileSync(join(nonVcsDir, "file.txt"), "content", "utf-8");

      const provider = await detectManagedVcs(nonVcsDir);

      expect(provider).toBeNull();
    });

    it("returns null for non-git workspace root with nested git repos", async () => {
      // This is the key regression test: a workspace root that is NOT a git repo
      // but contains multiple git repos should NOT be detected as having a VCS
      const workspaceRoot = makeTempDir("plannotator-vcs-workspace-");
      
      // Create nested git repos
      const frontend = join(workspaceRoot, "frontend");
      const backend = join(workspaceRoot, "backend");
      mkdirSync(frontend, { recursive: true });
      mkdirSync(backend, { recursive: true });
      
      initRepo(frontend);
      initRepo(backend);
      
      // Verify the workspace root itself is NOT a git repo
      const gitDir = join(workspaceRoot, ".git");
      const fs = await import("node:fs");
      expect(fs.existsSync(gitDir)).toBe(false);

      // The workspace root should NOT be detected as having a VCS
      const provider = await detectManagedVcs(workspaceRoot);

      expect(provider).toBeNull();
    });
  });

  describe("detectVcs", () => {
    it("returns git provider when inside a git repo", async () => {
      const repoDir = makeTempDir("plannotator-vcs-detect-git-");
      initRepo(repoDir);

      const provider = await detectVcs(repoDir);

      expect(provider.id).toBe("git");
    });

    it("falls back to git provider when no VCS detected (legacy behavior)", async () => {
      // This tests the current fallback behavior - when no VCS is detected,
      // it defaults to git provider. This is the existing behavior that
      // the workspace review feature needs to handle carefully.
      const nonVcsDir = makeTempDir("plannotator-vcs-fallback-");
      writeFileSync(join(nonVcsDir, "file.txt"), "content", "utf-8");

      const provider = await detectVcs(nonVcsDir);

      // Falls back to git provider even though not in a git repo
      expect(provider.id).toBe("git");
    });

    it("caches provider detection results", async () => {
      const repoDir = makeTempDir("plannotator-vcs-cache-");
      initRepo(repoDir);

      // First call should detect and cache
      const provider1 = await detectVcs(repoDir);
      
      // Second call should return cached result
      const provider2 = await detectVcs(repoDir);

      expect(provider1).toBe(provider2);
    });
  });

  describe("regression: non-git workspace roots", () => {
    it("workspace root without .git should not be treated as single-repo", async () => {
      // Regression test for: non-git workspace roots were incorrectly treated 
      // as single-repo due to VCS fallback behavior
      //
      // Before the fix, running `plannotator review` in a workspace root that
      // contained multiple git repos but wasn't itself a git repo would:
      // 1. detectVcs() would fall back to git provider
      // 2. The review would treat the entire workspace as a single repo
      // 3. This would show incorrect diff or fail to find git context
      //
      // After the fix, workspace review mode should:
      // 1. Check if the CWD is a git repo using detectManagedVcs()
      // 2. If not, discover nested repos and enter workspace mode
      // 3. Only fall back to single-repo mode if detectManagedVcs() returns a provider
      
      const workspaceRoot = makeTempDir("plannotator-regression-workspace-");
      
      // Create multiple nested git repos (simulating a typical workspace)
      const packages = join(workspaceRoot, "packages");
      const apps = join(workspaceRoot, "apps");
      
      const uiPkg = join(packages, "ui");
      const apiPkg = join(packages, "api");
      const webApp = join(apps, "web");
      
      mkdirSync(uiPkg, { recursive: true });
      mkdirSync(apiPkg, { recursive: true });
      mkdirSync(webApp, { recursive: true });
      
      initRepo(uiPkg);
      initRepo(apiPkg);
      initRepo(webApp);
      
      // Verify workspace root is NOT a git repo
      const fs = await import("node:fs");
      expect(fs.existsSync(join(workspaceRoot, ".git"))).toBe(false);
      
      // detectManagedVcs should return null (no VCS at workspace root)
      const managedVcs = await detectManagedVcs(workspaceRoot);
      expect(managedVcs).toBeNull();
      
      // But detectVcs (with fallback) returns git provider
      // This is the legacy behavior that workspace review must handle
      const fallbackVcs = await detectVcs(workspaceRoot);
      expect(fallbackVcs.id).toBe("git");
      
      // The key assertion: workspace review code should use detectManagedVcs()
      // to determine if it's in a repo, NOT detectVcs() which has fallback
    });

    it("single git repo at CWD should use single-repo mode", async () => {
      // When CWD is itself a git repo, we should use single-repo review mode
      const repoDir = makeTempDir("plannotator-regression-single-");
      initRepo(repoDir);

      const managedVcs = await detectManagedVcs(repoDir);
      
      expect(managedVcs).not.toBeNull();
      expect(managedVcs?.id).toBe("git");
    });

    it("nested git repo at CWD should use single-repo mode", async () => {
      // When CWD is a nested git repo within a workspace, use single-repo mode
      const workspaceRoot = makeTempDir("plannotator-regression-nested-");
      
      const frontend = join(workspaceRoot, "frontend");
      mkdirSync(frontend, { recursive: true });
      initRepo(frontend);

      const managedVcs = await detectManagedVcs(frontend);
      
      expect(managedVcs).not.toBeNull();
      expect(managedVcs?.id).toBe("git");
    });
  });
});
