import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAIEnabled,
  resolveCursorSandbox,
  resolveUseGlimpse,
  resolveAnnotateHistory,
  resolveGuideHistory,
  resolveUseJina,
  resolveTodoProviderEnabled,
  resolveUrlHost,
  isValidUrlHost,
  parseReviewAnalysisConfig,
  loadConfig,
  saveConfig,
  getServerConfig,
  resolveGuideShareUrl,
  resolveSharingEnabled,
  DEFAULT_GUIDE_SHARE_URL,
  __setConfigLockTimingsForTest,
  __setConfigSaveMergeWindowHookForTest,
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

describe("favicon config persistence", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plannotator-config-test-"));
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (originalDataDir !== undefined) {
      process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
    } else {
      delete process.env.PLANNOTATOR_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("persists and reads valid favicon styles via saveConfig and getServerConfig", () => {
    saveConfig({ favicon: "classic" });
    expect(loadConfig().favicon).toBe("classic");
    expect(getServerConfig(null).favicon).toBe("classic");

    saveConfig({ favicon: "totman" });
    expect(loadConfig().favicon).toBe("totman");
    expect(getServerConfig(null).favicon).toBe("totman");
  });

  test("omits unknown favicon styles from getServerConfig", () => {
    const unknownFavicon = "unknown" as unknown as PlannotatorConfig["favicon"];
    saveConfig({ favicon: unknownFavicon });
    expect(loadConfig().favicon).toBe(unknownFavicon);
    expect(getServerConfig(null).favicon).toBeUndefined();
  });
});

describe("saveConfig write serialization", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plannotator-config-lock-"));
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    __setConfigSaveMergeWindowHookForTest(null);
    __setConfigLockTimingsForTest(null);
    if (originalDataDir !== undefined) {
      process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
    } else {
      delete process.env.PLANNOTATOR_DATA_DIR;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("holds an exclusive lock across the whole read-merge-write, and releases it", () => {
    // The lost update the lock exists to stop happens between the read and
    // the write, so that is exactly the window mutual exclusion has to cover.
    const lockPath = join(tempDir, "config.json.lock");
    let observedInsideWindow: { exists: boolean; exclusiveCreateFailed: boolean } | null = null;
    __setConfigSaveMergeWindowHookForTest(() => {
      let exclusiveCreateFailed = false;
      try {
        closeSync(openSync(lockPath, "wx"));
      } catch (e) {
        exclusiveCreateFailed = (e as NodeJS.ErrnoException).code === "EEXIST";
      }
      observedInsideWindow = { exists: existsSync(lockPath), exclusiveCreateFailed };
    });

    saveConfig({ displayName: "held" });

    expect(observedInsideWindow).toEqual({ exists: true, exclusiveCreateFailed: true });
    expect(existsSync(lockPath)).toBe(false);
    expect(loadConfig().displayName).toBe("held");
  });

  test("concurrent saves in one process all land", async () => {
    await Promise.all([
      (async () => saveConfig({ displayName: "a" }))(),
      (async () => saveConfig({ conventionalComments: true }))(),
      (async () => saveConfig({ favicon: "classic" }))(),
    ]);
    const cfg = loadConfig();
    expect(cfg.displayName).toBe("a");
    expect(cfg.conventionalComments).toBe(true);
    expect(cfg.favicon).toBe("classic");
  });

  test("a lock left behind by a dead writer is taken over, not waited out", () => {
    const lockPath = join(tempDir, "config.json.lock");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(lockPath, "999999 dead\n");
    // Ancient by the shipping stale window; no timing dependence in the test.
    __setConfigLockTimingsForTest({ staleMs: 0, waitBudgetMs: 5000 });

    saveConfig({ displayName: "after-takeover" });

    expect(loadConfig().displayName).toBe("after-takeover");
    expect(existsSync(lockPath)).toBe(false);
  });

  test("a lock that never frees is waited out, then written past with a warning", () => {
    // Deadlock is the one outcome worse than a lost update: a lock that stays
    // fresh forever must cost a bounded wait and a warning, not a hung server.
    const lockPath = join(tempDir, "config.json.lock");
    mkdirSync(tempDir, { recursive: true });
    writeFileSync(lockPath, "1 forever\n");
    __setConfigLockTimingsForTest({ staleMs: 60_000, waitBudgetMs: 30 });

    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const startedAt = Date.now();
    try {
      saveConfig({ displayName: "not-blocked" });
    } finally {
      spy.mockRestore();
    }

    expect(Date.now() - startedAt).toBeLessThan(3000);
    expect(loadConfig().displayName).toBe("not-blocked");
    expect(writes.some((w) => w.includes("config.json lock unavailable"))).toBe(true);
    // Someone else's lock is left for them.
    expect(existsSync(lockPath)).toBe(true);
  });

  test("two processes sharing a data dir do not drop each other's keys", async () => {
    // The reported race: one annotate server and one review server settling
    // POST /api/config at the same time. Ordering here is barrier-driven, not
    // sleep-driven: the holder announces the lock, the contender announces it
    // has started, and only then is the holder released.
    const scriptPath = join(tempDir, "writer.ts");
    writeFileSync(
      scriptPath,
      `import { saveConfig, __setConfigSaveMergeWindowHookForTest, __setConfigLockTimingsForTest } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
import { existsSync, writeFileSync } from "node:fs";
const key = process.env.TEST_KEY!;
const holdUntil = process.env.TEST_HOLD_UNTIL;
// Long stale window: the holder is deliberately slow, and must not be robbed.
__setConfigLockTimingsForTest({ staleMs: 60000, waitBudgetMs: 30000 });
if (holdUntil) {
  __setConfigSaveMergeWindowHookForTest(() => {
    writeFileSync(process.env.TEST_HOLDING_FLAG!, "1");
    while (!existsSync(holdUntil)) { /* spin: saveConfig is synchronous */ }
  });
}
saveConfig({ prompts: { [key]: "v" } } as never);
`,
    );

    const holdingFlag = join(tempDir, "holding");
    const releaseFlag = join(tempDir, "release");
    const contenderStarted = join(tempDir, "contender-started");
    const env = { ...process.env, PLANNOTATOR_DATA_DIR: tempDir };

    const holder = Bun.spawn(["bun", "run", scriptPath], {
      env: { ...env, TEST_KEY: "holder", TEST_HOLD_UNTIL: releaseFlag, TEST_HOLDING_FLAG: holdingFlag },
      stderr: "pipe",
      stdout: "pipe",
    });
    await waitForFile(holdingFlag);

    const contender = Bun.spawn(["bun", "run", scriptPath], {
      env: { ...env, TEST_KEY: "contender", TEST_HOLDING_FLAG: contenderStarted },
      stderr: "pipe",
      stdout: "pipe",
    });
    // The contender is running and can only be inside acquire: nothing else in
    // that script blocks. Release the holder and let both finish.
    await Bun.sleep(150);
    writeFileSync(releaseFlag, "1");

    expect(await holder.exited).toBe(0);
    expect(await contender.exited).toBe(0);

    const prompts = loadConfig().prompts as Record<string, unknown> | undefined;
    expect(prompts?.holder).toBe("v");
    expect(prompts?.contender).toBe("v");
  }, 20_000);
});

async function waitForFile(path: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (existsSync(path)) return;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

describe("resolveGuideShareUrl", () => {
  test("defaults to guides.show; config key is honored; env wins", () => {
    expect(resolveGuideShareUrl({}, {})).toBe(DEFAULT_GUIDE_SHARE_URL);
    expect(resolveGuideShareUrl({ guideShareUrl: "https://guides.example.test" }, {})).toBe("https://guides.example.test");
    expect(resolveGuideShareUrl({ guideShareUrl: "https://guides.example.test" }, { PLANNOTATOR_GUIDE_SHARE_URL: "http://localhost:8788" })).toBe("http://localhost:8788");
    // An empty (but set) env var counts as unset.
    expect(resolveGuideShareUrl({ guideShareUrl: "https://guides.example.test" }, { PLANNOTATOR_GUIDE_SHARE_URL: "" })).toBe("https://guides.example.test");
  });

  test("trailing slashes, query and fragment are trimmed so /api/g can be appended", () => {
    expect(resolveGuideShareUrl({}, { PLANNOTATOR_GUIDE_SHARE_URL: "https://guides.example.test/" })).toBe("https://guides.example.test");
    expect(resolveGuideShareUrl({}, { PLANNOTATOR_GUIDE_SHARE_URL: "https://guides.example.test/sub/dir//?x=1#frag" })).toBe("https://guides.example.test/sub/dir");
    expect(resolveGuideShareUrl({}, { PLANNOTATOR_GUIDE_SHARE_URL: "  https://guides.example.test  " })).toBe("https://guides.example.test");
  });

  test("non-http(s) or unparsable values warn once and fall back to the default", () => {
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    try {
      for (const v of ["ftp://guides.example.test", "javascript:alert(1)", "not a url", "guides.example.test"]) {
        expect(resolveGuideShareUrl({}, { PLANNOTATOR_GUIDE_SHARE_URL: v })).toBe(DEFAULT_GUIDE_SHARE_URL);
        expect(resolveGuideShareUrl({ guideShareUrl: v }, {})).toBe(DEFAULT_GUIDE_SHARE_URL);
      }
      expect(resolveGuideShareUrl({ guideShareUrl: 42 as unknown as string }, {})).toBe(DEFAULT_GUIDE_SHARE_URL);
    } finally {
      spy.mockRestore();
    }
    const warnings = writes.filter((w) => w.includes("invalid guide share URL"));
    // Once per distinct value, not once per call.
    expect(warnings.length).toBe(4);
  });
});

describe("resolveSharingEnabled", () => {
  test("env wins over config; default enabled", () => {
    expect(resolveSharingEnabled({}, {})).toBe(true);
    expect(resolveSharingEnabled({ share: "disabled" }, {})).toBe(false);
    expect(resolveSharingEnabled({ share: "disabled" }, { PLANNOTATOR_SHARE: "enabled" })).toBe(true);
    expect(resolveSharingEnabled({}, { PLANNOTATOR_SHARE: "disabled" })).toBe(false);
  });
});
