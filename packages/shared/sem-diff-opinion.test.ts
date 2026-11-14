import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerSemDiffOpinionRequest, semDiffOpinionPath } from "./sem-diff-opinion";

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
const candidate = { kind: "extract", helper: "subtotal", caller: "checkout", file: "src/checkout.ts", code: { helper: "function subtotal() {}", caller: "a", callerNew: "b" } };
const route = (pathname: string, method: string, body: unknown, f: typeof fetch) => answerSemDiffOpinionRequest(pathname, method, async () => body, dir, f);

describe("Power Up key and opinion routes", () => {
  test("a key is checked before it is kept, kept 0600 outside config.json, and never answered back", async () => {
    dir = mkdtempSync(join(tmpdir(), "pn-opinion-"));
    const refused = await route("/api/sem-diff/opinion/settings", "POST", { provider: "jev", apiKey: KEY }, stub(401, { error: "nope" }));
    expect(refused.body).toEqual({ ok: false, reason: "The key was refused." });
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
});
