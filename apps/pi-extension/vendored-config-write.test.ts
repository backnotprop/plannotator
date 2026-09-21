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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
