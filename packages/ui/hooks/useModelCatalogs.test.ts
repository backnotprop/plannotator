import { afterEach, describe, expect, test } from "bun:test";
import { FALLBACK_MODELS, __resetModelCatalogsForTests, loadModelCatalog } from "./useModelCatalogs";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  __resetModelCatalogsForTests();
});

function stubFetch(handler: (url: string) => Response | Promise<Response>): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input));
    return handler(String(input));
  }) as typeof fetch;
  return urls;
}

describe("loadModelCatalog", () => {
  test("activates the Ask AI provider and returns its discovered list, once per page", async () => {
    const discovered = [{ id: "gpt-6-astra", label: "GPT-6-Astra", default: true }];
    const urls = stubFetch(() =>
      Response.json({ available: true, providers: [{ id: "codex-sdk", name: "codex-sdk", models: discovered }] }),
    );
    const [a, b] = await Promise.all([loadModelCatalog("codex"), loadModelCatalog("codex")]);
    expect(a).toEqual(discovered);
    expect(b).toBe(a);
    expect(urls).toEqual(["/api/ai/capabilities?activate=codex-sdk"]);
  });

  // A server whose Ask AI is a session bridge lists only the bridge under
  // `providers` and reports the launcher's SDK catalog under `catalogProviders`.
  test("reads the discovered list from catalogProviders when Ask AI is bridge-only", async () => {
    const discovered = [{ id: "opus[1m]", label: "Opus 5.5 (1M)" }, { id: "opus", label: "Opus 5.5 (latest)", default: true }];
    stubFetch(() =>
      Response.json({
        available: true,
        providers: [{ id: "session-bridge", name: "session-bridge", models: [], sessionBridge: { host: "claude-code", status: "ready", modes: { turn: true, transient: false } } }],
        defaultProvider: "session-bridge",
        catalogProviders: [{ id: "claude-agent-sdk", name: "claude-agent-sdk", models: discovered, modelsSource: "discovered" }],
      }),
    );
    expect(await loadModelCatalog("claude")).toEqual(discovered);
  });

  test("falls back to the static list when the request fails or the provider is absent", async () => {
    const urls = stubFetch(() => new Response("nope", { status: 404 }));
    expect(await loadModelCatalog("claude")).toBe(FALLBACK_MODELS.claude);
    // A failure is not cached: the next surface that asks tries again.
    await loadModelCatalog("claude");
    expect(urls).toHaveLength(2);

    stubFetch(() => Response.json({ available: true, providers: [{ id: "pi-sdk", models: [{ id: "x", label: "X" }] }] }));
    expect(await loadModelCatalog("codex")).toBe(FALLBACK_MODELS.codex);
  });

  test("a 200 answer the server marks as its fallback is shown but retried on the next load", async () => {
    const fallback = [{ id: "sonnet", label: "Sonnet (latest)", default: true }];
    const discovered = [{ id: "opus", label: "Opus 5.5 (latest)" }, ...fallback];
    let source = "fallback";
    const urls = stubFetch(() =>
      Response.json({
        available: true,
        providers: [{ id: "claude-agent-sdk", models: source === "fallback" ? fallback : discovered, modelsSource: source }],
      }),
    );
    expect(await loadModelCatalog("claude")).toEqual(fallback);
    source = "discovered";
    expect(await loadModelCatalog("claude")).toEqual(discovered);
    // A discovered answer is kept for the page.
    await loadModelCatalog("claude");
    expect(urls).toHaveLength(2);
  });
});
