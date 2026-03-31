import { afterEach, describe, expect, test } from "bun:test";
import { shouldTryRemoteBrowserFallback } from "./browser";

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
});
