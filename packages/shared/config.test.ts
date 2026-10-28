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
} from "node:fs";
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
  resolveUrlHost,
  isValidUrlHost,
  parseReviewAnalysisConfig,
  loadConfig,
  saveConfig,
  getServerConfig,
  resolveGuideShareUrl,
  resolveSharingEnabled,
  resolveDefaultDiffType,
  DEFAULT_GUIDE_SHARE_URL,
  __setConfigLockTimingsForTest,
  __setConfigSaveMergeWindowHookForTest,
} from "./config";
import type { PlannotatorConfig } from "./config";

describe("resolveDefaultDiffType", () => {
  test("accepts local-vs-remote as a persisted review default", () => {
    expect(resolveDefaultDiffType({
      diffOptions: { defaultDiffType: "local-vs-remote" },
    })).toBe("local-vs-remote");
  });
});

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
  test("unset: the host's default (owner's call: on for the Claude Code mod and Oh My Pi, off on Pi and OpenCode 2)", () => {
    expect(AGENT_TOOL_DEFAULTS).toEqual({ "claude-code": true, pi: false, "oh-my-pi": true, opencode: false });
    for (const host of ["claude-code", "pi", "oh-my-pi", "opencode"] as const) {
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

  test("an empty config.json holds nothing to lose and is written", () => {
    writeFileSync(configPath(), "  \n");
    expect(saveConfig({ displayName: "x" })).toBe(true);
    expect(loadConfig().displayName).toBe("x");
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
    expect(saveConfig({ favicon: "classic" })).toBe(true);
    expect(loadConfig()).toMatchObject({ displayName: "Ada", theme: { mode: "dark" }, favicon: "classic" });
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
