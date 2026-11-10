/**
 * The Pi server shares one ~/.plannotator data dir with whatever Bun-runtime
 * Plannotator session the user has open, and settles POST /api/config through
 * the SAME saveConfig — but through the vendored copy in generated/, not the
 * package under packages/shared. This asserts the write serialization is
 * actually present on that side of the vendor boundary, so a vendor.sh rule
 * that stopped copying it (or a Pi-only reimplementation) fails here rather
 * than in a user's config file.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  getConfigLockPath,
  isAgentTerminalSide,
  __setConfigSaveMergeWindowHookForTest,
  __setConfigLockTimingsForTest,
} from "./generated/config.ts";

describe("vendored config write path", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plannotator-pi-config-"));
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    __setConfigSaveMergeWindowHookForTest(null);
    __setConfigLockTimingsForTest(null);
    if (originalDataDir !== undefined) {
      process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
    } else {
      delete process.env.PLANNOTATOR_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("saveConfig holds the same advisory lock across its read-merge-write", () => {
    const lockPath = getConfigLockPath();
    expect(lockPath).toBe(join(tempDir, "config.json.lock"));

    let lockedDuringMerge = false;
    __setConfigSaveMergeWindowHookForTest(() => {
      lockedDuringMerge = existsSync(lockPath);
    });
    saveConfig({ agentTerminalSide: "right" });

    expect(lockedDuringMerge).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(loadConfig().agentTerminalSide).toBe("right");
  });

  // #2852: the Pi server's star ask and settings saves go through this copy, so it routes this computer's state the
  // same way: a config.json kept in a dotfiles repo is never rewritten by it.
  test("this computer's state goes to local-state.json, never config.json, on this side of the vendor boundary too", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ displayName: "me", starAsk: { shownAt: "old" }, inboxRowsPrev: ["roomy"] }, null, 2));
    const before = readFileSync(configPath, "utf-8");
    expect(loadConfig()).toMatchObject({ starAsk: { shownAt: "old" }, inboxRowsPrev: ["roomy"] });
    expect(saveConfig({ starAsk: { shownAt: "new", answer: "starred" }, inboxRowsBy: { host: "pi", session: "s" } })).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(JSON.parse(readFileSync(join(tempDir, "local-state.json"), "utf-8"))).toEqual({ starAsk: { shownAt: "new", answer: "starred" }, inboxRowsPrev: ["roomy"], inboxRowsBy: { host: "pi", session: "s" } });
    expect(loadConfig()).toMatchObject({ displayName: "me", starAsk: { answer: "starred" }, inboxRowsPrev: ["roomy"] });
  });

  test("the side guard the annotate endpoint uses accepts exactly the core sides", () => {
    // serverAnnotate.ts gates POST /api/config on this; it now delegates to
    // the single definition vendored from @plannotator/core.
    expect(isAgentTerminalSide("left")).toBe(true);
    expect(isAgentTerminalSide("right")).toBe(true);
    expect(isAgentTerminalSide("hidden")).toBe(true);
    expect(isAgentTerminalSide("top")).toBe(false);
    expect(isAgentTerminalSide(undefined)).toBe(false);
  });
});
