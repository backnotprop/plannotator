/**
 * @plannotator/dsh plugin tests: the plan-review listener against a fake DSH
 * context and a stub `plannotator` (a temp shell script printing fixed JSON).
 *
 * Run: bun test apps/dsh-plugin/plan-review.test.ts
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "./index";
import { parseDshPlanOutput, resolvePlannotatorBinary } from "./cli";
import {
  resolveConfig,
  type DshAnswer,
  type DshContext,
  type DshQuestionRequest,
  type DshUserMessage,
} from "./plan-review";

const posixOnly = process.platform === "win32" ? test.skip : test;
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-dsh-plugin-"));
  tempDirs.push(dir);
  return dir;
}

/** A stub CLI that records its stdin, origin and cwd, then runs `body`. */
function stubCli(body: string): { binary: string; dir: string } {
  const dir = tempDir();
  const binary = join(dir, "plannotator");
  writeFileSync(binary, [
    "#!/bin/sh",
    `cat > "${dir}/stdin.json"`,
    `printf '%s\\n' "$1|$PLANNOTATOR_ORIGIN|$PLANNOTATOR_CWD|$(pwd -P)" > "${dir}/call.txt"`,
    body,
    "",
  ].join("\n"));
  chmodSync(binary, 0o755);
  return { binary, dir };
}

const printJson = (value: unknown) => `printf '%s\\n' '${JSON.stringify(value)}'`;

/** A fake Cordis context: captures the listener apply() registers. */
function fakeContext(workingDirectory?: string) {
  const warnings: string[] = [];
  let listener: ((request: DshQuestionRequest, next: () => Promise<DshAnswer>) => Promise<DshAnswer>) | undefined;
  let prepended = false;
  const disposers: (() => void)[] = [];
  const ctx: DshContext = {
    on: (_event, fn, options) => {
      listener = fn;
      prepended = options?.prepend === true;
      return () => true;
    },
    get: (name) => (name === "workingDirectory" && workingDirectory ? { get: () => workingDirectory } : undefined),
    effect: (execute) => void disposers.push(execute()),
    logger: { warn: (format) => void warnings.push(format), info: () => {} },
  };
  return {
    ctx,
    warnings,
    get prepended() {
      return prepended;
    },
    /** What Cordis does when the plugin unloads: run the effect disposers. */
    unload() {
      for (const dispose of disposers.splice(0).reverse()) dispose();
    },
    listen(request: DshQuestionRequest, next: () => Promise<DshAnswer> = async () => NATIVE) {
      if (!listener) throw new Error("apply() registered no listener");
      return listener(request, next);
    },
  };
}

const NATIVE: DshAnswer = { answers: [{ id: "native", selected: ["from DSH's own card"] }] };

function planReviewRequest(overrides: Partial<DshQuestionRequest> = {}) {
  const steered: DshUserMessage[] = [];
  const request: DshQuestionRequest = {
    questions: [{
      id: "plan-review",
      detail: "# Plan\n\n1. Do it.\n",
      intent: { kind: "plan-review", approve: "Approve" },
    }],
    agent: {
      session: { header: { cwd: "/nowhere" } },
      steer: (message) => void steered.push(message),
    },
    ...overrides,
  };
  return { request, steered };
}

describe("plan-review listener", () => {
  // Catches: the plugin swallowing ordinary ask_user_question requests (or
  // approval prompts) that DSH's own answerers must handle.
  test("anything that is not a plan review goes to next()", async () => {
    const { binary, dir } = stubCli(printJson({ approved: true }));
    const fake = fakeContext();
    apply(fake.ctx, { binary });
    expect(fake.prepended).toBe(true);

    const answer = await fake.listen({ questions: [{ id: "q1", detail: "Pick one" }] });
    expect(answer).toBe(NATIVE);
    expect(existsSync(join(dir, "call.txt"))).toBe(false);
  });

  // Catches: approving with the wrong label (DSH reads exactly intent.approve
  // and no custom text as approval), or a plain approval steering a message.
  posixOnly("an approval answers with the approve label and steers nothing", async () => {
    const cwd = tempDir();
    const { binary, dir } = stubCli(printJson({ approved: true }));
    const fake = fakeContext(cwd);
    apply(fake.ctx, { binary });
    const { request, steered } = planReviewRequest();

    expect(await fake.listen(request)).toEqual({ answers: [{ id: "plan-review", selected: ["Approve"] }] });
    expect(steered).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "stdin.json"), "utf8")).plan).toBe("# Plan\n\n1. Do it.\n");
    // The review's project root is the DSH session's current directory.
    const [sub, origin, envCwd, processCwd] = readFileSync(join(dir, "call.txt"), "utf8").trim().split("|");
    expect(sub).toBe("dsh-plan");
    expect(origin).toBe("dsh");
    expect(envCwd).toBe(cwd);
    expect(processCwd).toBe(realpathSync(cwd));
  });

  // Catches: approval notes being dropped (DSH's answer has no field for them).
  posixOnly("an approval with notes approves, then steers the composed message", async () => {
    const { binary } = stubCli(printJson({ approved: true, feedback: "n", message: "Plan approved with notes! n" }));
    const fake = fakeContext();
    apply(fake.ctx, { binary });
    const { request, steered } = planReviewRequest();

    expect(await fake.listen(request)).toEqual({ answers: [{ id: "plan-review", selected: ["Approve"] }] });
    expect(steered).toHaveLength(1);
    expect(steered[0].role).toBe("user");
    expect(steered[0].content).toEqual([{ type: "text", text: "Plan approved with notes! n" }]);
  });

  // Catches: sending the raw feedback instead of the composed prompt, or
  // selecting a label (DSH then reads it as an approval attempt).
  posixOnly("a denial keeps planning with the composed message as custom text", async () => {
    const { binary } = stubCli(printJson({ approved: false, feedback: "raw", message: "YOUR PLAN WAS NOT APPROVED. raw" }));
    const fake = fakeContext();
    apply(fake.ctx, { binary });
    const { request, steered } = planReviewRequest();

    expect(await fake.listen(request)).toEqual({
      answers: [{ id: "plan-review", selected: [], custom: "YOUR PLAN WAS NOT APPROVED. raw" }],
    });
    expect(steered).toEqual([]);
  });

  // Catches: a missing CLI, a crash or garbage output leaving the plan
  // unreviewable instead of falling back to DSH's own card.
  posixOnly("a missing binary, a non-zero exit and unreadable output all go to next()", async () => {
    const missing = join(tempDir(), "no-such-plannotator");
    const failing = stubCli("echo 'boom' >&2; exit 3").binary;
    const garbage = stubCli("echo 'not json'").binary;
    for (const binary of [missing, failing, garbage]) {
      const fake = fakeContext();
      apply(fake.ctx, { binary });
      expect(await fake.listen(planReviewRequest().request)).toBe(NATIVE);
      expect(fake.warnings).toHaveLength(1);
    }
  });

  // Catches: a cancelled turn leaving the review server (and its port) running,
  // or the listener falling back to DSH's card for a request that is gone.
  posixOnly("an abort stops the CLI and rejects with the abort reason", async () => {
    const { binary, dir } = stubCli('echo $$ > "$(dirname "$0")/pid"; exec sleep 30');
    const fake = fakeContext();
    apply(fake.ctx, { binary });
    const controller = new AbortController();
    const { request } = planReviewRequest({ signal: controller.signal });
    let nextCalled = false;
    const pending = fake.listen(request, async () => {
      nextCalled = true;
      return NATIVE;
    });

    const pidFile = join(dir, "pid");
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
      if (Date.now() > deadline) throw new Error("stub CLI never started");
      await Bun.sleep(20);
    }
    const reason = new DOMException("Turn cancelled", "AbortError");
    const startedAt = Date.now();
    controller.abort(reason);

    // The listener settles only once the child has exited, so a prompt
    // rejection means the 30-second sleep was killed.
    await expect(pending).rejects.toBe(reason);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(nextCalled).toBe(false);
  });

  // Catches: disabling the plugin mid-review leaving the CLI and its server
  // running with nobody to answer, and the plan stuck without a review.
  posixOnly("unloading the plugin stops an open review and hands it back to DSH", async () => {
    const { binary, dir } = stubCli('echo $$ > "$(dirname "$0")/pid"; exec sleep 30');
    const fake = fakeContext();
    apply(fake.ctx, { binary });
    const pending = fake.listen(planReviewRequest().request);

    const pidFile = join(dir, "pid");
    const deadline = Date.now() + 5_000;
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
      if (Date.now() > deadline) throw new Error("stub CLI never started");
      await Bun.sleep(20);
    }
    const startedAt = Date.now();
    fake.unload();

    expect(await pending).toBe(NATIVE);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("planReview: false registers nothing", () => {
    let registered = false;
    apply({ on: () => void (registered = true) } as DshContext, { planReview: false });
    expect(registered).toBe(false);
  });
});

describe("resolveConfig", () => {
  // Catches: a typo'd or mistyped key silently disabling nothing (DSH's own
  // plugins fail at load on bad config).
  test("rejects wrong types and unknown keys, defaults plan review on", () => {
    expect(resolveConfig(undefined)).toEqual({ planReview: true });
    expect(resolveConfig({ binary: " /x/plannotator " })).toEqual({ binary: "/x/plannotator", planReview: true });
    expect(() => resolveConfig({ binary: 1 })).toThrow("binary");
    expect(() => resolveConfig({ planReview: "no" })).toThrow("planReview");
    expect(() => resolveConfig({ planreview: false })).toThrow("unknown key");
    expect(() => resolveConfig("x")).toThrow("object");
  });
});

describe("resolvePlannotatorBinary", () => {
  // Catches: DSH Desktop (whose PATH lacks ~/.local/bin) never finding a CLI
  // the install script put there.
  posixOnly("config, then PLANNOTATOR_BIN, then PATH, then ~/.local/bin", () => {
    const home = tempDir();
    const installed = join(home, ".local", "bin", "plannotator");
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(installed, "#!/bin/sh\n");
    chmodSync(installed, 0o755);
    const onPath = stubCli("").binary;
    const pathDir = join(onPath, "..");

    expect(resolvePlannotatorBinary({ configured: "/cfg/plannotator", env: { PLANNOTATOR_BIN: "/env/p" }, home })).toBe("/cfg/plannotator");
    expect(resolvePlannotatorBinary({ env: { PLANNOTATOR_BIN: "/env/p", PATH: pathDir }, home })).toBe("/env/p");
    expect(resolvePlannotatorBinary({ env: { PATH: pathDir }, home })).toBe(onPath);
    expect(resolvePlannotatorBinary({ env: { PATH: "/definitely/not/here" }, home })).toBe(installed);
    expect(resolvePlannotatorBinary({ env: { PATH: "" }, home: tempDir() })).toBeUndefined();
  });
});

describe("parseDshPlanOutput", () => {
  test("reads the last JSON line and requires a boolean approved", () => {
    expect(parseDshPlanOutput('noise\n{"approved":false,"message":"m","answersOnly":true}\n')).toEqual({
      approved: false,
      message: "m",
      answersOnly: true,
    });
    expect(() => parseDshPlanOutput('{"approved":"yes"}')).toThrow();
    expect(() => parseDshPlanOutput("")).toThrow();
  });
});
