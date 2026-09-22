import { describe, expect, test } from "bun:test";
import {
  CLAUDE_FALLBACK_MODELS,
  CODEX_FALLBACK_MODELS,
  claudeCatalogFromSdk,
  claudeModelVersion,
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
    const [row] = claudeCatalogFromSdk([{ value: "sonnet", resolvedModel: "some-future-scheme" }]);
    expect(row.label).toBe("Sonnet (latest)");
    expect(claudeCatalogFromSdk([{ value: "haiku" }])[0].label).toBe("Haiku (latest)");
  });

  test("effort support is per model: haiku takes none, the rest default to high", () => {
    expect(byId("haiku")?.reasoningEfforts).toBeUndefined();
    expect(byId("sonnet")?.defaultReasoningEffort).toBe("high");
    expect(byId("sonnet")?.fastMode).toBeUndefined();
  });

  test("sonnet is the single default", () => {
    expect(catalog.filter((m) => m.default).map((m) => m.id)).toEqual(["sonnet"]);
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
