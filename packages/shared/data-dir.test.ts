import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bun resolves homedir() from the environment captured at process start, so
// mutating process.env.HOME inside this test process has no effect. Each case
// therefore runs the resolver in a subprocess with a fully controlled
// environment (fake HOME, explicit PLANNOTATOR_DATA_DIR / XDG_DATA_HOME).
const MODULE_PATH = join(import.meta.dir, "data-dir.ts");

let fakeHome = "";

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "plannotator-data-dir-home-"));
});

afterEach(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

function resolveDataDir(env: Record<string, string>): string {
  const script = `console.log(require(${JSON.stringify(MODULE_PATH)}).getPlannotatorDataDir());`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    env: { PATH: process.env.PATH ?? "", HOME: fakeHome, ...env },
  });
  if (result.exitCode !== 0) {
    throw new Error(`resolver subprocess failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString().trim();
}

describe("getPlannotatorDataDir", () => {
  test("PLANNOTATOR_DATA_DIR wins over the legacy directory and XDG_DATA_HOME", () => {
    mkdirSync(join(fakeHome, ".plannotator"));

    const dir = resolveDataDir({
      PLANNOTATOR_DATA_DIR: join(fakeHome, "custom-data"),
      XDG_DATA_HOME: join(fakeHome, "xdg-data"),
    });

    expect(dir).toBe(join(fakeHome, "custom-data"));
  });

  test("PLANNOTATOR_DATA_DIR expands a leading ~", () => {
    const dir = resolveDataDir({ PLANNOTATOR_DATA_DIR: "~/relocated" });

    expect(dir).toBe(join(fakeHome, "relocated"));
  });

  test("an existing ~/.plannotator wins over XDG_DATA_HOME", () => {
    mkdirSync(join(fakeHome, ".plannotator"));

    const dir = resolveDataDir({ XDG_DATA_HOME: join(fakeHome, "xdg-data") });

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });

  test("XDG_DATA_HOME applies when set and ~/.plannotator does not exist", () => {
    const dir = resolveDataDir({ XDG_DATA_HOME: join(fakeHome, "xdg-data") });

    expect(dir).toBe(join(fakeHome, "xdg-data", "plannotator"));
  });

  test("a relative XDG_DATA_HOME is ignored", () => {
    const dir = resolveDataDir({ XDG_DATA_HOME: "relative/xdg-data" });

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });

  test("an empty XDG_DATA_HOME is ignored", () => {
    const dir = resolveDataDir({ XDG_DATA_HOME: "  " });

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });

  test("defaults to ~/.plannotator when nothing is set", () => {
    const dir = resolveDataDir({});

    expect(dir).toBe(join(fakeHome, ".plannotator"));
  });
});

test("bun test isolates imported stores, inherits runtime writes, and cleans only its owned directory after hooks", async () => {
  const repoRoot = join(import.meta.dir, "../..");
  const home = join(fakeHome, "home");
  const xdg = join(fakeHome, "xdg");
  const tempRoot = join(fakeHome, "tmp");
  const contributor = join(fakeHome, "contributor-data");
  const override = join(fakeHome, "explicit-override");
  for (const dir of [home, xdg, tempRoot, contributor, override]) mkdirSync(dir);
  const contributorConfig = JSON.stringify({ displayName: "contributor", feedbackHistory: true });
  writeFileSync(join(contributor, "config.json"), contributorConfig);
  writeFileSync(join(override, "keep"), "caller-owned");

  // These fixtures live outside the repository and are run by exact filename:
  // a nested `bun test` must load the real bunfig, never rediscover this test.
  const storesFile = join(fakeHome, "stores.ts");
  const runtimeFile = join(fakeHome, "runtime.ts");
  const nestedFile = join(fakeHome, "nested.test.ts");
  const fixtureFile = join(fakeHome, "preload.test.ts");
  const reportFile = join(fakeHome, "after-all.json");
  const runtimeReport = join(fakeHome, "runtime.json");
  const nestedReport = join(fakeHome, "nested.json");

  writeFileSync(storesFile, `
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
// Static imports are essential: storage captures DATA_DIR during evaluation.
import { saveToHistory, saveAnnotateSubmission } from ${JSON.stringify(join(import.meta.dir, "storage.ts"))};
import { loadConfig, saveConfig, resolveFeedbackHistory } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
import { appendFeedbackRecord } from ${JSON.stringify(join(import.meta.dir, "feedback-archive.ts"))};
export { loadConfig, saveConfig, resolveFeedbackHistory, appendFeedbackRecord };

export function writeStores(project: string) {
  const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
  const history = saveToHistory(project, "plan", "history:" + project).path;
  const submission = saveAnnotateSubmission(project, "plan", "submission:" + project);
  for (const path of [history, submission]) assert.ok(path.startsWith(dataDir + sep), path);
  assert.equal(readFileSync(history, "utf-8"), "history:" + project);
  assert.equal(readFileSync(submission, "utf-8"), "submission:" + project);
  saveConfig({ displayName: project });
  assert.equal(loadConfig().displayName, project);
  assert.equal(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf-8")).displayName, project);
  return { dataDir, history, submission };
}

export async function runChild(args: string[], env = process.env) {
  const child = Bun.spawn({
    cmd: [process.execPath, ...args],
    cwd: ${JSON.stringify(repoRoot)},
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 12_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(exitCode, 0, stdout + stderr);
  } finally {
    clearTimeout(timer);
  }
}
`);

  writeFileSync(runtimeFile, `
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { writeStores, resolveFeedbackHistory } from ${JSON.stringify(storesFile)};
assert.equal(resolveFeedbackHistory({ feedbackHistory: true }), false);
writeFileSync(${JSON.stringify(runtimeReport)}, JSON.stringify(writeStores("runtime")));
`);

  writeFileSync(nestedFile, `
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeStores } from ${JSON.stringify(storesFile)};
let writes;
test("a nested test run owns a fresh sandbox rather than its parent's", () => {
  const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
  assert.notEqual(dataDir, process.env.PARENT_DATA_DIR);
  assert.equal(dirname(dataDir), ${JSON.stringify(tempRoot)});
  writes = writeStores("nested");
});
afterAll(() => {
  assert.equal(readFileSync(writes.history, "utf-8"), "history:nested");
  assert.ok(existsSync(process.env.PARENT_DATA_DIR!));
  writeFileSync(${JSON.stringify(nestedReport)}, JSON.stringify(writes));
});
`);

  writeFileSync(fixtureFile, `
import { afterAll, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  appendFeedbackRecord, loadConfig, resolveFeedbackHistory, runChild, saveConfig, writeStores,
} from ${JSON.stringify(storesFile)};
const owned = process.env.PLANNOTATOR_DATA_DIR!;
const override = ${JSON.stringify(override)};
let writes;

function assertContributorUntouched() {
  assert.deepEqual(readdirSync(${JSON.stringify(contributor)}), ["config.json"]);
  assert.equal(readFileSync(${JSON.stringify(join(contributor, "config.json"))}, "utf-8"), ${JSON.stringify(contributorConfig)});
}

test("preloading precedes storage imports without disabling explicit overrides", async () => {
  assert.equal(dirname(owned), ${JSON.stringify(tempRoot)});
  assert.ok(existsSync(owned));
  assert.deepEqual(loadConfig(), {});
  // The contributor explicitly enabled feedback history in both env and config.
  assert.equal(resolveFeedbackHistory({ feedbackHistory: true }), false);
  writes = writeStores("parent");

  const savedHistory = process.env.PLANNOTATOR_FEEDBACK_HISTORY!;
  try {
    process.env.PLANNOTATOR_DATA_DIR = override;
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = "1";
    saveConfig({ displayName: "override" });
    assert.equal(loadConfig().displayName, "override");
    assert.equal(resolveFeedbackHistory(loadConfig()), true);
    const input = { project: "preload", surface: "review", decision: "feedback", feedback: "override feedback" } as const;
    const overrideIndex = appendFeedbackRecord(input);
    assert.equal(overrideIndex, join(override, "feedback", "preload", "index.jsonl"));
    assert.equal(JSON.parse(readFileSync(overrideIndex!, "utf-8")).feedback, "override feedback");

    process.env.PLANNOTATOR_DATA_DIR = owned;
    assert.equal(loadConfig().displayName, "parent");
    const restoredIndex = appendFeedbackRecord({ ...input, feedback: "restored feedback" });
    assert.equal(restoredIndex, join(owned, "feedback", "preload", "index.jsonl"));
    assert.equal(JSON.parse(readFileSync(restoredIndex!, "utf-8")).feedback, "restored feedback");
  } finally {
    process.env.PLANNOTATOR_DATA_DIR = owned;
    process.env.PLANNOTATOR_FEEDBACK_HISTORY = savedHistory;
  }
  assert.equal(resolveFeedbackHistory(loadConfig()), false);
  assertContributorUntouched();

  await runChild(["test", "--timeout", "10000", ${JSON.stringify(nestedFile)}], {
    ...process.env, PARENT_DATA_DIR: owned,
  });
  const nested = JSON.parse(readFileSync(${JSON.stringify(nestedReport)}, "utf-8"));
  assert.notEqual(nested.dataDir, owned);
  assert.equal(existsSync(nested.dataDir), false);
  assert.equal(readFileSync(writes.history, "utf-8"), "history:parent");
});

afterAll(async () => {
  // Read an earlier write before anything can recreate a prematurely removed dir.
  assert.equal(readFileSync(writes.submission, "utf-8"), "submission:parent");
  await runChild(["run", ${JSON.stringify(runtimeFile)}]);
  const runtime = JSON.parse(readFileSync(${JSON.stringify(runtimeReport)}, "utf-8"));
  assert.equal(runtime.dataDir, owned);
  assert.equal(readFileSync(runtime.history, "utf-8"), "history:runtime");
  assertContributorUntouched();
  writeFileSync(${JSON.stringify(reportFile)}, JSON.stringify(writeStores("after-all")));
  // Deliberately exit with a caller-owned override selected. Cleanup must use
  // the preload's captured path, not whichever env value a test leaves behind.
  process.env.PLANNOTATOR_DATA_DIR = override;
});
`);

  const child = Bun.spawn({
    cmd: [process.execPath, "test", "--timeout", "15000", fixtureFile],
    cwd: repoRoot,
    // Do not inherit any real data/home/temp location, even against the unfixed
    // preload. Runtime descendants then inherit only these controlled values.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      USERPROFILE: home,
      XDG_DATA_HOME: xdg,
      TMPDIR: tempRoot,
      TMP: tempRoot,
      TEMP: tempRoot,
      PLANNOTATOR_DATA_DIR: contributor,
      PLANNOTATOR_FEEDBACK_HISTORY: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 25_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`preload regression subprocess failed:\n${stdout}${stderr}`);

    const report = JSON.parse(readFileSync(reportFile, "utf-8"));
    expect(existsSync(report.dataDir)).toBe(false);
    expect(readdirSync(contributor)).toEqual(["config.json"]);
    expect(readFileSync(join(contributor, "config.json"), "utf-8")).toBe(contributorConfig);
    expect(readFileSync(join(override, "keep"), "utf-8")).toBe("caller-owned");
    expect(JSON.parse(readFileSync(join(override, "config.json"), "utf-8")).displayName).toBe("override");
    expect(JSON.parse(readFileSync(join(override, "feedback", "preload", "index.jsonl"), "utf-8")).feedback)
      .toBe("override feedback");
    expect(existsSync(join(home, ".plannotator"))).toBe(false);
    expect(existsSync(join(xdg, "plannotator"))).toBe(false);
  } finally {
    clearTimeout(timer);
  }
}, 35_000);
