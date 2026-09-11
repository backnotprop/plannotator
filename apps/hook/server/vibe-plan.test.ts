/**
 * Vibe Plan Resolver Tests
 *
 * Run: bun test apps/hook/server/vibe-plan.test.ts
 *
 * Uses synthetic fixtures in temp dirs matching Vibe's $VIBE_HOME/plans layout.
 */

import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLatestVibePlan, resolveVibePlansDir } from "./vibe-plan";

const tempDirs: string[] = [];

function cleanup() {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
}
afterEach(cleanup);

function makeVibeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "vibe-home-"));
  tempDirs.push(home);
  mkdirSync(join(home, "plans"), { recursive: true });
  return home;
}

describe("resolveVibePlansDir", () => {
  test("defaults to ~/.vibe/plans when VIBE_HOME unset", () => {
    delete process.env.VIBE_HOME;
    const dir = resolveVibePlansDir();
    expect(dir).toBe(join(require("node:os").homedir(), ".vibe", "plans"));
  });

  test("respects VIBE_HOME override", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vibe-override-"));
    tempDirs.push(tmp);
    process.env.VIBE_HOME = tmp;
    expect(resolveVibePlansDir()).toBe(join(tmp, "plans"));
    delete process.env.VIBE_HOME;
  });

  test("accepts explicit vibeHome argument over env", () => {
    process.env.VIBE_HOME = mkdtempSync(join(tmpdir(), "ignored-"));
    tempDirs.push(process.env.VIBE_HOME!);
    const arg = mkdtempSync(join(tmpdir(), "arg-wins-"));
    tempDirs.push(arg);
    expect(resolveVibePlansDir(arg)).toBe(join(arg, "plans"));
    delete process.env.VIBE_HOME;
  });
});

describe("resolveLatestVibePlan", () => {
  test("returns the newest .md plan by mtime", () => {
    const home = makeVibeHome();
    const old = join(home, "plans", "1780000000-old-plan.md");
    const newer = join(home, "plans", "1780001000-new-plan.md");
    writeFileSync(old, "# Old plan");
    writeFileSync(newer, "# New plan");
    // Force old to be older than newer
    utimesSync(old, 1, 1);
    utimesSync(newer, 100, 100);
    expect(resolveLatestVibePlan({ vibeHome: home })).toBe("# New plan");
  });

  test("returns null when plans dir is empty", () => {
    const home = makeVibeHome();
    expect(resolveLatestVibePlan({ vibeHome: home })).toBeNull();
  });

  test("returns null when plans dir does not exist", () => {
    const home = mkdtempSync(join(tmpdir(), "vibe-noplans-"));
    tempDirs.push(home);
    expect(resolveLatestVibePlan({ vibeHome: home })).toBeNull();
  });

  test("ignores non-.md files", () => {
    const home = makeVibeHome();
    writeFileSync(join(home, "plans", "note.txt"), "not a plan");
    expect(resolveLatestVibePlan({ vibeHome: home })).toBeNull();
  });
});
