import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CALLDIFF_COMMIT,
  CALLDIFF_SOURCE_INTEGRITY,
  CALLDIFF_VERSION,
  CallFlowService,
  getCallFlowManagedRuntimeDir,
  resolveCallFlowRuntime,
  pruneCallFlowNativePackage,
  type CallFlowAnalysisInput,
  type CallFlowRuntime,
} from "./call-flow";
import type { ParsedCallDiffWorkerResult } from "./call-flow-types";
import type { ReviewGitRuntime } from "./review-core";
import { createGitProvider, createJjProvider, createVcsApi } from "./vcs-core";

let repo = "";

function run(args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "plannotator-call-flow-test-"));
  run(["init", "-q"]);
  run(["config", "user.name", "Test"]);
  run(["config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "main.ts"), "export function main() { return 1; }\n");
  run(["add", "main.ts"]);
  run(["commit", "-qm", "initial"]);
});

afterEach(() => rmSync(repo, { recursive: true, force: true }));

const runtime: CallFlowRuntime = {
  nodePath: "node",
  packageEntry: "/runtime/calldiff/dist/run.js",
  runtimeDir: "/runtime",
  grammarCacheDir: "/runtime/grammar-cache",
  installedLanguageIds: ["javascript-typescript"],
  managed: true,
  version: "0.4.1",
};

const parsedResult: ParsedCallDiffWorkerResult = {
  version: "0.4.1",
  from: "before",
  to: "after",
  raw: "",
  trees: [],
  diagnostics: [],
};

const reviewRuntime: ReviewGitRuntime = {
  async runGit(args, options) {
    const result = Bun.spawnSync(["git", ...args], {
      cwd: options?.cwd,
      stdin: options?.stdin === undefined ? undefined : Buffer.from(options.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
      exitCode: result.exitCode,
    };
  },
  async readTextFile() { return null; },
  async getFileInfo() { return null; },
  async readLink() { return null; },
};

const gitVcs = createVcsApi([createGitProvider(reviewRuntime)]);

function input(snapshotId = "snapshot"): CallFlowAnalysisInput {
  return {
    snapshotId,
    rawPatch: "",
    snapshot: {
      materialize: ({ includedExtensions, signal }) => gitVcs.materializeVcsSnapshot("git", {
        cwd: repo,
        diffType: "uncommitted",
        base: "main",
        rawPatch: "",
        includedExtensions,
        signal,
      }),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("VCS snapshot materialization", () => {
  test("materializes an uncommitted patch as an immutable commit without changing the source repo", async () => {
    writeFileSync(join(repo, "main.ts"), "export function helper() { return 2; }\nexport function main() { return helper(); }\n");
    const patch = run(["diff", "--binary", "--full-index"]);
    const sourceHead = run(["rev-parse", "HEAD"]);
    expect(gitVcs.vcsSupportsSnapshot("git", "uncommitted")).toBe(true);
    expect(gitVcs.vcsSupportsSnapshot("git", "all")).toBe(false);
    const plan = await gitVcs.materializeVcsSnapshot("git", { cwd: repo, diffType: "uncommitted", base: "main", rawPatch: patch, includedExtensions: [".ts"] });
    try {
      expect(plan.from).toBe(sourceHead);
      expect(Bun.spawnSync(["git", "show", `${plan.to}:main.ts`], { cwd: plan.cwd }).stdout.toString()).toContain("helper()");
      expect(run(["rev-parse", "HEAD"])).toBe(sourceHead);
      expect(run(["status", "--short"])).toBe("M main.ts");
    } finally {
      plan.cleanup();
    }
  });

  test("uses the index snapshot as the left side of an unstaged review", async () => {
    writeFileSync(join(repo, "main.ts"), "export function staged() { return 2; }\n");
    run(["add", "main.ts"]);
    writeFileSync(join(repo, "main.ts"), "export function staged() { return 2; }\nexport function unstaged() { return 3; }\n");
    const patch = run(["diff", "--binary", "--full-index"]);
    const plan = await gitVcs.materializeVcsSnapshot("git", { cwd: repo, diffType: "unstaged", base: "main", rawPatch: patch, includedExtensions: [".ts"] });
    try {
      const before = Bun.spawnSync(["git", "show", `${plan.from}:main.ts`], { cwd: plan.cwd }).stdout.toString();
      const after = Bun.spawnSync(["git", "show", `${plan.to}:main.ts`], { cwd: plan.cwd }).stdout.toString();
      expect(before).toContain("staged");
      expect(before).not.toContain("unstaged");
      expect(after).toContain("unstaged");
    } finally {
      plan.cleanup();
    }
  });

  test("materializes the parseable Jujutsu source tree without touching the checkout", async () => {
    const calls: string[][] = [];
    // The base side is the whole parseable tree at the resolved first parent.
    const basePatch = [
      "diff --git a/alias.ts b/alias.ts",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/alias.ts",
      "@@ -0,0 +1 @@",
      "+main.ts",
      "\\ No newline at end of file",
      "diff --git a/binary.ts b/binary.ts",
      "new file mode 100644",
      "Binary files /dev/null and b/binary.ts differ",
      "diff --git a/main.ts b/main.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/main.ts",
      "@@ -0,0 +1 @@",
      "+export const version = 1;",
      "diff --git a/tool.ts b/tool.ts",
      "new file mode 100755",
      "--- /dev/null",
      "+++ b/tool.ts",
      "@@ -0,0 +1 @@",
      "+export const tool = 1;",
      "",
    ].join("\n");
    // The second side is only what changed between the two revisions.
    const deltaPatch = [
      "diff --git a/alias.ts b/alias.ts",
      "--- a/alias.ts",
      "+++ b/alias.ts",
      "@@ -1 +1 @@",
      "-main.ts",
      "\\ No newline at end of file",
      "+tool.ts",
      "\\ No newline at end of file",
      "diff --git a/main.ts b/main.ts",
      "--- a/main.ts",
      "+++ b/main.ts",
      "@@ -1 +1 @@",
      "-export const version = 1;",
      "+export const version = 2;",
      "diff --git a/tool.ts b/tool.ts",
      "old mode 100755",
      "new mode 100644",
      "",
    ].join("\n");
    const mergeParents = ["1111111111111111111111111111111111111111", "2222222222222222222222222222222222222222"];
    const jjRuntime = {
      async runJj(args: string[]) {
        calls.push(args);
        // `@` is a MERGE here, so the old `@-` revset would have been ambiguous.
        if (args.includes("log")) {
          return { stdout: mergeParents.join("\n"), stderr: "", exitCode: 0 };
        }
        const from = args[args.indexOf("--from") + 1];
        return {
          stdout: from === "root()" ? basePatch : deltaPatch,
          stderr: "",
          exitCode: 0,
        };
      },
    };
    const jjVcs = createVcsApi([createJjProvider(jjRuntime, reviewRuntime)]);
    expect(jjVcs.vcsSupportsSnapshot("jj", "jj-current")).toBe(true);
    expect(jjVcs.vcsSupportsSnapshot("jj", "jj-all")).toBe(false);
    const plan = await jjVcs.materializeVcsSnapshot("jj", {
      cwd: repo,
      diffType: "jj-current",
      base: "main",
      rawPatch: "diff --git a/main.ts b/main.ts\n",
      includedExtensions: [".ts"],
    });
    try {
      const oldTree = Bun.spawnSync(["git", "ls-tree", plan.from], { cwd: plan.cwd }).stdout.toString();
      const newTree = Bun.spawnSync(["git", "ls-tree", plan.to], { cwd: plan.cwd }).stdout.toString();
      expect(oldTree).toContain("120000 blob");
      expect(oldTree).toContain("100755 blob");
      expect(newTree).not.toContain("100755 blob");
      expect(Bun.spawnSync(["git", "show", `${plan.from}:main.ts`], { cwd: plan.cwd }).stdout.toString()).toContain("version = 1");
      expect(Bun.spawnSync(["git", "show", `${plan.to}:main.ts`], { cwd: plan.cwd }).stdout.toString()).toContain("version = 2");
      expect(Bun.spawnSync(["git", "show", `${plan.from}:alias.ts`], { cwd: plan.cwd }).stdout.toString()).toBe("main.ts");
      expect(Bun.spawnSync(["git", "show", `${plan.to}:alias.ts`], { cwd: plan.cwd }).stdout.toString()).toBe("tool.ts");
      // The delta never mentions tool.ts contents, so the second side can only
      // carry them by having been built ON TOP of the base tree.
      expect(Bun.spawnSync(["git", "show", `${plan.to}:tool.ts`], { cwd: plan.cwd }).stdout.toString()).toContain("tool = 1");
      expect(Bun.spawnSync(["git", "cat-file", "-e", `${plan.to}:binary.ts`], { cwd: plan.cwd }).exitCode).not.toBe(0);
      expect(run(["status", "--short"])).toBe("");

      const diffs = calls.filter((args) => args.includes("diff"));
      // Exactly one whole-tree pass; the second side is the changed files only.
      expect(diffs.map((args) => args[args.indexOf("--from") + 1]))
        .toEqual(["root()", mergeParents[0]]);
      expect(diffs.map((args) => args[args.indexOf("--to") + 1]))
        .toEqual([mergeParents[0], "@"]);
      // Ambiguous parent shorthands must never reach jj.
      expect(calls.flat()).not.toContain("@-");
      expect(calls.flat()).not.toContain("parents(@-)");
      expect(calls.every((args) => args[0] === "--ignore-working-copy")).toBe(true);
      // Repo-root-anchored, so the review's invocation directory cannot narrow it.
      expect(diffs.every((args) => args.includes('root-glob-i:"**/*.ts"'))).toBe(true);
      expect(diffs.every((args) => args.some((arg) => arg.startsWith("glob-i:")))).toBe(false);
    } finally {
      plan.cleanup();
    }
  });

  test("refuses a Jujutsu snapshot whose diff hit the runtime output ceiling", async () => {
    // A truncated tree would otherwise become a valid-looking snapshot and
    // CallDiff would report call-graph edges that do not exist.
    let requestedCap: number | undefined;
    const jjRuntime = {
      async runJj(args: string[], options?: { maxOutputBytes?: number }) {
        if (args.includes("log")) return { stdout: "abc", stderr: "", exitCode: 0 };
        requestedCap = options?.maxOutputBytes;
        return { stdout: "diff --git a/main.ts b/main.ts\n", stderr: "", exitCode: 0, truncated: true };
      },
    };
    const jjVcs = createVcsApi([createJjProvider(jjRuntime, reviewRuntime)]);
    expect(jjVcs.materializeVcsSnapshot("jj", {
      cwd: repo,
      diffType: "jj-current",
      base: "main",
      rawPatch: "",
      includedExtensions: [".ts"],
    })).rejects.toThrow(/64 MB/);
    expect(requestedCap).toBe(64 * 1024 * 1024);
  });
});

describe("CallFlowService", () => {
  test("shares one in-flight execution for the Dock and Lens", async () => {
    const execution = deferred<ParsedCallDiffWorkerResult>();
    let executions = 0;
    const service = new CallFlowService({
      resolveRuntime: async () => ({ ok: true, runtime }),
      executeAnalysis: async () => {
        executions++;
        return execution.promise;
      },
    });

    const first = service.analyze(input());
    const second = service.analyze(input());
    expect(second).toBe(first);
    execution.resolve(parsedResult);

    expect((await first).status).toBe("ok");
    expect(await second).toEqual(await first);
    expect(executions).toBe(1);
  });

  test("never caches a result whose snapshot revalidation fails", async () => {
    let executions = 0;
    const service = new CallFlowService({
      resolveRuntime: async () => ({ ok: true, runtime }),
      executeAnalysis: async () => {
        executions++;
        return parsedResult;
      },
    });

    const stale = await service.analyze({ ...input(), verifySnapshot: async () => false });
    const fresh = await service.analyze({ ...input(), verifySnapshot: async () => true });

    expect(stale.status).toBe("stale");
    expect(fresh.status).toBe("ok");
    expect(executions).toBe(2);
  });

  test("cools down repeated failures and permits an explicit retry after expiry", async () => {
    let now = 1_000;
    let executions = 0;
    const service = new CallFlowService({
      now: () => now,
      resolveRuntime: async () => ({ ok: true, runtime }),
      executeAnalysis: async () => {
        executions++;
        throw new Error("temporary failure");
      },
    });

    expect((await service.analyze(input())).status).toBe("error");
    expect((await service.analyze(input())).status).toBe("error");
    expect(executions).toBe(1);

    now += 30_001;
    expect((await service.analyze(input())).status).toBe("error");
    expect(executions).toBe(2);
  });

  test("supersedes an older snapshot before starting the newer one", async () => {
    const started: string[] = [];
    const oldStarted = deferred<void>();
    const service = new CallFlowService({
      resolveRuntime: async () => ({ ok: true, runtime }),
      executeAnalysis: async (_runtime, analysisInput, signal) => {
        started.push(analysisInput.snapshotId);
        if (analysisInput.snapshotId === "old") {
          oldStarted.resolve();
          await new Promise<void>((resolveAbort) => {
            signal.addEventListener("abort", () => resolveAbort(), { once: true });
          });
        }
        return parsedResult;
      },
    });

    const old = service.analyze(input("old"));
    await oldStarted.promise;
    const current = service.analyze(input("current"));

    expect((await old).status).toBe("stale");
    expect((await current).status).toBe("ok");
    expect(started).toEqual(["old", "current"]);
  });

  test("caches the runtime capability probe for a bounded interval", async () => {
    let now = 1_000;
    let probes = 0;
    const service = new CallFlowService({
      now: () => now,
      runtimeProbeTtlMs: 5_000,
      resolveRuntime: async () => {
        probes++;
        return { ok: true, runtime };
      },
    });

    await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    expect(probes).toBe(1);
    now += 5_001;
    await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    expect(probes).toBe(2);
  });

  test("invalidating the runtime probe re-resolves before the TTL expires", async () => {
    let probes = 0;
    let available = false;
    const service = new CallFlowService({
      runtimeProbeTtlMs: 60_000,
      resolveRuntime: async () => {
        probes++;
        return available
          ? { ok: true, runtime }
          : { ok: false, reason: "runtime-unavailable", message: "not installed" };
      },
    });

    const before = await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    expect(before.state).toBe("unavailable");
    expect(probes).toBe(1);

    // Without invalidation the 60s TTL would keep reporting unavailable.
    available = true;
    const cached = await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    expect(cached.state).toBe("unavailable");
    expect(probes).toBe(1);

    service.invalidateRuntimeProbe();
    const after = await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    expect(after.state).toBe("available");
    expect(probes).toBe(2);
  });

  test("offers the managed install flow when Node preflight must explain recovery", async () => {
    const service = new CallFlowService({
      resolveRuntime: async () => ({
        ok: false,
        reason: "node-unavailable",
        message: "Call flow requires Node.js 22 or newer, which was not found on PATH.",
      }),
    });
    const rawPatch = [
      "diff --git a/tool.py b/tool.py",
      "--- a/tool.py",
      "+++ b/tool.py",
      "@@ -1 +1 @@",
      "-pass",
      "+print('changed')",
    ].join("\n");

    const advert = await service.getAdvert(true, { snapshotSupported: true, rawPatch });
    expect(advert.state).toBe("unavailable");
    expect(advert.installable).toBe(true);
    expect(advert.installPlan?.languageIds).toEqual(["javascript-typescript", "python"]);
  });

  test("advertises the exact managed install consent while the feature is disabled", async () => {
    let probes = 0;
    const service = new CallFlowService({
      resolveRuntime: async () => {
        probes++;
        return { ok: false, reason: "runtime-unavailable", message: "not installed" };
      },
    });
    const rawPatch = [
      "diff --git a/tool.py b/tool.py",
      "--- a/tool.py",
      "+++ b/tool.py",
      "@@ -1 +1 @@",
      "-pass",
      "+print('changed')",
    ].join("\n");

    const advert = await service.getAdvert(false, { snapshotSupported: true, rawPatch });
    expect(advert).toMatchObject({
      enabled: false,
      state: "disabled",
      installable: true,
      consentPlan: {
        languageIds: ["javascript-typescript", "python"],
        labels: ["JavaScript and TypeScript", "Python"],
        installSizeBytes: 6 * 1024 * 1024,
      },
    });
    expect(probes).toBe(0);
  });

  test("does not advertise automatic consent work for an override while disabled", async () => {
    const previousOverride = process.env.PLANNOTATOR_CALLDIFF_PATH;
    process.env.PLANNOTATOR_CALLDIFF_PATH = "/tmp/external-calldiff";
    let probes = 0;
    const service = new CallFlowService({
      resolveRuntime: async () => {
        probes++;
        return { ok: true, runtime: { ...runtime, managed: false } };
      },
    });
    try {
      const advert = await service.getAdvert(false, {
        snapshotSupported: true,
        rawPatch: "diff --git a/tool.py b/tool.py\n",
      });
      expect(advert).toMatchObject({ enabled: false, state: "disabled", installable: false });
      expect(advert.consentPlan).toBeUndefined();
      expect(probes).toBe(0);
    } finally {
      if (previousOverride === undefined) delete process.env.PLANNOTATOR_CALLDIFF_PATH;
      else process.env.PLANNOTATOR_CALLDIFF_PATH = previousOverride;
    }
  });

  test("runtime installation invalidates a cached partial result for the same snapshot", async () => {
    let executions = 0;
    let installedLanguageIds: CallFlowRuntime["installedLanguageIds"] = ["javascript-typescript"];
    const service = new CallFlowService({
      resolveRuntime: async () => ({ ok: true, runtime: { ...runtime, installedLanguageIds } }),
      executeAnalysis: async () => {
        executions++;
        return parsedResult;
      },
    });
    const rawPatch = [
      "diff --git a/tool.py b/tool.py",
      "--- a/tool.py",
      "+++ b/tool.py",
      "@@ -1 +1 @@",
      "-pass",
      "+print('changed')",
    ].join("\n");

    const before = await service.analyze({ ...input(), rawPatch });
    expect(before.status === "ok" ? before.skippedLanguages.map(({ id }) => id) : []).toEqual(["python"]);
    installedLanguageIds = ["javascript-typescript", "python"];
    service.invalidateRuntimeState();
    const after = await service.analyze({ ...input(), rawPatch });
    expect(after.status === "ok" ? after.skippedLanguages : []).toEqual([]);
    expect(executions).toBe(2);
  });

  test("rejects unsupported views before probing or executing the runtime", async () => {
    let probes = 0;
    const service = new CallFlowService({
      resolveRuntime: async () => {
        probes++;
        return { ok: true, runtime };
      },
    });

    const allFiles = await service.getAdvert(true, { snapshotSupported: false, rawPatch: "" });
    const jj = await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    const jjAll = await service.getAdvert(true, { snapshotSupported: false, rawPatch: "" });
    const disabledAllFiles = await service.getAdvert(false, { snapshotSupported: false, rawPatch: "" });
    const disabledJj = await service.getAdvert(false, { snapshotSupported: true, rawPatch: "" });

    expect(allFiles.state).toBe("unsupported");
    expect(jj.state).toBe("available");
    expect(jjAll).toMatchObject({ state: "unsupported", reason: "view-unsupported" });
    expect(disabledAllFiles).toMatchObject({ state: "disabled", reason: "view-unsupported" });
    expect(disabledAllFiles.consentPlan).toBeUndefined();
    expect(disabledJj).toMatchObject({ state: "disabled" });
    expect(disabledJj.consentPlan).toBeDefined();
    expect(probes).toBe(1);
  });

  test("advertises only the missing language packs required by the current patch", async () => {
    const service = new CallFlowService({ resolveRuntime: async () => ({ ok: true, runtime }) });
    const rawPatch = [
      "diff --git a/tool.py b/tool.py",
      "--- a/tool.py",
      "+++ b/tool.py",
      "@@ -1 +1 @@",
      "-pass",
      "+print('changed')",
    ].join("\n");

    const advert = await service.getAdvert(true, { snapshotSupported: true, rawPatch });
    expect(advert.state).toBe("available");
    expect(advert.installPlan?.languageIds).toEqual(["python"]);
    expect(advert.installPlan?.changedFiles).toBe(1);
    expect(advert.languages?.find((language) => language.id === "python")).toMatchObject({ installed: false, required: true });
    expect(advert.languages?.find((language) => language.id === "go")).toMatchObject({ installed: false, required: false });
  });

  test("returns a successful partial result with explicit skipped files", async () => {
    const service = new CallFlowService({
      resolveRuntime: async () => ({ ok: true, runtime }),
      executeAnalysis: async () => parsedResult,
    });
    const rawPatch = [
      "diff --git a/tool.py b/tool.py",
      "--- a/tool.py",
      "+++ b/tool.py",
      "@@ -1 +1 @@",
      "-pass",
      "+print('changed')",
    ].join("\n");
    const result = await service.analyze({ ...input(), rawPatch });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.skippedLanguages).toEqual([{
        id: "python",
        label: "Python",
        files: ["tool.py"],
        installSizeBytes: 1024 * 1024,
      }]);
    }
  });

  test("never offers the managed funnel for an invalid runtime override", async () => {
    const service = new CallFlowService({
      resolveRuntime: async () => ({ ok: false, reason: "override-relative", message: "Override must be absolute." }),
    });
    const advert = await service.getAdvert(true, { snapshotSupported: true, rawPatch: "" });
    expect(advert.state).toBe("unavailable");
    expect(advert.installable).toBe(false);
    expect(advert.installPlan).toBeUndefined();
  });

  test("the worker cannot invoke npm during analysis", async () => {
    writeFileSync(join(repo, "main.ts"), "export function main() { return changed(); }\nfunction changed() { return 2; }\n");
    const rawPatch = run(["diff", "--binary", "--full-index"]);
    const runtimeDir = join(repo, "fake-runtime");
    const packageRoot = join(runtimeDir, "node_modules", "calldiff");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "0.4.1" }));
    writeFileSync(join(packageRoot, "dist", "run.js"), [
      'import { execFileSync } from "node:child_process";',
      'export function runDiff() { execFileSync("npm", ["--version"]); return {}; }',
    ].join("\n"));
    for (const [name, version] of [["tree-sitter", "0.25.1"], ["tree-sitter-javascript", "0.25.0"], ["tree-sitter-typescript", "0.23.2"]]) {
      const grammarRoot = join(runtimeDir, "node_modules", name);
      mkdirSync(grammarRoot, { recursive: true });
      writeFileSync(join(grammarRoot, "package.json"), JSON.stringify({ version }));
    }
    const fakeRuntime: CallFlowRuntime = {
      nodePath: process.execPath,
      packageEntry: join(packageRoot, "dist", "run.js"),
      runtimeDir,
      grammarCacheDir: join(runtimeDir, "grammar-cache"),
      installedLanguageIds: ["javascript-typescript"],
      managed: true,
      version: "0.4.1",
    };
    const service = new CallFlowService({ resolveRuntime: async () => ({ ok: true, runtime: fakeRuntime }) });
    const result = await service.analyze({ ...input(), rawPatch });
    expect(result.status).toBe("error");
    if (result.status === "error") expect(result.message).toContain("package installation is disabled during analysis");
  });

  test("a worker-side grammar race becomes a missing-grammar state", async () => {
    writeFileSync(join(repo, "tool.py"), "def before():\n    pass\n");
    run(["add", "tool.py"]);
    run(["commit", "-qm", "add python"]);
    writeFileSync(join(repo, "tool.py"), "def after():\n    pass\n");
    const rawPatch = run(["diff", "--binary", "--full-index"]);
    const runtimeDir = join(repo, "missing-runtime");
    const packageRoot = join(runtimeDir, "node_modules", "calldiff");
    mkdirSync(join(packageRoot, "dist"), { recursive: true });
    writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ type: "module", version: "0.4.1" }));
    writeFileSync(join(packageRoot, "dist", "run.js"), "export function runDiff() { throw new Error('must not run'); }\n");
    const fakeRuntime: CallFlowRuntime = {
      nodePath: process.execPath,
      packageEntry: join(packageRoot, "dist", "run.js"),
      runtimeDir,
      grammarCacheDir: join(runtimeDir, "grammar-cache"),
      installedLanguageIds: ["javascript-typescript", "python"],
      managed: true,
      version: "0.4.1",
    };
    const service = new CallFlowService({ resolveRuntime: async () => ({ ok: true, runtime: fakeRuntime }) });
    const result = await service.analyze({ ...input(), rawPatch });
    expect(result).toMatchObject({ status: "unavailable", reason: "missing-grammar" });
  });
});

describe("managed CallDiff runtime", () => {
  test("ships a lock whose remote packages all have integrity hashes", () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dir, "call-flow-runtime", "package.json"), "utf8"));
    const lock = JSON.parse(readFileSync(join(import.meta.dir, "call-flow-runtime", "package-lock.json"), "utf8"));

    expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
    expect(lock.packages["node_modules/calldiff"].integrity).toBe(CALLDIFF_SOURCE_INTEGRITY);
    for (const entry of Object.values(lock.packages) as Array<{ resolved?: string; integrity?: string }>) {
      if (entry.resolved?.startsWith("http")) expect(entry.integrity).toStartWith("sha512-");
    }
  });

  test("ships an independent integrity-complete lock for every optional grammar", () => {
    const packsRoot = join(import.meta.dir, "call-flow-runtime", "packs");
    for (const id of readdirSync(packsRoot)) {
      const manifest = JSON.parse(readFileSync(join(packsRoot, id, "package.json"), "utf8"));
      const lock = JSON.parse(readFileSync(join(packsRoot, id, "package-lock.json"), "utf8"));
      expect(lock.packages[""].dependencies).toEqual(manifest.dependencies);
      for (const entry of Object.values(lock.packages) as Array<{ resolved?: string; integrity?: string }>) {
        if (entry.resolved?.startsWith("http")) expect(entry.integrity).toStartWith("sha512-");
      }
    }
  });

  test("prunes foreign/source artifacts but preserves final locally-built addons", () => {
    const packageRoot = join(repo, "native-package");
    const currentPrebuild = join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`);
    mkdirSync(currentPrebuild, { recursive: true });
    mkdirSync(join(packageRoot, "prebuilds", "foreign-platform"), { recursive: true });
    mkdirSync(join(packageRoot, "src"), { recursive: true });
    mkdirSync(join(packageRoot, "build", "Release"), { recursive: true });
    writeFileSync(join(currentPrebuild, "grammar.node"), "current");
    writeFileSync(join(packageRoot, "prebuilds", "foreign-platform", "grammar.node"), "foreign");
    writeFileSync(join(packageRoot, "src", "parser.c"), "generated");
    writeFileSync(join(packageRoot, "build", "Release", "compiled.node"), "compiled");
    writeFileSync(join(packageRoot, "build", "Makefile"), "intermediate");

    pruneCallFlowNativePackage(packageRoot);

    expect(existsSync(join(currentPrebuild, "grammar.node"))).toBe(true);
    expect(existsSync(join(packageRoot, "prebuilds", "foreign-platform"))).toBe(false);
    expect(existsSync(join(packageRoot, "src"))).toBe(false);
    expect(readFileSync(join(packageRoot, "build", "Release", "compiled.node"), "utf8")).toBe("compiled");
    expect(existsSync(join(packageRoot, "build", "Makefile"))).toBe(false);
  });

  test("rejects a relative PLANNOTATOR_CALLDIFF_PATH before inspecting the review cwd", async () => {
    const previous = process.env.PLANNOTATOR_CALLDIFF_PATH;
    process.env.PLANNOTATOR_CALLDIFF_PATH = "relative/runtime";
    try {
      const result = await resolveCallFlowRuntime();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("override-relative");
    } finally {
      if (previous === undefined) delete process.env.PLANNOTATOR_CALLDIFF_PATH;
      else process.env.PLANNOTATOR_CALLDIFF_PATH = previous;
    }
  });

  test("rejects a managed core whose pinned Tree-sitter parser is missing", async () => {
    const previousDataDir = process.env.PLANNOTATOR_DATA_DIR;
    process.env.PLANNOTATOR_DATA_DIR = repo;
    try {
      const runtimeDir = getCallFlowManagedRuntimeDir();
      const callDiffRoot = join(runtimeDir, "node_modules", "calldiff");
      mkdirSync(join(callDiffRoot, "dist"), { recursive: true });
      writeFileSync(join(callDiffRoot, "package.json"), JSON.stringify({ name: "calldiff", version: CALLDIFF_VERSION }));
      writeFileSync(join(callDiffRoot, "dist", "run.js"), "export const runDiff = () => {};\n");
      writeFileSync(join(runtimeDir, ".calldiff-revision"), `${CALLDIFF_COMMIT}\n`);
      writeFileSync(join(runtimeDir, "package-lock.json"), readFileSync(join(import.meta.dir, "call-flow-runtime", "package-lock.json")));
      for (const [name, version] of [
        ["tree-sitter-javascript", "0.25.0"],
        ["tree-sitter-typescript", "0.23.2"],
      ] as const) {
        const dependencyRoot = join(runtimeDir, "node_modules", name);
        mkdirSync(dependencyRoot, { recursive: true });
        writeFileSync(join(dependencyRoot, "package.json"), JSON.stringify({ name, version }));
      }

      const result = await resolveCallFlowRuntime();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("core-incomplete");
    } finally {
      if (previousDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = previousDataDir;
    }
  });
});
