import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  isNoOpBrowserSentinel,
  isPosixBrowserTarget,
  openBrowser,
  resolvePosixBrowserTarget,
  shouldTryRemoteBrowserFallback,
} from "./browser";

const savedEnv: Record<string, string | undefined> = {};
const envKeys = ["PLANNOTATOR_BROWSER", "BROWSER"];

function clearEnv() {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

afterEach(() => {
  for (const key of envKeys) {
    if (savedEnv[key] !== undefined) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

describe("shouldTryRemoteBrowserFallback", () => {
  test("false for local sessions", () => {
    clearEnv();
    expect(shouldTryRemoteBrowserFallback(false)).toBe(false);
  });

  test("true for remote sessions without browser handlers", () => {
    clearEnv();
    expect(shouldTryRemoteBrowserFallback(true)).toBe(true);
  });

  test("false for remote sessions with BROWSER configured", () => {
    clearEnv();
    process.env.BROWSER = "/usr/bin/browser";
    expect(shouldTryRemoteBrowserFallback(true)).toBe(false);
  });

  test("false for remote sessions with PLANNOTATOR_BROWSER configured", () => {
    clearEnv();
    process.env.PLANNOTATOR_BROWSER = "/usr/bin/browser";
    expect(shouldTryRemoteBrowserFallback(true)).toBe(false);
  });

  test("true for remote sessions when BROWSER is a no-op sentinel", () => {
    clearEnv();
    process.env.BROWSER = "true";
    expect(shouldTryRemoteBrowserFallback(true)).toBe(true);
  });

  test("true for remote sessions when PLANNOTATOR_BROWSER is a no-op sentinel", () => {
    clearEnv();
    process.env.PLANNOTATOR_BROWSER = "none";
    expect(shouldTryRemoteBrowserFallback(true)).toBe(true);
  });
});

describe("isNoOpBrowserSentinel", () => {
  test("returns false for undefined and empty values", () => {
    expect(isNoOpBrowserSentinel(undefined)).toBe(false);
    expect(isNoOpBrowserSentinel("")).toBe(false);
  });

  test("recognizes no-op values case- and whitespace-insensitively", () => {
    for (const value of [
      "true",
      "false",
      "none",
      ":",
      "0",
      "1",
      "TRUE",
      "  none  ",
    ]) {
      expect(isNoOpBrowserSentinel(value)).toBe(true);
    }
  });

  test("does not flag real browser handlers or explicit command paths", () => {
    expect(isNoOpBrowserSentinel("/usr/bin/firefox")).toBe(false);
    expect(isNoOpBrowserSentinel("Google Chrome")).toBe(false);
    expect(isNoOpBrowserSentinel("open")).toBe(false);
    expect(isNoOpBrowserSentinel("/usr/bin/true")).toBe(false);
  });
});

describe("isPosixBrowserTarget", () => {
  test("accepts POSIX paths and resolves bare names to their PATH location", () => {
    expect(isPosixBrowserTarget("/usr/bin/fake-browser")).toBe(true);
    expect(resolvePosixBrowserTarget("/usr/bin/fake-browser")).toBe("/usr/bin/fake-browser");
    expect(resolvePosixBrowserTarget("./browser")).toBe("./browser");
    expect(resolvePosixBrowserTarget("../browser")).toBe("../browser");
    // A bare name is resolved against the Linux PATH at call time.
    expect(resolvePosixBrowserTarget("sh")).toMatch(/\/sh$/);
  });

  test("rejects Windows targets that belong to cmd.exe", () => {
    expect(resolvePosixBrowserTarget("chrome.exe")).toBeNull();
    expect(resolvePosixBrowserTarget("C:\\Program Files\\Chrome\\chrome.exe")).toBeNull();
    expect(resolvePosixBrowserTarget("/mnt/c/Program Files/Chrome/chrome.exe")).toBeNull();
    expect(resolvePosixBrowserTarget("/mnt/c/Windows/System32/cmd.exe")).toBeNull();
    expect(resolvePosixBrowserTarget("not-a-real-binary-1472")).toBeNull();
  });
});

// --- WSL PLANNOTATOR_BROWSER routing (#1472) ---

const realPlatform = process.platform;
const realRelease = os.release;

/** Pretend to run under WSL: isWSL() reads process.platform and os.release(). */
function mockWsl() {
  Object.defineProperty(process, "platform", { value: "linux", configurable: true });
  os.release = () => "5.15.90.1-microsoft-standard-WSL2";
}

function restoreHostPlatform() {
  Object.defineProperty(process, "platform", { value: realPlatform, configurable: true });
  os.release = realRelease;
}

function writeExecutable(dir: string, name: string, body: string): string {
  const file = join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "plannotator-browser-"));
}

const URL = "http://127.0.0.1:19432/plan";

describe("WSL configured browser launch", () => {
  afterEach(() => {
    restoreHostPlatform();
  });

  test("a POSIX path is executed directly with the URL", async () => {
    const dir = makeTempDir();
    const log = join(dir, "args.txt");
    const script = writeExecutable(dir, "fake-browser", `printf '%s' "$1" > '${log}'`);
    try {
      clearEnv();
      mockWsl();
      process.env.PLANNOTATOR_BROWSER = script;

      expect(await openBrowser(URL)).toBe(true);
      expect(readFileSync(log, "utf8")).toBe(URL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // openBrowser spawns the RESOLVED absolute path, not the bare name: Bun
  // 1.3's `$` resolves bare command names against the PATH captured at
  // startup, so a runtime-prepended PATH entry would be invisible to it.
  test("a bare Linux PATH executable name is executed directly", async () => {
    const dir = makeTempDir();
    const log = join(dir, "args.txt");
    writeExecutable(dir, "fake-browser-wsl1472", `printf '%s' "$1" > '${log}'`);
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
      clearEnv();
      mockWsl();
      process.env.PLANNOTATOR_BROWSER = "fake-browser-wsl1472";

      expect(await openBrowser(URL)).toBe(true);
      expect(readFileSync(log, "utf8")).toBe(URL);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The cmd.exe route itself cannot be execution-tested through Bun's `$` on
  // a non-Windows host (see the note on the bare-name test above): a bare
  // cmd.exe shim on a mutated PATH is invisible to Bun 1.3's shell. The Pi
  // mirror pins it end-to-end in apps/pi-extension/server/network.test.ts
  // (node:child_process spawn honors a mutated PATH on every Bun version),
  // and the classifier tests above pin the routing decision.

  test("a failing configured browser warns on stderr and still falls back", async () => {
    const dir = makeTempDir();
    const script = writeExecutable(dir, "broken-browser", "exit 3");
    const originalWrite = process.stderr.write;
    const chunks: string[] = [];
    (process.stderr as { write: unknown }).write = (chunk: string) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      clearEnv();
      mockWsl();
      process.env.PLANNOTATOR_BROWSER = script;

      expect(await openBrowser(URL)).toBe(false);
      const warning = chunks.join("");
      expect(warning).toContain(script);
      expect(warning).toContain("PLANNOTATOR_BROWSER");
    } finally {
      (process.stderr as { write: unknown }).write = originalWrite;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
