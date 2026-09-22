import { describe, expect, test } from "bun:test";
import {
  CLAUDE_FALLBACK_MODELS,
  CODEX_FALLBACK_MODELS,
  claudeCatalogFromSdk,
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
    expect(byId("opus")).toMatchObject({ label: "Opus (latest)", fastMode: true });
    expect(byId("opus")?.reasoningEfforts?.map((e) => e.id)).toEqual(ALL);
    expect(byId("opus")?.resolvedId).toBeUndefined();
    expect(byId("fable")?.reasoningEfforts?.map((e) => e.id)).toEqual(ALL);
  });

  test("labels name the actual model and version from the description", () => {
    expect(byId("opus[1m]")?.label).toBe("Opus 5.5 with 1M context");
    expect(byId("sonnet")?.label).toBe("Sonnet 5");
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
  });

  test("maps a saved canonical id onto the alias that covers it", () => {
    expect(resolveModelChoice("claude-sonnet-5", catalog, "opus")).toBe("sonnet");
  });

  test("a stale pick falls back to the surface default, then the catalog default", () => {
    expect(resolveModelChoice("claude-opus-4-8", catalog, "opus")).toBe("opus");
    expect(resolveModelChoice("claude-opus-4-8", catalog, "not-offered")).toBe("sonnet");
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
