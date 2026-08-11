import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CALLDIFF_COMMIT,
  CALLDIFF_SOURCE_INTEGRITY,
  CALLDIFF_VERSION,
  CallFlowService,
  createCallFlowSnapshotPlan,
  getCallFlowManagedRuntimeDir,
  resolveCallFlowRuntime,
  pruneCallFlowNativePackage,
  type CallFlowAnalysisInput,
  type CallFlowRuntime,
} from "./call-flow";
import type { ParsedCallDiffWorkerResult } from "./call-flow-types";

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

function input(snapshotId = "snapshot"): CallFlowAnalysisInput {
  return {
    snapshotId,
    cwd: repo,
    diffType: "uncommitted",
    base: "main",
    rawPatch: "",
    vcsType: "git",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

describe("createCallFlowSnapshotPlan", () => {
  test("materializes an uncommitted patch as an immutable commit without changing the source repo", async () => {
    writeFileSync(join(repo, "main.ts"), "export function helper() { return 2; }\nexport function main() { return helper(); }\n");
    const patch = run(["diff", "--binary", "--full-index"]);
    const sourceHead = run(["rev-parse", "HEAD"]);
    const plan = await createCallFlowSnapshotPlan({ snapshotId: "s", cwd: repo, diffType: "uncommitted", base: "main", rawPatch: patch, vcsType: "git" });
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
    const plan = await createCallFlowSnapshotPlan({ snapshotId: "s", cwd: repo, diffType: "unstaged", base: "main", rawPatch: patch, vcsType: "git" });
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

    await service.getAdvert(true, { vcsType: "git", diffType: "uncommitted" });
    await service.getAdvert(true, { vcsType: "git", diffType: "staged" });
    expect(probes).toBe(1);
    now += 5_001;
    await service.getAdvert(true, { vcsType: "git", diffType: "unstaged" });
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

    const before = await service.getAdvert(true, { vcsType: "git", diffType: "uncommitted" });
    expect(before.state).toBe("unavailable");
    expect(probes).toBe(1);

    // Without invalidation the 60s TTL would keep reporting unavailable.
    available = true;
    const cached = await service.getAdvert(true, { vcsType: "git", diffType: "uncommitted" });
    expect(cached.state).toBe("unavailable");
    expect(probes).toBe(1);

    service.invalidateRuntimeProbe();
    const after = await service.getAdvert(true, { vcsType: "git", diffType: "uncommitted" });
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

    const advert = await service.getAdvert(true, { vcsType: "git", diffType: "uncommitted", rawPatch });
    expect(advert.state).toBe("unavailable");
    expect(advert.installable).toBe(true);
    expect(advert.installPlan?.languageIds).toEqual(["javascript-typescript", "python"]);
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

    const allFiles = await service.getAdvert(true, { vcsType: "git", diffType: "all" });
    const jj = await service.getAdvert(true, { vcsType: "jj", diffType: "jj-working-copy" });

    expect(allFiles.state).toBe("unsupported");
    expect(jj.state).toBe("unsupported");
    expect(probes).toBe(0);
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

    const advert = await service.getAdvert(true, { vcsType: "git", diffType: "uncommitted", rawPatch });
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
    const advert = await service.getAdvert(true, { vcsType: "git", diffType: "uncommitted", rawPatch: "" });
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
