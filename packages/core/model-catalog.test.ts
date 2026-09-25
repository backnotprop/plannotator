import { describe, expect, test } from "bun:test";
import {
  CLAUDE_FALLBACK_MODELS,
  CODEX_FALLBACK_MODELS,
  claudeCatalogFromSdk,
  claudeModelVersion,
  cliVersionFrom,
  modelSelectOptions,
  resolveEffortChoice,
  resolveModelChoice,
  type CatalogModel,
  type ClaudeSdkModelInfo,
} from "./model-catalog";

const ALL = ["low", "medium", "high", "xhigh", "max"];

// supportedModels() as returned by an installed claude 2.1.280 (captured
// verbatim, fields the catalog does not read omitted).
const SDK_MODELS: ClaudeSdkModelInfo[] = [
  { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ALL, supportsFastMode: true },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks", supportsEffort: true, supportedEffortLevels: ALL, supportsFastMode: true },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks", supportsEffort: true, supportedEffortLevels: ALL },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks", supportsEffort: true, supportedEffortLevels: ALL },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
];

describe("claudeCatalogFromSdk", () => {
  const catalog = claudeCatalogFromSdk(SDK_MODELS);
  const byId = (id: string) => catalog.find((m) => m.id === id);

  test("drops the 'default' pointer row and keeps every real model", () => {
    expect(byId("default")).toBeUndefined();
    for (const id of ["opus[1m]", "claude-fable-5-1[1m]", "sonnet", "haiku"]) expect(byId(id)).toBeDefined();
  });

  test("every family the tool offers has its bare alias, carrying that family's support", () => {
    // The launchers default to `opus` / `sonnet`; the CLI resolves them to the
    // latest model, so they must be pickable even when the tool lists only
    // `opus[1m]` or a pinned Fable id.
    expect(byId("opus")).toMatchObject({ label: "Opus 5.5 (latest)", fastMode: true });
    expect(byId("opus")?.reasoningEfforts?.map((e) => e.id)).toEqual(ALL);
    expect(byId("opus")?.resolvedId).toBeUndefined();
    expect(byId("fable")?.reasoningEfforts?.map((e) => e.id)).toEqual(ALL);
  });

  test("aliases name the version they resolve to today, taken from the tool's own data", () => {
    // Owner requirement: people want to see version numbers. The versions come
    // from supportedModels()' resolvedModel, never from a hand list.
    for (const [id, label] of [
      ["opus", "Opus 5.5 (latest)"],
      ["opus[1m]", "Opus 5.5 1M (latest)"],
      ["sonnet", "Sonnet 5 (latest)"],
      ["fable", "Fable 5.1 (latest)"],
      ["haiku", "Haiku 4.5 (latest)"],
    ]) {
      expect(byId(id)?.label).toBe(label);
    }
    expect(byId("claude-fable-5-1[1m]")?.label).toBe("Fable 5.1 (1M)");
  });

  test("an alias whose resolved model is missing or unparseable keeps the plain label", () => {
    const row = claudeCatalogFromSdk([{ value: "sonnet", resolvedModel: "some-future-scheme" }]).find((m) => m.id === "sonnet");
    expect(row?.label).toBe("Sonnet (latest)");
    expect(claudeCatalogFromSdk([{ value: "haiku" }]).find((m) => m.id === "haiku")?.label).toBe("Haiku (latest)");
  });

  test("effort support is per model: haiku takes none, the rest default to high", () => {
    expect(byId("haiku")?.reasoningEfforts).toBeUndefined();
    expect(byId("sonnet")?.defaultReasoningEffort).toBe("high");
    expect(byId("sonnet")?.fastMode).toBeUndefined();
  });

  test("sonnet is the single default", () => {
    expect(catalog.filter((m) => m.default).map((m) => m.id)).toEqual(["sonnet"]);
  });

  test("a CLI that names Opus only through the default row still offers opus (Claude Code 2.1.141)", () => {
    // Captured from Claude Code 2.1.141: the default row carries no
    // resolvedModel and is the only place Opus appears. Without the alias a
    // saved or default `opus` pick resolved to sonnet and ran Sonnet.
    const old = claudeCatalogFromSdk([
      { value: "default", displayName: "Default (recommended)", description: "Use the default model (currently Opus 4.7 (1M context))" },
      { value: "sonnet", resolvedModel: "claude-sonnet-4-6", description: "Sonnet 4.6 · Best for everyday tasks", supportsEffort: true, supportedEffortLevels: ALL },
      { value: "sonnet[1m]", resolvedModel: "claude-sonnet-4-6[1m]", description: "Sonnet 4.6 with 1M context · For long sessions", supportsEffort: true, supportedEffortLevels: ALL },
      { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", description: "Haiku 4.5 · Fastest for quick answers" },
    ]);
    expect(old.find((m) => m.id === "opus")?.label).toBe("Opus 4.7 (latest)");
    expect(resolveModelChoice("opus", old, "opus")).toBe("opus");
    expect(resolveModelChoice("claude-opus-4-7", old)).toBe("opus");
    expect(old.filter((m) => m.default).map((m) => m.id)).toEqual(["sonnet"]);
  });

  test("a context size in the default row's description is not read as a version", () => {
    const models = claudeCatalogFromSdk([
      { value: "default", description: "Use the default model (currently Opus 1M context)" },
      { value: "sonnet", resolvedModel: "claude-sonnet-5" },
    ]);
    expect(models.find((m) => m.id === "opus")?.label).toBe("Opus (latest)");
  });

  test("the core aliases are offered even when nothing names their family", () => {
    const models = claudeCatalogFromSdk([{ value: "sonnet", resolvedModel: "claude-sonnet-5" }]);
    expect(models.map((m) => m.id).sort()).toEqual(["haiku", "opus", "sonnet"]);
    expect(models.find((m) => m.id === "opus")?.label).toBe("Opus (latest)");
    // The 2.1.280 shape already offers every family; nothing extra is added.
    expect(catalog.map((m) => m.id).sort()).toEqual(["claude-fable-5-1[1m]", "fable", "haiku", "opus", "opus[1m]", "sonnet"]);
  });

  test("names pinned models from displayName when the description is only a tagline (Claude Code 2.1.282)", () => {
    // 2.1.282 moved the model name from `description` ("Fable 5.1 · …") into
    // `displayName` and left `description` as a tagline; the tagline must not
    // become the label, or several rows read identically.
    const rows = claudeCatalogFromSdk([
      { value: "claude-fable-5-1", displayName: "Fable 5.1", description: "For your toughest challenges" },
      { value: "claude-opus-4-8", displayName: "Opus 4.8", description: "Best for everyday, complex tasks" },
      { value: "claude-opus-4-7", displayName: "Opus 4.7", description: "Best for everyday, complex tasks" },
      { value: "claude-opus-4-6[1m]", displayName: "Opus 4.6", description: "Best for everyday, complex tasks" },
    ]);
    const label = (id: string) => rows.find((m) => m.id === id)?.label;
    expect(label("claude-fable-5-1")).toBe("Fable 5.1");
    expect(label("claude-opus-4-8")).toBe("Opus 4.8");
    expect(label("claude-opus-4-7")).toBe("Opus 4.7");
    expect(label("claude-opus-4-6[1m]")).toBe("Opus 4.6 (1M)");
  });

  test("tolerates an empty or malformed reply", () => {
    expect(claudeCatalogFromSdk([])).toEqual([]);
    expect(claudeCatalogFromSdk([{ value: "" }, null as unknown as ClaudeSdkModelInfo])).toEqual([]);
  });
});

describe("resolveModelChoice", () => {
  const catalog = claudeCatalogFromSdk(SDK_MODELS);

  test("keeps a pick the catalog offers", () => {
    expect(resolveModelChoice("haiku", catalog, "opus")).toBe("haiku");
    expect(resolveModelChoice("opus[1m]", catalog, "sonnet")).toBe("opus[1m]");
  });

  test("maps a saved canonical id onto the alias that covers it", () => {
    expect(resolveModelChoice("claude-sonnet-5", catalog, "opus")).toBe("sonnet");
  });

  test("a stale pinned id keeps its family instead of taking the surface default", () => {
    // Tour/guide default to sonnet, review to opus: neither may win over the
    // family the user picked.
    expect(resolveModelChoice("claude-opus-5-5", catalog, "sonnet")).toBe("opus");
    expect(resolveModelChoice("claude-opus-5", catalog, "sonnet")).toBe("opus");
    expect(resolveModelChoice("claude-sonnet-4-6", catalog, "opus")).toBe("sonnet");
    expect(resolveModelChoice("claude-fable-5", catalog, "opus")).toBe("fable");
  });

  test("never moves a pick across the 1M-context boundary", () => {
    // claude-fable-5-1 is covered by claude-fable-5-1[1m] via resolvedId, but
    // that is a different context window (and bill): land on the plain alias.
    expect(resolveModelChoice("claude-fable-5-1", catalog, "sonnet")).toBe("fable");
    expect(resolveModelChoice("claude-opus-4-8[1m]", catalog, "sonnet")).toBe("opus[1m]");
    expect(resolveModelChoice("claude-sonnet-4-6[1m]", catalog, "opus")).toBe("sonnet");
  });

  test("an unrecognised pick falls back to the surface default, then the catalog default", () => {
    expect(resolveModelChoice("mystery-model", catalog, "opus")).toBe("opus");
    expect(resolveModelChoice("mystery-model", catalog, "not-offered")).toBe("sonnet");
    expect(resolveModelChoice("", catalog)).toBe("sonnet");
  });

  test("an empty pick with no surface default uses the tool's default (Codex)", () => {
    const codex: CatalogModel[] = [{ id: "gpt-a", label: "A" }, { id: "gpt-b", label: "B", default: true }];
    expect(resolveModelChoice("", codex)).toBe("gpt-b");
    expect(resolveModelChoice("gpt-retired", codex)).toBe("gpt-b");
  });
});

describe("resolveEffortChoice", () => {
  const models: CatalogModel[] = [
    { id: "m", label: "M", reasoningEfforts: [{ id: "low", label: "Low" }, { id: "high", label: "High" }], defaultReasoningEffort: "high" },
    { id: "plain", label: "Plain" },
  ];

  test("keeps a supported effort and snaps an unsupported one to the model default", () => {
    expect(resolveEffortChoice("low", models, "m")).toBe("low");
    expect(resolveEffortChoice("ultra", models, "m")).toBe("high");
  });

  test("a model that takes no effort yields none; an unknown model passes through", () => {
    expect(resolveEffortChoice("high", models, "plain")).toBe("");
    expect(resolveEffortChoice("max", models, "future")).toBe("max");
  });
});

test("a current pick the catalog lacks stays visible in the picker", () => {
  expect(modelSelectOptions([{ id: "a", label: "A" }], "saved").map((o) => o.value)).toEqual(["a", "saved"]);
  expect(modelSelectOptions([{ id: "a", label: "A" }], "").map((o) => o.value)).toEqual(["a"]);
});

test("fallbacks: one default each, and every default effort is one the model lists", () => {
  for (const list of [CLAUDE_FALLBACK_MODELS, CODEX_FALLBACK_MODELS]) {
    expect(list.filter((m) => m.default)).toHaveLength(1);
    for (const m of list) {
      if (m.defaultReasoningEffort) expect(m.reasoningEfforts?.map((e) => e.id)).toContain(m.defaultReasoningEffort);
    }
  }
  // The launchers' Claude surface defaults must exist even without discovery.
  for (const alias of ["opus", "sonnet"]) expect(CLAUDE_FALLBACK_MODELS.some((m) => m.id === alias)).toBe(true);
});

test("claudeModelVersion reads major.minor and ignores date and [1m] suffixes", () => {
  expect(claudeModelVersion("claude-opus-5-5")).toBe("5.5");
  expect(claudeModelVersion("claude-opus-5-5[1m]")).toBe("5.5");
  expect(claudeModelVersion("claude-sonnet-5")).toBe("5");
  expect(claudeModelVersion("claude-haiku-4-5-20251001")).toBe("4.5");
  expect(claudeModelVersion("claude-sonnet-4-20250514")).toBe("4");
  expect(claudeModelVersion("gpt-6-sol")).toBeUndefined();
  expect(claudeModelVersion(undefined)).toBeUndefined();
});

test("the Codex fallback defaults to GPT-6-Sol, which codex >= 0.155 lists", () => {
  expect(CODEX_FALLBACK_MODELS.filter((m) => m.default).map((m) => m.id)).toEqual(["gpt-6-sol"]);
});

test("cliVersionFrom reads the version from claude --version and the codex userAgent", () => {
  expect(cliVersionFrom("2.1.282 (Claude Code)\n")).toBe("2.1.282");
  expect(cliVersionFrom("plannotator/0.155.1 (Mac OS 26.3.0; arm64) ghostty/1.3.1 (plannotator; 0)")).toBe("0.155.1");
  expect(cliVersionFrom("codex_cli_rs/0.156.0-alpha.2 (Linux)")).toBe("0.156.0-alpha.2");
  expect(cliVersionFrom("")).toBeUndefined();
  expect(cliVersionFrom(undefined)).toBeUndefined();
});

test("cliVersionFrom prefers the line naming the tool, else the first line", () => {
  const noisy = "node 18.2.0 warning: something\n2.1.282 (Claude Code)\n";
  expect(cliVersionFrom(noisy, /claude code/i)).toBe("2.1.282");
  // No line names the tool: the first line's version, never a later line's.
  expect(cliVersionFrom("2.1.282\nnode 18.2.0", /claude code/i)).toBe("2.1.282");
  expect(cliVersionFrom("no version here\n1.2.3")).toBeUndefined();
});

test("cliVersionFrom refuses an unbounded prerelease suffix", () => {
  expect(cliVersionFrom(`0.156.0-${"a".repeat(200)}`)).toBeUndefined();
  expect(cliVersionFrom("0.156.0-alpha.2")).toBe("0.156.0-alpha.2");
});
