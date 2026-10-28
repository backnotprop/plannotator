/**
 * The Bun PR runtime runs `gh` as another signed-in account for one repo
 * (#2157). The runtime runs in a child process (tests/helpers/
 * gh-account-runtime-probe.ts) whose PATH starts with a fake `gh`, with a
 * scratch HOME and gh config dir: the real gh is never reachable from it.
 */
import { afterEach, expect, test } from "bun:test";
import { probeGhAccountRuntime, type FakeGh } from "../../tests/helpers/fake-gh";

let fake: FakeGh | undefined;

afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

test("checkPRAuth picks the work account, and the runtime's later gh calls run as it", async () => {
  const run = await probeGhAccountRuntime("bun", ["tobey-work"]);
  fake = run.fake;
  expect(run.out).toEqual({
    notice: "Using gh account tobey-work for this review: your active account tobey can't see acme/widgets. Your gh setting is unchanged.",
    hasChildEnv: true,
    user: "tobey-work",
    repo: "widgets",
    // The in-process override never touches process.env.
    ghTokenInEnv: false,
  });
  const calls = fake.calls();
  const firstWork = calls.findIndex((c) => c.as === "tobey-work");
  expect(firstWork).toBeGreaterThan(0);
  expect(calls.slice(firstWork).every((c) => c.as === "tobey-work")).toBe(true);
  expect(calls.some((c) => c.args.slice(0, 2).join(" ") === "auth switch")).toBe(false);
});

test("no account sees it: checkPRAuth refuses before any fetch", async () => {
  const run = await probeGhAccountRuntime("bun", []);
  fake = run.fake;
  expect(String(run.out.error)).toContain("Your active gh account tobey can't see acme/widgets (pull request #7).");
  expect(fake.calls().some((c) => c.args[0] === "pr")).toBe(false);
});
