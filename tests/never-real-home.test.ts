/**
 * A test's Inbox or review server never runs on the runner's real home. A temp
 * PLANNOTATOR_DATA_DIR and the sandbox flag do not move `~/.agents/skills` or the
 * `inbox mcp` shim's read of `~/.env` (the server's own Qwen reads are sandboxed).
 * No HOME, or an empty one, counts as real: `os.homedir()` then falls back to the
 * account's home.
 *
 * Nothing here starts a server on a real home: the refusal is the first thing
 * each start does, and it is proved on its own before the starts are tried.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import os, { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startInboxServer } from "../packages/server/inbox";
import { startReviewServer } from "../packages/server/review";
import { resolveGlobalSkillRoots } from "../packages/server/review-skill-loader";
import { testHomeRefusal } from "../packages/server/test-home-guard";
import { SimAgent } from "../scripts/inbox-sim";
import { refuseRealHome } from "./helpers/inbox-process";
import { accountHome, isScratchDataDir } from "./helpers/real-data-dir";

const account = accountHome()!;
const flag = { PLANNOTATOR_TEST_SANDBOX: "1" };

/** These tests empty HOME and call a real start: without the preload's flag nothing would refuse it. */
function requireSandbox(): void {
  if (!process.env.PLANNOTATOR_TEST_SANDBOX) throw new Error("run this from a folder with the bunfig preload: it needs PLANNOTATOR_TEST_SANDBOX");
}

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

  test("sees through a symlink to the account's home", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-home-link-"));
    try {
      const link = join(dir, "link");
      symlinkSync(dir, link);
      expect(testHomeRefusal({ ...flag, HOME: link }, "darwin", () => dir)).toContain("HOME");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("an in-process start", () => {
    const saved = process.env.HOME;
    afterEach(() => {
      process.env.HOME = saved;
    });

    test("refuses before it writes anything", async () => {
      requireSandbox();
      const dataDir = resolve(process.env.PLANNOTATOR_DATA_DIR!, "refused");
      process.env.HOME = "";
      await expect(startInboxServer({ dataDir })).rejects.toThrow("HOME");
      expect(existsSync(dataDir)).toBe(false);
      await expect(startReviewServer({} as never)).rejects.toThrow("HOME");
    });

    test("inbox mcp refuses before the shim runs", async () => {
      requireSandbox();
      // No child and no real shim: without the guard this reaches the stub and then "exit 0".
      const shimPath = "../apps/hook/server/inbox-mcp-shim";
      const realShim = { ...(await import(shimPath)) };
      let shimCalls = 0;
      mock.module(shimPath, () => ({ ...realShim, runInboxMcpShim: async () => void shimCalls++ }));
      const realExit = process.exit;
      process.exit = ((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as typeof process.exit;
      try {
        const { runInboxCommand } = await import("../apps/hook/server/inbox-command");
        process.env.HOME = "";
        await expect(runInboxCommand(["mcp"])).rejects.toThrow("HOME");
        expect(shimCalls).toBe(0);
      } finally {
        process.exit = realExit;
        // Bun runs every test file in one process: the next file gets the real shim back.
        mock.module(shimPath, () => realShim);
      }
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
