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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  saveConfig,
  getConfigLockPath,
  isAgentTerminalSide,
  __setConfigSaveMergeWindowHookForTest,
  __setConfigLockTimingsForTest,
  __setConfigWriteForTest,
  __setConfigReadForTest,
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
    __setConfigWriteForTest(null);
    __setConfigReadForTest(null);
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

  // #2852 (case from #2998): the Pi server's star ask and settings saves go through this copy, so machine state must
  // land in state.json here too, and a config.json kept in a dotfiles repo is never rewritten by a state-only save.
  test("machine state goes to state.json, never config.json, on this side of the vendor boundary too", () => {
    const configPath = join(tempDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ displayName: "me", starAsk: { shownAt: "2026-01-01T00:00:00.000Z" } }, null, 2));
    const before = readFileSync(configPath, "utf-8");
    expect(saveConfig({ starAsk: { shownAt: "2026-02-01T00:00:00.000Z", answer: "starred" } })).toBe(true);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(JSON.parse(readFileSync(join(tempDir, "state.json"), "utf-8"))).toEqual({
      starAsk: { shownAt: "2026-02-01T00:00:00.000Z", answer: "starred" },
    });
    expect(loadConfig()).toMatchObject({ displayName: "me", starAsk: { answer: "starred" } });
  });

  // A failed write must never empty the file: the Pi server's settings saves go through this copy too.
  test("a failed rename or fsync leaves config.json byte for byte; an empty config.json is saved over", () => {
    const configPath = join(tempDir, "config.json");
    const bytes = JSON.stringify({ displayName: "me", agentTerminalSide: "left" }, null, 2) + "\n";
    writeFileSync(configPath, bytes);
    const enospc = () => {
      throw Object.assign(new Error("ENOSPC: simulated"), { code: "ENOSPC" });
    };
    const write = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      for (const seams of [{ rename: enospc }, { fsync: enospc }]) {
        __setConfigWriteForTest(seams);
        expect(saveConfig({ agentTerminalSide: "right" })).toBe(false);
        expect(readFileSync(configPath, "utf-8")).toBe(bytes);
        expect(readdirSync(tempDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      }
      __setConfigWriteForTest(null);
      writeFileSync(configPath, "");
      expect(saveConfig({ agentTerminalSide: "right" })).toBe(true);
      expect(loadConfig().agentTerminalSide).toBe("right");
    } finally {
      process.stderr.write = write;
    }
  });

  test("loadConfig reads an unchanged config.json once, and a save from this process at once", () => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ agentTerminalSide: "left" }));
    const reads: string[] = [];
    __setConfigReadForTest({
      read: (path) => {
        reads.push(path);
        return readFileSync(path, "utf-8");
      },
      // A minute ahead: the file just written counts as settled.
      now: () => Date.now() + 60_000,
    });
    for (let i = 0; i < 5; i++) expect(loadConfig().agentTerminalSide).toBe("left");
    expect(reads.filter((path) => path.endsWith("config.json"))).toHaveLength(1);
    expect(saveConfig({ agentTerminalSide: "right" })).toBe(true);
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
