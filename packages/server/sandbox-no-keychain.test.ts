/**
 * A sandboxed run (scratch HOME, PLANNOTATOR_TEST_SANDBOX) must never reach the
 * macOS Keychain: with a scratch HOME macOS finds no keychain and shows
 * "Keychain Not Found" on the person's screen for each try. Xcode's system
 * gitconfig sets `credential.helper=osxkeychain`, so a git the Inbox starts must
 * skip it, and the gh runners must carry the same env. Outside the sandbox
 * nothing changes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnv, SANDBOX_NO_KEYCHAIN_ENV } from "@plannotator/shared/child-env";
import { createNodeRefCliRunner } from "@plannotator/shared/ref-cards-node";
import { runtime as gitRuntime } from "./git";
import { pullDiffCliRunner } from "./inbox-pulls";
import { refCliRunner } from "./ref-cards";
import type { RefCli } from "@plannotator/shared/ref-cards";

const KEYS = ["PLANNOTATOR_TEST_SANDBOX", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_GLOBAL", ...Object.keys(SANDBOX_NO_KEYCHAIN_ENV)];
let saved: Record<string, string | undefined>;
let dir: string;
let systemConfig: string;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of Object.keys(SANDBOX_NO_KEYCHAIN_ENV)) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), "sandbox-no-keychain-"));
  mkdirSync(join(dir, "work"));
  // A system gitconfig like Xcode's: the helper that reaches the Keychain.
  systemConfig = join(dir, "gitconfig");
  writeFileSync(systemConfig, "[credential]\n\thelper = osxkeychain\n");
  process.env.GIT_CONFIG_SYSTEM = systemConfig;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

const helpers = async () => (await gitRuntime.runGit(["config", "--get-all", "credential.helper"], { cwd: join(dir, "work") })).stdout.trim();

describe("git the Inbox starts", () => {
  test("in the sandbox, sees no credential helper from the system config", async () => {
    process.env.PLANNOTATOR_TEST_SANDBOX = dir;
    expect(await helpers()).toBe("");
  });

  test("outside the sandbox, keeps the person's helper", async () => {
    delete process.env.PLANNOTATOR_TEST_SANDBOX;
    expect(await helpers()).toContain("osxkeychain");
  });

  test("a caller's own setting still wins over the sandbox's", () => {
    process.env.PLANNOTATOR_TEST_SANDBOX = dir;
    expect(childEnv({ GCM_INTERACTIVE: "auto" }).GCM_INTERACTIVE).toBe("auto");
    expect(childEnv().GCM_INTERACTIVE).toBe("never");
  });
});

// `env` stands in for gh: it prints the environment the runner gave it.
describe.skipIf(process.platform === "win32")("the gh runners", () => {
  const ENV = "env" as RefCli;
  const runners = {
    "hover cards (Bun)": () => refCliRunner(ENV, []),
    "hover cards (Node, Pi)": () => createNodeRefCliRunner()(ENV, []),
    "pull request diffs": () => pullDiffCliRunner(ENV, [], 1_000_000),
  };

  for (const [name, run] of Object.entries(runners)) {
    test(`${name}: carry the no-keychain env in the sandbox, and not outside it`, async () => {
      process.env.PLANNOTATOR_TEST_SANDBOX = dir;
      const inside = (await run()).stdout.split("\n");
      for (const [key, value] of Object.entries(SANDBOX_NO_KEYCHAIN_ENV)) expect(inside).toContain(`${key}=${value}`);
      delete process.env.PLANNOTATOR_TEST_SANDBOX;
      const outside = (await run()).stdout.split("\n");
      expect(outside.some((line) => line.startsWith("GIT_CONFIG_NOSYSTEM="))).toBe(false);
    });
  }
});
