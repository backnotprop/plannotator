/**
 * The Pi PR runtime (node:child_process) runs `gh` as another signed-in
 * account for one repo (#2157). The runtime runs in a child process (tests/
 * helpers/gh-account-runtime-probe.ts) whose PATH starts with a fake `gh`,
 * with a scratch HOME and gh config dir: the real gh is never reachable.
 */
import { afterEach, expect, test } from "bun:test";
import { probeGhAccountRuntime, type FakeGh } from "../../../tests/helpers/fake-gh.ts";

let fake: FakeGh | undefined;

afterEach(() => {
  fake?.cleanup();
  fake = undefined;
});

test("checkPRAuth picks the work account, and the runtime's later gh calls run as it", async () => {
  const run = await probeGhAccountRuntime("pi", ["tobey-work"]);
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

test("the PR checkout's git runtime carries the chosen account's env to git, and only it", async () => {
  const { reviewRuntime, reviewRuntimeWithEnv } = await import("./vcs.ts");
  const withEnv = await reviewRuntimeWithEnv({ GIT_AUTHOR_NAME: "Chosen Account", GIT_AUTHOR_EMAIL: "chosen@example.invalid" })
    .runGit(["var", "GIT_AUTHOR_IDENT"]);
  expect(withEnv.exitCode).toBe(0);
  expect(withEnv.stdout).toContain("Chosen Account <chosen@example.invalid>");
  const plain = await reviewRuntime.runGit(["var", "GIT_AUTHOR_IDENT"]);
  expect(plain.stdout).not.toContain("Chosen Account");
});

test("no account sees it: checkPRAuth refuses before any fetch", async () => {
  const run = await probeGhAccountRuntime("pi", []);
  fake = run.fake;
  expect(String(run.out.error)).toContain("Your active gh account tobey can't see acme/widgets (pull request #7).");
  expect(fake.calls().some((c) => c.args[0] === "pr")).toBe(false);
});
