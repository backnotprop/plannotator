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

function stub(status: number, body: unknown, seen?: Array<{ url: string; auth: string | null }>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen?.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

const okCheck = stub(200, { result: { answers: { q: { noul: 0.97 } } } });
const openAICheck = stub(200, { answers: [{ type: "predicate", name: "q", probability: 0.99 }] });
const candidate = { kind: "extract", helper: "subtotal", caller: "checkout", file: "src/checkout.ts", code: { helper: "function subtotal() {}", caller: "a", callerNew: "b" } };
const route = (pathname: string, method: string, body: unknown, f: typeof fetch) => answerSemDiffOpinionRequest(pathname, method, async () => body, dir, f);

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
