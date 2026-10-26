/**
 * Which signed-in gh account a GitHub PR review runs as (#2157), against a
 * fake `gh` (tests/helpers/fake-gh.ts) run as a real process. The real gh,
 * its config and the network are never touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { makeFakeGh, type FakeGh, type FakeGhScenario } from "../../tests/helpers/fake-gh";
import {
  clearGhAccountOverrides,
  ensureGhPRAccess,
  ghAccountEnvFor,
  ghAccountEnvForPRUrl,
  ghTokenEnvVar,
  parseGhAuthStatusJson,
  parseGhAuthStatusText,
} from "./pr-github-account";
import { checkAuth, fetchPR, getUser } from "./pr-provider";
import type { PRRuntime } from "./pr-types";

const PERSONAL = { login: "tobey", token: "gho_personalTOKEN0001" };
const WORK = { login: "tobey-work", token: "gho_workTOKEN0002" };
const REF = { platform: "github" as const, host: "github.com", owner: "acme", repo: "widgets", number: 7 };

let fake: FakeGh | undefined;

afterEach(() => {
  fake?.cleanup();
  fake = undefined;
  clearGhAccountOverrides();
});

/** A runtime that spawns the fake gh by absolute path with its scratch env. */
function fakeRuntime(scenario: FakeGhScenario): PRRuntime {
  fake = makeFakeGh(scenario);
  const gh = join(fake.binDir, "gh");
  const env = fake.env;
  return {
    async runCommand(cmd, args, options) {
      const proc = Bun.spawn([cmd === "gh" ? gh : cmd, ...args], {
        env: { ...env, ...options?.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    },
  };
}

function twoAccounts(readers: string[], extra: Partial<FakeGhScenario> = {}): FakeGhScenario {
  return {
    accounts: [{ ...PERSONAL, active: true }, WORK],
    repos: { "acme/widgets": { readers, prs: [7] } },
    ...extra,
  };
}

function calls() {
  return fake!.calls();
}

describe("ensureGhPRAccess", () => {
  test("the active account sees the PR: one check, nothing chosen", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey"]));
    expect(await ensureGhPRAccess(runtime, REF)).toEqual({});
    expect(calls().map((c) => c.args.slice(0, 2))).toEqual([["api", "repos/acme/widgets/pulls/7"]]);
    expect(ghAccountEnvFor(REF)).toBeUndefined();
  });

  test("another signed-in account sees it: used for this repo only, gh never switched", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey-work"]));
    const access = await ensureGhPRAccess(runtime, REF);
    expect(access.login).toBe("tobey-work");
    expect(access.childEnv).toEqual({ GH_TOKEN: WORK.token });
    expect(access.notice).toBe(
      "Using gh account tobey-work for this review: your active account tobey can't see acme/widgets. Your gh setting is unchanged.",
    );
    expect(access.notice).not.toContain(WORK.token);
    expect(ghAccountEnvFor(REF)).toEqual({ GH_TOKEN: WORK.token });
    expect(ghAccountEnvFor({ host: "github.com", owner: "acme", repo: "other" })).toBeUndefined();
    expect(calls().some((c) => c.args[0] === "auth" && c.args[1] === "switch")).toBe(false);
    // The probe that found it ran as the work account.
    expect(calls().at(-1)).toEqual({ args: ["api", "repos/acme/widgets/pulls/7", "--jq", ".number"], as: "tobey-work" });
  });

  test("every later provider call for that repo runs as the chosen account", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey-work"]));
    const access = await checkAuth(runtime, REF);
    expect(access.childEnv).toEqual({ GH_TOKEN: WORK.token });
    const before = calls().length;
    expect(await getUser(runtime, REF)).toBe("tobey-work");
    const pr = await fetchPR(runtime, REF);
    expect(pr.metadata).toMatchObject({ owner: "acme", repo: "widgets", number: 7 });
    const after = calls().slice(before);
    expect(after.length).toBeGreaterThan(2);
    expect(after.every((c) => c.as === "tobey-work")).toBe(true);
  });

  test("no account sees it: the review does not start, and the error names both", async () => {
    const runtime = fakeRuntime(twoAccounts([]));
    const error = await ensureGhPRAccess(runtime, REF).then(() => null, (e: Error) => e);
    expect(error?.message).toBe(
      [
        "Your active gh account tobey can't see acme/widgets (pull request #7).",
        "Your other signed-in github.com accounts can't see it either: tobey-work.",
        "Sign in with an account that can see it (`gh auth login`), then switch to it with `gh auth switch -u <user>`.",
      ].join("\n"),
    );
    expect(error?.message).not.toContain(WORK.token);
    expect(ghAccountEnvFor(REF)).toBeUndefined();
  });

  test("one account only: says how to sign in and switch", async () => {
    const runtime = fakeRuntime({ accounts: [{ ...PERSONAL, active: true }], repos: { "acme/widgets": { readers: [], prs: [7] } } });
    const error = await ensureGhPRAccess(runtime, REF).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("Your active gh account tobey can't see acme/widgets (pull request #7).");
    expect(error?.message).not.toContain("other signed-in");
    expect(error?.message).toContain("`gh auth switch -u <user>`");
  });

  test("a gh that can't hand out another account's token: names it and how to switch", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey-work"], { noTokenUser: true }));
    const error = await ensureGhPRAccess(runtime, REF).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("Couldn't check: tobey-work. Switch with `gh auth switch -u tobey-work` and run the review again.");
  });

  test("a gh without auth status --json: the text output is read", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey-work"], { jsonStatus: false }));
    expect((await ensureGhPRAccess(runtime, REF)).login).toBe("tobey-work");
  });

  test("the repository is visible but the PR is not: the number is wrong, not the account", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey"]));
    expect(await ensureGhPRAccess(runtime, { ...REF, number: 999 })).toEqual({});
    expect(calls().some((c) => c.args[0] === "auth")).toBe(false);
  });

  test("gh can't reach GitHub: no verdict, the fetch reports its own error", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey"], { offline: true }));
    expect(await ensureGhPRAccess(runtime, REF)).toEqual({});
  });

  test("GH_TOKEN as the active source: the error says it outranks every account", async () => {
    const runtime = fakeRuntime({
      accounts: [{ ...PERSONAL, active: true, tokenSource: "GH_TOKEN" }],
      repos: { "acme/widgets": { readers: [], prs: [7] } },
    });
    const error = await ensureGhPRAccess(runtime, REF).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("GH_TOKEN is set, and gh uses it before any signed-in account");
  });

  test("an invalid GH_TOKEN: the notice says GitHub rejected it and names the account used instead", async () => {
    for (const jsonStatus of [true, false]) {
      const runtime = fakeRuntime({ ...twoAccounts(["tobey-work"]), rejectEnvToken: true, jsonStatus });
      const withBadToken: PRRuntime = {
        runCommand: (cmd, args, options) =>
          runtime.runCommand(cmd, args, { ...options, env: { GH_TOKEN: "ghp_rejected0000", ...options?.env } }),
      };
      const access = await ensureGhPRAccess(withBadToken, REF);
      expect(access.login).toBe("tobey-work");
      expect(access.notice).toBe(
        "GitHub rejected the token in GH_TOKEN (invalid or expired), so this review uses your signed-in gh account tobey-work instead. " +
          "Fix or unset GH_TOKEN to stop seeing this. Your gh setting is unchanged.",
      );
      expect(access.notice).not.toContain("can't see");
      expect(access.notice).not.toContain(PERSONAL.token);
      fake!.cleanup();
      clearGhAccountOverrides();
    }
  });

  test("an invalid GH_TOKEN and no account sees it: the error leads with the rejected token", async () => {
    const runtime = fakeRuntime({ ...twoAccounts([]), rejectEnvToken: true });
    const withBadToken: PRRuntime = {
      runCommand: (cmd, args, options) =>
        runtime.runCommand(cmd, args, { ...options, env: { GH_TOKEN: "ghp_rejected0000", ...options?.env } }),
    };
    const error = await ensureGhPRAccess(withBadToken, REF).then(() => null, (e: Error) => e);
    expect(error?.message.split("\n")[0]).toBe(
      "GitHub rejected the token in GH_TOKEN (invalid or expired), so it can't see acme/widgets (pull request #7).",
    );
    expect(error?.message).toContain("GH_TOKEN is set, and gh uses it before any signed-in account");
  });

  test("a valid GH_TOKEN that can't see the repo: the notice names the token, its account and the one used", async () => {
    const runtime = fakeRuntime({
      accounts: [{ ...PERSONAL, active: true, tokenSource: "GH_TOKEN" }, WORK],
      repos: { "acme/widgets": { readers: ["tobey-work"], prs: [7] } },
    });
    const withToken: PRRuntime = {
      runCommand: (cmd, args, options) =>
        runtime.runCommand(cmd, args, { ...options, env: { GH_TOKEN: PERSONAL.token, ...options?.env } }),
    };
    const access = await ensureGhPRAccess(withToken, REF);
    expect(access.login).toBe("tobey-work");
    expect(access.notice).toBe(
      "The token in GH_TOKEN (account tobey) can't see acme/widgets, so this review uses your signed-in gh account tobey-work instead. " +
        "Fix or unset GH_TOKEN to stop seeing this. Your gh setting is unchanged.",
    );
    expect(access.notice).not.toContain(WORK.token);
  });

  test("an entry with no login is never tried or named as an account", async () => {
    // A stub gh: the active account can't see the PR, and the account list
    // holds a second, inactive entry with no login (a rejected env token).
    const runtime: PRRuntime = {
      async runCommand(_cmd, args) {
        if (args[0] === "api") return { stdout: "", stderr: "gh: Not Found (HTTP 404)", exitCode: 1 };
        if (args[0] === "auth" && args[1] === "status") {
          return {
            stdout: JSON.stringify({
              hosts: {
                "github.com": [
                  { state: "success", active: true, login: "tobey", tokenSource: "keyring" },
                  { state: "error", active: false, login: "", tokenSource: "GITHUB_TOKEN" },
                ],
              },
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        throw new Error(`unexpected gh ${args.join(" ")}`);
      },
    };
    const error = await ensureGhPRAccess(runtime, REF).then(() => null, (e: Error) => e);
    expect(error?.message.split("\n")[0]).toBe("Your active gh account tobey can't see acme/widgets (pull request #7).");
    expect(error?.message).not.toContain("Couldn't check");
    expect(error?.message).not.toContain("-u `");
  });

  test("the active account sees it again later: the earlier choice is forgotten", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey-work"]));
    await ensureGhPRAccess(runtime, REF);
    expect(ghAccountEnvFor(REF)).toBeDefined();
    fake!.cleanup();
    const again = fakeRuntime(twoAccounts(["tobey", "tobey-work"]));
    expect(await ensureGhPRAccess(again, REF)).toEqual({});
    expect(ghAccountEnvFor(REF)).toBeUndefined();
  });

  test("an account with no verdict (offline for it) is listed under Couldn't check, not can't see", async () => {
    const third = { login: "tobey-oss", token: "gho_ossTOKEN0003" };
    const runtime = fakeRuntime({
      accounts: [{ ...PERSONAL, active: true }, WORK, third],
      repos: { "acme/widgets": { readers: [], prs: [7] } },
      offlineFor: ["tobey-oss"],
    });
    const error = await ensureGhPRAccess(runtime, REF).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("Your other signed-in github.com accounts can't see it either: tobey-work.");
    expect(error?.message).toContain("Couldn't check: tobey-oss. Switch with `gh auth switch -u tobey-oss` and run the review again.");
    expect(error?.message).not.toContain("either: tobey-work, tobey-oss");
  });

  test("another account sees the repo but not the PR: the PR number may be wrong", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey-work"]));
    const error = await ensureGhPRAccess(runtime, { ...REF, number: 999 }).then(() => null, (e: Error) => e);
    expect(error?.message).toContain("tobey-work can see acme/widgets but not pull request #999: the PR number may be wrong.");
    expect(error?.message).not.toContain("can't see it either");
  });

  test("a GitHub Enterprise Server host uses GH_ENTERPRISE_TOKEN", async () => {
    const ref = { ...REF, host: "git.corp.example" };
    const runtime = fakeRuntime({ ...twoAccounts(["tobey-work"]), host: "git.corp.example" });
    const access = await ensureGhPRAccess(runtime, ref);
    expect(access.childEnv).toEqual({ GH_ENTERPRISE_TOKEN: WORK.token });
    expect(calls()[0].args).toEqual(["api", "repos/acme/widgets/pulls/7", "--jq", ".number", "--hostname", "git.corp.example"]);
  });
});

describe("the startup check depends on the active account only", () => {
  const broken = { ...WORK, state: "error" };

  test("a broken second account doesn't block a review the active account can do", async () => {
    const runtime = fakeRuntime({ accounts: [{ ...PERSONAL, active: true }, broken], repos: { "acme/widgets": { readers: ["tobey"], prs: [7] } } });
    expect(await checkAuth(runtime, REF)).toEqual({});
    expect(calls()[0].args).toEqual(["auth", "status", "--active", "--hostname", "github.com"]);
  });

  test("the same on a gh without --active (the account list decides)", async () => {
    const runtime = fakeRuntime({
      accounts: [{ ...PERSONAL, active: true }, broken],
      repos: { "acme/widgets": { readers: ["tobey"], prs: [7] } },
      noActiveFlag: true,
      jsonStatus: false,
    });
    expect(await checkAuth(runtime, REF)).toEqual({});
  });

  test("a broken active account, a working one that sees the PR: that one is used", async () => {
    const runtime = fakeRuntime({ accounts: [{ ...PERSONAL, active: true, state: "error" }, WORK], repos: { "acme/widgets": { readers: ["tobey-work"], prs: [7] } } });
    const access = await checkAuth(runtime, REF);
    expect(access.notice).toBe(
      "Using gh account tobey-work for this review: your active account tobey isn't signed in properly. Your gh setting is unchanged.",
    );
  });

  test("no usable account at all: still the not-authenticated error", async () => {
    const runtime = fakeRuntime({ accounts: [{ ...PERSONAL, active: true, state: "error" }], repos: {} });
    await expect(checkAuth(runtime, REF)).rejects.toThrow("GitHub CLI not authenticated. Run `gh auth login` first.");
  });
});

describe("agent jobs get the chosen token only for their own PR", () => {
  test("ghAccountEnvForPRUrl", async () => {
    const runtime = fakeRuntime(twoAccounts(["tobey-work"]));
    await ensureGhPRAccess(runtime, REF);
    expect(ghAccountEnvForPRUrl("https://github.com/acme/widgets/pull/12")).toEqual({ GH_TOKEN: WORK.token });
    expect(ghAccountEnvForPRUrl("https://github.com/acme/other/pull/7")).toEqual({});
    expect(ghAccountEnvForPRUrl("https://gitlab.com/acme/widgets/-/merge_requests/7")).toEqual({});
    expect(ghAccountEnvForPRUrl(undefined)).toEqual({});
  });
});

describe("gh auth status parsing", () => {
  test("color codes in the text are stripped", () => {
    const text = "github.com\n  \u001b[32m✓\u001b[0m Logged in to github.com account \u001b[1ma\u001b[0m (keyring)\n  - Active account: \u001b[1mtrue\u001b[0m\n";
    expect(parseGhAuthStatusText(text, "github.com")).toEqual([
      { login: "a", active: true, state: "success", tokenSource: "keyring" },
    ]);
  });

  test("JSON: every account of the host", () => {
    const json = JSON.stringify({
      hosts: {
        "github.com": [
          { state: "success", active: true, host: "github.com", login: "a", tokenSource: "keyring" },
          { state: "error", active: false, host: "github.com", login: "b", tokenSource: "keyring" },
        ],
        "ghe.example": [{ state: "success", active: true, login: "c" }],
      },
    });
    expect(parseGhAuthStatusJson(json, "github.com")).toEqual([
      { login: "a", active: true, state: "success", tokenSource: "keyring" },
      { login: "b", active: false, state: "error", tokenSource: "keyring" },
    ]);
    expect(parseGhAuthStatusJson("not json", "github.com")).toBeNull();
  });

  test("text, multi-account and single-account forms", () => {
    const multi = [
      "github.com",
      "  ✓ Logged in to github.com account a (keyring)",
      "  - Active account: false",
      "  X Failed to log in to github.com account b (keyring)",
      "  - Active account: true",
      "ghe.example",
      "  ✓ Logged in to ghe.example account c (keyring)",
      "  - Active account: true",
    ].join("\n");
    expect(parseGhAuthStatusText(multi, "github.com")).toEqual([
      { login: "a", active: false, state: "success", tokenSource: "keyring" },
      { login: "b", active: true, state: "error", tokenSource: "keyring" },
    ]);
    expect(parseGhAuthStatusText("github.com\n  ✓ Logged in to github.com as old (oauth_token)\n", "github.com")).toEqual([
      { login: "old", active: true, state: "success", tokenSource: "oauth_token" },
    ]);
  });

  test("a rejected env token has no login and is kept, in JSON and text", () => {
    const json = JSON.stringify({
      hosts: {
        "github.com": [
          { state: "error", active: true, host: "github.com", login: "", tokenSource: "GH_TOKEN" },
          { state: "success", active: false, host: "github.com", login: "a", tokenSource: "keyring" },
          { state: "error", active: false, host: "github.com", login: "", tokenSource: "keyring" },
        ],
      },
    });
    expect(parseGhAuthStatusJson(json, "github.com")).toEqual([
      { login: "", active: true, state: "error", tokenSource: "GH_TOKEN" },
      { login: "a", active: false, state: "success", tokenSource: "keyring" },
    ]);
    const text = [
      "github.com",
      "  X Failed to log in to github.com using token (GH_TOKEN)",
      "  - Active account: true",
      "  - The token in GH_TOKEN is invalid.",
      "",
      "  ✓ Logged in to github.com account a (keyring)",
      "  - Active account: false",
    ].join("\n");
    expect(parseGhAuthStatusText(text, "github.com")).toEqual([
      { login: "", active: true, state: "error", tokenSource: "GH_TOKEN" },
      { login: "a", active: false, state: "success", tokenSource: "keyring" },
    ]);
  });

  test("the token variable per host", () => {
    expect(ghTokenEnvVar("github.com")).toBe("GH_TOKEN");
    expect(ghTokenEnvVar("acme.ghe.com")).toBe("GH_TOKEN");
    expect(ghTokenEnvVar("git.corp.example")).toBe("GH_ENTERPRISE_TOKEN");
  });
});
