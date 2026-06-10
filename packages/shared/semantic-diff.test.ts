import { describe, expect, test } from "bun:test";
import {
  getManagedSemBinaryPath,
  getSemanticDiffAvailability,
  parseSemVersion,
  runSemanticDiff,
  semanticDiffCacheKey,
  semanticDiffFileExtsFromSearchParams,
  SemanticDiffResponseCache,
  type SemanticDiffRuntime,
} from "./semantic-diff";
import type { SemanticDiffResponse } from "./semantic-diff-types";

interface MockCommand {
  version?: string;
  diff?: string;
  stderr?: string;
  exitCode?: number;
}

function makeRuntime(options: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  files?: string[];
  commands?: Record<string, MockCommand>;
  pathDelimiter?: string;
  platform?: NodeJS.Platform;
} = {}): SemanticDiffRuntime & { calls: Array<{ command: string; args: string[]; input?: string }> } {
  const calls: Array<{ command: string; args: string[]; input?: string }> = [];
  const files = new Set(options.files ?? []);
  const commands = options.commands ?? {};

  return {
    calls,
    env: options.env ?? {},
    cwd: options.cwd ?? "/repo",
    dataDir: "/home/user/.plannotator",
    pathDelimiter: options.pathDelimiter ?? ":",
    platform: options.platform ?? "linux",
    fileExists(path) {
      return files.has(path);
    },
    async runCommand(command, args, runOptions) {
      calls.push({ command, args, input: runOptions?.input });
      const mock = commands[command];
      if (!mock) return { stdout: "", stderr: "not found", exitCode: 1, error: "not found" };
      if (args.includes("--version")) {
        return { stdout: mock.version ?? "", stderr: "", exitCode: mock.version ? 0 : 1 };
      }
      return {
        stdout: mock.diff ?? "",
        stderr: mock.stderr ?? "",
        exitCode: mock.exitCode ?? 0,
      };
    },
  };
}

describe("semantic diff runner", () => {
  test("parses real sem version output and rejects other sem commands", () => {
    expect(parseSemVersion("sem 0.8.0\n")).toBe("0.8.0");
    expect(parseSemVersion("sem 0.8.0-dev+abc\n")).toBe("0.8.0-dev+abc");
    expect(parseSemVersion("GNU parallel 20250122\n")).toBeNull();
  });

  test("reports unavailable when sem cannot be resolved", async () => {
    const runtime = makeRuntime();
    await expect(getSemanticDiffAvailability(runtime)).resolves.toMatchObject({
      available: false,
      reason: "sem-not-found",
    });
  });

  test("validates PLANNOTATOR_SEM_PATH before using it", async () => {
    const runtime = makeRuntime({
      env: { PLANNOTATOR_SEM_PATH: "/missing/sem" },
    });

    await expect(runSemanticDiff({ rawPatch: "diff --git a/a.ts b/a.ts\n" }, runtime)).resolves.toMatchObject({
      status: "unavailable",
      reason: "sem-path-missing",
    });
  });

  test("runs sem with patch input and normalized file extensions", async () => {
    const runtime = makeRuntime({
      env: { PLANNOTATOR_SEM_PATH: "mock-sem" },
      commands: {
        "mock-sem": {
          version: "sem 0.8.0",
          diff: JSON.stringify({
            summary: { fileCount: 1, added: 1, modified: 0, deleted: 0, total: 1 },
            changes: [
              {
                entityId: "src/a.ts::function::hello",
                changeType: "added",
                entityType: "function",
                entityName: "hello",
                filePath: "src/a.ts",
                startLine: 3,
                endLine: 5,
              },
            ],
          }),
        },
      },
    });

    const result = await runSemanticDiff({
      rawPatch: "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+export function hello() {}\n",
      fileExts: ["ts", ".tsx", "ts"],
    }, runtime);

    expect(result).toMatchObject({
      status: "ok",
      summary: { fileCount: 1, added: 1, total: 1 },
      changes: [{ entityType: "function", entityName: "hello", filePath: "src/a.ts" }],
      semVersion: "0.8.0",
      semSource: "env",
    });
    expect(runtime.calls[1]).toMatchObject({
      command: "mock-sem",
      args: ["diff", "--patch", "--format", "json", "--file-exts", ".ts", ".tsx"],
      input: expect.stringContaining("diff --git"),
    });
  });

  test("does not pass a file extension filter unless one is requested", async () => {
    const runtime = makeRuntime({
      env: { PLANNOTATOR_SEM_PATH: "mock-sem" },
      commands: {
        "mock-sem": {
          version: "sem 0.8.0",
          diff: JSON.stringify({
            summary: { fileCount: 0, added: 0, modified: 0, deleted: 0, total: 0 },
            changes: [],
            binaryChanges: [],
          }),
        },
      },
    });

    await runSemanticDiff({
      rawPatch: "diff --git a/src/a.py b/src/a.py\n@@ -1 +1 @@\n-a\n+b\n",
    }, runtime);

    expect(runtime.calls[1]).toMatchObject({
      command: "mock-sem",
      args: ["diff", "--patch", "--format", "json"],
    });
  });

  test("does not run a sem package from the reviewed cwd", async () => {
    const repoSem = "/repo/node_modules/@ataraxy-labs/sem/vendor/sem";
    const runtime = makeRuntime({
      cwd: "/server",
      files: [repoSem],
      commands: {
        [repoSem]: {
          version: "sem 0.8.0",
          diff: JSON.stringify({
            summary: { fileCount: 1, added: 1, modified: 0, deleted: 0, total: 1 },
            changes: [
              {
                changeType: "added",
                entityType: "function",
                entityName: "fromRepoPackage",
                filePath: "src/a.ts",
              },
            ],
            binaryChanges: [],
          }),
        },
      },
    });

    await expect(runSemanticDiff({
      rawPatch: "diff --git a/src/a.ts b/src/a.ts\n@@ -0,0 +1 @@\n+export function fromRepoPackage() {}\n",
      cwd: "/repo",
    }, runtime)).resolves.toMatchObject({
      status: "unavailable",
      reason: "sem-not-found",
    });
    expect(runtime.calls.map(call => call.command)).not.toContain(repoSem);
  });

  test("returns error instead of throwing when sem exits nonzero", async () => {
    const runtime = makeRuntime({
      env: { PLANNOTATOR_SEM_PATH: "mock-sem" },
      commands: {
        "mock-sem": {
          version: "sem 0.8.0",
          stderr: "parse failed",
          exitCode: 2,
        },
      },
    });

    await expect(runSemanticDiff({ rawPatch: "diff --git a/a.ts b/a.ts\n" }, runtime)).resolves.toMatchObject({
      status: "error",
      reason: "sem-exit",
      exitCode: 2,
      message: "parse failed",
    });
  });

  test("returns error instead of throwing when sem returns invalid JSON", async () => {
    const runtime = makeRuntime({
      env: { PLANNOTATOR_SEM_PATH: "mock-sem" },
      commands: {
        "mock-sem": {
          version: "sem 0.8.0",
          diff: "not json",
        },
      },
    });

    await expect(runSemanticDiff({ rawPatch: "diff --git a/a.ts b/a.ts\n" }, runtime)).resolves.toMatchObject({
      status: "error",
      reason: "invalid-json",
    });
  });

  test("uses managed sidecar before PATH fallback", async () => {
    const managed = getManagedSemBinaryPath("/home/user/.plannotator", "linux");
    const runtime = makeRuntime({
      files: [managed],
      commands: {
        [managed]: { version: "sem 0.8.0" },
        sem: { version: "sem 0.9.0" },
      },
    });

    await expect(getSemanticDiffAvailability(runtime)).resolves.toMatchObject({
      available: true,
      semVersion: "0.8.0",
      semSource: "managed",
    });
    expect(runtime.calls[0].command).toBe(managed);
  });

  test("does not fall back to bare sem on Windows when PATH resolution misses", async () => {
    const runtime = makeRuntime({
      platform: "win32",
      pathDelimiter: ";",
      env: {
        PATH: "C:/repo;C:/tools",
        PATHEXT: ".EXE",
      },
      commands: {
        sem: { version: "sem 0.8.0" },
      },
    });

    await expect(getSemanticDiffAvailability(runtime)).resolves.toMatchObject({
      available: false,
      reason: "sem-not-found",
    });
    expect(runtime.calls).toEqual([]);
  });

  test("resolves an absolute sem.exe from PATH on Windows", async () => {
    const semPath = "C:/tools/sem.exe";
    const runtime = makeRuntime({
      platform: "win32",
      pathDelimiter: ";",
      env: {
        PATH: "C:/tools",
        PATHEXT: ".EXE",
      },
      files: [semPath],
      commands: {
        [semPath]: { version: "sem 0.8.0" },
      },
    });

    await expect(getSemanticDiffAvailability(runtime)).resolves.toMatchObject({
      available: true,
      semVersion: "0.8.0",
      semSource: "path",
    });
    expect(runtime.calls[0].command).toBe(semPath);
  });

  test("cache key accounts for patch, cwd, and file extensions", () => {
    const a = semanticDiffCacheKey({ rawPatch: "a", cwd: "/repo", fileExts: ["ts"] });
    const b = semanticDiffCacheKey({ rawPatch: "a", cwd: "/repo", fileExts: [".ts"] });
    const c = semanticDiffCacheKey({ rawPatch: "a", cwd: "/other", fileExts: [".ts"] });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  test("parses requested file extensions without applying a default filter", () => {
    expect(semanticDiffFileExtsFromSearchParams(new URLSearchParams())).toEqual([]);
    expect(semanticDiffFileExtsFromSearchParams(new URLSearchParams("fileExt=ts&fileExts=.tsx,jsx"))).toEqual([
      ".ts",
      ".tsx",
      ".jsx",
    ]);
  });

  test("response cache clears when the patch changes and evicts oldest entries", () => {
    const cache = new SemanticDiffResponseCache(1);
    const first: SemanticDiffResponse = {
      status: "unavailable",
      reason: "sem-not-found",
      message: "missing",
    };
    const second: SemanticDiffResponse = {
      status: "error",
      reason: "sem-exit",
      message: "failed",
    };

    cache.set("a", "patch-a", first);
    expect(cache.get("a", "patch-a")).toBe(first);
    cache.set("b", "patch-a", second);
    expect(cache.get("a", "patch-a")).toBeUndefined();
    expect(cache.get("b", "patch-a")).toBe(second);
    expect(cache.get("b", "patch-b")).toBeUndefined();
  });
});
