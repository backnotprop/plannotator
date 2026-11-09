/**
 * Codex's account line (inbox-codex-account.ts) against a fake `codex` app-server (tests/helpers/fake-codex-launch.ts),
 * never the real one: the plan and the limits used from Codex's own answers, an API key without limits, a signed-out
 * Codex as signed out, no email or id passed on, a limits read that fails leaving the plan, one run per 30 s.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFakeCodexLaunch, type FakeCodexLaunchState } from "../../tests/helpers/fake-codex-launch";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { codexAccountOf, codexLimitsOf, codexPlanName, createInboxCodexAccount } from "./inbox-codex-account";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

function setup(state: FakeCodexLaunchState, withCodex = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-codex-account-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const data = join(root, "data");
  mkdirSync(home, { recursive: true });
  mkdirSync(data, { recursive: true });
  const fake = installFakeCodexLaunch(join(root, "fake"), state);
  const bin = withCodex ? fake.bin : join(root, "empty");
  mkdirSync(bin, { recursive: true });
  const clock = { now: 1_000_000 };
  const reader = createInboxCodexAccount({
    environment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` } }),
    dataDir: data,
    extraClis: [],
    now: () => clock.now,
  });
  cleanup.push(() => reader.stop());
  return { fake, reader, clock };
}

describe("Codex's account, read from Codex", () => {
  test("a ChatGPT login: the plan from the limits read, and the 5h and weekly limits used; no email", async () => {
    const { reader, fake } = setup({ login: "chatgpt", plan: "pro" });
    const account = await reader.read();
    expect(account).toEqual({
      state: "signed_in",
      kind: "chatgpt",
      plan: "ChatGPT Pro",
      limits: [
        { used_percent: 21, window_mins: 300, resets_at: new Date(1900000000 * 1000).toISOString() },
        { used_percent: 40, window_mins: 10080, resets_at: new Date(1900500000 * 1000).toISOString() },
      ],
    });
    expect(JSON.stringify(account)).not.toContain("example.com");
    expect(fake.rpc().map((call) => call.method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    // Never signs in or out.
    expect(fake.rpc().some((call) => call.method.startsWith("account/login") || call.method === "account/logout")).toBe(false);
  });

  test("an API key has no limits; signed out is signed out; no codex is missing", async () => {
    expect(await setup({ login: "apikey" }).reader.read()).toEqual({ state: "signed_in", kind: "api_key", plan: null, limits: null });
    expect(await setup({ login: "none" }).reader.read()).toEqual({ state: "signed_out" });
    expect(await setup({}, false).reader.read()).toEqual({ state: "missing" });
  });

  test("a limits read that fails keeps the plan; one run serves 30 s", async () => {
    const { reader, fake, clock } = setup({ login: "chatgpt", plan: "plus", rateLimits: "fail" });
    expect(await reader.read()).toEqual({ state: "signed_in", kind: "chatgpt", plan: "ChatGPT Plus", limits: null });
    await reader.read();
    expect(fake.starts()).toHaveLength(1);
    clock.now += 30_001;
    await reader.read();
    expect(fake.starts()).toHaveLength(2);
  });

  test("the parsers take named fields only", () => {
    expect(codexPlanName("team")).toBe("ChatGPT Business");
    expect(codexPlanName("someday_new")).toBe("ChatGPT");
    expect(codexAccountOf({ account: null, requiresOpenaiAuth: false })).toEqual({ state: "signed_in", kind: "other", plan: null, limits: null });
    // The `codex` limit first; a window with no finite percent is left out, never read as 0.
    expect(codexLimitsOf({ rateLimits: { primary: { usedPercent: 99 } }, rateLimitsByLimitId: { codex: { primary: { usedPercent: 12.4, windowDurationMins: 300 }, secondary: { usedPercent: "x" }, planType: "go" } } })).toEqual({
      limits: [{ used_percent: 12, window_mins: 300, resets_at: null }],
      plan: "go",
    });
  });
});
