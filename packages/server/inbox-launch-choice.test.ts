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
  // A Send left on Default: the next New message starts on Default too; Pi's stays.
  writeLastLaunchChoice(dir, "claude-code", {});
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({});
  expect(readLastLaunchChoice(dir, "pi")).toEqual({ effort: "minimal" });

  const file = join(dir, "inbox", "launch", "last-choice.json");
  writeFileSync(file, JSON.stringify({ "claude-code": { model: "--dangerously-skip-permissions", effort: "max" } }));
  expect(readLastLaunchChoice(dir, "claude-code")).toEqual({ effort: "max" });
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
  // The same read is shared, not run twice; it fails (an older CLI), and is not run again for a while.
  void read("pi@1.5");
  finish(null);
  await Bun.sleep(0);
  expect(await read("pi@1.5")).toBeNull();
  expect(calls).toBe(1);
  clock += 6 * 60_000;
  void read("pi@1.5");
  expect(calls).toBe(2);
});
