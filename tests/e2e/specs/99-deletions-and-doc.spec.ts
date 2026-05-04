import { describe, test, expect } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

function repoPath(...segments: string[]): string {
  return resolve(repoRoot, ...segments);
}

describe("99-deletions-and-doc", () => {
  test("99.1 apps/marketing/ does not exist", () => {
    expect(existsSync(repoPath("apps/marketing"))).toBe(false);
  });

  test("99.2 apps/paste-service/ does not exist", () => {
    expect(existsSync(repoPath("apps/paste-service"))).toBe(false);
  });

  test("99.3 apps/portal/ does not exist", () => {
    expect(existsSync(repoPath("apps/portal"))).toBe(false);
  });

  test("99.4 packages/server/share-url.ts does not exist", () => {
    expect(existsSync(repoPath("packages/server/share-url.ts"))).toBe(false);
  });

  test("99.5 packages/ui/utils/sharing.ts does not exist", () => {
    expect(existsSync(repoPath("packages/ui/utils/sharing.ts"))).toBe(false);
  });

  test("99.6 packages/ui/hooks/useSharing.ts does not exist", () => {
    expect(existsSync(repoPath("packages/ui/hooks/useSharing.ts"))).toBe(false);
  });

  test("99.7 package.json scripts do not contain deleted build targets", () => {
    const raw = readFileSync(repoPath("package.json"), "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const banned = ["build:portal", "build:marketing", "dev:portal", "dev:marketing"];
    for (const script of banned) {
      expect(Object.keys(scripts)).not.toContain(script);
    }
  });

  test("99.8 README does not reference removed env vars", () => {
    const readme = readFileSync(repoPath("README.md"), "utf8");
    const bannedVars = [
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_SHARE",
      "PLANNOTATOR_SHARE_URL",
      "PLANNOTATOR_PASTE_URL",
    ];
    for (const envVar of bannedVars) {
      expect(readme).not.toContain(envVar);
    }
  });

  test("99.9 AGENTS.md describes daemon architecture [expected to fail until doc is updated]", () => {
    // ADR: AGENTS.md is stale — still describes the pre-refactor per-invocation server model
    // (references startPlannotatorServer, does not describe daemon lifecycle).
    // This test is expected to fail until AGENTS.md is rewritten for the daemon model.
    // Tracking issue: update AGENTS.md (NIM-38).
    const agentsMd = readFileSync(repoPath("AGENTS.md"), "utf8");
    expect(agentsMd).toContain("daemon start");
    expect(agentsMd).not.toContain("startPlannotatorServer");
  });

  test("99.10 no source files reference old hosted share URLs (excluding legacy/ and test files)", () => {
    const patterns = [
      "share\\.plannotator\\.ai",
      "plannotator-paste\\.plannotator\\.workers\\.dev",
    ];
    for (const pattern of patterns) {
      let output = "";
      try {
        output = execSync(
          `grep -r --include="*.ts" --include="*.tsx" --include="*.html" --include="*.json" -l "${pattern}" "${repoRoot}" 2>/dev/null || true`,
          { encoding: "utf8" },
        );
      } catch {
        output = "";
      }
      const hits = output
        .trim()
        .split("\n")
        .filter((line) => {
          if (!line.trim()) return false;
          if (line.includes(`${repoRoot}/legacy/`)) return false;
          // Exclude test files that check for the ABSENCE of these URLs
          if (line.includes(`${repoRoot}/tests/`)) return false;
          return true;
        });
      expect(hits).toEqual([]);
    }
  });

  test("99.11 apps/pi-extension/ does not exist (codified absence)", () => {
    // ADR: apps/pi-extension/ was not part of this fork at sprint close.
    // If it is intentionally added later, update this test to assert its presence/structure.
    expect(existsSync(repoPath("apps/pi-extension"))).toBe(false);
  });
});
