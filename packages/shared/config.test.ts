import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import {
  resolveAIEnabled,
  resolveCursorSandbox,
  resolveUseGlimpse,
  resolveAnnotateHistory,
  resolveGuideHistory,
  resolveUseJina,
  resolveTodoProviderEnabled,
} from "./config";
import type { PlannotatorConfig } from "./config";

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
