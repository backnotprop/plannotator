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

  test("falls back to the static list when the request fails or the provider is absent", async () => {
    stubFetch(() => new Response("nope", { status: 404 }));
    expect(await loadModelCatalog("claude")).toBe(FALLBACK_MODELS.claude);

    stubFetch(() => Response.json({ available: true, providers: [{ id: "pi-sdk", models: [{ id: "x", label: "X" }] }] }));
    expect(await loadModelCatalog("codex")).toBe(FALLBACK_MODELS.codex);
  });
});
