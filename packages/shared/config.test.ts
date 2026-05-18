import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { detectGitUser } from "./config";

const dirs: string[] = [];

function tempRepo(name: string, gitUser: string): string {
  const dir = mkdtempSync(join(tmpdir(), `plannotator-config-${name}-`));
  dirs.push(dir);
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", gitUser], { cwd: dir });
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("detectGitUser", () => {
  test("reads git identity from the provided cwd", () => {
    const first = tempRepo("first", "First Repo User");
    const second = tempRepo("second", "Second Repo User");
    const originalCwd = process.cwd();

    try {
      process.chdir(first);
      expect(detectGitUser(second)).toBe("Second Repo User");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
