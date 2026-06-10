import { afterEach, describe, expect, test } from "bun:test";
import { isNoOpBrowserSentinel, shouldTryRemoteBrowserFallback } from "./browser";

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
