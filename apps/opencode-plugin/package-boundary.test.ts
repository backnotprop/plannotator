import { describe, expect, test } from "bun:test";
import packageJson from "./package.json";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("OpenCode package entrypoints", () => {
  test("keeps V1 on main and exposes V2 from the package root", () => {
    expect(packageJson.main).toBe("dist/index.js");
    expect(packageJson.exports).toEqual({
      ".": "./dist/server.js",
    });
  });

  test("ships the plannotator knowledge skill and installs it where OpenCode scans", () => {
    expect(packageJson.files).toContain("skills");
    expect(packageJson.scripts["build:skill"]).toContain(
      "cp -R ../skills/core/plannotator skills/plannotator",
    );
    expect(packageJson.scripts.build).toContain("bun run build:skill");
    expect(packageJson.scripts.postinstall).toBe("node scripts/postinstall.cjs");
    expect(packageJson.files).toContain("scripts/postinstall.cjs");
  });
});
