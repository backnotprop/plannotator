import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { toRelativePath } from "./path-utils";

test("review paths distinguish dot-prefixed names from parent traversal", () => {
  const parent = resolve("fixture");
  const cwd = join(parent, "worktree");
  expect(toRelativePath(join(cwd, "..notes", "plan.md"), cwd)).toBe("..notes/plan.md");
  expect(toRelativePath(join(parent, "outside.md"), cwd)).toBe(join(parent, "outside.md"));
});

test.skipIf(process.platform === "win32")("keeps literal backslashes in POSIX Git paths", () => {
  const cwd = resolve("fixture", "worktree");
  expect(toRelativePath(join(cwd, "a\\b.ts"), cwd)).toBe("a\\b.ts");
});
