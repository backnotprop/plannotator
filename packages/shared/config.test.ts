import { describe, expect, test, beforeEach, afterEach, afterAll, spyOn } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  chmodSync,
  symlinkSync,
  lstatSync,
  renameSync,
  statSync,
} from "node:fs";
import * as nodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveAIEnabled,
  resolveClaudeSandbox,
  resolveCursorSandbox,
  resolveGitRemoteCheck,
  resolveUseGlimpse,
  resolveAnnotateHistory,
  resolveGuideHistory,
  resolveReviewProgress,
  resolveAgentTool,
  resolveExperimental,
  parseExperimentalEnv,
  agentToolHostOf,
  agentToolSaveFailed,
  AGENT_TOOL_DEFAULTS,
  resolveUseJina,
  resolveTodoProviderEnabled,
  resolvePublicUrl,
  resolveUrlHost,
  isValidPublicUrl,
  isValidUrlHost,
  parseReviewAnalysisConfig,
  loadConfig,
  saveConfig,
  getServerConfig,
  resolveGuideShareUrl,
  resolveForgejoToken,
  resolveSharingEnabled,
  resolveDefaultDiffType,
  resolveDefaultDiffTypeFor,
  resolveInboxLaunch,
  DEFAULT_GUIDE_SHARE_URL,
  __setConfigLockTimingsForTest,
  __setConfigSaveMergeWindowHookForTest,
  __setConfigWriteForTest,
  __setConfigReadForTest,
} from "./config";
import type { PlannotatorConfig } from "./config";

describe("resolveInboxLaunch", () => {
  test("on unless enabled is false; the model only when it is a plain model name, never settings of another shape", () => {
    // fullPermissions null: never set (a launch follows the login shell); a value once set, either way.
    expect(resolveInboxLaunch({}, "darwin")).toEqual({ enabled: true, fullPermissions: null, model: null, settingsFile: null, scratchDir: null, startIn: "inbox" });
    // Absent is on (0.29's default) on macOS and Linux; an explicit false, as Settings → Agents' switch writes it, is off.
    const on = (config: unknown, platform: NodeJS.Platform = "linux") => resolveInboxLaunch(config as PlannotatorConfig, platform).enabled;
    expect(on({ inboxLaunch: {} })).toBe(true);
    expect(on({ inboxLaunch: { fullPermissions: true } })).toBe(true);
    expect(on({ inboxLaunch: { enabled: "nonsense" } })).toBe(true);
    // Every false-like hand edit is off, in `enabled` or as `inboxLaunch` itself.
    for (const off of [false, 0, "false", "0", "off", "OFF", " no "]) {
      expect(on({ inboxLaunch: { enabled: off } })).toBe(false);
      expect(on({ inboxLaunch: off })).toBe(false);
    }
    expect(on({ inboxLaunch: { enabled: "on" } })).toBe(true);
    // Windows has no launch support: off unless explicitly on.
    expect(on({}, "win32")).toBe(false);
    expect(on({ inboxLaunch: { fullPermissions: true } }, "win32")).toBe(false);
    expect(on({ inboxLaunch: { enabled: true } }, "win32")).toBe(true);
    expect(resolveInboxLaunch({ inboxLaunch: { enabled: true, model: "haiku" } })).toEqual({ enabled: true, fullPermissions: null, model: "haiku", settingsFile: null, scratchDir: null, startIn: "inbox" });
    // Rex only when it says exactly that: anything else starts in the background.
    expect(resolveInboxLaunch({ inboxLaunch: { startIn: "rex" } }).startIn).toBe("rex");
    for (const startIn of ["REX", "inbox", true, 1, null]) expect(resolveInboxLaunch({ inboxLaunch: { startIn } } as unknown as PlannotatorConfig).startIn).toBe("inbox");
    expect(resolveInboxLaunch({ inboxLaunch: { fullPermissions: false } }).fullPermissions).toBe(false);
    expect(resolveInboxLaunch({ inboxLaunch: { fullPermissions: true } }).fullPermissions).toBe(true);
    expect(resolveInboxLaunch({ inboxLaunch: { model: "opus[1m]" } }).model).toBe("opus[1m]");
    for (const model of ["haiku --dangerously-skip-permissions", "a\"b", "", { hooks: {} }, "x".repeat(65)]) {
      expect(resolveInboxLaunch({ inboxLaunch: { model } } as unknown as PlannotatorConfig).model).toBeNull();
    }
  });

  test("the scratch root only as an absolute path other than /; a relative path or / is the default", () => {
    expect(resolveInboxLaunch({ inboxLaunch: { scratchDir: "/tmp/scratch/../work" } }).scratchDir).toBe("/tmp/work");
    for (const scratchDir of ["scratch", "~/scratch", "", "/", "//", 42]) {
      expect(resolveInboxLaunch({ inboxLaunch: { scratchDir } } as unknown as PlannotatorConfig).scratchDir).toBeNull();
    }
  });
});

describe("resolveDefaultDiffType", () => {
  test("accepts local-vs-remote as a persisted review default", () => {
    expect(resolveDefaultDiffType({
      diffOptions: { defaultDiffType: "local-vs-remote" },
    })).toBe("local-vs-remote");
  });
});

describe("resolveDefaultDiffTypeFor", () => {
  test("Git and Jujutsu each open on their own saved default", () => {
    const config: PlannotatorConfig = {
      diffOptions: { defaultDiffType: "merge-base" },
      reviewDefaults: { jj: { defaultDiffType: "jj-line" } },
    };
    expect(resolveDefaultDiffTypeFor(config, "git")).toBe("merge-base");
    expect(resolveDefaultDiffTypeFor(config, "jj")).toBe("jj-line");
    // No detected VCS (and GitButler) read the Git default.
    expect(resolveDefaultDiffTypeFor(config, undefined)).toBe("merge-base");
    expect(resolveDefaultDiffTypeFor(config, "gitbutler")).toBe("merge-base");
  });

  test("a config saved before jj defaults opens jj on jj-current and keeps Git's value", () => {
    const legacy = { diffOptions: { defaultDiffType: "branch" } } as unknown as PlannotatorConfig;
    expect(resolveDefaultDiffTypeFor(legacy, "git")).toBe("merge-base");
    expect(resolveDefaultDiffTypeFor(legacy, "jj")).toBe("jj-current");
    expect(resolveDefaultDiffTypeFor(undefined, "jj")).toBe("jj-current");
  });

  test("a Git mode or unknown id saved for jj opens on jj-current", () => {
    for (const bad of ["since-base", "merge-base", "jj-commit:abc", "nope"]) {
      expect(resolveDefaultDiffTypeFor({ reviewDefaults: { jj: { defaultDiffType: bad } } }, "jj")).toBe("jj-current");
    }
  });
});

describe("reviewDefaults persistence", () => {
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

  test("saving the jj default keeps Git's default and other VCS keys, and the server sends it", () => {
    saveConfig({ diffOptions: { defaultDiffType: "uncommitted" }, reviewDefaults: { other: { defaultDiffType: "x" } } });
    saveConfig({ reviewDefaults: { jj: { defaultDiffType: "jj-evolog" } } });
    const cfg = loadConfig();
    expect(cfg.diffOptions?.defaultDiffType).toBe("uncommitted");
    expect(cfg.reviewDefaults).toEqual({ other: { defaultDiffType: "x" }, jj: { defaultDiffType: "jj-evolog" } });
    expect(getServerConfig(null).reviewDefaults?.jj).toEqual({ defaultDiffType: "jj-evolog" });
  });
});

describe("annotateView (the view an annotate session opens in)", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plannotator-config-annotate-view-"));
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (originalDataDir !== undefined) process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
    else delete process.env.PLANNOTATOR_DATA_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const advertised = (raw: unknown): unknown => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ annotateView: raw }));
    return getServerConfig(null).annotateView;
  };

  test("each of the toolbar's three views is served to the page as written", () => {
    expect(advertised("wide")).toBe("wide");
    expect(advertised("focus")).toBe("focus");
    expect(advertised("edit")).toBe("edit");
  });

  test("a value the toolbar does not offer is left out, so the page keeps today's default", () => {
    for (const raw of ["Focus", " focus", "zen", "", 1, true, null, ["focus"], { view: "focus" }]) {
      expect(advertised(raw)).toBeUndefined();
    }
  });

  test("unset is left out", () => {
    writeFileSync(join(tempDir, "config.json"), JSON.stringify({ displayName: "x" }));
    expect("annotateView" in getServerConfig(null)).toBe(false);
  });
});

describe("parseReviewAnalysisConfig", () => {
  test("accepts independent boolean analysis flags", () => {
    expect(parseReviewAnalysisConfig({ semanticDiff: false })).toEqual({ semanticDiff: false });
    expect(parseReviewAnalysisConfig({ callFlow: true })).toEqual({ callFlow: true });
    expect(parseReviewAnalysisConfig({ semanticDiff: true, callFlow: false })).toEqual({ semanticDiff: true, callFlow: false });
  });

  test("rejects non-object and non-boolean settings", () => {
    expect(parseReviewAnalysisConfig(null)).toBeUndefined();
    expect(parseReviewAnalysisConfig([])).toBeUndefined();
    expect(parseReviewAnalysisConfig({ callFlow: 1 })).toBeUndefined();
    expect(parseReviewAnalysisConfig({ semanticDiff: "false" })).toBeUndefined();
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

describe("resolveClaudeSandbox (#1627)", () => {
  const CLAUDE_ENV = "PLANNOTATOR_CLAUDE_SANDBOX";
  const original = process.env[CLAUDE_ENV];
  beforeEach(() => {
    delete process.env[CLAUDE_ENV];
  });
  afterAll(() => {
    if (original === undefined) delete process.env[CLAUDE_ENV];
    else process.env[CLAUDE_ENV] = original;
  });

  test("defaults to true (defer to the user's Claude Code sandbox setting)", () => {
    expect(resolveClaudeSandbox({})).toBe(true);
  });

  test("config.claudeSandbox is honored when the env var is unset", () => {
    expect(resolveClaudeSandbox({ claudeSandbox: false })).toBe(false);
    expect(resolveClaudeSandbox({ claudeSandbox: true })).toBe(true);
  });

  test("env values 0 / false / disabled turn it off, and env wins over config", () => {
    for (const v of ["0", "false", "disabled", "FALSE"]) {
      process.env[CLAUDE_ENV] = v;
      expect(resolveClaudeSandbox({ claudeSandbox: true })).toBe(false);
    }
    process.env[CLAUDE_ENV] = "1";
    expect(resolveClaudeSandbox({ claudeSandbox: false })).toBe(true);
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
      name: "resolveReviewProgress",
      envVar: "PLANNOTATOR_REVIEW_PROGRESS",
      key: "reviewProgress",
      resolve: (config) => resolveReviewProgress(config),
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
    {
      name: "resolveClaudeSandbox",
      envVar: "PLANNOTATOR_CLAUDE_SANDBOX",
      key: "claudeSandbox",
      resolve: resolveClaudeSandbox,
    },
    {
      name: "resolveGitRemoteCheck",
      envVar: "PLANNOTATOR_GIT_REMOTE_CHECK",
      key: "gitRemoteCheck",
      resolve: (config) => resolveGitRemoteCheck(false, config),
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

describe("resolveReviewProgress env handling", () => {
  test("off/on vocabulary wins over the config key", () => {
    for (const v of ["0", "false", "FALSE", "off", "disabled", " false "]) {
      expect(resolveReviewProgress({ reviewProgress: true }, { PLANNOTATOR_REVIEW_PROGRESS: v })).toBe(false);
    }
    for (const v of ["1", "true", "on"]) {
      expect(resolveReviewProgress({ reviewProgress: false }, { PLANNOTATOR_REVIEW_PROGRESS: v })).toBe(true);
    }
  });

  test("an empty-but-set env var counts as unset, so the config key decides", () => {
    expect(resolveReviewProgress({ reviewProgress: false }, { PLANNOTATOR_REVIEW_PROGRESS: "" })).toBe(false);
    expect(resolveReviewProgress({}, { PLANNOTATOR_REVIEW_PROGRESS: "" })).toBe(true);
  });
});

describe("resolveAgentTool", () => {
  // The failure this guards: a user who turned the tool on (or off) gets the
  // other answer, so the agent's tool list does not match their setting.
  test("unset: the host's default (owner's call: on for the Claude Code mod and Oh My Pi, off on Pi, OpenCode 2 and DeepSeek Harness)", () => {
    expect(AGENT_TOOL_DEFAULTS).toEqual({ "claude-code": true, pi: false, "oh-my-pi": true, opencode: false, dsh: false });
    for (const host of ["claude-code", "pi", "oh-my-pi", "opencode", "dsh"] as const) {
      expect(resolveAgentTool({}, {}, host)).toBe(AGENT_TOOL_DEFAULTS[host]);
      // An empty or unrecognized env value counts as unset.
      expect(resolveAgentTool({}, { PLANNOTATOR_AGENT_TOOL: "" }, host)).toBe(AGENT_TOOL_DEFAULTS[host]);
      expect(resolveAgentTool({}, { PLANNOTATOR_AGENT_TOOL: "yes" }, host)).toBe(AGENT_TOOL_DEFAULTS[host]);
    }
  });

  test("config.json overrides the host default in both directions", () => {
    expect(resolveAgentTool({ agentTool: true }, {}, "pi")).toBe(true);
    expect(resolveAgentTool({ agentTool: "1" as never }, {}, "opencode")).toBe(true);
    expect(resolveAgentTool({ agentTool: false }, {}, "claude-code")).toBe(false);
    expect(resolveAgentTool({ agentTool: "false" as never }, {}, "claude-code")).toBe(false);
    expect(resolveAgentTool({ agentTool: "nope" as never }, {}, "pi")).toBe(false);
  });

  // Oh My Pi defaults on, but an explicit choice still decides there, both ways.
  test("Oh My Pi: config.json and the env var override its default in both directions", () => {
    expect(resolveAgentTool({}, {}, "oh-my-pi")).toBe(true);
    expect(resolveAgentTool({ agentTool: false }, {}, "oh-my-pi")).toBe(false);
    expect(resolveAgentTool({}, { PLANNOTATOR_AGENT_TOOL: "0" }, "oh-my-pi")).toBe(false);
    expect(resolveAgentTool({ agentTool: true }, { PLANNOTATOR_AGENT_TOOL: "off" }, "oh-my-pi")).toBe(false);
    expect(resolveAgentTool({ agentTool: false }, { PLANNOTATOR_AGENT_TOOL: "1" }, "oh-my-pi")).toBe(true);
    // Plain Pi keeps its default: off.
    expect(resolveAgentTool({}, {}, "pi")).toBe(false);
  });

  test("the env var wins over agentTool in config.json, in both directions", () => {
    for (const v of ["0", "false", "OFF", "disabled", " off "]) {
      expect(resolveAgentTool({ agentTool: true }, { PLANNOTATOR_AGENT_TOOL: v }, "claude-code")).toBe(false);
    }
    for (const v of ["1", "true", "On"]) {
      expect(resolveAgentTool({ agentTool: false }, { PLANNOTATOR_AGENT_TOOL: v }, "pi")).toBe(true);
    }
  });

  test("only the tool hosts name one", () => {
    expect(agentToolHostOf("claude-code")).toBe("claude-code");
    expect(agentToolHostOf("pi")).toBe("pi");
    // The Pi extension's in-process servers name their host, Pi or Oh My Pi.
    expect(agentToolHostOf("oh-my-pi")).toBe("oh-my-pi");
    expect(agentToolHostOf("opencode")).toBe("opencode");
    expect(agentToolHostOf("codex")).toBeNull();
    expect(agentToolHostOf(undefined)).toBeNull();
  });
});

// What a later Settings toggle / "turn the tool on" offer reads: the
// effective value for the session's host, whether the file decided it, and
// an env override that a toggle cannot change.
describe("getServerConfig agent tool advert", () => {
  const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  const savedEnv = process.env.PLANNOTATOR_AGENT_TOOL;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plannotator-agent-tool-advert-"));
    process.env.PLANNOTATOR_DATA_DIR = dir;
    delete process.env.PLANNOTATOR_AGENT_TOOL;
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
    if (savedEnv === undefined) delete process.env.PLANNOTATOR_AGENT_TOOL;
    else process.env.PLANNOTATOR_AGENT_TOOL = savedEnv;
    rmSync(dir, { recursive: true, force: true });
  });

  test("unset: the host default, marked not configured; no host, nothing", () => {
    expect(getServerConfig(null, "pi")).toMatchObject({ agentTool: false, agentToolConfigured: false, agentToolHost: "pi", agentToolEnabled: false });
    expect(getServerConfig(null, "claude-code")).toMatchObject({ agentTool: true, agentToolConfigured: false, agentToolHost: "claude-code", agentToolEnabled: true });
    // Oh My Pi: on by default, so the Settings row shows it on and the one-time offer has nothing to offer.
    expect(getServerConfig(null, "oh-my-pi")).toMatchObject({ agentTool: true, agentToolConfigured: false, agentToolHost: "oh-my-pi", agentToolEnabled: true });
    const codex = getServerConfig(null, "codex");
    expect([codex.agentTool, codex.agentToolHost, codex.agentToolEnabled]).toEqual([undefined, undefined, undefined]);
  });

  test("a saved choice is reported, and an env override is reported beside it", () => {
    saveConfig({ agentTool: true });
    expect(getServerConfig(null, "opencode")).toMatchObject({ agentTool: true, agentToolConfigured: true, agentToolEnabled: true });
    expect(getServerConfig(null, "opencode").agentToolEnv).toBeUndefined();
    process.env.PLANNOTATOR_AGENT_TOOL = "0";
    expect(getServerConfig(null, "opencode")).toMatchObject({ agentTool: true, agentToolEnv: false, agentToolEnabled: false });
  });

  test("agentToolSaveFailed tells a write that reached config.json from one that did not", () => {
    saveConfig({ agentTool: true });
    expect(agentToolSaveFailed({ agentTool: true })).toBe(false);
    expect(agentToolSaveFailed({ displayName: "x" } as { agentTool?: unknown })).toBe(false);
    // A data dir that is a file: saveConfig logs and returns, nothing is written.
    const blocker = join(dir, "not-a-dir");
    writeFileSync(blocker, "");
    process.env.PLANNOTATOR_DATA_DIR = blocker;
    const savedWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      saveConfig({ agentTool: true });
    } finally {
      process.stderr.write = savedWrite;
    }
    expect(agentToolSaveFailed({ agentTool: true })).toBe(true);
  });
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
    saveConfig({ favicon: "yellow" });
    expect(loadConfig().favicon).toBe("yellow");
    expect(getServerConfig(null).favicon).toBe("yellow");

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

  test("a 'classic' left by 0.28.57 (the removed P icon) reads as unset and stays in the file", () => {
    saveConfig({ favicon: "classic" as unknown as PlannotatorConfig["favicon"] });
    expect(getServerConfig(null).favicon).toBeUndefined();
    expect(loadConfig().favicon as string).toBe("classic");
  });
});

describe("saveConfig never writes over a config.json it could not read", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let tempDir: string;
  let warnings: string[];
  let savedWrite: typeof process.stderr.write;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "plannotator-config-refuse-"));
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
    warnings = [];
    savedWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    __setConfigWriteForTest(null);
    process.stderr.write = savedWrite;
    if (originalDataDir !== undefined) process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
    else delete process.env.PLANNOTATOR_DATA_DIR;
    rmSync(tempDir, { recursive: true, force: true });
  });

  const configPath = () => join(tempDir, "config.json");
  const raw = () => readFileSync(configPath(), "utf-8");

  test("a missing config.json is created, as before", () => {
    expect(saveConfig({ displayName: "first" })).toBe(true);
    expect(loadConfig().displayName).toBe("first");
    expect(warnings).toEqual([]);
  });

  test("an empty config.json (zero bytes or only whitespace) holds nothing to lose: it reads as defaults and a save writes it", () => {
    for (const bytes of ["", "  \n"]) {
      writeFileSync(configPath(), bytes);
      expect(loadConfig()).toEqual({});
      warnings = [];
      expect(saveConfig({ displayName: "x" })).toBe(true);
      expect(JSON.parse(raw())).toEqual({ displayName: "x" });
      expect(warnings).toEqual([]);
    }
  });

  test("a save whose rename fails leaves config.json byte for byte, says so, and leaves no temp file", () => {
    const bytes = JSON.stringify({ displayName: "Ada", theme: { mode: "dark" }, favicon: "yellow" }, null, 2) + "\n";
    writeFileSync(configPath(), bytes);
    // ENOSPC stands in for a disk that filled up; EPERM for a lock that never lets go.
    for (const code of ["ENOSPC", "EPERM"]) {
      let calls = 0;
      const waits: number[] = [];
      let lockHeldWhileWaiting = true;
      __setConfigWriteForTest({
        rename: () => {
          calls++;
          throw Object.assign(new Error(`${code}: simulated`), { code });
        },
        sleep: (ms) => {
          waits.push(ms);
          lockHeldWhileWaiting &&= existsSync(join(tempDir, "config.json.lock"));
        },
      });
      try {
        warnings = [];
        expect(saveConfig({ displayName: "Grace" })).toBe(false);
      } finally {
        __setConfigWriteForTest(null);
      }
      expect(raw()).toBe(bytes);
      expect(warnings.join("")).toContain("failed to write config.json");
      expect(readdirSync(tempDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      // A disk error is not retried; a Windows lock error is, with backoff, for about 2 s, under the config lock.
      const waited = waits.reduce((a, b) => a + b, 0);
      if (code === "ENOSPC") {
        expect(calls).toBe(1);
        expect(waits).toEqual([]);
      } else {
        expect(calls).toBe(waits.length + 1);
        expect(waited).toBeGreaterThanOrEqual(1800);
        expect(waited).toBeLessThanOrEqual(2500);
        expect(waits[0]).toBeLessThan(waits[waits.length - 1]);
        expect(lockHeldWhileWaiting).toBe(true);
      }
    }
    expect(loadConfig()).toMatchObject({ displayName: "Ada", theme: { mode: "dark" }, favicon: "yellow" });
  });

  test("a rename held for a while by another program (Windows) is retried and lands", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    let calls = 0;
    __setConfigWriteForTest({
      rename: (from, to) => {
        if (++calls <= 6) throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
        renameSync(from, to);
      },
      sleep: () => {},
    });
    try {
      expect(saveConfig({ favicon: "yellow" })).toBe(true);
    } finally {
      __setConfigWriteForTest(null);
    }
    expect(JSON.parse(raw())).toEqual({ displayName: "Ada", favicon: "yellow" });
    expect(warnings).toEqual([]);
  });

  test("an fsync error (a full disk or quota that shows up only there) stops the write before the rename; only 'no fsync here' is ignored", () => {
    const bytes = JSON.stringify({ displayName: "Ada", theme: { mode: "dark" } });
    writeFileSync(configPath(), bytes);
    for (const code of ["ENOSPC", "EDQUOT", "EIO"]) {
      let renamed = false;
      __setConfigWriteForTest({
        fsync: () => {
          throw Object.assign(new Error(`${code}: simulated`), { code });
        },
        rename: (from, to) => {
          renamed = true;
          renameSync(from, to);
        },
      });
      try {
        warnings = [];
        expect(saveConfig({ displayName: "Grace" })).toBe(false);
      } finally {
        __setConfigWriteForTest(null);
      }
      expect(renamed).toBe(false);
      expect(raw()).toBe(bytes);
      expect(warnings.join("")).toContain(code);
      expect(readdirSync(tempDir).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    }
    for (const [code, favicon] of [["EINVAL", "yellow"], ["ENOTSUP", "blue"]]) {
      __setConfigWriteForTest({
        fsync: () => {
          throw Object.assign(new Error(`${code}: simulated`), { code });
        },
      });
      try {
        expect(saveConfig({ favicon } as Partial<PlannotatorConfig>)).toBe(true);
      } finally {
        __setConfigWriteForTest(null);
      }
      expect(JSON.parse(raw()).favicon).toBe(favicon);
    }
    expect(JSON.parse(raw())).toEqual({ displayName: "Ada", theme: { mode: "dark" }, favicon: "blue" });
  });

  test("a folder that is not writable: the save fails and config.json keeps its bytes (never written in place)", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const bytes = JSON.stringify({ displayName: "Ada", theme: { mode: "dark" } });
    writeFileSync(configPath(), bytes);
    chmodSync(tempDir, 0o555);
    try {
      expect(saveConfig({ displayName: "Grace" })).toBe(false);
    } finally {
      chmodSync(tempDir, 0o700);
    }
    expect(raw()).toBe(bytes);
    expect(warnings.join("")).toContain("failed to write config.json");
  });

  test("a symlinked config.json in a folder that is not writable still saves: the temp file goes beside the link's target", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const dotfiles = mkdtempSync(join(tmpdir(), "plannotator-config-dotfiles-"));
    try {
      const target = join(dotfiles, "config.json");
      writeFileSync(target, JSON.stringify({ displayName: "Ada" }));
      symlinkSync(target, configPath());
      chmodSync(tempDir, 0o555);
      try {
        expect(saveConfig({ favicon: "yellow" })).toBe(true);
      } finally {
        chmodSync(tempDir, 0o700);
      }
      expect(lstatSync(configPath()).isSymbolicLink()).toBe(true);
      expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ displayName: "Ada", favicon: "yellow" });
      expect(readdirSync(dotfiles)).toEqual(["config.json"]);
    } finally {
      rmSync(dotfiles, { recursive: true, force: true });
    }
  });

  test("config.json that is not valid JSON is kept byte for byte, and the save says so", () => {
    // A hand edit with a trailing comma: every setting in it would be lost if the save merged onto {}.
    const bytes = '{\n  "theme": { "mode": "dark", "dark": "tokyo-night" },\n  "displayName": "Ada",\n}\n';
    writeFileSync(configPath(), bytes);
    expect(saveConfig({ inboxTour: { version: 1, seen_at: "2026-10-25T00:00:00.000Z", finished_at: null, skipped_at: null, notify_again: false } } as Partial<PlannotatorConfig>)).toBe(false);
    expect(raw()).toBe(bytes);
    expect(warnings.join("")).toContain("not valid JSON");
    expect(warnings.join("")).toContain("Fix or remove");
    // Nothing moved aside: the file stays where every reader looks.
    expect(readdirSync(tempDir).filter((n) => n.startsWith("config.json"))).toEqual(["config.json"]);
  });

  test("config.json that is JSON but not an object is kept too", () => {
    for (const bytes of ['["theme"]', '"dark"', "42", "null"]) {
      writeFileSync(configPath(), bytes);
      expect(saveConfig({ displayName: "x" })).toBe(false);
      expect(raw()).toBe(bytes);
    }
  });

  test("an unreadable config.json is kept", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const bytes = '{"theme":{"mode":"dark"}}';
    writeFileSync(configPath(), bytes);
    chmodSync(configPath(), 0o000);
    try {
      expect(saveConfig({ displayName: "x" })).toBe(false);
      expect(warnings.join("")).toContain("could not be read");
    } finally {
      chmodSync(configPath(), 0o600);
    }
    expect(raw()).toBe(bytes);
  });

  test("a UTF-8 BOM (Notepad's “UTF-8 with BOM”) is read, and a save keeps every setting", () => {
    writeFileSync(configPath(), '﻿{"displayName":"Ada","theme":{"mode":"dark"}}');
    expect(loadConfig().displayName).toBe("Ada");
    expect(saveConfig({ favicon: "yellow" })).toBe(true);
    expect(loadConfig()).toMatchObject({ displayName: "Ada", theme: { mode: "dark" }, favicon: "yellow" });
  });

  test("a hand-edited value a save does not name is kept verbatim, whatever it holds", () => {
    writeFileSync(configPath(), JSON.stringify({ experimental: true, theme: "dark", diffOptions: "unified", prompts: 7 }));
    expect(saveConfig({ displayName: "x" })).toBe(true);
    expect(JSON.parse(raw())).toEqual({ experimental: true, theme: "dark", diffOptions: "unified", prompts: 7, displayName: "x" });
  });

  test("a save that names a key holding a non-object replaces it; it is never spread into characters", () => {
    writeFileSync(configPath(), JSON.stringify({ theme: "dark", experimental: true, diffOptions: { diffStyle: "split", hideWhitespace: true } }));
    expect(saveConfig({ theme: { mode: "light" }, experimental: { decisionMode: true }, diffOptions: { diffStyle: "unified" } } as Partial<PlannotatorConfig>)).toBe(true);
    expect(JSON.parse(raw())).toEqual({ theme: { mode: "light" }, experimental: { decisionMode: true }, diffOptions: { diffStyle: "unified", hideWhitespace: true } });
  });

  test("a config.json that is a folder is refused, not replaced", () => {
    mkdirSync(configPath());
    expect(saveConfig({ displayName: "x" })).toBe(false);
    expect(existsSync(join(configPath()))).toBe(true);
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
      (async () => saveConfig({ favicon: "yellow" }))(),
    ]);
    const cfg = loadConfig();
    expect(cfg.displayName).toBe("a");
    expect(cfg.conventionalComments).toBe(true);
    expect(cfg.favicon).toBe("yellow");
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

/**
 * `--no-git-remote-check` / PLANNOTATOR_GIT_REMOTE_CHECK / config.gitRemoteCheck (#1553).
 * Guards the precedence order itself: this is the switch that decides whether
 * a review session may touch the network at all, and getting the order wrong
 * means either an opt-out that silently does nothing (the user still gets a
 * hardware-key prompt per probe) or an env var that overrides an explicit
 * command-line flag.
 */
describe("resolveGitRemoteCheck precedence", () => {
  const ENV_VAR = "PLANNOTATOR_GIT_REMOTE_CHECK";

  const cases: Array<{
    label: string;
    cli: boolean;
    env?: string;
    config: PlannotatorConfig;
    expected: boolean;
  }> = [
    { label: "nothing set → on", cli: false, config: {}, expected: true },
    { label: "config false → off", cli: false, config: { gitRemoteCheck: false }, expected: false },
    { label: "config true → on", cli: false, config: { gitRemoteCheck: true }, expected: true },
    { label: "env 0 → off", cli: false, env: "0", config: {}, expected: false },
    { label: "env false → off", cli: false, env: "false", config: {}, expected: false },
    { label: "env disabled → off", cli: false, env: "disabled", config: {}, expected: false },
    { label: "env FALSE (case) → off", cli: false, env: "FALSE", config: {}, expected: false },
    { label: "env 1 → on", cli: false, env: "1", config: {}, expected: true },
    { label: "env garbage → on", cli: false, env: "maybe", config: {}, expected: true },
    { label: "env beats config false", cli: false, env: "1", config: { gitRemoteCheck: false }, expected: true },
    { label: "env beats config true", cli: false, env: "0", config: { gitRemoteCheck: true }, expected: false },
    { label: "CLI flag beats env on", cli: true, env: "1", config: {}, expected: false },
    { label: "CLI flag beats config true", cli: true, config: { gitRemoteCheck: true }, expected: false },
  ];

  for (const c of cases) {
    test(c.label, () => {
      const env: NodeJS.ProcessEnv = c.env === undefined ? {} : { [ENV_VAR]: c.env };
      expect(resolveGitRemoteCheck(c.cli, c.config, env)).toBe(c.expected);
    });
  }

  test("reads process.env by default", () => {
    const original = process.env[ENV_VAR];
    try {
      process.env[ENV_VAR] = "0";
      expect(resolveGitRemoteCheck(false, {})).toBe(false);
    } finally {
      if (original === undefined) delete process.env[ENV_VAR];
      else process.env[ENV_VAR] = original;
    }
  });
});

// Experimental features (approval "inbox-decision-mode"): off unless switched on,
// PLANNOTATOR_EXPERIMENTAL decides over config.json, and saving one flag keeps the others.
describe("experimental features", () => {
  const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plannotator-experimental-"));
    process.env.PLANNOTATOR_DATA_DIR = dir;
  });
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
    rmSync(dir, { recursive: true, force: true });
  });

  test("off by default; config.json turns it on; the env var decides both ways", () => {
    expect(resolveExperimental({}, "decision-mode", {})).toBe(false);
    expect(resolveExperimental({ experimental: { decisionMode: true } }, "decision-mode", {})).toBe(true);
    expect(resolveExperimental({ experimental: { decisionMode: "true" as unknown as boolean } }, "decision-mode", {})).toBe(true);
    expect(resolveExperimental({ experimental: [] as unknown as { decisionMode?: boolean } }, "decision-mode", {})).toBe(false);
    expect(resolveExperimental({}, "decision-mode", { PLANNOTATOR_EXPERIMENTAL: "x, Decision-Mode" })).toBe(true);
    expect(resolveExperimental({ experimental: { decisionMode: true } }, "decision-mode", { PLANNOTATOR_EXPERIMENTAL: "-decision-mode" })).toBe(false);
    expect(resolveExperimental({ experimental: { decisionMode: true } }, "decision-mode", { PLANNOTATOR_EXPERIMENTAL: "something-else" })).toBe(true);
    expect(parseExperimentalEnv("decision-mode", { PLANNOTATOR_EXPERIMENTAL: "" })).toBeUndefined();
  });

  test("saving one flag keeps the other experimental keys", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ experimental: { otherFlag: true } }));
    saveConfig({ experimental: { decisionMode: true } });
    expect(loadConfig().experimental).toEqual({ otherFlag: true, decisionMode: true } as unknown as { decisionMode?: boolean });
    saveConfig({ inboxTextSize: 13 });
    expect(loadConfig().experimental).toEqual({ otherFlag: true, decisionMode: true } as unknown as { decisionMode?: boolean });
  });

  test("inboxLaunch merges key by key: Settings → Agents' switches, saved one key each, never undo one another", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ inboxLaunch: { fullPermissions: true, model: "haiku" } }));
    saveConfig({ inboxLaunch: { enabled: false } });
    saveConfig({ inboxLaunch: { scratchDir: "/tmp/scratch-root" } });
    expect(loadConfig().inboxLaunch).toEqual({ fullPermissions: true, model: "haiku", enabled: false, scratchDir: "/tmp/scratch-root" });
    // Back to the default folder: the key goes.
    saveConfig({ inboxLaunch: { scratchDir: undefined } as { scratchDir?: string } });
    expect(loadConfig().inboxLaunch).toEqual({ fullPermissions: true, model: "haiku", enabled: false });
    // A hand-written non-object is replaced, never spread into characters.
    writeFileSync(join(dir, "config.json"), JSON.stringify({ inboxLaunch: "off" }));
    saveConfig({ inboxLaunch: { enabled: true } });
    expect(loadConfig().inboxLaunch).toEqual({ enabled: true });
  });

  test("a hand-edited experimental value that is not an object is replaced, never spread", () => {
    for (const bad of ["on", ["decisionMode"], 7, null]) {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ experimental: bad }));
      saveConfig({ experimental: { decisionMode: true } });
      expect(loadConfig().experimental).toEqual({ decisionMode: true });
    }
  });

  // The usage counts were removed (approval "remove-usage-counts"); v0.28.33's
  // hidden `plannotator telemetry --off` could write `usageCounts`. Such a file
  // still loads quietly, its flags still work, and a save leaves the old keys be.
  test("a config.json with the removed usage-count keys loads with no warning and keeps them on save", () => {
    writeFileSync(join(dir, "config.json"), JSON.stringify({ experimental: { decisionMode: true }, usageCounts: false, usageCountsNotice: { decisionMode: 1 } }));
    const warn = spyOn(process.stderr, "write");
    try {
      expect(resolveExperimental(loadConfig(), "decision-mode", {})).toBe(true);
      saveConfig({ inboxTextSize: 13 });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"))).toMatchObject({ usageCounts: false, usageCountsNotice: { decisionMode: 1 }, inboxTextSize: 13 });
  });
});

describe("machine state lives in state.json, not config.json (#2852)", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
  let root: string;
  let tempDir: string;
  let warnings: string[];
  let warn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plannotator-config-state-"));
    tempDir = join(root, "data");
    mkdirSync(tempDir);
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
    warnings = [];
    warn = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    warn.mockRestore();
    __setConfigSaveMergeWindowHookForTest(null);
    if (originalDataDir !== undefined) process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
    else delete process.env.PLANNOTATOR_DATA_DIR;
    chmodSync(root, 0o700);
    for (const name of readdirSync(root)) chmodSync(join(root, name), 0o700);
    rmSync(root, { recursive: true, force: true });
  });

  const configPath = () => join(tempDir, "config.json");
  const statePath = () => join(tempDir, "state.json");
  const json = (file: string) => JSON.parse(readFileSync(file, "utf-8"));
  /** Both files as given (state.json only when given). */
  const seed = (config: Record<string, unknown>, state?: Record<string, unknown>) => {
    writeFileSync(configPath(), JSON.stringify(config));
    if (state) writeFileSync(statePath(), JSON.stringify(state));
  };

  test("a dialog record lands in state.json and config.json keeps only settings", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }, null, 2) + "\n");
    expect(saveConfig({ inboxListIntro: { dueAt: "2026-11-05T00:00:00.000Z" }, inboxReveals: { lastShownAt: "2026-11-06T00:00:00.000Z" } })).toBe(true);
    expect(saveConfig({ inboxSound: { enabled: false, dialogShownFor: "0.28.35" } })).toBe(true);
    expect(json(configPath())).toEqual({ displayName: "Ada", inboxSound: { enabled: false } });
    expect(json(statePath())).toEqual({
      inboxListIntro: { dueAt: "2026-11-05T00:00:00.000Z" },
      inboxReveals: { lastShownAt: "2026-11-06T00:00:00.000Z" },
      inboxSound: { dialogShownFor: "0.28.35" },
    });
    expect(loadConfig()).toMatchObject({ displayName: "Ada", inboxSound: { enabled: false, dialogShownFor: "0.28.35" } });
    expect(warnings).toEqual([]);
  });

  test("a fresh machine gets no config.json from a dialog record alone", () => {
    expect(saveConfig({ starAsk: { shownAt: "2026-11-06T00:00:00.000Z" } })).toBe(true);
    expect(existsSync(configPath())).toBe(false);
    expect(loadConfig().starAsk).toEqual({ shownAt: "2026-11-06T00:00:00.000Z" });
  });

  test("records an older version left in config.json are read, never removed, and config.json is never rewritten for them", () => {
    const bytes = JSON.stringify({
      theme: { mode: "dark" },
      inboxSnoozeIntro: { firstUseAt: "2026-10-29T00:00:00.000Z" },
      inboxTour: { version: 2, seen_at: "2026-10-01T00:00:00.000Z" },
      inboxSound: { volume: 30, dialogShownFor: "0.28.20" },
    });
    writeFileSync(configPath(), bytes);
    const before = lstatSync(configPath()).mtimeMs;
    expect(loadConfig()).toMatchObject({ inboxSnoozeIntro: { firstUseAt: "2026-10-29T00:00:00.000Z" }, inboxSound: { volume: 30, dialogShownFor: "0.28.20" } });

    expect(saveConfig({ inboxSnoozeIntro: { ...loadConfig().inboxSnoozeIntro, shownAt: "2026-11-07T00:00:00.000Z" } })).toBe(true);
    expect(saveConfig({ inboxSound: { ...loadConfig().inboxSound, dialogShownFor: "0.29.0" } })).toBe(true);
    // Both saves name only machine state (the sound's settings are unchanged), so config.json is never opened for
    // writing: no crash between two writes can leave it half moved.
    expect(readFileSync(configPath(), "utf-8")).toBe(bytes);
    expect(lstatSync(configPath()).mtimeMs).toBe(before);
    expect(json(statePath())).toEqual({
      inboxSnoozeIntro: { firstUseAt: "2026-10-29T00:00:00.000Z", shownAt: "2026-11-07T00:00:00.000Z" },
      inboxSound: { dialogShownFor: "0.29.0" },
    });
    expect(loadConfig().inboxSound).toEqual({ volume: 30, dialogShownFor: "0.29.0" });

    // A setting changed beside them: config.json is rewritten with the old records still in it.
    expect(saveConfig({ inboxSound: { ...loadConfig().inboxSound, volume: 40 } })).toBe(true);
    expect(json(configPath()).inboxSound).toEqual({ volume: 40, dialogShownFor: "0.28.20" });
    expect(json(configPath()).inboxTour).toEqual({ version: 2, seen_at: "2026-10-01T00:00:00.000Z" });
    expect(loadConfig().inboxSound).toEqual({ volume: 40, dialogShownFor: "0.29.0" });
  });

  test("two machines sharing one config.json: one saving its records takes nothing from the other, and a note choice is kept", () => {
    // The reporter's setup: config.json in a dotfiles repo, linked into each machine's data dir.
    const dotfiles = join(root, "dotfiles");
    mkdirSync(dotfiles);
    const shared = join(dotfiles, "config.json");
    writeFileSync(shared, JSON.stringify({
      displayName: "Ada",
      inboxAgentNotes: { offered: true, asked: ["codex", "gemini"] },
      inboxReveals: { lastShownAt: "2026-11-01T00:00:00.000Z", board: { shownAt: "2026-11-01T00:00:00.000Z" } },
      inboxSound: { dialogShownFor: "0.28.35" },
    }));
    const machineB = join(root, "machine-b");
    mkdirSync(machineB);
    symlinkSync(shared, configPath());
    symlinkSync(shared, join(machineB, "config.json"));
    const sharedBytes = readFileSync(shared, "utf-8");

    // Machine A: a new agent asked, a reveal stamped, the sound dialog shown for a new version.
    const notes = loadConfig().inboxAgentNotes!;
    expect(saveConfig({ inboxAgentNotes: { ...notes, asked: [...notes.asked!, "pi"] } })).toBe(true);
    expect(saveConfig({ inboxReveals: { ...loadConfig().inboxReveals, notNowAt: "2026-11-08T00:00:00.000Z" } })).toBe(true);
    expect(saveConfig({ inboxSound: { ...loadConfig().inboxSound, dialogShownFor: "0.29.0" } })).toBe(true);
    expect(readFileSync(shared, "utf-8")).toBe(sharedBytes);

    // Machine B (its own data dir, no state.json yet) still reads every record and choice from the shared file.
    process.env.PLANNOTATOR_DATA_DIR = machineB;
    const onB = loadConfig();
    expect(onB.inboxAgentNotes).toEqual({ offered: true, asked: ["codex", "gemini"] });
    expect(onB.inboxReveals?.board?.shownAt).toBe("2026-11-01T00:00:00.000Z");
    expect(onB.inboxSound).toEqual({ dialogShownFor: "0.28.35" });
  });

  test("an older version writing a record back to config.json after the move: the more protective copy wins, with no ping-pong", () => {
    // The new Inbox checked the star ask (still open) and asked about Codex.
    seed({}, { starAsk: { checkedAt: "2026-11-05T00:00:00.000Z" }, inboxAgentNotes: { offered: true, asked: ["codex"] } });
    // Then an older Pi extension showed the star ask and got Not now; a downgraded Inbox turned Gemini's note off.
    seed({
      starAsk: { shownAt: "2026-11-06T00:00:00.000Z", surface: "plan", answer: "not-now", answeredAt: "2026-11-06T00:00:01.000Z" },
      inboxAgentNotes: { offered: true, asked: ["gemini"] },
    });
    expect(loadConfig().starAsk).toMatchObject({ answer: "not-now", surface: "plan" });
    expect(loadConfig().inboxAgentNotes?.asked).toEqual(["codex", "gemini"]);
    // The new version saves the merged record back: state.json takes it, config.json stays as the older one wrote it.
    const configBytes = readFileSync(configPath(), "utf-8");
    expect(saveConfig({ inboxAgentNotes: loadConfig().inboxAgentNotes, starAsk: loadConfig().starAsk })).toBe(true);
    expect(json(statePath()).inboxAgentNotes.asked).toEqual(["codex", "gemini"]);
    expect(json(statePath()).starAsk.answer).toBe("not-now");
    expect(readFileSync(configPath(), "utf-8")).toBe(configBytes);
    expect(saveConfig({ inboxAgentNotes: loadConfig().inboxAgentNotes, starAsk: loadConfig().starAsk })).toBe(true);
    expect(loadConfig().inboxAgentNotes?.asked).toEqual(["codex", "gemini"]);
    expect(loadConfig().starAsk?.answer).toBe("not-now");
  });

  describe("each record that both files hold follows its own rule", () => {
    const merged = (key: string, fromConfig: unknown, fromState: unknown) => {
      seed({ [key]: fromConfig }, { [key]: fromState });
      return (loadConfig() as Record<string, unknown>)[key];
    };

    test("inboxAgentNotes: asked is the union, offered either; auto (notes not said yet) is state.json's", () => {
      expect(merged("inboxAgentNotes", { offered: true, asked: ["codex"], auto: [{ agent: "codex", path: "~/.codex/AGENTS.md" }] }, { asked: ["gemini"] }))
        .toEqual({ offered: true, asked: ["gemini", "codex"] });
    });

    test("inboxTour: the higher version whole; the same version merges stamps, notify_again from state.json", () => {
      expect(merged("inboxTour", { version: 1, finished_at: "2026-10-01T00:00:00.000Z" }, { version: 2, seen_at: "2026-11-01T00:00:00.000Z" }))
        .toEqual({ version: 2, seen_at: "2026-11-01T00:00:00.000Z" });
      expect(merged("inboxTour", { version: 2, skipped_at: "2026-11-02T00:00:00.000Z", notify_again: true }, { version: 2, seen_at: "2026-11-01T00:00:00.000Z", skipped_at: null, notify_again: false }))
        .toEqual({ version: 2, seen_at: "2026-11-01T00:00:00.000Z", skipped_at: "2026-11-02T00:00:00.000Z", notify_again: false });
    });

    test("inboxListIntro: the higher version whole (none is version 1); the same version merges stamps", () => {
      expect(merged("inboxListIntro", { shownAt: "2026-10-01T00:00:00.000Z" }, { version: 2, dueAt: "2026-11-01T00:00:00.000Z" }))
        .toEqual({ version: 2, dueAt: "2026-11-01T00:00:00.000Z" });
      expect(merged("inboxListIntro", { version: 2, shownAt: "2026-11-03T00:00:00.000Z" }, { version: 2, dueAt: "2026-11-01T00:00:00.000Z" }))
        .toEqual({ version: 2, dueAt: "2026-11-01T00:00:00.000Z", shownAt: "2026-11-03T00:00:00.000Z" });
    });

    test("starAsk: the copy further along wins whole (answered, shown, checked); a tie goes to the later one", () => {
      expect(merged("starAsk", { checkedAt: "2026-11-09T00:00:00.000Z" }, { shownAt: "2026-11-01T00:00:00.000Z", surface: "inbox" }))
        .toEqual({ shownAt: "2026-11-01T00:00:00.000Z", surface: "inbox" });
      expect(merged("starAsk", { answer: "opened", answeredAt: "2026-11-03T00:00:00.000Z" }, { answer: "not-now", answeredAt: "2026-11-02T00:00:00.000Z" }))
        .toEqual({ answer: "opened", answeredAt: "2026-11-03T00:00:00.000Z" });
    });

    test("inboxReveals: the later spacing clocks, the earliest waitingSince, a claim anywhere kept, shownFor the union", () => {
      expect(merged(
        "inboxReveals",
        { lastShownAt: "2026-11-05T00:00:00.000Z", waitingSince: { board: "2026-11-01T00:00:00.000Z" }, board: { shownAt: "2026-11-02T00:00:00.000Z" }, agentNote: { shownFor: ["codex"] } },
        { lastShownAt: "2026-11-04T00:00:00.000Z", waitingSince: { board: "2026-11-03T00:00:00.000Z", steps: "2026-11-03T00:00:00.000Z" }, agentNote: { shownFor: ["pi"] } },
      )).toEqual({
        lastShownAt: "2026-11-05T00:00:00.000Z",
        waitingSince: { board: "2026-11-01T00:00:00.000Z", steps: "2026-11-03T00:00:00.000Z" },
        board: { shownAt: "2026-11-02T00:00:00.000Z" },
        agentNote: { shownFor: ["pi", "codex"] },
      });
    });

    test("inboxSnoozeIntro: stamps kept from either, the earliest firstUseAt", () => {
      expect(merged("inboxSnoozeIntro", { firstUseAt: "2026-09-01T00:00:00.000Z", snoozedAt: "2026-10-01T00:00:00.000Z" }, { firstUseAt: "2026-10-29T00:00:00.000Z", shownAt: "2026-11-07T00:00:00.000Z" }))
        .toEqual({ firstUseAt: "2026-09-01T00:00:00.000Z", snoozedAt: "2026-10-01T00:00:00.000Z", shownAt: "2026-11-07T00:00:00.000Z" });
    });

    test("inboxBoardIntro, inboxVoiceIntro, inboxThemeChooser, inboxPriorityIntro: shown, skipped, used or not needed anywhere stays so", () => {
      expect(merged("inboxBoardIntro", { shownAt: "2026-11-01T00:00:00.000Z" }, {})).toEqual({ shownAt: "2026-11-01T00:00:00.000Z" });
      expect(merged("inboxVoiceIntro", { skippedAt: "2026-11-02T00:00:00.000Z" }, { dueAt: "2026-11-01T00:00:00.000Z" }))
        .toEqual({ dueAt: "2026-11-01T00:00:00.000Z", skippedAt: "2026-11-02T00:00:00.000Z" });
      expect(merged("inboxThemeChooser", { notNeededAt: "2026-11-02T00:00:00.000Z" }, { dueAt: "2026-11-01T00:00:00.000Z" }))
        .toEqual({ dueAt: "2026-11-01T00:00:00.000Z", notNeededAt: "2026-11-02T00:00:00.000Z" });
      expect(merged("inboxPriorityIntro", { usedAt: "2026-11-02T00:00:00.000Z" }, {})).toEqual({ usedAt: "2026-11-02T00:00:00.000Z" });
    });

    test("inboxSound: an old dialogShownFor in config.json never hides a dialog that is due; a newer one does", () => {
      expect(merged("inboxSound", { volume: 30, dialogShownFor: "0.28.35" }, { dialogDueFor: "0.29.0" })).toEqual({ volume: 30, dialogDueFor: "0.29.0" });
      expect(merged("inboxSound", { dialogShownFor: "0.29.1" }, { dialogDueFor: "0.29.0" })).toEqual({ dialogShownFor: "0.29.1" });
      expect(merged("inboxSound", { dialogDueFor: "0.28.10" }, { dialogShownFor: "0.28.10" })).toEqual({ dialogShownFor: "0.28.10" });
      // Builds that are not versions: state.json's own fields.
      expect(merged("inboxSound", { dialogShownFor: "tidy-e2e" }, { dialogDueFor: "0.0.0-dev" })).toEqual({ dialogDueFor: "0.0.0-dev" });
    });
  });

  test("a save with no settings change leaves config.json byte for byte, hand formatting included", () => {
    const bytes = '{\n    "displayName": "Ada",\n    "theme": {"mode": "dark"}\n}\n';
    writeFileSync(configPath(), bytes);
    const before = lstatSync(configPath()).mtimeMs;
    expect(saveConfig({ inboxReveals: { lastShownAt: "2026-11-06T00:00:00.000Z" } })).toBe(true);
    expect(saveConfig({ inboxSound: { dialogShownFor: "0.29.0" } })).toBe(true);
    expect(saveConfig({ displayName: "Ada" })).toBe(true);
    expect(readFileSync(configPath(), "utf-8")).toBe(bytes);
    expect(lstatSync(configPath()).mtimeMs).toBe(before);
  });

  test("a read-only config.json that still holds old records: saving those records succeeds with no warning", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    // A home-manager style link into a store nothing may write.
    const store = join(root, "store");
    mkdirSync(store);
    const bytes = JSON.stringify({ displayName: "Ada", inboxTour: { version: 2, seen_at: "2026-10-01T00:00:00.000Z" }, inboxSound: { volume: 30, dialogShownFor: "0.28.20" } });
    writeFileSync(join(store, "config.json"), bytes);
    symlinkSync(join(store, "config.json"), configPath());
    chmodSync(join(store, "config.json"), 0o444);
    chmodSync(store, 0o555);
    expect(saveConfig({ inboxTour: { ...loadConfig().inboxTour, finished_at: "2026-11-01T00:00:00.000Z" } })).toBe(true);
    expect(saveConfig({ inboxSound: { ...loadConfig().inboxSound, dialogShownFor: "0.29.0" } })).toBe(true);
    expect(warnings).toEqual([]);
    expect(readFileSync(configPath(), "utf-8")).toBe(bytes);
    expect(loadConfig()).toMatchObject({ inboxTour: { finished_at: "2026-11-01T00:00:00.000Z" }, inboxSound: { volume: 30, dialogShownFor: "0.29.0" } });
  });

  test("a corrupt or unreadable state.json is kept aside (never deleted) with one warning before a new one is written; settings never suffer", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    const cases: [string, () => void][] = [["{not json", () => {}], ["[1,2]", () => {}]];
    if (process.platform !== "win32" && process.getuid?.() !== 0) cases.push(['{"inboxTour":{"version":2}}', () => chmodSync(statePath(), 0o000)]);
    for (const [bytes, spoil] of cases) {
      for (const name of readdirSync(tempDir)) if (name.startsWith("state.json")) rmSync(join(tempDir, name));
      writeFileSync(statePath(), bytes);
      spoil();
      warnings = [];
      expect(loadConfig().displayName).toBe("Ada");
      expect(saveConfig({ favicon: "yellow" })).toBe(true);
      expect(warnings).toEqual([]);
      expect(saveConfig({ inboxTour: { version: 3 } })).toBe(true);
      expect(json(statePath())).toEqual({ inboxTour: { version: 3 } });
      const aside = readdirSync(tempDir).filter((name) => name.startsWith("state.json.corrupt-"));
      expect(aside).toHaveLength(1);
      chmodSync(join(tempDir, aside[0]), 0o600);
      expect(readFileSync(join(tempDir, aside[0]), "utf-8")).toBe(bytes);
      expect(warnings.filter((line) => line.includes("state.json"))).toHaveLength(1);
      expect(warnings.join("")).toContain(aside[0]);
      expect(json(configPath())).toEqual({ displayName: "Ada", favicon: "yellow" });
    }
  });

  test("state.json as a folder: the warning names state.json, the record save says it failed, and the sound's settings still save", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    mkdirSync(statePath());
    expect(loadConfig().displayName).toBe("Ada");
    expect(saveConfig({ inboxTour: { version: 2 } })).toBe(false);
    expect(warnings.join("")).toContain("not saving state.json because it is a folder");
    expect(warnings.join("")).not.toContain("config.json");
    saveConfig({ inboxSound: { enabled: false, volume: 40, dialogShownFor: "0.29.0" } });
    expect(loadConfig().inboxSound).toMatchObject({ enabled: false, volume: 40 });
    expect(json(configPath()).inboxSound).toEqual({ enabled: false, volume: 40 });
    expect(lstatSync(statePath()).isDirectory()).toBe(true);
  });

  test("a symlinked config.json (a dotfiles repo) is written through for settings, and machine state never lands in it", () => {
    const dotfiles = join(root, "dotfiles");
    mkdirSync(dotfiles);
    const target = join(dotfiles, "plannotator-config.json");
    writeFileSync(target, JSON.stringify({ displayName: "Ada" }));
    symlinkSync(target, configPath());
    expect(saveConfig({ inboxListIntro: { shownAt: "2026-11-06T00:00:00.000Z" } })).toBe(true);
    expect(saveConfig({ favicon: "yellow" })).toBe(true);
    expect(lstatSync(configPath()).isSymbolicLink()).toBe(true);
    expect(json(target)).toEqual({ displayName: "Ada", favicon: "yellow" });
    expect(json(statePath())).toEqual({ inboxListIntro: { shownAt: "2026-11-06T00:00:00.000Z" } });
  });

  test("a state save runs under the config lock and is refused with config.json when that file is unreadable", () => {
    let lockHeld = false;
    __setConfigSaveMergeWindowHookForTest(() => {
      lockHeld = existsSync(join(tempDir, "config.json.lock"));
    });
    expect(saveConfig({ inboxPriorityIntro: { usedAt: "2026-11-06T00:00:00.000Z" } })).toBe(true);
    __setConfigSaveMergeWindowHookForTest(null);
    expect(lockHeld).toBe(true);

    writeFileSync(configPath(), "{ broken");
    expect(saveConfig({ inboxPriorityIntro: { usedAt: "later" } })).toBe(false);
    expect(readFileSync(configPath(), "utf-8")).toBe("{ broken");
    expect(json(statePath())).toEqual({ inboxPriorityIntro: { usedAt: "2026-11-06T00:00:00.000Z" } });
  });
});


describe("resolveForgejoToken (a token goes only to the origin it was configured for)", () => {
  const ORIGIN = "https://forgejo.example.com";

  test("takes the token configured for the origin, however the origin is spelled", () => {
    const config = { forgejoTokens: { "https://Forgejo.Example.com:443": "cfg-token" } };
    expect(resolveForgejoToken(config, ORIGIN, {})).toBe("cfg-token");
    expect(resolveForgejoToken(config, "https://forgejo.example.com/acme/widgets/pulls/1", {})).toBe("cfg-token");
  });

  test("never returns a token for another host, another port, or the same host over http", () => {
    const config = { forgejoTokens: { [ORIGIN]: "cfg-token" } };
    for (const other of [
      "https://elsewhere.example.com",
      "https://forgejo.example.com:8443",
      "http://forgejo.example.com",
      "https://forgejo.example.com.evil.test",
    ]) {
      expect(resolveForgejoToken(config, other, {})).toBeNull();
    }
  });

  test("the environment token applies only to the origin PLANNOTATOR_FORGEJO_URL names", () => {
    const env = { PLANNOTATOR_FORGEJO_TOKEN: "env-token", PLANNOTATOR_FORGEJO_URL: ORIGIN };
    expect(resolveForgejoToken({}, ORIGIN, env)).toBe("env-token");
    expect(resolveForgejoToken({}, "https://elsewhere.example.com", env)).toBeNull();
    // A token with no URL to bind it to is not sent anywhere.
    expect(resolveForgejoToken({}, ORIGIN, { PLANNOTATOR_FORGEJO_TOKEN: "env-token" })).toBeNull();
  });

  test("the environment wins over config for its origin, and config still serves the others", () => {
    const config = { forgejoTokens: { [ORIGIN]: "cfg-token", "http://forgejo.lan:3000": "lan-token" } };
    const env = { PLANNOTATOR_FORGEJO_TOKEN: "env-token", PLANNOTATOR_FORGEJO_URL: ORIGIN };
    expect(resolveForgejoToken(config, ORIGIN, env)).toBe("env-token");
    expect(resolveForgejoToken(config, "http://forgejo.lan:3000", env)).toBe("lan-token");
  });

  test("ignores empty, non-string and malformed entries, and an origin that is not http(s)", () => {
    const config = {
      forgejoTokens: { [ORIGIN]: "   ", "not a url": "x", "ftp://forgejo.example.com": "x" },
    } as unknown as Parameters<typeof resolveForgejoToken>[0];
    expect(resolveForgejoToken(config, ORIGIN, {})).toBeNull();
    expect(resolveForgejoToken({ forgejoTokens: ["x"] } as never, ORIGIN, {})).toBeNull();
    expect(resolveForgejoToken({ forgejoTokens: { [ORIGIN]: "t" } }, "ftp://forgejo.example.com", {})).toBeNull();
    expect(resolveForgejoToken({ forgejoTokens: { [ORIGIN]: "t" } }, "https://u:p@forgejo.example.com", {})).toBeNull();
  });
});

describe("loadConfig reads config.json and state.json only when they change", () => {
  const originalDataDir = process.env.PLANNOTATOR_DATA_DIR;
  const originalShare = process.env.PLANNOTATOR_SHARE;
  let root: string;
  let tempDir: string;
  let reads: string[];
  let stats: string[];
  let warnings: string[];
  let warn: ReturnType<typeof spyOn>;
  /** The clock loadConfig sees: a minute ahead, so a file this test just wrote counts as settled (older than a timestamp tick). */
  let clockAhead: number;

  const countingSeams = (stat: (path: string) => ReturnType<typeof statSync> = (path) => statSync(path)) => ({
    stat: (path: string) => {
      stats.push(path);
      return stat(path);
    },
    read: (path: string) => {
      reads.push(path);
      return readFileSync(path, "utf-8");
    },
    now: () => Date.now() + clockAhead,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "plannotator-config-cache-"));
    tempDir = join(root, "data");
    mkdirSync(tempDir);
    process.env.PLANNOTATOR_DATA_DIR = tempDir;
    delete process.env.PLANNOTATOR_SHARE;
    reads = [];
    stats = [];
    clockAhead = 60_000;
    __setConfigReadForTest(countingSeams());
    warnings = [];
    warn = spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
  });

  afterEach(() => {
    warn.mockRestore();
    __setConfigReadForTest(null);
    if (originalDataDir !== undefined) process.env.PLANNOTATOR_DATA_DIR = originalDataDir;
    else delete process.env.PLANNOTATOR_DATA_DIR;
    if (originalShare !== undefined) process.env.PLANNOTATOR_SHARE = originalShare;
    else delete process.env.PLANNOTATOR_SHARE;
    rmSync(root, { recursive: true, force: true });
  });

  const configPath = () => join(tempDir, "config.json");
  const statePath = () => join(tempDir, "state.json");
  const count = (list: string[], file: string) => list.filter((entry) => entry === file).length;

  test("an unchanged file is read and parsed once; each later call costs one stat per file", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada", experimental: { voice: true } }));
    writeFileSync(statePath(), JSON.stringify({ inboxTour: { version: 2 } }));
    for (let i = 0; i < 25; i++) {
      const config = loadConfig();
      expect(config.displayName).toBe("Ada");
      expect(config.inboxTour?.version).toBe(2);
    }
    expect(count(reads, configPath())).toBe(1);
    expect(count(reads, statePath())).toBe(1);
    expect(count(stats, configPath())).toBe(25);
    expect(count(stats, statePath())).toBe(25);
  });

  test("a missing file costs one stat and no read", () => {
    for (let i = 0; i < 5; i++) expect(loadConfig()).toEqual({});
    expect(reads).toEqual([]);
    expect(count(stats, configPath())).toBe(5);
    expect(count(stats, statePath())).toBe(5);
  });

  test("an edit by another program, in place or by an editor's rename, is read on the next call", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    expect(loadConfig().displayName).toBe("Ada");
    writeFileSync(configPath(), JSON.stringify({ displayName: "Grace Hopper" }));
    expect(loadConfig().displayName).toBe("Grace Hopper");
    // An editor's save: a new file renamed over the old one (a new inode).
    writeFileSync(join(tempDir, "config.json.swp"), JSON.stringify({ displayName: "Linus" }));
    renameSync(join(tempDir, "config.json.swp"), configPath());
    expect(loadConfig().displayName).toBe("Linus");
    writeFileSync(statePath(), JSON.stringify({ inboxTour: { version: 3 } }));
    expect(loadConfig().inboxTour?.version).toBe(3);
    expect(count(reads, configPath())).toBe(3);
  });

  test("a file deleted, then created again", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    expect(loadConfig().displayName).toBe("Ada");
    rmSync(configPath());
    expect(loadConfig()).toEqual({});
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    expect(loadConfig().displayName).toBe("Ada");
    expect(count(reads, configPath())).toBe(2);
  });

  test("our own save is read at once, even when the file's stat would not show it", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    writeFileSync(statePath(), JSON.stringify({ inboxTour: { version: 2 } }));
    // Stats that never change: only the save itself can tell the next load to read again.
    const frozen = statSync(configPath());
    const frozenState = statSync(statePath());
    __setConfigReadForTest(countingSeams((path) => (path === configPath() ? frozen : path === statePath() ? frozenState : statSync(path))));
    expect(loadConfig().displayName).toBe("Ada");
    expect(loadConfig().displayName).toBe("Ada");
    expect(count(reads, configPath())).toBe(1);
    expect(saveConfig({ displayName: "Grace" })).toBe(true);
    expect(loadConfig().displayName).toBe("Grace");
    // Machine state goes to state.json (#2852): read at once too.
    expect(loadConfig().inboxTour?.version).toBe(2);
    expect(saveConfig({ inboxTour: { version: 4 } })).toBe(true);
    expect(loadConfig().inboxTour?.version).toBe(4);
    expect(loadConfig().displayName).toBe("Grace");
  });

  test("a file changed within one timestamp tick at the same size is never hidden: a parse is kept only once the file is older than a tick", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "aaaa" }));
    const real = statSync(configPath());
    // Two writes in one tick at the same size: the stat (mtime, ctime, size, inode) is the same for both.
    const sameTick = { ...real, mtimeMs: 1_000_000, ctimeMs: 1_000_000, isFile: () => true } as unknown as ReturnType<typeof statSync>;
    let now = 1_000_500;
    __setConfigReadForTest({ ...countingSeams((path) => (path === configPath() ? sameTick : statSync(path))), now: () => now });
    expect(loadConfig().displayName).toBe("aaaa");
    writeFileSync(configPath(), JSON.stringify({ displayName: "bbbb" }));
    expect(loadConfig().displayName).toBe("bbbb");
    expect(count(reads, configPath())).toBe(2);
    // 2.5 s on, past a FAT tick but inside the margin: still read every time.
    now = 1_002_500;
    expect(loadConfig().displayName).toBe("bbbb");
    expect(count(reads, configPath())).toBe(3);
    // Three seconds on: the same stat now holds for good, so the parse is kept.
    now = 1_003_000;
    expect(loadConfig().displayName).toBe("bbbb");
    expect(loadConfig().displayName).toBe("bbbb");
    expect(count(reads, configPath())).toBe(4);
  });

  test("a file just written is read on every call until it settles (the real clock)", () => {
    clockAhead = 0;
    __setConfigReadForTest(countingSeams());
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    for (let i = 0; i < 3; i++) expect(loadConfig().displayName).toBe("Ada");
    expect(count(reads, configPath())).toBe(3);
  });

  test("invalid JSON is read and warned about on every call, never kept; a good file is not kept past a bad edit", () => {
    writeFileSync(configPath(), "{ broken");
    writeFileSync(statePath(), "{ broken too");
    for (let i = 0; i < 3; i++) expect(loadConfig()).toEqual({});
    expect(count(reads, configPath())).toBe(3);
    expect(count(reads, statePath())).toBe(3);
    expect(warnings.filter((line) => line.includes("failed to read config.json"))).toHaveLength(3);
    // quiet: no warning, as before.
    expect(loadConfig({ quiet: true })).toEqual({});
    expect(warnings.filter((line) => line.includes("failed to read config.json"))).toHaveLength(3);
    // Fixed: read and kept.
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
    expect(loadConfig().displayName).toBe("Ada");
    expect(loadConfig().displayName).toBe("Ada");
    expect(count(reads, configPath())).toBe(5);
    // Broken again: the good parse is not served.
    writeFileSync(configPath(), "{ broken again");
    expect(loadConfig()).toEqual({});
    expect(warnings.filter((line) => line.includes("failed to read config.json"))).toHaveLength(4);
  });

  test("a JSON value that is not an object reads as {} on every call, never kept", () => {
    writeFileSync(configPath(), "[1, 2]");
    expect(loadConfig()).toEqual({});
    expect(loadConfig()).toEqual({});
    expect(count(reads, configPath())).toBe(2);
  });

  test("two data dirs each keep their own parse", () => {
    const other = join(root, "other");
    mkdirSync(other);
    writeFileSync(configPath(), JSON.stringify({ displayName: "first" }));
    writeFileSync(join(other, "config.json"), JSON.stringify({ displayName: "second" }));
    for (let i = 0; i < 3; i++) {
      process.env.PLANNOTATOR_DATA_DIR = tempDir;
      expect(loadConfig().displayName).toBe("first");
      process.env.PLANNOTATOR_DATA_DIR = other;
      expect(loadConfig().displayName).toBe("second");
    }
    expect(count(reads, configPath())).toBe(1);
    expect(count(reads, join(other, "config.json"))).toBe(1);
  });

  test("a caller that changes what it got changes nothing for the next caller", () => {
    writeFileSync(configPath(), JSON.stringify({ displayName: "Ada", experimental: { voice: true }, inboxReactions: { emoji: ["a"] } }));
    writeFileSync(statePath(), JSON.stringify({ inboxTour: { version: 2 } }));
    const first = loadConfig() as Record<string, any>;
    first.displayName = "changed";
    first.experimental.voice = false;
    first.inboxReactions.emoji.push("b");
    first.inboxTour.version = 99;
    const second = loadConfig() as Record<string, any>;
    expect(second.displayName).toBe("Ada");
    expect(second.experimental).toEqual({ voice: true });
    expect(second.inboxReactions).toEqual({ emoji: ["a"] });
    expect(second.inboxTour).toEqual({ version: 2 });
    // The second came from the cache: changing it leaves the third clean too.
    second.experimental.voice = "hit";
    second.inboxReactions.emoji.push("c");
    second.inboxTour.version = 100;
    const third = loadConfig() as Record<string, any>;
    expect(third.experimental).toEqual({ voice: true });
    expect(third.inboxReactions).toEqual({ emoji: ["a"] });
    expect(third.inboxTour).toEqual({ version: 2 });
    expect(count(reads, configPath())).toBe(1);
    expect(count(reads, statePath())).toBe(1);
  });

  test("an env override read beside the config still changes between calls", () => {
    writeFileSync(configPath(), JSON.stringify({ share: "disabled" }));
    expect(resolveSharingEnabled(loadConfig())).toBe(false);
    process.env.PLANNOTATOR_SHARE = "enabled";
    expect(resolveSharingEnabled(loadConfig())).toBe(true);
    delete process.env.PLANNOTATOR_SHARE;
    expect(resolveSharingEnabled(loadConfig())).toBe(false);
  });

  test("no data dir to name (no home folder to find): {} with one warning, as before", () => {
    const home = spyOn(nodeOs, "homedir").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, uv_os_homedir"), { code: "ENOENT" });
    });
    try {
      expect(loadConfig()).toEqual({});
      expect(warnings.filter((line) => line.includes("failed to read config.json"))).toHaveLength(1);
      expect(loadConfig({ quiet: true })).toEqual({});
      expect(warnings.filter((line) => line.includes("failed to read config.json"))).toHaveLength(1);
    } finally {
      home.mockRestore();
    }
  });

  describe("through fake stats", () => {
    type FakeStat = { mtimeMs: number; ctimeMs: number; size: number; dev: number; ino: number; isFile: () => boolean };
    let fake: Map<string, FakeStat | Error>;
    const statOf = (path: string) => {
      const entry = fake.get(path);
      if (entry instanceof Error) throw entry;
      if (entry) return entry as unknown as ReturnType<typeof statSync>;
      return statSync(path);
    };
    const file = (over: Partial<FakeStat> = {}): FakeStat => ({ mtimeMs: 1000, ctimeMs: 1000, size: 20, dev: 1, ino: 7, isFile: () => true, ...over });

    beforeEach(() => {
      fake = new Map();
      // The clock far past every fake time: every parse counts as settled.
      __setConfigReadForTest({ ...countingSeams(statOf), now: () => 1_000_000 });
    });

    test("a change of ctime alone, of the inode alone or of the device alone is read", () => {
      fake.set(configPath(), file());
      writeFileSync(configPath(), JSON.stringify({ displayName: "aaaa" }));
      expect(loadConfig().displayName).toBe("aaaa");
      expect(loadConfig().displayName).toBe("aaaa");
      expect(count(reads, configPath())).toBe(1);
      writeFileSync(configPath(), JSON.stringify({ displayName: "bbbb" }));
      fake.set(configPath(), file({ ctimeMs: 1001 }));
      expect(loadConfig().displayName).toBe("bbbb");
      writeFileSync(configPath(), JSON.stringify({ displayName: "cccc" }));
      fake.set(configPath(), file({ ctimeMs: 1001, ino: 8 }));
      expect(loadConfig().displayName).toBe("cccc");
      writeFileSync(configPath(), JSON.stringify({ displayName: "dddd" }));
      fake.set(configPath(), file({ ctimeMs: 1001, ino: 8, dev: 2 }));
      expect(loadConfig().displayName).toBe("dddd");
      expect(loadConfig().displayName).toBe("dddd");
      expect(count(reads, configPath())).toBe(4);
    });

    test("at most 8 paths are kept: the oldest is read again, every answer stays right", () => {
      const dirs = Array.from({ length: 9 }, (_, i) => join(root, `dir-${i}`));
      dirs.forEach((dir, i) => {
        mkdirSync(dir);
        writeFileSync(join(dir, "config.json"), JSON.stringify({ displayName: `n${i}` }));
        fake.set(join(dir, "config.json"), file({ ino: 100 + i }));
        fake.set(join(dir, "state.json"), Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
      });
      const load = (i: number) => {
        process.env.PLANNOTATOR_DATA_DIR = dirs[i];
        return loadConfig().displayName;
      };
      dirs.forEach((_, i) => expect(load(i)).toBe(`n${i}`));
      // dir-0 was the oldest of 9: read again; dir-8, the newest, is still kept.
      expect(load(0)).toBe("n0");
      expect(load(8)).toBe("n8");
      expect(count(reads, join(dirs[0], "config.json"))).toBe(2);
      expect(count(reads, join(dirs[8], "config.json"))).toBe(1);
      dirs.forEach((_, i) => expect(load(i)).toBe(`n${i}`));
    });

    test("a folder in place of either file reads as before: config.json warns every call, state.json is no state", () => {
      mkdirSync(configPath());
      mkdirSync(statePath());
      for (let i = 0; i < 3; i++) expect(loadConfig()).toEqual({});
      expect(warnings.filter((line) => line.includes("failed to read config.json"))).toHaveLength(3);
    });

    test("EACCES: a stat refused reads as no file, silently; a read refused warns every call and is never kept", () => {
      const refused = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      fake.set(configPath(), refused());
      fake.set(statePath(), refused());
      expect(loadConfig()).toEqual({});
      expect(reads).toEqual([]);
      expect(warnings).toEqual([]);
      fake.set(configPath(), file());
      fake.set(statePath(), file({ ino: 9 }));
      writeFileSync(configPath(), JSON.stringify({ displayName: "Ada" }));
      writeFileSync(statePath(), JSON.stringify({ inboxTour: { version: 2 } }));
      __setConfigReadForTest({
        stat: statOf,
        read: (path) => {
          reads.push(path);
          throw refused();
        },
        now: () => 1_000_000,
      });
      for (let i = 0; i < 3; i++) expect(loadConfig()).toEqual({});
      expect(count(reads, configPath())).toBe(3);
      expect(count(reads, statePath())).toBe(3);
      expect(warnings.filter((line) => line.includes("failed to read config.json") && line.includes("EACCES"))).toHaveLength(3);
      // Readable again: read and right.
      __setConfigReadForTest({ ...countingSeams(statOf), now: () => 1_000_000 });
      expect(loadConfig().displayName).toBe("Ada");
      expect(loadConfig().inboxTour?.version).toBe(2);
    });
  });
});
