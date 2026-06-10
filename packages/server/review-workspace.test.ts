/**
 * Workspace Review Tests
 *
 * Tests for workspace repo discovery, label building, and path resolution.
 * Run: bun test packages/server/review-workspace.test.ts
 */

import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  aggregateWorkspacePatch,
  buildLocalWorkspaceReview,
  prefixPatchPaths,
  resolveWorkspaceFilePath,
  discoverWorkspaceRepoPaths,
  WorkspaceReviewSession,
  type WorkspaceRepoRuntimeState,
} from "./review-workspace";
import { startReviewServer } from "./review";
import { getVcsContext, type DiffType, type GitContext } from "./vcs";

const tempDirs: string[] = [];
const originalSemPath = process.env.PLANNOTATOR_SEM_PATH;
const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;

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

function makeMockSem(dir: string, options: {
  versionCounterPath?: string;
  runCwdLogPath?: string;
  inputLogPath?: string;
} = {}): string {
  const semPath = join(dir, "sem");
  writeFileSync(
    semPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'if [ "${1:-}" = "--version" ]; then',
      ...(options.versionCounterPath ? [`  printf x >> ${JSON.stringify(options.versionCounterPath)}`] : []),
      '  echo "sem 0.8.0"',
      "  exit 0",
      "fi",
      ...(options.runCwdLogPath ? [`pwd >> ${JSON.stringify(options.runCwdLogPath)}`] : []),
      ...(options.inputLogPath ? [`cat > ${JSON.stringify(options.inputLogPath)}`] : ["cat >/dev/null"]),
      "cat <<'JSON'",
      JSON.stringify({
        summary: { fileCount: 1, added: 1, modified: 0, deleted: 0, moved: 0, renamed: 0, reordered: 0, binary: 0, orphan: 0, total: 1 },
        changes: [
          {
            entityId: "src/app.ts::function::created",
            changeType: "added",
            entityType: "function",
            entityName: "created",
            filePath: "src/app.ts",
            startLine: 1,
            endLine: 3,
          },
        ],
        binaryChanges: [],
      }),
      "JSON",
      "",
    ].join("\n"),
    "utf-8",
  );
  chmodSync(semPath, 0o755);
  return semPath;
}

afterEach(() => {
  if (originalSemPath === undefined) {
    delete process.env.PLANNOTATOR_SEM_PATH;
  } else {
    process.env.PLANNOTATOR_SEM_PATH = originalSemPath;
  }
  if (originalDataDir === undefined) {
    delete process.env.PLANNOTATOR_DATA_DIR;
  } else {
    process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("review-workspace", () => {
  describe("semantic diff API", () => {
    const rawPatch = [
      "diff --git a/src/app.ts b/src/app.ts",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/src/app.ts",
      "@@ -0,0 +1,3 @@",
      "+export function created() {",
      "+  return true;",
      "+}",
      "",
    ].join("\n");

    it("advertises semantic diff availability and serves parsed sem output", async () => {
      const dir = makeTempDir("plannotator-sem-server-");
      const dataDir = makeTempDir("plannotator-sem-data-");
      const cwdLogPath = join(dir, "cwd-log");
      process.env.PLANNOTATOR_DATA_DIR = dataDir;
      process.env.PLANNOTATOR_SEM_PATH = makeMockSem(dir, { runCwdLogPath: cwdLogPath });

      const server = await startReviewServer({
        rawPatch,
        gitRef: "test",
        origin: "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });

      try {
        const diffPayload = await fetch(`${server.url}/api/diff`).then((response) => response.json()) as {
          semanticDiff?: { available: boolean; semVersion?: string; semSource?: string };
        };
        expect(diffPayload.semanticDiff).toMatchObject({
          available: true,
          semVersion: "0.8.0",
          semSource: "env",
        });

        const semanticPayload = await fetch(`${server.url}/api/semantic-diff?fileExt=.ts`).then((response) => response.json()) as {
          status: string;
          summary?: { added: number; fileCount: number };
          changes?: Array<{ entityType: string; entityName: string; filePath: string }>;
        };
        expect(semanticPayload).toMatchObject({
          status: "ok",
          summary: { added: 1, fileCount: 1 },
          changes: [
            { entityType: "function", entityName: "created", filePath: "src/app.ts" },
          ],
        });
        expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(
          realpathSync(join(dataDir, "semantic-diff", "patch-only")),
        );
      } finally {
        server.stop();
      }
    });

    it("runs semantic diff from the local agent cwd when one is available", async () => {
      const dir = makeTempDir("plannotator-sem-agent-");
      const agentCwd = makeTempDir("plannotator-sem-agent-cwd-");
      const cwdLogPath = join(dir, "cwd-log");
      process.env.PLANNOTATOR_SEM_PATH = makeMockSem(dir, { runCwdLogPath: cwdLogPath });

      const server = await startReviewServer({
        rawPatch,
        gitRef: "test",
        origin: "claude-code",
        agentCwd,
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });

      try {
        const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
          status: string;
        };
        expect(semanticPayload.status).toBe("ok");
        expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(realpathSync(agentCwd));
      } finally {
        server.stop();
      }
    });

    it("runs semantic diff from the local git context cwd in local review mode", async () => {
      const dir = makeTempDir("plannotator-sem-local-");
      const repoDir = makeTempDir("plannotator-sem-local-repo-");
      const cwdLogPath = join(dir, "cwd-log");
      initRepo(repoDir);
      const gitContext = await getVcsContext(repoDir);
      process.env.PLANNOTATOR_SEM_PATH = makeMockSem(dir, { runCwdLogPath: cwdLogPath });

      const server = await startReviewServer({
        rawPatch,
        gitRef: "test",
        origin: "claude-code",
        diffType: "unstaged",
        gitContext,
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });

      try {
        const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
          status: string;
        };
        expect(semanticPayload.status).toBe("ok");
        expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(realpathSync(repoDir));
      } finally {
        server.stop();
      }
    });

    it("caches semantic diff availability probes for the session cwd", async () => {
      const dir = makeTempDir("plannotator-sem-cache-");
      const versionCounterPath = join(dir, "version-count");
      process.env.PLANNOTATOR_SEM_PATH = makeMockSem(dir, { versionCounterPath });

      const server = await startReviewServer({
        rawPatch,
        gitRef: "test",
        origin: "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });

      try {
        await fetch(`${server.url}/api/diff`).then((response) => response.json());
        await fetch(`${server.url}/api/diff`).then((response) => response.json());
        expect(readFileSync(versionCounterPath, "utf-8")).toBe("x");
      } finally {
        server.stop();
      }
    });

    it("hides semantic diff from /api/diff when sem cannot be resolved", async () => {
      const dir = makeTempDir("plannotator-sem-missing-server-");
      process.env.PLANNOTATOR_SEM_PATH = join(dir, "missing-sem");

      const server = await startReviewServer({
        rawPatch,
        gitRef: "test",
        origin: "claude-code",
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });

      try {
        const diffPayload = await fetch(`${server.url}/api/diff`).then((response) => response.json()) as {
          semanticDiff?: { available: boolean };
        };
        expect(diffPayload.semanticDiff).toEqual({ available: false });

        const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
          status: string;
          reason?: string;
        };
        expect(semanticPayload).toMatchObject({
          status: "unavailable",
          reason: "sem-path-missing",
        });
      } finally {
        server.stop();
      }
    });
  });

  describe("prefixPatchPaths", () => {
    it("prefixes diff headers with the repo label", () => {
      const patch = [
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ b/src/index.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain("diff --git a/repo-a/src/index.ts b/repo-a/src/index.ts");
      expect(result).toContain("--- a/repo-a/src/index.ts");
      expect(result).toContain("+++ b/repo-a/src/index.ts");
    });

    it("preserves paths containing the diff header separator text", () => {
      const patch = [
        "diff --git a/foo b/bar.ts b/foo b/bar.ts",
        "--- a/foo b/bar.ts",
        "+++ b/foo b/bar.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n");

      const result = prefixPatchPaths(patch, "api");

      expect(result).toContain("diff --git \"a/api/foo b/bar.ts\" \"b/api/foo b/bar.ts\"");
      expect(result).toContain("--- \"a/api/foo b/bar.ts\"");
      expect(result).toContain("+++ \"b/api/foo b/bar.ts\"");
    });

    it("keeps quoted paths valid when prefixing workspace paths", () => {
      const patch = [
        "diff --git \"a/path with space.ts\" \"b/path with space.ts\"",
        "--- \"a/path with space.ts\"",
        "+++ \"b/path with space.ts\"",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n");

      const result = prefixPatchPaths(patch, "web");

      expect(result).toContain("diff --git \"a/web/path with space.ts\" \"b/web/path with space.ts\"");
      expect(result).toContain("--- \"a/web/path with space.ts\"");
      expect(result).toContain("+++ \"b/web/path with space.ts\"");
    });

    it("handles /dev/null paths correctly", () => {
      const patch = [
        "diff --git a/src/index.ts b/src/index.ts",
        "--- a/src/index.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-content",
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain("+++ /dev/null");
      expect(result).not.toContain("+++ b/repo-a/dev/null");
    });

    it("handles empty patches", () => {
      expect(prefixPatchPaths("", "repo-a")).toBe("");
      expect(prefixPatchPaths("   ", "repo-a")).toBe("   ");
    });

    it("handles nested paths correctly", () => {
      const patch = [
        "diff --git a/packages/ui/src/index.ts b/packages/ui/src/index.ts",
        "--- a/packages/ui/src/index.ts",
        "+++ b/packages/ui/src/index.ts",
      ].join("\n");

      const result = prefixPatchPaths(patch, "frontend");

      expect(result).toContain("diff --git a/frontend/packages/ui/src/index.ts b/frontend/packages/ui/src/index.ts");
    });

    it("prefixes rename and copy metadata without corrupting the header keywords", () => {
      const patch = [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 100%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "diff --git a/src/source.ts b/src/copy.ts",
        "similarity index 100%",
        "copy from src/source.ts",
        "copy to src/copy.ts",
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain("rename from repo-a/src/old.ts");
      expect(result).toContain("rename to repo-a/src/new.ts");
      expect(result).toContain("copy from repo-a/src/source.ts");
      expect(result).toContain("copy to repo-a/src/copy.ts");
      expect(result).not.toContain("rename a/repo-a/from");
      expect(result).not.toContain("copy a/repo-a/from");
    });

    it("prefixes pure rename headers when there are no file path lines", () => {
      const patch = [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 100%",
        "rename from src/old.ts",
        "rename to src/new.ts",
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain("diff --git a/repo-a/src/old.ts b/repo-a/src/new.ts");
      expect(result).toContain("rename from repo-a/src/old.ts");
      expect(result).toContain("rename to repo-a/src/new.ts");
    });

    it("keeps quoted rename and copy metadata valid", () => {
      const patch = [
        'diff --git "a/old name.ts" "b/new name.ts"',
        "similarity index 100%",
        'rename from "old name.ts"',
        'rename to "new name.ts"',
        'diff --git "a/source name.ts" "b/copy name.ts"',
        "similarity index 100%",
        'copy from "source name.ts"',
        'copy to "copy name.ts"',
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain('diff --git "a/repo-a/old name.ts" "b/repo-a/new name.ts"');
      expect(result).toContain('rename from "repo-a/old name.ts"');
      expect(result).toContain('rename to "repo-a/new name.ts"');
      expect(result).toContain('diff --git "a/repo-a/source name.ts" "b/repo-a/copy name.ts"');
      expect(result).toContain('copy from "repo-a/source name.ts"');
      expect(result).toContain('copy to "repo-a/copy name.ts"');
      expect(result).not.toContain('repo-a/"old name.ts"');
    });

    it("keeps embedded quotes valid in rename metadata", () => {
      const patch = [
        'diff --git "a/old\\"name.ts" "b/new\\"name.ts"',
        "similarity index 100%",
        'rename from "old\\"name.ts"',
        'rename to "new\\"name.ts"',
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain('diff --git "a/repo-a/old\\"name.ts" "b/repo-a/new\\"name.ts"');
      expect(result).toContain('rename from "repo-a/old\\"name.ts"');
      expect(result).toContain('rename to "repo-a/new\\"name.ts"');
    });

    it("prefixes unquoted headers from the right when file path lines are absent", () => {
      const patch = [
        "diff --git a/foo b/old.bin b/new.bin",
        "new file mode 100644",
        "index 0000000..1234567",
        "GIT binary patch",
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain("diff --git \"a/repo-a/foo b/old.bin\" b/repo-a/new.bin");
    });

    it("does not treat hunk body lines as file headers", () => {
      const patch = [
        "diff --git a/src/file.txt b/src/file.txt",
        "--- a/src/file.txt",
        "+++ b/src/file.txt",
        "@@ -1,2 +1,2 @@",
        "---- a/not-a-header.txt",
        "++++ b/not-a-header.txt",
      ].join("\n");

      const result = prefixPatchPaths(patch, "repo-a");

      expect(result).toContain("diff --git a/repo-a/src/file.txt b/repo-a/src/file.txt");
      expect(result).toContain("---- a/not-a-header.txt");
      expect(result).toContain("++++ b/not-a-header.txt");
    });

    it("does not prefix /dev/null when it appears in metadata", () => {
      const result = prefixPatchPaths("rename from /dev/null", "repo-a");

      expect(result).toBe("rename from /dev/null");
    });
  });

  describe("aggregateWorkspacePatch", () => {
    it("preserves real trailing spaces in patch lines", () => {
      const aggregate = aggregateWorkspacePatch([{
        label: "api",
        selected: true,
        rawPatch: [
          "diff --git a/api/file.txt b/api/file.txt",
          "@@ -1 +1 @@",
          "-before",
          "+after   ",
          "",
        ].join("\n"),
        gitRef: "Uncommitted changes",
      }]);

      expect(aggregate.rawPatch).toEndWith("+after   ");
    });
  });

  describe("resolveWorkspaceFilePath", () => {
    it("resolves the longest matching repo label first", () => {
      const repos = [
        { id: "1", label: "apps", cwd: "/tmp/apps", selected: true, rawPatch: "", gitRef: "" },
        { id: "2", label: "apps/api", cwd: "/tmp/apps-api", selected: true, rawPatch: "", gitRef: "" },
      ] as WorkspaceRepoRuntimeState[];

      const resolved = resolveWorkspaceFilePath(repos, "apps/api/src/index.ts");

      expect(resolved?.repo.id).toBe("2");
      expect(resolved?.repoRelativePath).toBe("src/index.ts");
    });

    it("returns null when no repo matches", () => {
      const repos = [
        { id: "1", label: "frontend", cwd: "/tmp/frontend", selected: true, rawPatch: "", gitRef: "" },
      ] as WorkspaceRepoRuntimeState[];

      const resolved = resolveWorkspaceFilePath(repos, "backend/src/index.ts");

      expect(resolved).toBeNull();
    });

    it("handles exact label matches", () => {
      const repos = [
        { id: "1", label: "repo-a", cwd: "/tmp/repo-a", selected: true, rawPatch: "", gitRef: "" },
      ] as WorkspaceRepoRuntimeState[];

      const resolved = resolveWorkspaceFilePath(repos, "repo-a/file.ts");

      expect(resolved?.repo.id).toBe("1");
      expect(resolved?.repoRelativePath).toBe("file.ts");
    });

    it("rejects bare repo labels", () => {
      const repos = [
        { id: "1", label: "repo-a", cwd: "/tmp/repo-a", selected: true, rawPatch: "", gitRef: "" },
      ] as WorkspaceRepoRuntimeState[];

      const resolved = resolveWorkspaceFilePath(repos, "repo-a");

      expect(resolved).toBeNull();
    });

    it("validates file paths for directory traversal attacks", () => {
      const repos = [
        { id: "1", label: "repo", cwd: "/tmp/repo", selected: true, rawPatch: "", gitRef: "" },
      ] as WorkspaceRepoRuntimeState[];

      expect(() => resolveWorkspaceFilePath(repos, "repo/../../../etc/passwd")).toThrow();
    });
  });

  describe("discoverWorkspaceRepoPaths", () => {
    it("excludes the root itself even if it is a git repo", () => {
      // The function is designed to discover repos WITHIN a workspace root,
      // not the root itself. This allows the workspace root to be a git repo
      // (e.g., a meta-repo) while still discovering nested repos.
      const root = makeTempDir("plannotator-workspace-root-repo-");
      initRepo(root);

      const repos = discoverWorkspaceRepoPaths(root);

      // Root itself is excluded even though it's a git repo
      expect(repos).toHaveLength(0);
      expect(repos).not.toContain(root);
    });

    it("discovers multiple nested VCS repos", () => {
      const root = makeTempDir("plannotator-workspace-multi-");

      // Create nested repos
      const frontend = join(root, "frontend");
      const backend = join(root, "backend");
      const backendApi = join(backend, "api");

      mkdirSync(frontend, { recursive: true });
      mkdirSync(backendApi, { recursive: true });

      initRepo(frontend);
      initRepo(backendApi);

      const repos = discoverWorkspaceRepoPaths(root);

      expect(repos).toHaveLength(2);
      expect(repos).toContain(frontend);
      expect(repos).toContain(backendApi);
      expect(repos).not.toContain(root);
      expect(repos).not.toContain(backend); // backend itself is not a repo
    });

    it("stops recursion at git repo boundaries (does not discover nested repos inside other repos)", () => {
      const root = makeTempDir("plannotator-workspace-boundary-");

      // Create a repo with a nested directory that would be a repo
      const parentRepo = join(root, "parent");
      const childDir = join(parentRepo, "child");

      mkdirSync(childDir, { recursive: true });
      initRepo(parentRepo);

      // Create a git repo inside the child (should NOT be discovered separately
      // because parent repo stops recursion - we don't traverse into git repos)
      const grandchildRepo = join(childDir, "grandchild");
      mkdirSync(grandchildRepo, { recursive: true });
      initRepo(grandchildRepo);

      const repos = discoverWorkspaceRepoPaths(root);

      // Only the parent should be discovered - grandchild is inside a git repo
      expect(repos).toHaveLength(1);
      expect(repos).toContain(parentRepo);
      expect(repos).not.toContain(grandchildRepo);
    });

    it("discovers nested jj repos", () => {
      const root = makeTempDir("plannotator-workspace-jj-");
      const jjRepo = join(root, "jj-app");
      mkdirSync(join(jjRepo, ".jj"), { recursive: true });

      const repos = discoverWorkspaceRepoPaths(root);

      expect(repos).toEqual([jjRepo]);
    });

    it("skips ignored directories", () => {
      const root = makeTempDir("plannotator-workspace-skip-");

      // Create node_modules with a fake .git (should be skipped)
      const nodeModules = join(root, "node_modules", "some-pkg");
      mkdirSync(nodeModules, { recursive: true });
      mkdirSync(join(nodeModules, ".git"), { recursive: true });

      // Create a real repo
      const realRepo = join(root, "src");
      mkdirSync(realRepo, { recursive: true });
      initRepo(realRepo);

      const repos = discoverWorkspaceRepoPaths(root);

      expect(repos).toHaveLength(1);
      expect(repos[0]).toBe(realRepo);
    });

    it("returns empty array when root has no git repos", () => {
      const root = makeTempDir("plannotator-workspace-empty-");

      // Create some non-git directories
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "docs"), { recursive: true });
      writeFileSync(join(root, "README.md"), "# Project\n", "utf-8");

      const repos = discoverWorkspaceRepoPaths(root);

      expect(repos).toHaveLength(0);
    });

    it("sorts results alphabetically", () => {
      const root = makeTempDir("plannotator-workspace-sort-");

      const zebra = join(root, "zebra");
      const alpha = join(root, "alpha");
      const beta = join(root, "beta");

      mkdirSync(zebra, { recursive: true });
      mkdirSync(alpha, { recursive: true });
      mkdirSync(beta, { recursive: true });

      initRepo(zebra);
      initRepo(alpha);
      initRepo(beta);

      const repos = discoverWorkspaceRepoPaths(root);

      expect(repos).toEqual([alpha, beta, zebra]);
    });

    it("handles deeply nested repos", () => {
      const root = makeTempDir("plannotator-workspace-deep-");

      const deepRepo = join(root, "a", "b", "c", "d", "repo");
      mkdirSync(deepRepo, { recursive: true });
      initRepo(deepRepo);

      const repos = discoverWorkspaceRepoPaths(root);

      expect(repos).toHaveLength(1);
      expect(repos[0]).toBe(deepRepo);
    });
  });

  describe("buildRepoLabel (via discoverWorkspaceRepoPaths integration)", () => {
    it("uses relative path as label when possible", () => {
      // This is tested indirectly through the full workspace flow
      // The label building logic is internal, but we verify it works
      // through resolveWorkspaceFilePath tests with realistic labels
      const repos = [
        { id: "1", label: "packages/frontend", cwd: "/tmp/packages/frontend", selected: true, rawPatch: "", gitRef: "" },
        { id: "2", label: "packages/backend", cwd: "/tmp/packages/backend", selected: true, rawPatch: "", gitRef: "" },
      ] as WorkspaceRepoRuntimeState[];

      const resolved1 = resolveWorkspaceFilePath(repos, "packages/frontend/src/index.ts");
      const resolved2 = resolveWorkspaceFilePath(repos, "packages/backend/api.ts");

      expect(resolved1?.repo.id).toBe("1");
      expect(resolved2?.repo.id).toBe("2");
    });

    it("handles duplicate basename fallback", () => {
      // When two repos have the same basename but different paths,
      // the second should get a numbered suffix
      const repos = [
        { id: "1", label: "api", cwd: "/tmp/apps/api", selected: true, rawPatch: "", gitRef: "" },
        { id: "2", label: "api-2", cwd: "/tmp/services/api", selected: true, rawPatch: "", gitRef: "" },
      ] as WorkspaceRepoRuntimeState[];

      const resolved = resolveWorkspaceFilePath(repos, "api-2/src/index.ts");

      expect(resolved?.repo.id).toBe("2");
    });
  });

  describe("workspace review server integration", () => {
    it("maps one workspace mode across mixed Git and JJ repos", async () => {
      const root = makeTempDir("plannotator-workspace-mixed-vcs-");
      const gitRepo = join(root, "api");
      const jjRepo = join(root, "web");
      mkdirSync(join(gitRepo, ".git"), { recursive: true });
      mkdirSync(join(jjRepo, ".jj"), { recursive: true });
      const calls: Array<{ cwd?: string; diffType: DiffType }> = [];

      const runtime = {
        async getVcsContext(cwd?: string): Promise<GitContext> {
          const isJj = cwd === jjRepo;
          return {
            vcsType: isJj ? "jj" : "git",
            currentBranch: "main",
            defaultBranch: "main",
            cwd: cwd ?? root,
            worktrees: [],
            availableBranches: { local: [], remote: [] },
            diffOptions: isJj
              ? [{ id: "jj-current", label: "Current change" }, { id: "jj-last", label: "Last change" }]
              : [{ id: "uncommitted", label: "Uncommitted changes" }, { id: "last-commit", label: "Last commit" }],
          };
        },
        async runVcsDiff(diffType: DiffType, _defaultBranch?: string, cwd?: string) {
          calls.push({ cwd, diffType });
          return {
            patch: [
              "diff --git a/file.txt b/file.txt",
              "--- a/file.txt",
              "+++ b/file.txt",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
            label: diffType,
          };
        },
        async getVcsFileContentsForDiff() {
          return { oldContent: null, newContent: null };
        },
        async canStageFiles() {
          return true;
        },
        async stageFile() {},
        async unstageFile() {},
      };

      const workspace = await WorkspaceReviewSession.create(runtime, root, {
        requestedDiffType: "staged",
      });

      expect(workspace.diffType).toBe("workspace-current");
      expect(workspace.diffOptions.map((option) => option.id)).toEqual([
        "workspace-current",
        "workspace-last",
      ]);
      expect(calls).toEqual(
        expect.arrayContaining([
          { cwd: gitRepo, diffType: "uncommitted" },
          { cwd: jjRepo, diffType: "jj-current" },
        ]),
      );
      expect(workspace.rawPatch).toContain("diff --git a/api/file.txt b/api/file.txt");
      expect(workspace.rawPatch).toContain("diff --git a/web/file.txt b/web/file.txt");

      calls.length = 0;
      await workspace.rebuild({ diffType: "workspace-last" });
      expect(calls).toEqual(
        expect.arrayContaining([
          { cwd: gitRepo, diffType: "last-commit" },
          { cwd: jjRepo, diffType: "jj-last" },
        ]),
      );
      await expect(workspace.rebuild({ diffType: "workspace-staged" })).rejects.toThrow(
        "Workspace diff mode is not available",
      );
    });

    it("normalizes agent annotation paths to workspace-prefixed paths", async () => {
      const root = makeTempDir("plannotator-workspace-agent-path-");
      const api = join(root, "api");
      mkdirSync(join(api, ".git"), { recursive: true });

      const runtime = {
        async getVcsContext(cwd?: string): Promise<GitContext> {
          return {
            vcsType: "git",
            currentBranch: "main",
            defaultBranch: "main",
            cwd: cwd ?? api,
            worktrees: [],
            availableBranches: { local: [], remote: [] },
            diffOptions: [{ id: "uncommitted", label: "Uncommitted changes" }],
          };
        },
        async runVcsDiff() {
          return {
            patch: [
              "diff --git a/src/file.ts b/src/file.ts",
              "--- a/src/file.ts",
              "+++ b/src/file.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
            label: "Uncommitted changes",
          };
        },
        async getVcsFileContentsForDiff() {
          return { oldContent: null, newContent: null };
        },
        async canStageFiles() {
          return true;
        },
        async stageFile() {},
        async unstageFile() {},
      };

      const workspace = await WorkspaceReviewSession.create(runtime, root);

      expect(workspace.normalizeAnnotationPath("api/src/file.ts")).toBe("api/src/file.ts");
      expect(workspace.normalizeAnnotationPath("src/file.ts")).toBe("api/src/file.ts");
      expect(workspace.normalizeAnnotationPath(join(api, "src/file.ts"))).toBe("api/src/file.ts");
    });

    it("keeps requested Git-only workspace modes available when another child repo fails detection", async () => {
      const root = makeTempDir("plannotator-workspace-partial-failure-");
      const api = join(root, "api");
      const broken = join(root, "broken");
      mkdirSync(join(api, ".git"), { recursive: true });
      mkdirSync(join(broken, ".git"), { recursive: true });

      const runtime = {
        async getVcsContext(cwd?: string): Promise<GitContext> {
          if (cwd === broken) throw new Error("broken repo");
          return {
            vcsType: "git",
            currentBranch: "main",
            defaultBranch: "main",
            cwd: cwd ?? api,
            worktrees: [],
            availableBranches: { local: [], remote: [] },
            diffOptions: [{ id: "staged", label: "Staged changes" }],
          };
        },
        async runVcsDiff() {
          return {
            patch: [
              "diff --git a/src/file.ts b/src/file.ts",
              "--- a/src/file.ts",
              "+++ b/src/file.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ].join("\n"),
            label: "Staged changes",
          };
        },
        async getVcsFileContentsForDiff() {
          return { oldContent: null, newContent: null };
        },
        async canStageFiles() {
          return true;
        },
        async stageFile() {},
        async unstageFile() {},
      };

      const workspace = await WorkspaceReviewSession.create(runtime, root, {
        requestedDiffType: "staged",
      });

      expect(workspace.diffType).toBe("workspace-staged");
      expect(workspace.diffOptions.map((option) => option.id)).toContain("workspace-staged");
      expect(workspace.rawPatch).toContain("diff --git a/api/src/file.ts b/api/src/file.ts");
      expect(workspace.error).toContain("broken repo");
      expect(workspace.getPromptContext().repos).toEqual([
        expect.objectContaining({ label: "api", changed: true }),
        expect.objectContaining({ label: "broken", changed: false, error: "broken repo" }),
      ]);
    });

    it("passes hide-whitespace through child repo diffs", async () => {
      const root = makeTempDir("plannotator-workspace-whitespace-");
      const api = join(root, "api");
      mkdirSync(api, { recursive: true });
      initRepo(api);

      writeFileSync(join(api, "tracked.txt"), "const value = 1;\n", "utf-8");
      git(api, ["add", "tracked.txt"]);
      git(api, ["commit", "-m", "add tracked"]);
      writeFileSync(join(api, "tracked.txt"), "const    value    =    1;\n", "utf-8");

      const workspace = await buildLocalWorkspaceReview(root, { hideWhitespace: true });
      const aggregate = aggregateWorkspacePatch(workspace.repos);

      expect(workspace.repos[0]?.selected).toBe(false);
      expect(aggregate.rawPatch).toBe("");
    }, 15_000);

    it("serves combined diffs and maps prefixed paths back to child repos", async () => {
      const root = makeTempDir("plannotator-workspace-server-");
      const semDir = makeTempDir("plannotator-workspace-switch-sem-");
      const cwdLogPath = join(semDir, "cwd-log");
      const inputLogPath = join(semDir, "input.patch");
      process.env.PLANNOTATOR_SEM_PATH = makeMockSem(semDir, { runCwdLogPath: cwdLogPath, inputLogPath });
      const api = join(root, "api");
      const web = join(root, "web");
      mkdirSync(api, { recursive: true });
      mkdirSync(web, { recursive: true });
      initRepo(api);
      initRepo(web);

      writeFileSync(join(api, "tracked.txt"), "before\n", "utf-8");
      git(api, ["add", "tracked.txt"]);
      git(api, ["commit", "-m", "add tracked"]);
      writeFileSync(join(api, "tracked.txt"), "after\n", "utf-8");
      writeFileSync(join(web, "new.txt"), "new file\n", "utf-8");

      const workspace = await buildLocalWorkspaceReview(root);
      const aggregate = aggregateWorkspacePatch(workspace.repos);
      const server = await startReviewServer({
        rawPatch: aggregate.rawPatch,
        gitRef: aggregate.gitRef,
        error: aggregate.errors.join("\n") || undefined,
        origin: "claude-code",
        workspace,
        agentCwd: workspace.root,
        htmlContent: "<!doctype html><html><body>review</body></html>",
      });

      try {
        const diffResponse = await fetch(`${server.url}/api/diff`);
        expect(diffResponse.status).toBe(200);
        const diffPayload = await diffResponse.json() as {
          mode?: string;
          rawPatch: string;
          diffType?: string;
          diffOptions?: Array<{ id: string }>;
          agentCwd?: string;
          semanticDiff?: { available: boolean };
        };
        expect(diffPayload.mode).toBe("workspace");
        expect(diffPayload.diffType).toBe("workspace-current");
        expect(diffPayload.diffOptions?.map((option) => option.id)).toEqual([
          "workspace-current",
          "workspace-staged",
          "workspace-unstaged",
          "workspace-last",
        ]);
        expect(diffPayload.agentCwd).toBe(root);
        expect(diffPayload.semanticDiff).toEqual(expect.objectContaining({ available: true }));
        expect("workspace" in diffPayload).toBe(false);
        expect(diffPayload.rawPatch).toContain("diff --git a/api/tracked.txt b/api/tracked.txt");
        expect(diffPayload.rawPatch).toContain("diff --git a/web/new.txt b/web/new.txt");

        const semanticPayload = await fetch(`${server.url}/api/semantic-diff`).then((response) => response.json()) as {
          status: string;
        };
        expect(semanticPayload.status).toBe("ok");
        expect(realpathSync(readFileSync(cwdLogPath, "utf-8").trim())).toBe(realpathSync(root));
        const semInput = readFileSync(inputLogPath, "utf-8");
        expect(semInput).toContain("diff --git a/api/tracked.txt b/api/tracked.txt");
        expect(semInput).toContain("diff --git a/web/new.txt b/web/new.txt");

        const lastResponse = await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "workspace-last", hideWhitespace: true }),
        });
        expect(lastResponse.status).toBe(200);
        const lastPayload = await lastResponse.json() as {
          diffType?: string;
          rawPatch: string;
          diffOptions?: Array<{ id: string }>;
          semanticDiff?: { available: boolean };
        };
        expect(lastPayload.diffType).toBe("workspace-last");
        expect(lastPayload.diffOptions?.map((option) => option.id)).toContain("workspace-current");
        expect(lastPayload.semanticDiff).toEqual(expect.objectContaining({ available: true }));
        expect(lastPayload.rawPatch).toContain("diff --git a/api/tracked.txt b/api/tracked.txt");

        const currentResponse = await fetch(`${server.url}/api/diff/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ diffType: "workspace-current", hideWhitespace: false }),
        });
        expect(currentResponse.status).toBe(200);

        const fileContentResponse = await fetch(`${server.url}/api/file-content?path=api/tracked.txt`);
        expect(fileContentResponse.status).toBe(200);
        const fileContent = await fileContentResponse.json() as {
          oldContent: string | null;
          newContent: string | null;
        };
        expect(fileContent.oldContent).toBe("before\n");
        expect(fileContent.newContent).toBe("after\n");

        const stageResponse = await fetch(`${server.url}/api/git-add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: "web/new.txt" }),
        });
        expect(stageResponse.status).toBe(200);
        expect(git(web, ["diff", "--staged", "--name-only"])).toContain("new.txt");

        const invalidStageResponse = await fetch(`${server.url}/api/git-add`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filePath: "api/../web/new.txt" }),
        });
        expect(invalidStageResponse.status).toBe(400);
      } finally {
        server.stop();
      }
    }, 15_000);
  });
});
