import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxPull } from "@plannotator/core/inbox-types";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { createPullRisk, INBOX_PULL_RISK_FILE } from "./inbox-pull-risk";
import { inboxDir } from "@plannotator/shared/inbox/schema";

let dataDir: string;
const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
beforeEach(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pull-risk-auto-")));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
});

const pull = { key: "github.com/n/b#1", number: 1, title: "PR 1", state: "open", head_sha: "head-1", base: "main", host: "github.com", repo: "n/b" } as InboxPull;
let head = "head-1";
const engine = (onJudged?: (pull: InboxPull, level: string, again?: boolean) => void) =>
  createPullRisk({
    dataDir,
    isOn: () => true,
    agents: () => [{ id: "pi-sdk", label: "Pi" }],
    pulls: { wholeDiff: async () => ({ patch: "diff --git a/x b/x\n", partial: false, head_sha: head }) },
    run: async () => ({ text: '{"risk":"high","why":"It changes the billing webhook."}' }),
    onJudged,
  });

test("the automatic run's setting: saved and served by the risk rules, kept by a save that leaves it out, cleared by null, a bad one refused", () => {
  const risk = engine();
  risk.save({ rules: "Billing.", provider: "pi-sdk", model: null, auto: { level: "high", make: "picture_it", agent: "codex" } });
  expect(risk.answer().auto).toEqual({ level: "high", make: "picture_it", agent: "codex" });
  risk.save({ rules: "Billing and auth.", provider: "pi-sdk", model: null });
  expect((loadConfig().inboxPullRisk as { auto?: unknown }).auto).toEqual({ level: "high", make: "picture_it", agent: "codex" });
  for (const bad of [{ level: "low", make: "guide" }, { level: "high", make: "both" }, "high"]) {
    expect(() => risk.save({ rules: "x", provider: "pi-sdk", model: null, auto: bad })).toThrow();
  }
  risk.save({ rules: "Billing.", provider: "pi-sdk", model: null, auto: null });
  expect(risk.answer().auto).toBeNull();
});

test("a judgment stored for a listed PR is handed on with its level, so the automatic run can look at it", async () => {
  saveConfig({ inboxPullRisk: { rules: "Billing.", provider: "pi-sdk", model: null } });
  const seen: [string, string][] = [];
  engine((judged, level) => seen.push([judged.key, level])).assess([pull]);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(seen).toEqual([[pull.key, "high"]]);
});

test("a ranking made again at the same head, for new rules or after a lost judgments file, says so; a new head or a new PR does not", async () => {
  saveConfig({ inboxPullRisk: { rules: "Billing.", provider: "pi-sdk", model: null } });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const seen: [string, string, boolean | undefined][] = [];
  const risk = engine((judged, _level, again) => seen.push([judged.key, judged.head_sha!, again]));
  risk.assess([pull]);
  await settle();
  risk.save({ rules: "Billing and auth.", provider: "pi-sdk", model: null });
  risk.assess([pull]);
  await settle();
  head = "head-2";
  risk.assess([{ ...pull, head_sha: "head-2" }]);
  await settle();
  const other = { ...pull, key: "github.com/n/b#2", number: 2, head_sha: "head-2" };
  risk.assess([other]);
  await settle();
  head = "head-1";
  expect(seen).toEqual([
    [pull.key, "head-1", false],
    [pull.key, "head-1", true],
    [pull.key, "head-2", false],
    [other.key, "head-2", false],
  ]);
  mkdirSync(inboxDir(dataDir), { recursive: true });
  writeFileSync(join(inboxDir(dataDir), INBOX_PULL_RISK_FILE), "not json");
  const after: (boolean | undefined)[] = [];
  engine((_judged, _level, again) => after.push(again)).assess([pull]);
  await settle();
  expect(after).toEqual([true]);
});
