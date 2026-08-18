import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const scriptPath = resolve(import.meta.dir, "check-release-version.mjs");
const temporaryRoots: string[] = [];
const jsonVersionPaths = [
  "package.json",
  "apps/opencode-plugin/package.json",
  "apps/pi-extension/package.json",
  "apps/hook/.claude-plugin/plugin.json",
  "apps/copilot/plugin.json",
  "packages/server/package.json",
] as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function createFixture(version = "1.2.3"): string {
  const root = mkdtempSync(join(tmpdir(), "plannotator-release-version-"));
  temporaryRoots.push(root);

  for (const relativePath of jsonVersionPaths) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, `${JSON.stringify({ version }, null, 2)}\n`);
  }
  writeFileSync(join(root, "openpackage.yml"), `name: plannotator\nversion: ${version}\n`);
  return root;
}

function runCheck(root: string, tag?: string) {
  const argumentsList = [process.execPath, scriptPath, "--root", root];
  if (tag !== undefined) argumentsList.push("--tag", tag);
  return Bun.spawnSync(argumentsList, { stdout: "pipe", stderr: "pipe" });
}

describe("release version consistency check", () => {
  test("accepts matching manifests and tag", () => {
    const result = runCheck(createFixture(), "v1.2.3");

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("Release version is consistent: v1.2.3");
  });

  test("rejects a mismatched release-coupled manifest", () => {
    const root = createFixture();
    writeFileSync(join(root, "apps/pi-extension/package.json"), '{"version":"1.2.4"}\n');

    const result = runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("Release-coupled versions do not match");
    expect(result.stderr.toString()).toContain("apps/pi-extension/package.json: 1.2.4");
  });

  test("rejects a tag that does not match the manifests", () => {
    const result = runCheck(createFixture(), "v1.2.4");

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Release tag v1.2.4 does not match manifest version v1.2.3",
    );
  });
});
