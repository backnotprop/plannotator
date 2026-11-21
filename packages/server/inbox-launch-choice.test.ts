import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchChoiceCache, readLastLaunchChoice, withinLaunchWait, writeLastLaunchChoice } from "./inbox-launch-choice";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-launch-choice-"));
  dirs.push(dir);
  return dir;
};

test("the last choice is kept per agent on this machine; Default clears it; a hand edit never brings back a flag", () => {
  const dir = dataDir();
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({});
  writeLastLaunchChoice(dir, "claude-code", { model: "opus", effort: "high" });
  writeLastLaunchChoice(dir, "pi", { effort: "minimal" });
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({ model: "opus", effort: "high" });
  expect(readLastLaunchChoice(dir, "pi")).toEqual({ effort: "minimal" });
  expect(statSync(join(dir, "inbox", "launch", "last-choice.json")).mode & 0o777).toBe(0o600);
  writeLastLaunchChoice(dir, "claude-code", {});
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({});
  expect(readLastLaunchChoice(dir, "pi")).toEqual({ effort: "minimal" });

  const file = join(dir, "inbox", "launch", "last-choice.json");
  writeFileSync(file, JSON.stringify({ "claude-code": { model: "--dangerously-skip-permissions", effort: "max" } }));
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({ effort: "max" });
  // OpenCode's primary agent is kept with its model, and checked as a token like them.
  writeLastLaunchChoice(dir, "opencode", { model: "opencode/big-pickle", primary_agent: "plan" });
  expect(readLastLaunchChoice(dir, "opencode")).toEqual({ model: "opencode/big-pickle", primary_agent: "plan" });
  writeFileSync(file, JSON.stringify({ opencode: { primary_agent: "-x" } }));
  expect(readLastLaunchChoice(dir, "opencode")).toEqual({});
  writeFileSync(file, "not json");
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({});
  // A broken file never stops the next Send from keeping its choice.
  writeLastLaunchChoice(dir, "claude-code", { model: "sonnet" });
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({ model: "sonnet" });
});

test("the lists never hold up an offer: a slow CLI is waited on a moment only, and one that can't list them is not asked again at once", async () => {
  let calls = 0;
  let clock = 0;
  let finish: (value: null) => void = () => {};
  const read = launchChoiceCache(() => {
    calls++;
    return new Promise((resolve) => (finish = resolve));
  }, () => clock);
  const started = Date.now();
  expect(await withinLaunchWait(read("pi@1.5"), 50)).toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
  void read("pi@1.5");
  finish(null);
  await Bun.sleep(0);
  expect(await read("pi@1.5")).toBeNull();
  expect(calls).toBe(1);
  clock += 6 * 60_000;
  void read("pi@1.5");
  expect(calls).toBe(2);
});

const lists = (...models: string[]) => ({ models, efforts: [], effort_word: "Variant" });

test("a failed read is tried again after the host's wait, doubled after each failure in a row up to its most; a success starts over", async () => {
  let clock = 0;
  let answer: ReturnType<typeof lists> | null = null;
  let calls = 0;
  const read = launchChoiceCache(async () => {
    calls++;
    return answer;
  }, () => clock, { failedAgainMs: 15_000, failedAgainMaxMs: 40_000 });
  const key = "opencode2@2.2.7|a";
  expect(await read(key)).toBeNull();
  clock += 10_000;
  expect(await read(key)).toBeNull();
  expect(calls).toBe(1);
  clock += 6_000; // 16 s after the first failure: read again, fails again (now 30 s).
  expect(await read(key)).toBeNull();
  expect(calls).toBe(2);
  clock += 20_000;
  await read(key);
  expect(calls).toBe(2);
  clock += 11_000; // 31 s: read again, fails a third time (60 s, held to 40 s).
  await read(key);
  expect(calls).toBe(3);
  clock += 39_000;
  await read(key);
  expect(calls).toBe(3);
  answer = lists("ollama/qwen");
  clock += 2_000;
  expect((await read(key))?.models).toEqual(["ollama/qwen"]);
  expect(calls).toBe(4);
  clock += 60 * 60_000;
  expect((await read(key))?.models).toEqual(["ollama/qwen"]);
  expect(calls).toBe(4);
});

test("a new key answers the last good lists at once while it reads, and its own once read", async () => {
  let finish: (value: ReturnType<typeof lists> | null) => void = () => {};
  let calls = 0;
  const read = launchChoiceCache(() => {
    calls++;
    return new Promise((resolve) => (finish = resolve));
  });
  const first = read("opencode2@2.2.7|a");
  finish(lists("opencode/big-pickle"));
  expect((await first)?.models).toEqual(["opencode/big-pickle"]);
  // The config changed: the old lists at once, one read in the background however often it is asked.
  expect((await read("opencode2@2.2.7|b"))?.models).toEqual(["opencode/big-pickle"]);
  expect((await read("opencode2@2.2.7|b"))?.models).toEqual(["opencode/big-pickle"]);
  expect(calls).toBe(2);
  finish(lists("opencode/big-pickle", "ollama/qwen"));
  await Bun.sleep(0);
  expect((await read("opencode2@2.2.7|b"))?.models).toEqual(["opencode/big-pickle", "ollama/qwen"]);
  expect(calls).toBe(2);
});

test("a new key whose read fails keeps the last good lists, and is not read again before its wait", async () => {
  let clock = 0;
  let answer: ReturnType<typeof lists> | null = lists("opencode/big-pickle");
  let calls = 0;
  const read = launchChoiceCache(async () => {
    calls++;
    return answer;
  }, () => clock, { failedAgainMs: 15_000 });
  expect((await read("opencode2@2.2.7|a"))?.models).toEqual(["opencode/big-pickle"]);
  answer = null; // A half-edited config: OpenCode can't list them.
  expect((await read("opencode2@2.2.7|b"))?.models).toEqual(["opencode/big-pickle"]);
  await Bun.sleep(0);
  expect(calls).toBe(2);
  clock += 5_000;
  expect((await read("opencode2@2.2.7|b"))?.models).toEqual(["opencode/big-pickle"]);
  expect(calls).toBe(2);
});

test("a slower read for an older key never replaces a newer key's lists", async () => {
  const pending: ((value: ReturnType<typeof lists>) => void)[] = [];
  const read = launchChoiceCache(() => new Promise((resolve) => pending.push(resolve)));
  const a = read("k|a");
  const b = read("k|b");
  pending[1]!(lists("new"));
  expect((await b)?.models).toEqual(["new"]);
  pending[0]!(lists("old"));
  await a;
  expect((await read("k|b"))?.models).toEqual(["new"]);
});
