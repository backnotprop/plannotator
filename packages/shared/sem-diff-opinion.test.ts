import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerSemDiffOpinionRequest, semDiffOpinionPath } from "./sem-diff-opinion";
import { openaiAnswers } from "./sem-diff-openai";

const KEY = "tsk-secret-value-123";
let dir = "";
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
});

type SeenCall = { url: string; auth: string | null; body: Record<string, unknown> | null };

function stub(status: number, body: unknown, seen?: SeenCall[]): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    seen?.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body: parsed });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const okCheck = stub(200, { result: { answers: { q: { noul: 0.97 } } } });
const openAICheck = stub(200, { answers: [{ type: "predicate", name: "q", probability: 0.99 }] });
const candidate = { kind: "extract", helper: "subtotal", caller: "checkout", file: "src/checkout.ts", code: { helper: "function subtotal() {}", caller: "a", callerNew: "b" } };
const route = (pathname: string, method: string, body: unknown, f: typeof fetch, env: Record<string, string | undefined> = {}) =>
  answerSemDiffOpinionRequest(pathname, method, async () => body, dir, f, env);

describe("Power Up key and opinion routes", () => {
  test("a key is checked before it is kept, kept 0600 outside config.json, and never answered back", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const refused = await route("/api/sem-diff/opinion/settings", "POST", { provider: "jev", apiKey: KEY }, stub(401, { error: "nope" }));
    expect(refused.body).toEqual({ ok: false, failure: "refused", reason: "The key was refused." });
    expect(existsSync(semDiffOpinionPath(dir))).toBe(false);
    const saved = await route("/api/sem-diff/opinion/settings", "POST", { provider: "jev", apiKey: KEY }, okCheck);
    expect(saved.body).toMatchObject({ ok: true, provider: "jev" });
    expect(statSync(semDiffOpinionPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(semDiffOpinionPath(dir), "utf8")).toContain(KEY);
    expect(existsSync(join(dir, "config.json"))).toBe(false);
    const settings = await route("/api/sem-diff/opinion/settings", "GET", null, okCheck);
    expect(settings.body).toEqual({ configured: true, provider: "jev" });
    expect(JSON.stringify([refused, saved, settings])).not.toContain(KEY);
    await route("/api/sem-diff/opinion/settings", "DELETE", null, okCheck);
    expect(existsSync(semDiffOpinionPath(dir))).toBe(false);
  });

  test("questions go only to the chosen provider with the key, and the answers come back without it", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const off = await route("/api/sem-diff/opinion", "POST", { candidates: [candidate] }, okCheck);
    expect(off.body).toMatchObject({ ok: false, state: "off" });
    await route("/api/sem-diff/opinion/settings", "POST", { provider: "jev", apiKey: KEY }, okCheck);
    const seen: Array<{ url: string; auth: string | null }> = [];
    const reply = await route("/api/sem-diff/opinion", "POST", { candidates: [candidate] }, stub(200, { result: { answers: { q: { probabilities: { moved: 0.93, new: 0.05 } } } } }, seen));
    expect(reply.body).toMatchObject({ ok: true, answers: [{ accept: true, band: "very-likely", answer: "moved" }] });
    expect(seen.map((s) => new URL(s.url).host)).toEqual(["api.typesafe.ai"]);
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(JSON.stringify(reply)).not.toContain(KEY);
  });

  test("a refused key, an empty account, a dead provider and a bad question each read as one state", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    await route("/api/sem-diff/opinion/settings", "POST", { provider: "clef", accountId: "acct", apiToken: KEY }, okCheck);
    const other = { ...candidate, helper: "other" };
    expect((await route("/api/sem-diff/opinion", "POST", { candidates: [other] }, stub(403, {}))).body).toMatchObject({ state: "refusedKey" });
    expect((await route("/api/sem-diff/opinion", "POST", { candidates: [{ ...other, helper: "third" }] }, stub(402, {}))).body).toMatchObject({ state: "noCredit" });
    expect((await route("/api/sem-diff/opinion", "POST", { candidates: "x" }, okCheck)).body).toMatchObject({ state: "failed" });
    expect((await route("/api/sem-diff/opinion", "GET", null, okCheck)).status).toBe(405);
  });

  test("env-configured systemone endpoint, model, auth scheme, and API key work without a saved key", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const env = {
      PLANNOTATOR_OPINION_URL: "https://inference.baseten.co/v1/systemone",
      PLANNOTATOR_OPINION_MODEL: "decision-models/baseten-mammoth-27b-latest",
      PLANNOTATOR_OPINION_API_KEY: KEY,
      PLANNOTATOR_OPINION_AUTH: "api-key",
    };
    const settings = await route("/api/sem-diff/opinion/settings", "GET", null, okCheck, env);
    expect(settings.body).toEqual({
      configured: true,
      provider: "jev",
      source: "env",
      endpoint: "inference.baseten.co",
      model: "decision-models/baseten-mammoth-27b-latest",
    });
    expect(JSON.stringify(settings)).not.toContain(KEY);

    const seen: SeenCall[] = [];
    const reply = await route(
      "/api/sem-diff/opinion",
      "POST",
      { candidates: [candidate] },
      stub(200, { answers: { q: { probabilities: { moved: 0.91, new: 0.09 } } } }, seen),
      env,
    );
    expect(reply.body).toMatchObject({ ok: true, answers: [{ accept: true, band: "very-likely", answer: "moved", model: "decision-models/baseten-mammoth-27b-latest" }] });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://inference.baseten.co/v1/systemone");
    expect(seen[0]!.auth).toBe(`Api-Key ${KEY}`);
    expect(seen[0]!.body?.model).toBe("decision-models/baseten-mammoth-27b-latest");
    expect(existsSync(semDiffOpinionPath(dir))).toBe(false);
    expect(JSON.stringify(reply)).not.toContain(KEY);
  });

  test("saved key verifies against custom endpoint, invalid env config fails closed, and Clef is unaffected", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const customEnv = {
      PLANNOTATOR_OPINION_URL: "https://models.example.com/v1/systemone",
      PLANNOTATOR_OPINION_MODEL: "custom-decision-v1",
    };
    const seen: SeenCall[] = [];
    const saved = await route("/api/sem-diff/opinion/settings", "POST", { provider: "jev", apiKey: KEY }, stub(200, { answers: { q: { noul: 0.95 } } }, seen), customEnv);
    expect(saved.body).toMatchObject({ ok: true, provider: "jev" });
    expect(seen[0]!.url).toBe("https://models.example.com/v1/systemone");
    expect(seen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(seen[0]!.body?.model).toBe("custom-decision-v1");

    const badUrlCalls: SeenCall[] = [];
    const badUrl = await route(
      "/api/sem-diff/opinion",
      "POST",
      { candidates: [candidate] },
      stub(200, {}, badUrlCalls),
      { PLANNOTATOR_OPINION_URL: "ftp://bad.example.com" },
    );
    expect(badUrl.body).toMatchObject({ ok: false, state: "failed" });
    expect(badUrlCalls).toHaveLength(0);

    const badAuthCalls: SeenCall[] = [];
    const badAuth = await route(
      "/api/sem-diff/opinion/settings",
      "POST",
      { provider: "jev", apiKey: KEY },
      stub(200, {}, badAuthCalls),
      { PLANNOTATOR_OPINION_AUTH: "basic" },
    );
    expect(badAuth.body).toMatchObject({ ok: false, failure: "noAnswer" });
    expect(badAuthCalls).toHaveLength(0);

    const clefSeen: SeenCall[] = [];
    const clefSaved = await route(
      "/api/sem-diff/opinion/settings",
      "POST",
      { provider: "clef", accountId: "acct", apiToken: KEY },
      stub(200, { result: { answers: { q: { noul: 0.96 } } } }, clefSeen),
      { ...customEnv, PLANNOTATOR_OPINION_AUTH: "api-key" },
    );
    expect(clefSaved.body).toMatchObject({ ok: true, provider: "clef" });
    expect(new URL(clefSeen[0]!.url).host).toBe("api.cloudflare.com");
    expect(clefSeen[0]!.auth).toBe(`Bearer ${KEY}`);
  });

  test("custom provider saves URL, model, auth, and key, rejects invalid URLs, and honors env overrides", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const badCalls: SeenCall[] = [];
    const bad = await route(
      "/api/sem-diff/opinion/settings",
      "POST",
      { provider: "custom", url: "ftp://bad.example.com/v1", auth: "api-key", apiKey: KEY },
      stub(200, {}, badCalls),
    );
    expect(bad.body).toMatchObject({ ok: false, failure: "invalidUrl" });
    expect(badCalls).toHaveLength(0);
    expect(existsSync(semDiffOpinionPath(dir))).toBe(false);

    const credCalls: SeenCall[] = [];
    const withCreds = await route(
      "/api/sem-diff/opinion/settings",
      "POST",
      { provider: "custom", url: "https://user:pass@inference.baseten.co/v1/systemone", apiKey: KEY },
      stub(200, {}, credCalls),
    );
    expect(withCreds.body).toMatchObject({ ok: false, failure: "invalidUrl" });
    expect(credCalls).toHaveLength(0);

    const saveSeen: SeenCall[] = [];
    const saved = await route(
      "/api/sem-diff/opinion/settings",
      "POST",
      {
        provider: "custom",
        url: "https://inference.baseten.co/v1/systemone",
        model: "decision-models/baseten-mammoth-27b-latest",
        auth: "api-key",
        apiKey: KEY,
      },
      stub(200, { answers: { q: { noul: 0.96 } } }, saveSeen),
    );
    expect(saved.body).toMatchObject({ ok: true, provider: "custom" });
    expect(saveSeen[0]!.url).toBe("https://inference.baseten.co/v1/systemone");
    expect(saveSeen[0]!.auth).toBe(`Api-Key ${KEY}`);
    expect(saveSeen[0]!.body?.model).toBe("decision-models/baseten-mammoth-27b-latest");

    const settings = await route("/api/sem-diff/opinion/settings", "GET", null, okCheck);
    expect(settings.body).toEqual({
      configured: true,
      provider: "custom",
      url: "https://inference.baseten.co/v1/systemone",
      endpoint: "inference.baseten.co",
      model: "decision-models/baseten-mammoth-27b-latest",
      auth: "api-key",
    });
    expect(JSON.stringify(settings)).not.toContain(KEY);

    const askSeen: SeenCall[] = [];
    const reply = await route(
      "/api/sem-diff/opinion",
      "POST",
      { candidates: [candidate] },
      stub(200, { answers: { q: { probabilities: { moved: 0.92, new: 0.08 } } } }, askSeen),
    );
    expect(reply.body).toMatchObject({ ok: true, answers: [{ accept: true, answer: "moved" }] });
    expect(askSeen[0]!.url).toBe("https://inference.baseten.co/v1/systemone");
    expect(askSeen[0]!.auth).toBe(`Api-Key ${KEY}`);
    expect(askSeen[0]!.body?.model).toBe("decision-models/baseten-mammoth-27b-latest");

    const overrideSeen: SeenCall[] = [];
    const envOverride = {
      PLANNOTATOR_OPINION_URL: "https://override.example.com/v1/systemone",
      PLANNOTATOR_OPINION_MODEL: "override-model",
      PLANNOTATOR_OPINION_AUTH: "bearer",
    };
    await route(
      "/api/sem-diff/opinion",
      "POST",
      { candidates: [{ ...candidate, helper: "overrideHelper" }] },
      stub(200, { answers: { q: { probabilities: { moved: 0.9, new: 0.1 } } } }, overrideSeen),
      envOverride,
    );
    expect(overrideSeen[0]!.url).toBe("https://override.example.com/v1/systemone");
    expect(overrideSeen[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(overrideSeen[0]!.body?.model).toBe("override-model");
  });

  test("OpenAI is selected by an explicit save and sees only the probe or the candidate snippets", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const settings = "/api/sem-diff/opinion/settings";
    const opinion = "/api/sem-diff/opinion";
    expect((await route(opinion, "POST", { candidates: [candidate] }, openAICheck)).body).toMatchObject({ state: "off" });
    const requests: Array<{ url: string; key: string | null; body: Record<string, unknown> }> = [];
    const decisions = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(input), key: new Headers(init?.headers).get("authorization"), body });
      return body.questions[0].type === "predicate"
        ? Response.json({ answers: [{ type: "predicate", name: "q", probability: 0.99 }] })
        : Response.json({ answers: [{
            type: "choice", name: "q", choice: "moved", probabilities: [{ value: "moved", probability: 0.97 }],
          }] });
    }) as typeof fetch;
    const saved = await route(settings, "POST", { provider: "openai", apiKey: KEY }, decisions);
    const asked = await route(opinion, "POST", { candidates: [candidate, { ...candidate, kind: "inline" }] }, decisions);
    expect(saved.body).toMatchObject({ ok: true, provider: "openai" });
    expect(asked.body).toMatchObject({ ok: true, answers: [
      { accept: true, band: "likely", model: "gpt-6-luna", answer: "moved" },
      { accept: true, band: "likely", model: "gpt-6-luna", answer: "moved" },
    ] });
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.url).toBe("https://api.openai.com/v1/decisions");
      expect(request.key).toBe(`Bearer ${KEY}`);
      expect(request.body.model).toBe("gpt-6-luna");
    }
    expect(requests[0]?.body.input).toBe("A red apple.");
    expect(requests[1]?.body.input).toContain(candidate.code.helper);
    expect(requests[1]?.body.questions).toMatchObject([{ type: "choice", name: "q", choices: [
      { value: "moved" }, { value: "new" }, { value: "rewritten" }, { value: "elsewhere" },
    ] }]);
    expect(requests[2]?.body.questions).toMatchObject([{ choices: [
      { value: "moved" }, { value: "deleted" }, { value: "rewritten" }, { value: "elsewhere" },
    ] }]);
    expect(JSON.stringify([saved.body, asked.body])).not.toContain(KEY);
  });

  test("the endpoint, model and auth overrides never change where an OpenAI key is sent", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const seen: SeenCall[] = [];
    const decisions = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body });
      return body.questions[0].type === "predicate"
        ? Response.json({ answers: [{ type: "predicate", name: "q", probability: 0.99 }] })
        : Response.json({ answers: [{
            type: "choice", name: "q", choice: "moved", probabilities: [{ value: "moved", probability: 0.97 }],
          }] });
    }) as typeof fetch;
    const overrides = {
      PLANNOTATOR_OPINION_URL: "https://decisions.example.com/v1/systemone",
      PLANNOTATOR_OPINION_MODEL: "override-model",
      PLANNOTATOR_OPINION_AUTH: "api-key",
    };
    const saved = await route("/api/sem-diff/opinion/settings", "POST", { provider: "openai", apiKey: KEY }, decisions, overrides);
    expect(saved.body).toMatchObject({ ok: true, provider: "openai" });
    const asked = await route("/api/sem-diff/opinion", "POST", { candidates: [candidate] }, decisions, overrides);
    expect(asked.body).toMatchObject({ ok: true, answers: [{ accept: true, model: "gpt-6-luna" }] });
    // An override the Jev contract would refuse does not stop OpenAI either.
    const broken = await route("/api/sem-diff/opinion", "POST", { candidates: [{ ...candidate, helper: "other" }] }, decisions, {
      PLANNOTATOR_OPINION_URL: "ftp://bad.example.com",
      PLANNOTATOR_OPINION_AUTH: "basic",
    });
    expect(broken.body).toMatchObject({ ok: true });
    expect(seen).toHaveLength(3);
    for (const call of seen) {
      expect(call.url).toBe("https://api.openai.com/v1/decisions");
      expect(call.auth).toBe(`Bearer ${KEY}`);
      expect(call.body?.model).toBe("gpt-6-luna");
    }
    const settings = await route("/api/sem-diff/opinion/settings", "GET", null, decisions, overrides);
    expect(settings.body).toEqual({ configured: true, provider: "openai" });
  });

  test("a failed OpenAI key check keeps the active provider and distinguishes throttling from quota", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const settings = "/api/sem-diff/opinion/settings";
    const secret = { provider: "openai", apiKey: KEY };
    await route(settings, "POST", { provider: "jev", apiKey: KEY }, okCheck);
    for (const [response, failure] of [
      [stub(401, {}), "refused"],
      [stub(429, { error: { code: "project_spend_limit_exceeded" } }), "noCredit"],
      [stub(429, { error: { code: "rate_limit_exceeded" } }), "noAnswer"],
      [stub(200, { answers: [{ type: "refusal", name: "q" }] }), "noAnswer"],
    ] as const) {
      expect((await route(settings, "POST", secret, response)).body).toMatchObject({ ok: false, failure });
      expect((await route(settings, "GET", null, response)).body).toEqual({ configured: true, provider: "jev" });
    }
    expect((await route(settings, "POST", secret, openAICheck)).body).toMatchObject({ ok: true });
    const opinion = "/api/sem-diff/opinion";
    const refused = stub(200, { answers: [{ type: "refusal", name: "q" }] });
    const malformed = stub(200, { answers: [{ type: "choice", name: "q", choice: "moved", probabilities: [{ value: "moved", probability: 2 }] }] });
    for (const response of [refused, malformed]) {
      expect((await route(opinion, "POST", { candidates: [candidate] }, response)).body).toMatchObject({ ok: true, answers: [{ accept: false }] });
    }
    const rateLimited = stub(429, { error: { code: "slow_down", message: KEY } });
    const reply = await route(opinion, "POST", { candidates: [candidate] }, rateLimited);
    expect(reply.body).toMatchObject({ ok: false, state: "failed" });
    expect(JSON.stringify(reply.body)).not.toContain(KEY);
  });

  test("an OpenAI batch waiting behind another gets its whole time limit once its turn comes", async () => {
    // Each answer takes 120 ms against a 200 ms limit: the second batch would run out of time
    // if its clock started while it waited for the first.
    const slow = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json({ answers: [{
        type: "choice", name: "q", choice: "moved", probabilities: [{ value: "moved", probability: 0.97 }],
      }] })), 120);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(init.signal!.reason);
      });
    })) as typeof fetch;
    const ask = openaiAnswers(KEY, slow, 200);
    const [first, second] = await Promise.allSettled([ask([candidate as never]), ask([candidate as never])]);
    expect(first).toMatchObject({ status: "fulfilled", value: [{ accept: true }] });
    expect(second).toMatchObject({ status: "fulfilled", value: [{ accept: true }] });
  });
});

describe("a provider that redirects never gets the key forwarded", () => {
  // Two loopback servers with the real fetch: the provider the person named answers every call with a redirect to
  // another host, which records whatever reaches it.
  function redirectingProvider() {
    const reached: (string | null)[] = [];
    const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req) => {
      reached.push(req.headers.get("authorization"));
      return Response.json({ result: { answers: { q: { noul: 0.97 } } }, answers: [] });
    } });
    const named = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${other.port}/stolen` } }) });
    return { reached, url: `http://127.0.0.1:${named.port}/v1/systemone`, stop: () => { named.stop(true); other.stop(true); } };
  }

  test("a custom provider: the key check fails, the ask accepts nothing, and the other host hears nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const provider = redirectingProvider();
    try {
      const body = { provider: "custom", url: provider.url, auth: "bearer", apiKey: KEY };
      const checked = await route("/api/sem-diff/opinion/settings", "POST", body, fetch);
      expect(checked.body).toMatchObject({ ok: false });
      expect(existsSync(semDiffOpinionPath(dir))).toBe(false);
      // Saved while the provider still answered, then it starts redirecting.
      expect((await route("/api/sem-diff/opinion/settings", "POST", body, okCheck)).body).toMatchObject({ ok: true });
      const asked = await route("/api/sem-diff/opinion", "POST", { candidates: [candidate] }, fetch);
      // The engine's call stands (no link accepted), as when the provider does not answer.
      expect((asked.body as { answers?: { accept: boolean }[] }).answers?.map((answer) => answer.accept)).toEqual([false]);
      expect(provider.reached).toEqual([]);
    } finally {
      provider.stop();
    }
  });

  test("OpenAI: an answer that redirects is a failed ask, and the other host hears nothing", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const provider = redirectingProvider();
    try {
      expect((await route("/api/sem-diff/opinion/settings", "POST", { provider: "openai", apiKey: KEY }, openAICheck)).body).toMatchObject({ ok: true });
      // OpenAI's own address, sent to the loopback provider instead, with the init the module chose.
      const toLoopback = ((_input: RequestInfo | URL, init?: RequestInit) => fetch(provider.url, init)) as typeof fetch;
      const asked = await route("/api/sem-diff/opinion", "POST", { candidates: [candidate] }, toLoopback);
      expect(asked.body).toMatchObject({ ok: false });
      expect(provider.reached).toEqual([]);
    } finally {
      provider.stop();
    }
  });
});
