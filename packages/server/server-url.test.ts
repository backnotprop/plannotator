/**
 * PR C: Tests for getServerUrl() respecting PLANNOTATOR_SERVER_URL
 *
 * When PLANNOTATOR_SERVER_URL is set, the server should use that URL
 * instead of hardcoded http://localhost:{port}.
 */
import { describe, test, expect, afterAll, beforeAll, afterEach } from "bun:test";

// We test getServerUrl directly since it's a pure function reading env vars.
// Import once and test with env manipulation.

describe("getServerUrl", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ["PLANNOTATOR_SERVER_URL", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_HOST"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(() => {
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
      else delete process.env[key];
    }
  });

  // We need to re-import each time because remote.ts reads env at module level
  // for isRemoteSession. But getServerUrl reads env on each call.
  // Let's just test the function directly.

  test("returns localhost URL when no env vars set", async () => {
    const { getServerUrl } = await import("./remote");
    const url = getServerUrl(9999);
    expect(url).toBe("http://127.0.0.1:9999");
  });

  test("respects PLANNOTATOR_SERVER_URL when set", async () => {
    process.env.PLANNOTATOR_SERVER_URL = "http://192.168.1.100:8080";
    try {
      const { getServerUrl } = await import("./remote");
      expect(getServerUrl(0)).toBe("http://192.168.1.100:8080");
    } finally {
      delete process.env.PLANNOTATOR_SERVER_URL;
    }
  });

  test("PLANNOTATOR_SERVER_URL takes precedence over port", async () => {
    process.env.PLANNOTATOR_SERVER_URL = "https://plannotator.example.com";
    process.env.PLANNOTATOR_PORT = "9999";
    try {
      const { getServerUrl } = await import("./remote");
      expect(getServerUrl(0)).toBe("https://plannotator.example.com");
    } finally {
      delete process.env.PLANNOTATOR_SERVER_URL;
      delete process.env.PLANNOTATOR_PORT;
    }
  });

  test("PLANNOTATOR_HOST overrides hostname", async () => {
    process.env.PLANNOTATOR_HOST = "100.64.0.1";
    try {
      const { getServerUrl } = await import("./remote");
      expect(getServerUrl(8080)).toBe("http://100.64.0.1:8080");
    } finally {
      delete process.env.PLANNOTATOR_HOST;
    }
  });

  test("PLANNOTATOR_HOST + custom port", async () => {
    process.env.PLANNOTATOR_HOST = "100.64.0.1";
    try {
      const { getServerUrl } = await import("./remote");
      expect(getServerUrl(3000)).toBe("http://100.64.0.1:3000");
    } finally {
      delete process.env.PLANNOTATOR_HOST;
    }
  });
});
