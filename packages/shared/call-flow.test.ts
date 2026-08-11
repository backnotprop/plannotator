import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CALLDIFF_SOURCE_INTEGRITY,
  CallFlowService,
  createCallFlowSnapshotPlan,
  resolveCallFlowRuntime,
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
  packageEntry: "/runtime/calldiff/dist/index.js",
  runtimeDir: "/runtime",
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
});
