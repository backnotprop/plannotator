import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveOpenInTarget } from "@plannotator/shared/html-assets-node";
import { openFileInApp } from "./open-in";

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

// Launch semantics for POST /api/open-in: the launcher must be a concurrent
// side concern of the review session. Each test shims the per-platform
// launcher command (mac: `open`, linux: the catalog's `code` bin) onto PATH
// and drives the real openFileInApp. Skipped on Windows (no sh shims).
const launcherShimName = process.platform === "darwin" ? "open" : "code";
const launchTest = process.platform === "win32" ? test.skip : test;

/** Write the executable launcher shim into `dir`. */
function writeShim(dir: string, script: string): void {
  const shim = join(dir, launcherShimName);
  writeFileSync(shim, script);
  chmodSync(shim, 0o755);
}

function pgidOf(pid: number): number {
  const out = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf-8",
  });
  return Number.parseInt(out.stdout.trim(), 10);
}

async function waitForPidFile(path: string, timeoutMs = 5000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const text = readFileSync(path, "utf-8").trim();
      if (text) return Number.parseInt(text, 10);
    } catch {
      /* not written yet */
    }
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("openFileInApp launch semantics", () => {
  launchTest(
    "a lingering launcher returns ok within the grace and runs detached from the server's process group",
    async () => {
      const shimDir = makeDir();
      const pidFile = join(shimDir, "child.pid");
      writeShim(
        shimDir,
        `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 30\n`,
      );
      const target = join(makeDir(), "file.txt");
      writeFileSync(target, "x");

      const oldPath = process.env.PATH;
      process.env.PATH = `${shimDir}${delimiter}${oldPath ?? ""}`;
      let childPid: number | null = null;
      try {
        const started = Date.now();
        const result = await openFileInApp(target, "vscode");
        const elapsed = Date.now() - started;

        // Regression guard: the request must not be held until the launcher
        // exits (30s here). It resolves ok at the grace deadline instead.
        expect(result.ok).toBe(true);
        expect(elapsed).toBeLessThan(8000);

        childPid = await waitForPidFile(pidFile);
        // The launcher is still running after we answered ok...
        expect(() => process.kill(childPid!, 0)).not.toThrow();
        // ...and in its OWN process group, so a signal aimed at this
        // process's group (agent cancelling the session, terminal close)
        // cannot take a cold-started editor down with it.
        expect(pgidOf(childPid)).not.toBe(pgidOf(process.pid));
      } finally {
        process.env.PATH = oldPath;
        if (childPid != null) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    },
    15000,
  );

  launchTest(
    "an instantly failing launcher still reports the friendly exit + stderr error",
    async () => {
      const shimDir = makeDir();
      writeShim(
        shimDir,
        `#!/bin/sh\necho "Unable to find application named 'ShimTarget'" >&2\nexit 1\n`,
      );
      const target = join(makeDir(), "file.txt");
      writeFileSync(target, "x");

      const oldPath = process.env.PATH;
      process.env.PATH = `${shimDir}${delimiter}${oldPath ?? ""}`;
      try {
        const result = await openFileInApp(target, "vscode");
        expect(result.ok).toBe(false);
        if (result.ok === false) {
          // Same failure shape as before the detach: exit code + stderr.
          expect(result.error).toContain("Failed to open");
          expect(result.error).toContain("exit 1");
          expect(result.error).toContain(
            "Unable to find application named 'ShimTarget'",
          );
        }
      } finally {
        process.env.PATH = oldPath;
      }
    },
    15000,
  );

  launchTest(
    "a chatty launcher (>128KB stderr, then lingers) cannot deadlock the request",
    async () => {
      const shimDir = makeDir();
      const pidFile = join(shimDir, "child.pid");
      // Writes far more stderr than a pipe buffer holds, THEN records its pid
      // and lingers. Without a concurrent drain the shim blocks on the full
      // pipe and never reaches sleep, and the request never returns.
      writeShim(
        shimDir,
        `#!/bin/sh\nhead -c 200000 /dev/zero | tr '\\0' e >&2\necho $$ > "${pidFile}"\nexec sleep 30\n`,
      );
      const target = join(makeDir(), "file.txt");
      writeFileSync(target, "x");

      const oldPath = process.env.PATH;
      process.env.PATH = `${shimDir}${delimiter}${oldPath ?? ""}`;
      let childPid: number | null = null;
      try {
        const started = Date.now();
        const result = await openFileInApp(target, "vscode");
        const elapsed = Date.now() - started;
        expect(result.ok).toBe(true);
        expect(elapsed).toBeLessThan(8000);
        childPid = await waitForPidFile(pidFile);
      } finally {
        process.env.PATH = oldPath;
        if (childPid != null) {
          try {
            process.kill(childPid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    },
    15000,
  );
});
