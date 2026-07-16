import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveOpenInTarget } from "@plannotator/shared/html-assets-node";

// resolveOpenInTarget is the security boundary for POST /api/open-in: it decides
// which absolute file a launch is allowed to touch. Real temp dirs/files are
// used so the realpath-based symlink containment (isWithinDirectory) actually runs.

const tempDirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "open-in-test-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort cleanup */
    }
  }
});

describe("resolveOpenInTarget — /api/open-in containment", () => {
  test("a server root scopes opens: a file inside the root is allowed", () => {
    const root = makeDir();
    writeFileSync(join(root, "notes.md"), "x");
    expect(resolveOpenInTarget("notes.md", null, () => root)).not.toBeNull();
  });

  test("empty server roots deny opens while PR checkout warmup is pending", () => {
    // resolveOpenInRoot returns [] in PR pool warmup; that must deny, not fall back.
    expect(resolveOpenInTarget("notes.md", null, () => [])).toBeNull();
  });

  test("rejects relative traversal that escapes the root", () => {
    const root = makeDir();
    expect(resolveOpenInTarget("../escape.md", null, () => root)).toBeNull();
  });

  test("rejects an arbitrary absolute path", () => {
    const root = makeDir();
    expect(resolveOpenInTarget("/etc/passwd", null, () => root)).toBeNull();
  });

  test("a server root overrides a malicious client base", () => {
    const root = makeDir();
    writeFileSync(join(root, "inside.md"), "x");
    // base "/" would otherwise let anything through; the server root must win.
    expect(resolveOpenInTarget("/etc/passwd", "/", () => root)).toBeNull();
    expect(resolveOpenInTarget("inside.md", "/", () => root)).not.toBeNull();
  });

  test("rejects an in-root symlink that points outside the root", () => {
    const root = makeDir();
    const outside = makeDir();
    writeFileSync(join(outside, "secret.txt"), "x");
    try {
      symlinkSync(join(outside, "secret.txt"), join(root, "link.txt"));
    } catch {
      return; // platform without symlink permission (e.g. Windows CI) — skip
    }
    expect(resolveOpenInTarget("link.txt", null, () => root)).toBeNull();
  });

  test("with no server root, an absolute path resolves against its own dir", () => {
    const root = makeDir();
    writeFileSync(join(root, "file.md"), "x");
    // Documents the default (review supplies resolveAgentCwd; this is the fallback).
    expect(resolveOpenInTarget(join(root, "file.md"), null, undefined)).not.toBeNull();
  });

  test("accepts a file in any of several roots (annotate reference roots)", () => {
    const a = makeDir();
    const b = makeDir();
    writeFileSync(join(b, "doc.md"), "x");
    // A linked doc living in root B is allowed because B is one of the roots
    // (mirrors /api/doc serving from cwd + the source-file dir).
    expect(resolveOpenInTarget(join(b, "doc.md"), null, () => [a, b])).not.toBeNull();
    // Outside every allowed root → still rejected.
    expect(resolveOpenInTarget("/etc/passwd", null, () => [a, b])).toBeNull();
  });

  test("multi-root resolves relative paths per-root and rejects cross-root traversal", () => {
    const a = makeDir();
    const b = makeDir();
    writeFileSync(join(a, "x.md"), "x");
    // A relative path resolves within a root that contains it.
    expect(resolveOpenInTarget("x.md", null, () => [a, b])).not.toBeNull();
    // A traversal can't escape one root by landing inside another.
    expect(resolveOpenInTarget("../x.md", null, () => [a, b])).toBeNull();
  });
});
