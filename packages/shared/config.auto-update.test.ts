import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServerConfig, resolveAutoUpdate, saveConfig, type PlannotatorConfig } from "./config";

describe("resolveAutoUpdate (#1634)", () => {
  test("defaults to off: absent key, garbage, and no env var", () => {
    expect(resolveAutoUpdate({}, {})).toBe(false);
    for (const v of ["yes", "", 42, null, {}]) {
      expect(resolveAutoUpdate({ autoUpdate: v } as unknown as PlannotatorConfig, {})).toBe(false);
    }
  });

  test("config key turns it on (booleans and quoted booleans)", () => {
    expect(resolveAutoUpdate({ autoUpdate: true }, {})).toBe(true);
    expect(resolveAutoUpdate({ autoUpdate: "true" } as unknown as PlannotatorConfig, {})).toBe(true);
  });

  test("env var wins over config in both directions", () => {
    for (const v of ["1", "true", "TRUE", "on"]) {
      expect(resolveAutoUpdate({ autoUpdate: false }, { PLANNOTATOR_AUTO_UPDATE: v })).toBe(true);
    }
    for (const v of ["0", "false", "off", "disabled"]) {
      expect(resolveAutoUpdate({ autoUpdate: true }, { PLANNOTATOR_AUTO_UPDATE: v })).toBe(false);
    }
  });

  test("an empty or unrecognized env var counts as unset", () => {
    expect(resolveAutoUpdate({ autoUpdate: true }, { PLANNOTATOR_AUTO_UPDATE: "" })).toBe(true);
    expect(resolveAutoUpdate({ autoUpdate: true }, { PLANNOTATOR_AUTO_UPDATE: "maybe" })).toBe(true);
  });

  test("getServerConfig always sends the config-file value and reports an env override", () => {
    const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
    const originalEnv = process.env.PLANNOTATOR_AUTO_UPDATE;
    const tempDir = mkdtempSync(join(tmpdir(), "plannotator-auto-update-config-"));
    try {
      process.env.PLANNOTATOR_DATA_DIR = tempDir;
      delete process.env.PLANNOTATOR_AUTO_UPDATE;
      expect(getServerConfig(null).autoUpdate).toBe(false);
      expect(getServerConfig(null).autoUpdateEnv).toBeUndefined();

      saveConfig({ autoUpdate: true });
      expect(getServerConfig(null).autoUpdate).toBe(true);

      process.env.PLANNOTATOR_AUTO_UPDATE = "0";
      expect(getServerConfig(null).autoUpdate).toBe(true);
      expect(getServerConfig(null).autoUpdateEnv).toBe(false);
    } finally {
      if (originalDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
      else process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
      if (originalEnv === undefined) delete process.env.PLANNOTATOR_AUTO_UPDATE;
      else process.env.PLANNOTATOR_AUTO_UPDATE = originalEnv;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
