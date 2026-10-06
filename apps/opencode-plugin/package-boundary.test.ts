import { describe, expect, test } from "bun:test";
import packageJson from "./package.json";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

describe("OpenCode package entrypoints", () => {
  test("keeps V1 on main and exposes V2 from the package root", () => {
    expect(packageJson.main).toBe("dist/index.js");
    // OpenCode 1 checks ./server before main, so that subpath must remain absent.
    expect(packageJson.exports).toEqual({
      ".": "./dist/server.js",
    });
  });

  test("ships the plannotator knowledge skill and installs it where OpenCode scans", () => {
    // #1377 install reach: postinstall wrote only commands/*.md, so npm-plugin
    // users never received the CLI reference. Three things have to line up or
    // it silently stops shipping: the build must copy it into the package,
    // `files` must include it, and postinstall must place it under the config
    // dir OpenCode scans (`{skill,skills}/**/SKILL.md` under xdgConfig/opencode).
    expect(packageJson.files).toContain("skills");
    expect(packageJson.scripts["build:skill"]).toContain(
      "cp -R ../skills/core/plannotator skills/plannotator",
    );
    // The build must actually run that step, not merely define it.
    expect(packageJson.scripts.build).toContain("bun run build:skill");
    // postinstall is a Node script (see postinstall.test.ts for what it
    // writes); the published package has to carry it or every install fails.
    expect(packageJson.scripts.postinstall).toBe("node scripts/postinstall.cjs");
    expect(packageJson.files).toContain("scripts/postinstall.cjs");
  });
});
