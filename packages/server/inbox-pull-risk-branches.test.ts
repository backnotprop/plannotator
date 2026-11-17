/**
 * Risk for reported branches (Branch reviews, inbox-pull-risk.ts `assessBranch`). What regresses:
 *  - a branch judged while the person's switch is off, Branch reviews is off, or no rules exist;
 *  - the same head judged twice (a second report of it, a restart);
 *  - a PR opened on the very commit judged again instead of taking the branch's judgment;
 *  - the switch shown to a window with Branch reviews off, or lost by a window that doesn't send it;
 *  - a branch read as waiting when none is (no Rank), or as rankable when it can't run, or a judgment under old rules
 *    still shown after the rules change (it would never be offered to rank again).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { createPullRisk, type RiskBranch, type RiskRun } from "./inbox-pull-risk";

const HIGH = '{"risk":"high","why":"It changes the billing webhook."}';
const HEAD = "3a9f2c1d0e9b8a7f6e5d4c3b2a1f0e9d8c7b6a5f";

let dataDir: string;
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-branch-risk-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const settled = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

function engine(branchesOn: { on: boolean }) {
  const runs: RiskRun[] = [];
  const prReads: string[] = [];
  const risk = createPullRisk({
    dataDir,
    isOn: () => true,
    branchesOn: () => branchesOn.on,
    agents: () => [{ id: "pi-sdk", label: "Pi" }],
    pulls: {
      wholeDiff: async (key) => {
        prReads.push(key);
        return { patch: "diff --git a/x b/x\n", partial: false, head_sha: HEAD };
      },
    },
    run: async (run) => {
      runs.push(run);
      return { text: HIGH };
    },
  });
  return { risk, runs, prReads };
}

const branch = (reads: string[] = []): RiskBranch => ({
  key: "branch:prj_1:retry-jitter",
  head_sha: HEAD,
  base: "main",
  title: "retry-jitter",
  read: async () => {
    reads.push("read");
    return "diff --git a/billing.ts b/billing.ts\n+a line\n";
  },
});

const rules = (branches?: boolean) => saveConfig({ inboxPullRisk: { rules: "Anything in billing.", provider: "pi-sdk", model: null, ...(branches ? { branches: true } : {}) } });

describe("a reported branch's risk", () => {
  test("runs only with the person's switch on, Branch reviews on and rules set", async () => {
    const gate = { on: true };
    rules(false);
    const { risk, runs } = engine(gate);
    risk.assessBranch(branch());
    await settled();
    expect(runs).toHaveLength(0);

    rules(true);
    gate.on = false;
    risk.assessBranch(branch());
    await settled();
    expect(runs).toHaveLength(0);

    saveConfig({ inboxPullRisk: { rules: "", provider: "pi-sdk", model: null, branches: true } });
    gate.on = true;
    risk.assessBranch(branch());
    await settled();
    expect(runs).toHaveLength(0);

    rules(true);
    risk.assessBranch(branch());
    await settled();
    expect(runs).toHaveLength(1);
    expect(risk.branchJudgment("branch:prj_1:retry-jitter", HEAD, "main").judgment).toEqual({ level: "high", why: "It changes the billing webhook." });
  });

  test("runs once per head: the same report again, or after a restart, runs nothing", async () => {
    rules(true);
    const reads: string[] = [];
    const first = engine({ on: true });
    first.risk.assessBranch(branch(reads));
    first.risk.assessBranch(branch(reads));
    await settled();
    first.risk.assessBranch(branch(reads));
    await settled();
    expect(first.runs).toHaveLength(1);
    expect(reads).toHaveLength(1);
    const again = engine({ on: true });
    again.risk.assessBranch(branch(reads));
    await settled();
    expect(again.runs).toHaveLength(0);
  });

  test("a PR opened on the judged head takes the branch's judgment: no second run, no PR diff read", async () => {
    rules(true);
    const { risk, runs, prReads } = engine({ on: true });
    risk.assessBranch(branch());
    await settled();
    const pull = { key: "github.com/n/b#7", number: 7, title: "Retry jitter", state: "open", head_sha: HEAD, base: "main", host: "github.com", repo: "n/b" } as InboxPull;
    risk.assess([pull]);
    await settled();
    expect(runs).toHaveLength(1);
    expect(prReads).toEqual([]);
    expect(risk.answer().judgments[pull.key]).toMatchObject({ level: "high" });
  });

  test("the switch is in the answer only while Branch reviews is on, and a save without it keeps it", () => {
    rules(true);
    const gate = { on: false };
    const { risk } = engine(gate);
    expect("branches" in risk.answer()).toBe(false);
    gate.on = true;
    expect(risk.answer().branches).toBe(true);
    risk.save({ rules: "Anything in billing.", provider: "pi-sdk", model: null });
    expect(loadConfig().inboxPullRisk?.branches).toBe(true);
    risk.save({ rules: "Anything in billing.", provider: "pi-sdk", model: null, branches: false });
    expect(loadConfig().inboxPullRisk?.branches).toBeUndefined();
  });

  test("pending only while its judgment waits or runs; rankable only when a branch may run; old rules are no judgment", async () => {
    rules(true);
    let finish: (value: { text: string }) => void = () => {};
    const risk = createPullRisk({
      dataDir,
      isOn: () => true,
      branchesOn: () => true,
      agents: () => [{ id: "pi-sdk", label: "Pi" }],
      pulls: { wholeDiff: async () => ({ patch: "", partial: false, head_sha: HEAD }) },
      run: () => new Promise((resolve) => (finish = resolve)),
    });
    expect(risk.branchRankable()).toBe(true);
    expect(risk.branchPending("branch:prj_1:retry-jitter", HEAD, "main")).toBe(false);
    risk.assessBranch(branch());
    await settled();
    expect(risk.branchPending("branch:prj_1:retry-jitter", HEAD, "main")).toBe(true);
    finish({ text: HIGH });
    await settled();
    expect(risk.branchPending("branch:prj_1:retry-jitter", HEAD, "main")).toBe(false);
    expect(risk.branchJudgment("branch:prj_1:retry-jitter", HEAD, "main").judgment).toMatchObject({ level: "high" });
    saveConfig({ inboxPullRisk: { rules: "Anything in auth.", provider: "pi-sdk", model: null, branches: true } });
    expect(risk.branchJudgment("branch:prj_1:retry-jitter", HEAD, "main").judgment).toBeNull();
    rules(false);
    expect(risk.branchRankable()).toBe(false);
  });
});
