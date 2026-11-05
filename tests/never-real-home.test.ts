/**
 * A test's Inbox or review server never runs on the runner's real home. A temp
 * PLANNOTATOR_DATA_DIR and the sandbox flag do not cover it: `~/.agents/skills`
 * and `~/.env` are still read through HOME. No HOME, or an empty one, counts as
 * real, because `os.homedir()` then falls back to the account's home.
 *
 * Nothing here starts a server on a real home: the refusal is the first thing
 * each start does, and it is proved on its own before the starts are tried.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import os, { homedir } from "node:os";
import { resolve } from "node:path";
import { startInboxServer } from "../packages/server/inbox";
import { startReviewServer } from "../packages/server/review";
import { resolveGlobalSkillRoots } from "../packages/server/review-skill-loader";
import { testHomeRefusal } from "../packages/server/test-home-guard";
import { SimAgent } from "../scripts/inbox-sim";
import { refuseRealHome } from "./helpers/inbox-process";
import { accountHome, isScratchDataDir } from "./helpers/real-data-dir";

const account = accountHome()!;
const flag = { PLANNOTATOR_TEST_SANDBOX: "1" };

describe("the preload's home", () => {
  test("HOME and homedir() are a scratch folder, here and in a child that inherits it", () => {
    const child = spawnSync(process.execPath, ["-e", 'console.log(require("node:os").homedir())'], { encoding: "utf8" });
    for (const home of [process.env.HOME!, homedir(), os.homedir(), require("os").homedir(), child.stdout.trim()]) {
      expect(home).not.toBe(account);
      expect(isScratchDataDir(home)).toBe(true);
    }
  });

  test("no global skill root is under the account's home", () => {
    for (const { dir } of resolveGlobalSkillRoots()) expect(dir.startsWith(`${account}/`)).toBe(false);
  });
});

describe("the refusal under the sandbox flag", () => {
  const refusal = (env: Record<string, string | undefined>, platform: NodeJS.Platform = "darwin") => testHomeRefusal(env, platform, () => "/Users/someone");

  test("refuses no HOME, an empty HOME and the account's home", () => {
    for (const HOME of [undefined, "", "  ", "/Users/someone", "/Users/someone/"]) expect(refusal({ ...flag, HOME })).toContain("HOME");
  });

  test("lets a scratch HOME through, and anything without the flag or on Windows", () => {
    expect(refusal({ ...flag, HOME: "/tmp/world/home" })).toBeNull();
    expect(refusal({ HOME: "/Users/someone" })).toBeNull();
    expect(refusal({ ...flag, HOME: "/Users/someone" }, "win32")).toBeNull();
  });

  describe("an in-process start", () => {
    const saved = process.env.HOME;
    afterEach(() => {
      process.env.HOME = saved;
    });

    test("refuses before it writes anything", async () => {
      process.env.HOME = "";
      await expect(startInboxServer({ dataDir: resolve(process.env.PLANNOTATOR_DATA_DIR!, "refused") })).rejects.toThrow("HOME");
      await expect(startReviewServer({} as never)).rejects.toThrow("HOME");
    });
  });
});

describe("refuseRealHome", () => {
  test("SimAgent.connect refuses a real or missing HOME without the sandbox flag", async () => {
    // A program that is not Plannotator: even without the guard, no Inbox could start here.
    const options = { binary: "/usr/bin/false", name: "x", host: "x" };
    const env = { PATH: "/usr/bin:/bin", PLANNOTATOR_DATA_DIR: process.env.PLANNOTATOR_DATA_DIR! };
    await expect(SimAgent.connect({ ...options, env })).rejects.toThrow("HOME must be a scratch folder");
    await expect(SimAgent.connect({ ...options, env: { ...env, HOME: account } })).rejects.toThrow("HOME must be a scratch folder");
    expect(() => refuseRealHome("", "test")).toThrow("HOME must be a scratch folder");
  });
});
