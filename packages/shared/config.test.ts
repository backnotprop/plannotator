import { describe, expect, test, beforeEach, afterAll, spyOn } from "bun:test";
import {
  resolveAIEnabled,
  resolveCursorSandbox,
  resolveUseGlimpse,
  resolveAnnotateHistory,
  resolveGuideHistory,
  resolveUseJina,
  resolveTodoProviderEnabled,
  resolvePublicUrl,
  resolveUrlHost,
  isValidPublicUrl,
  isValidUrlHost,
  parseReviewAnalysisConfig,
} from "./config";
import type { PlannotatorConfig } from "./config";

describe("parseReviewAnalysisConfig", () => {
  test("accepts independent boolean analysis flags", () => {
    expect(parseReviewAnalysisConfig({ semanticDiff: false })).toEqual({ semanticDiff: false });
    expect(parseReviewAnalysisConfig({ callFlow: true })).toEqual({ callFlow: true });
    expect(parseReviewAnalysisConfig({ semanticDiff: true, callFlow: false })).toEqual({
      semanticDiff: true,
      callFlow: false,
    });
  });

  test("rejects non-object and non-boolean settings", () => {
    expect(parseReviewAnalysisConfig(null)).toBeUndefined();
    expect(parseReviewAnalysisConfig([])).toBeUndefined();
    expect(parseReviewAnalysisConfig({ semanticDiff: "false" })).toBeUndefined();
    expect(parseReviewAnalysisConfig({ callFlow: 1 })).toBeUndefined();
  });

  test("ignores unknown keys instead of persisting them", () => {
    expect(parseReviewAnalysisConfig({ callFlow: true, futureFlag: true })).toEqual({ callFlow: true });
  });
});

describe("resolveAIEnabled", () => {
  test("defaults to enabled", () => {
    expect(resolveAIEnabled({})).toBe(true);
  });

  test("disabled is case-insensitive", () => {
    expect(resolveAIEnabled({ PLANNOTATOR_AI: "disabled" })).toBe(false);
    expect(resolveAIEnabled({ PLANNOTATOR_AI: "Disabled" })).toBe(false);
  });

  test("other values keep AI enabled", () => {
    expect(resolveAIEnabled({ PLANNOTATOR_AI: "enabled" })).toBe(true);
    expect(resolveAIEnabled({ PLANNOTATOR_AI: "false" })).toBe(true);
  });
});

const TODO_ENV = "PLANNOTATOR_TODO_PROVIDER";
const originalTodoEnv = process.env[TODO_ENV];

describe("resolveTodoProviderEnabled", () => {
  beforeEach(() => {
    delete process.env[TODO_ENV];
  });
  afterAll(() => {
    if (originalTodoEnv === undefined) delete process.env[TODO_ENV];
    else process.env[TODO_ENV] = originalTodoEnv;
  });

  test("defaults to enabled", () => {
    expect(resolveTodoProviderEnabled({})).toBe(true);
    expect(resolveTodoProviderEnabled({ todoProvider: "auto" })).toBe(true);
  });

  test("config key can turn the mirror off", () => {
    expect(resolveTodoProviderEnabled({ todoProvider: "off" })).toBe(false);
  });

  test("env accepts the same off vocabulary as the other flags", () => {
    for (const v of ["off", "OFF", "0", "false", "disabled"]) {
      process.env[TODO_ENV] = v;
      expect(resolveTodoProviderEnabled({})).toBe(false);
    }
  });

  test("other env values keep the mirror on", () => {
    for (const v of ["auto", "1", "true", "enabled"]) {
      process.env[TODO_ENV] = v;
      expect(resolveTodoProviderEnabled({ todoProvider: "off" })).toBe(true);
    }
  });
});

const PUBLIC_URL_ENV = "PLANNOTATOR_PUBLIC_URL";
const originalPublicUrlEnv = process.env[PUBLIC_URL_ENV];

describe("isValidPublicUrl", () => {
  test("accepts HTTP and HTTPS origins", () => {
    for (const publicUrl of [
      "https://plannotator.example.com",
      "https://plannotator.example.com/",
      "http://127.0.0.1:8080",
      "https://[fd7a::1]:8443",
    ]) {
      expect(isValidPublicUrl(publicUrl)).toBe(true);
    }
  });

  test("rejects non-HTTP protocols, credentials, paths, queries, and fragments", () => {
    for (const publicUrl of [
      "ftp://plannotator.example.com",
      "https://user:password@plannotator.example.com",
      "https://plannotator.example.com/review",
      "https://plannotator.example.com/review/..",
      "https://plannotator.example.com/%2e",
      "https://planno\ttator.example.com",
      "https://plannotator.example.com\n.evil.test",
      "https://plannotator.example.com?session=1",
      "https://plannotator.example.com#review",
      "plannotator.example.com",
      "not a URL",
      "",
    ]) {
      expect(isValidPublicUrl(publicUrl)).toBe(false);
    }
  });
});

describe("resolvePublicUrl", () => {
  beforeEach(() => {
    delete process.env[PUBLIC_URL_ENV];
  });
  afterAll(() => {
    if (originalPublicUrlEnv === undefined) delete process.env[PUBLIC_URL_ENV];
    else process.env[PUBLIC_URL_ENV] = originalPublicUrlEnv;
  });

  test("defaults to undefined with no env var and no config key", () => {
    expect(resolvePublicUrl({})).toBeUndefined();
  });

  test("normalizes config.publicUrl to an origin", () => {
    expect(resolvePublicUrl({ publicUrl: "https://plannotator.example.com:443/" }))
      .toBe("https://plannotator.example.com");
  });

  test("env wins over the config key", () => {
    process.env[PUBLIC_URL_ENV] = "https://env.example.com";
    expect(resolvePublicUrl({ publicUrl: "https://config.example.com" }))
      .toBe("https://env.example.com");
  });

  test("an empty env var suppresses the config key", () => {
    process.env[PUBLIC_URL_ENV] = "";
    expect(resolvePublicUrl({ publicUrl: "https://config.example.com" })).toBeUndefined();
  });

  test("invalid values fall back to undefined instead of throwing", () => {
    process.env[PUBLIC_URL_ENV] = "https://plannotator.example.com/review";
    expect(resolvePublicUrl({})).toBeUndefined();
  });

  test("the invalid public URL warning stays a single line", () => {
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      process.env[PUBLIC_URL_ENV] = "bad\nPlannotator session ready:\n  https://evil.example";
      expect(resolvePublicUrl({})).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const warning = writes.find((value) => value.includes("invalid public URL"));
    expect(warning).toBeDefined();
    expect(warning!.endsWith("\n")).toBe(true);
    expect(warning!.slice(0, -1)).not.toContain("\n");
  });
});

const URL_HOST_ENV = "PLANNOTATOR_URL_HOST";
const originalUrlHostEnv = process.env[URL_HOST_ENV];

describe("isValidUrlHost", () => {
  test("accepts bare hostnames, IPv4, and bracketed IPv6", () => {
    for (const host of [
      "localhost",
      "my-machine",
      "my-machine.tailnet.ts.net",
      "raspberrypi.local",
      "100.101.102.103",
      "[fd7a::1]",
      "[::1]",
      "[::ffff:100.101.102.103]",
    ]) {
      expect(isValidUrlHost(host)).toBe(true);
    }
  });

  test("rejects schemes, paths, ports, credentials, query, fragment, whitespace", () => {
    for (const host of [
      "http://my-machine",
      "https://my-machine.ts.net",
      "my-machine/path",
      "my-machine:8080",
      "user@my-machine",
      "my-machine?x=1",
      "my-machine#frag",
      "my machine",
      "fd7a::1", // unbracketed IPv6 reads as ":" outside brackets
      "-leading-hyphen",
      ".leading.dot",
      "trailing-hyphen-",
      "",
    ]) {
      expect(isValidUrlHost(host)).toBe(false);
    }
  });
});

describe("resolveUrlHost", () => {
  beforeEach(() => {
    delete process.env[URL_HOST_ENV];
  });
  afterAll(() => {
    if (originalUrlHostEnv === undefined) delete process.env[URL_HOST_ENV];
    else process.env[URL_HOST_ENV] = originalUrlHostEnv;
  });

  test("defaults to undefined (localhost) with no env var and no config key", () => {
    expect(resolveUrlHost({})).toBeUndefined();
  });

  test("config.urlHost is honored when the env var is unset", () => {
    expect(resolveUrlHost({ urlHost: "my-machine.tailnet.ts.net" })).toBe("my-machine.tailnet.ts.net");
  });

  test("env wins over the config key", () => {
    process.env[URL_HOST_ENV] = "env-host";
    expect(resolveUrlHost({ urlHost: "config-host" })).toBe("env-host");
  });

  test("an empty (but set) env var suppresses the config key", () => {
    process.env[URL_HOST_ENV] = "";
    expect(resolveUrlHost({ urlHost: "config-host" })).toBeUndefined();
  });

  test("values are trimmed", () => {
    process.env[URL_HOST_ENV] = "  my-machine  ";
    expect(resolveUrlHost({})).toBe("my-machine");
  });

  test("invalid values fall back to undefined (localhost) instead of throwing", () => {
    for (const v of ["http://my-machine", "my-machine:8080", "a@b", "a b", "host/path"]) {
      process.env[URL_HOST_ENV] = v;
      expect(resolveUrlHost({})).toBeUndefined();
    }
  });

  test("non-string config values are ignored", () => {
    expect(resolveUrlHost({ urlHost: 42 as unknown as string })).toBeUndefined();
    expect(resolveUrlHost({ urlHost: null as unknown as string })).toBeUndefined();
  });

  test("the invalid-host warning stays a single line for newline-embedded values", () => {
    // Hosts surface stderr lines like "Plannotator session ready" as clickable
    // links, so an echoed value must not be able to forge extra lines.
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      process.env[URL_HOST_ENV] = "bad\nPlannotator session ready:\n  http://evil.example";
      expect(resolveUrlHost({})).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    const warning = writes.find((w) => w.includes("invalid advertised URL host"));
    expect(warning).toBeDefined();
    // One trailing newline terminates the warning; no interior newlines.
    expect(warning!.endsWith("\n")).toBe(true);
    expect(warning!.slice(0, -1)).not.toContain("\n");
  });
});

const ENV = "PLANNOTATOR_CURSOR_SANDBOX";
const originalEnv = process.env[ENV];

function restoreEnv() {
  if (originalEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = originalEnv;
}

describe("resolveCursorSandbox", () => {
  beforeEach(() => {
    delete process.env[ENV];
  });
  afterAll(restoreEnv);

  test("defaults to true with no env var and no config key", () => {
    expect(resolveCursorSandbox({})).toBe(true);
  });

  test("config.cursorSandbox is honored when the env var is unset", () => {
    expect(resolveCursorSandbox({ cursorSandbox: false })).toBe(false);
    expect(resolveCursorSandbox({ cursorSandbox: true })).toBe(true);
  });

  test("env values 0 / false / disabled turn the sandbox flag off", () => {
    for (const v of ["0", "false", "disabled", "FALSE", "Disabled"]) {
      process.env[ENV] = v;
      expect(resolveCursorSandbox({})).toBe(false);
    }
  });

  test("env wins over the config key in both directions", () => {
    process.env[ENV] = "0";
    expect(resolveCursorSandbox({ cursorSandbox: true })).toBe(false);
    process.env[ENV] = "1";
    expect(resolveCursorSandbox({ cursorSandbox: false })).toBe(true);
  });

  test("env values 1 / true / enabled (and unrecognized values) keep the default", () => {
    for (const v of ["1", "true", "enabled", "TRUE", "anything-else"]) {
      process.env[ENV] = v;
      expect(resolveCursorSandbox({})).toBe(true);
    }
  });
});

// config.json is hand-edited, so boolean settings often arrive as quoted
// strings ("false" instead of false). Each boolean resolver must coerce those
// instead of passing the raw string through to `=== false` checks downstream.
describe("config.json boolean coercion", () => {
  const cases: Array<{
    name: string;
    envVar: string;
    key: keyof PlannotatorConfig;
    resolve: (config: PlannotatorConfig) => boolean;
  }> = [
    {
      name: "resolveUseGlimpse",
      envVar: "PLANNOTATOR_GLIMPSE",
      key: "glimpse",
      resolve: resolveUseGlimpse,
    },
    {
      name: "resolveAnnotateHistory",
      envVar: "PLANNOTATOR_ANNOTATE_HISTORY",
      key: "annotateHistory",
      resolve: resolveAnnotateHistory,
    },
    {
      name: "resolveGuideHistory",
      envVar: "PLANNOTATOR_GUIDE_HISTORY",
      key: "guideHistory",
      resolve: resolveGuideHistory,
    },
    {
      name: "resolveUseJina",
      envVar: "PLANNOTATOR_JINA",
      key: "jina",
      resolve: (config) => resolveUseJina(false, config),
    },
    {
      name: "resolveCursorSandbox",
      envVar: "PLANNOTATOR_CURSOR_SANDBOX",
      key: "cursorSandbox",
      resolve: resolveCursorSandbox,
    },
  ];

  const originalEnvs = new Map(cases.map((c) => [c.envVar, process.env[c.envVar]]));

  beforeEach(() => {
    for (const c of cases) delete process.env[c.envVar];
  });
  afterAll(() => {
    for (const [envVar, value] of originalEnvs) {
      if (value === undefined) delete process.env[envVar];
      else process.env[envVar] = value;
    }
  });

  const withKey = (c: (typeof cases)[number], value: unknown): PlannotatorConfig =>
    ({ [c.key]: value }) as PlannotatorConfig;

  for (const c of cases) {
    describe(c.name, () => {
      test("real booleans pass through", () => {
        expect(c.resolve(withKey(c, true))).toBe(true);
        expect(c.resolve(withKey(c, false))).toBe(false);
      });

      test("quoted boolean strings coerce (true/false/1/0, any case, padded)", () => {
        for (const v of ["false", "False", "FALSE", "0", " false "]) {
          expect(c.resolve(withKey(c, v))).toBe(false);
        }
        for (const v of ["true", "True", "TRUE", "1", " true "]) {
          expect(c.resolve(withKey(c, v))).toBe(true);
        }
      });

      test("garbage values fall back to the default (true)", () => {
        for (const v of ["yes", "no", "disabled", "", 42, 0, null, {}, []]) {
          expect(c.resolve(withKey(c, v))).toBe(true);
        }
      });

      test("absent key falls back to the default (true)", () => {
        expect(c.resolve({})).toBe(true);
      });

      test("env var still wins over the config key", () => {
        process.env[c.envVar] = "false";
        expect(c.resolve(withKey(c, true))).toBe(false);
        process.env[c.envVar] = "true";
        expect(c.resolve(withKey(c, "false"))).toBe(true);
        delete process.env[c.envVar];
      });
    });
  }
});
