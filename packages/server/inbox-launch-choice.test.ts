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
/** OpenCode's keys: `<path>@<version>|<the rest>`; the binary is the part before the bar. */
const binaryOf = (key: string) => key.split("|")[0]!;

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

test("a new key of the same binary answers the last good lists at once while it reads, and its own once read", async () => {
  let finish: (value: ReturnType<typeof lists> | null) => void = () => {};
  let calls = 0;
  const read = launchChoiceCache(() => {
    calls++;
    return new Promise((resolve) => (finish = resolve));
  }, Date.now, { binaryOf });
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

test("a new key of the same binary whose read fails keeps the last good lists, and is not read again before its wait", async () => {
  let clock = 0;
  let answer: ReturnType<typeof lists> | null = lists("opencode/big-pickle");
  let calls = 0;
  const read = launchChoiceCache(async () => {
    calls++;
    return answer;
  }, () => clock, { failedAgainMs: 15_000, binaryOf });
  expect((await read("opencode2@2.2.7|a"))?.models).toEqual(["opencode/big-pickle"]);
  answer = null; // A half-edited config: OpenCode can't list them.
  expect((await read("opencode2@2.2.7|b"))?.models).toEqual(["opencode/big-pickle"]);
  await Bun.sleep(0);
  expect(calls).toBe(2);
  clock += 5_000;
  expect((await read("opencode2@2.2.7|b"))?.models).toEqual(["opencode/big-pickle"]);
  expect(calls).toBe(2);
});

test("a new binary (an upgrade) never gets the old binary's lists: none while it reads, none when its read fails", async () => {
  let answer: ReturnType<typeof lists> | null = lists("opencode/retired-model");
  let finish: (value: ReturnType<typeof lists> | null) => void = () => {};
  let slow = false;
  const read = launchChoiceCache(() => (slow ? new Promise((resolve) => (finish = resolve)) : Promise.resolve(answer)), Date.now, { binaryOf });
  expect((await read("/bin/opencode2@2.2.7|a"))?.models).toEqual(["opencode/retired-model"]);
  slow = true;
  expect(await withinLaunchWait(read("/bin/opencode2@2.3.0|a"), 20)).toBeNull();
  finish(null);
  await Bun.sleep(0);
  expect(await read("/bin/opencode2@2.3.0|a")).toBeNull();
  // Without binaryOf (Claude Code, Codex, Pi) a new key never gets another key's lists either.
  slow = false;
  const plain = launchChoiceCache(() => Promise.resolve(answer));
  expect((await plain("claude@2.1.1"))?.models).toEqual(["opencode/retired-model"]);
  answer = null;
  expect(await plain("claude@2.2.0")).toBeNull();
  expect(await plain("claude@2.2.0")).toBeNull();
});

test("keys that alternate keep each one's lists and wait, and one key never has two reads at once", async () => {
  let clock = 0;
  const calls: string[] = [];
  const answers: Record<string, ReturnType<typeof lists> | null> = { "k|a": lists("a"), "k|b": null };
  let current = "";
  const read = launchChoiceCache(async () => {
    calls.push(current);
    return answers[current] ?? null;
  }, () => clock, { failedAgainMs: 15_000, binaryOf });
  const ask = (key: string) => {
    current = key;
    return read(key);
  };
  expect((await ask("k|a"))?.models).toEqual(["a"]);
  expect((await ask("k|b"))?.models).toEqual(["a"]); // b failed: a's lists stay (same binary).
  await Bun.sleep(0);
  for (let n = 0; n < 4; n++) {
    clock += 2_000;
    expect((await ask("k|a"))?.models).toEqual(["a"]);
    expect((await ask("k|b"))?.models).toEqual(["a"]);
  }
  // a was never read again (its lists kept); b not before its 15 s.
  expect(calls).toEqual(["k|a", "k|b"]);
  // A good read for b is kept even when a is asked for in between.
  answers["k|b"] = lists("b");
  clock += 10_000;
  void ask("k|b");
  void ask("k|b");
  expect((await ask("k|a"))?.models).toEqual(["a"]);
  await Bun.sleep(0);
  expect((await ask("k|b"))?.models).toEqual(["b"]);
  expect((await ask("k|a"))?.models).toEqual(["a"]);
  expect(calls).toEqual(["k|a", "k|b", "k|b"]);
});

test("a read that fails with its reason (OpenCode) answers that reason until it is read again; a success clears it", async () => {
  let clock = 0;
  const why = (unread: "timeout" | "exit") => ({ models: [], efforts: [], effort_word: "Variant", unread });
  let answer: ReturnType<typeof lists> | ReturnType<typeof why> = why("timeout");
  let calls = 0;
  const read = launchChoiceCache(async () => {
    calls++;
    return answer;
  }, () => clock, { failedAgainMs: 15_000, failedAgainMaxMs: 60_000, binaryOf });
  expect((await read("opencode2@2.2.7|a"))?.unread).toBe("timeout");
  // Within the wait: the same reason, no read again.
  clock += 5_000;
  expect((await read("opencode2@2.2.7|a"))?.unread).toBe("timeout");
  expect(calls).toBe(1);
  // After it: read again, with its own reason this time, and the wait doubles.
  answer = why("exit");
  clock += 15_000;
  expect((await read("opencode2@2.2.7|a"))?.unread).toBe("exit");
  clock += 20_000;
  expect((await read("opencode2@2.2.7|a"))?.unread).toBe("exit");
  expect(calls).toBe(2);
  answer = lists("opencode/big-pickle");
  clock += 15_000;
  expect(await read("opencode2@2.2.7|a")).toEqual(lists("opencode/big-pickle"));
  expect(calls).toBe(3);
});

test("while a stale good list is served for a new key of the same binary, its failed read says nothing: the list shows as it was", async () => {
  let clock = 0;
  let answer: ReturnType<typeof lists> | { models: string[]; efforts: string[]; effort_word: string; unread: "exit" } = lists("opencode/big-pickle");
  const read = launchChoiceCache(async () => answer, () => clock, { failedAgainMs: 15_000, binaryOf });
  expect((await read("opencode2@2.2.7|a"))?.models).toEqual(["opencode/big-pickle"]);
  answer = { models: [], efforts: [], effort_word: "Variant", unread: "exit" };
  const served = await read("opencode2@2.2.7|b");
  await Bun.sleep(0);
  expect(served?.unread).toBeUndefined();
  const again = await read("opencode2@2.2.7|b");
  expect(again?.unread).toBeUndefined();
  expect(again?.models).toEqual(["opencode/big-pickle"]);
});

test("a list still being read past the offer's wait answers the host's being-read lists; one that settles in time answers itself", async () => {
  const reading = { models: [], efforts: [], effort_word: "Variant", reading: true as const };
  let finish: (value: ReturnType<typeof lists> | null) => void = () => {};
  const slow = new Promise<ReturnType<typeof lists> | null>((resolve) => (finish = resolve));
  expect(await withinLaunchWait<{ models: string[] }>(slow, 20, reading)).toBe(reading);
  finish(lists("opencode/big-pickle"));
  expect((await withinLaunchWait<{ models: string[] }>(slow, 20, reading))?.models).toEqual(["opencode/big-pickle"]);
  // Without one (Claude Code, Codex, Pi): nothing, as before.
  expect(await withinLaunchWait(new Promise<null>(() => {}), 20)).toBeNull();
});
