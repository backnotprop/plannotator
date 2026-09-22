import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLAUDE_FALLBACK_MODELS } from "@plannotator/core/model-catalog";
import { ClaudeAgentSDKProvider } from "./claude-agent-sdk.ts";
import { codexCatalogFromModelList } from "./codex-app-server.ts";

describe("codexCatalogFromModelList", () => {
  // Shape of codex-cli 0.154 `model/list` entries (trimmed to the read fields).
  const list = [
    {
      id: "gpt-6-astra",
      displayName: "GPT-6-Astra",
      hidden: false,
      isDefault: true,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"].map((reasoningEffort) => ({ reasoningEffort })),
      additionalSpeedTiers: ["fast"],
    },
    {
      id: "gpt-slow",
      displayName: "GPT Slow",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "high",
      supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      additionalSpeedTiers: [],
    },
    { id: "gpt-hidden", displayName: "Hidden", hidden: true },
  ];

  test("maps default, efforts and fast-tier support; drops hidden models", () => {
    const catalog = codexCatalogFromModelList(list);
    expect(catalog.map((m) => m.id)).toEqual(["gpt-6-astra", "gpt-slow"]);
    expect(catalog[0]).toMatchObject({ label: "GPT-6-Astra", default: true, defaultReasoningEffort: "medium", fastMode: true });
    expect(catalog[0].reasoningEfforts?.map((e) => e.id)).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(catalog[1].default).toBeUndefined();
    expect(catalog[1].fastMode).toBeUndefined();
  });
});

describe("Claude model discovery", () => {
  test("a claude that cannot start leaves the fallback in place and never throws", async () => {
    const provider = new ClaudeAgentSDKProvider({
      type: "claude-agent-sdk",
      cwd: process.cwd(),
      claudeExecutablePath: resolve(import.meta.dir, "does-not-exist", "claude"),
    });
    await provider.fetchModels();
    expect(provider.models).toBe(CLAUDE_FALLBACK_MODELS);
  }, 15_000);

  // Discovery spawns `claude`, so neither runtime may run it at startup — only
  // behind the deferred initializer (?activate= from a picker, or a session).
  for (const relPath of ["packages/server/ai-runtime.ts", "apps/pi-extension/server/ai-runtime.ts"]) {
    test(`${relPath} defers Claude model discovery`, () => {
      const src = readFileSync(resolve(import.meta.dir, "../../..", relPath), "utf8");
      const start = src.indexOf('"claude-agent-sdk"');
      const end = src.indexOf("Claude SDK not available", start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const block = src.slice(start, end);
      expect(block).toContain("providerInitializers.set");
      expect(block).not.toContain("modelDiscovery.push");
    });
  }
});
