/**
 * Server-side persistence for Guided Review standing instructions (#1265).
 *
 * Contract: read/write round-trip through `${dataDir}/guide-instructions.md`
 * (trimmed, bounded at GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS); blank input
 * deletes the file rather than persisting whitespace; and launch resolution
 * prefers explicit launch-body text over the stored value, yielding
 * undefined when neither has text so instruction-less launches stay
 * byte-identical to pre-feature prompts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readGuideInstructions,
  resolveGuideLaunchInstructions,
  writeGuideInstructions,
} from "./guide-instructions-store";
import { GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS } from "./guide";

let dir: string;
let priorDataDir: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pn-guide-instructions-"));
  priorDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dir;
});

afterEach(() => {
  if (priorDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = priorDataDir;
  rmSync(dir, { recursive: true, force: true });
});

describe("read/write round trip", () => {
  it("stores and returns the trimmed text", () => {
    expect(writeGuideInstructions("  Never invent ticket IDs.  ")).toBe("Never invent ticket IDs.");
    expect(readGuideInstructions()).toBe("Never invent ticket IDs.");
  });

  it("returns empty when nothing was ever stored", () => {
    expect(readGuideInstructions()).toBe("");
  });

  it("blank input deletes the stored file rather than persisting whitespace", () => {
    writeGuideInstructions("keep me");
    expect(existsSync(join(dir, "guide-instructions.md"))).toBe(true);
    expect(writeGuideInstructions("   \n  ")).toBe("");
    expect(existsSync(join(dir, "guide-instructions.md"))).toBe(false);
    expect(readGuideInstructions()).toBe("");
  });

  it("bounds stored text at the shared cap", () => {
    const long = "a".repeat(GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS + 500);
    expect(writeGuideInstructions(long).length).toBe(GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS);
    expect(readGuideInstructions().length).toBe(GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS);
  });

  it("multi-byte text round-trips exactly (the failure mode cookies had)", () => {
    const emoji = "\u{1F525}".repeat(400);
    expect(writeGuideInstructions(emoji)).toBe(emoji);
    expect(readGuideInstructions()).toBe(emoji);
  });
});

describe("resolveGuideLaunchInstructions (launch precedence)", () => {
  it("explicit launch-body text wins over the stored value", () => {
    writeGuideInstructions("stored standing text");
    expect(resolveGuideLaunchInstructions("live textarea text")).toBe("live textarea text");
  });

  it("falls back to the stored value when the body carries none", () => {
    writeGuideInstructions("stored standing text");
    expect(resolveGuideLaunchInstructions(undefined)).toBe("stored standing text");
    expect(resolveGuideLaunchInstructions("   ")).toBe("stored standing text");
  });

  it("yields undefined when neither has text (byte-identical launches)", () => {
    expect(resolveGuideLaunchInstructions(undefined)).toBeUndefined();
    expect(resolveGuideLaunchInstructions("")).toBeUndefined();
  });

  it("non-string body values never reach the prompt", () => {
    writeGuideInstructions("stored standing text");
    expect(resolveGuideLaunchInstructions(42)).toBe("stored standing text");
    expect(resolveGuideLaunchInstructions({ evil: true })).toBe("stored standing text");
  });
});
