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
