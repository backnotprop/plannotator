import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLocalOnlyAdvertisedUrl, resolveAdvertisedSessionUrl } from "./advertised-url";

const ENV_KEYS = [
  "PLANNOTATOR_DATA_DIR",
  "PLANNOTATOR_PORT",
  "PLANNOTATOR_PUBLIC_URL",
  "PLANNOTATOR_URL_HOST",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const DATA_DIR = mkdtempSync(join(tmpdir(), "plannotator-advertised-url-"));

beforeEach(() => {
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  process.env.PLANNOTATOR_DATA_DIR = DATA_DIR;
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  rmSync(DATA_DIR, { recursive: true, force: true });
});

describe("resolveAdvertisedSessionUrl", () => {
  test("defaults to the bound localhost port", () => {
    expect(resolveAdvertisedSessionUrl(19432, true)).toBe("http://localhost:19432");
  });

  test("uses the public origin only on the first port of a range", () => {
    process.env.PLANNOTATOR_PORT = "19432-19463";
    process.env.PLANNOTATOR_PUBLIC_URL = "https://plannotator.example.com";
    process.env.PLANNOTATOR_URL_HOST = "my-machine.tailnet.ts.net";

    expect(resolveAdvertisedSessionUrl(19432, true)).toBe("https://plannotator.example.com");
    expect(resolveAdvertisedSessionUrl(19433, true)).toBe("http://my-machine.tailnet.ts.net:19433");

    process.env.PLANNOTATOR_URL_HOST = "";
    expect(resolveAdvertisedSessionUrl(19434, true)).toBe("http://localhost:19434");
  });

  test("resolves only the override that applies to the bound port", () => {
    const spy = spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      process.env.PLANNOTATOR_PUBLIC_URL = "https://plannotator.example.com";
      process.env.PLANNOTATOR_URL_HOST = "https://invalid.example/path";
      expect(resolveAdvertisedSessionUrl(19432, true)).toBe("https://plannotator.example.com");
      expect(spy.mock.calls).toEqual([]);

      process.env.PLANNOTATOR_PORT = "19432-19463";
      process.env.PLANNOTATOR_PUBLIC_URL = "https://invalid.example/path";
      process.env.PLANNOTATOR_URL_HOST = "my-machine.tailnet.ts.net";
      expect(resolveAdvertisedSessionUrl(19433, true)).toBe(
        "http://my-machine.tailnet.ts.net:19433",
      );
      expect(spy.mock.calls).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  test("ignores display overrides for a local session", () => {
    process.env.PLANNOTATOR_PUBLIC_URL = "https://plannotator.example.com";
    expect(resolveAdvertisedSessionUrl(1234, false)).toBe("http://localhost:1234");
  });

  test("keeps a bracketed IPv6 host and the bound port", () => {
    process.env.PLANNOTATOR_URL_HOST = "[fd7a::1]";
    expect(resolveAdvertisedSessionUrl(9999, true)).toBe("http://[fd7a::1]:9999");
  });
});

describe("isLocalOnlyAdvertisedUrl", () => {
  test("recognizes loopback aliases and unspecified bind addresses", () => {
    for (const url of [
      "http://localhost:19432",
      "http://foo.localhost:19432",
      "http://127.0.0.2:19432",
      "http://127.1:19432",
      "http://0.0.0.0:19432",
      "http://[::1]:19432",
      "http://[::]:19432",
      "http://[::ffff:127.0.0.2]:19432",
      "not a URL",
    ]) {
      expect(isLocalOnlyAdvertisedUrl(url)).toBe(true);
    }
  });

  test("does not classify network hostnames as local-only", () => {
    for (const url of [
      "https://plannotator.example.com",
      "http://my-machine.tailnet.ts.net:19433",
      "http://127.example.com:19433",
    ]) {
      expect(isLocalOnlyAdvertisedUrl(url)).toBe(false);
    }
  });
});
