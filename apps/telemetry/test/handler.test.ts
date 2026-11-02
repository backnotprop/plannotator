/**
 * The daily ping's Worker (src/handler.ts) against a fake D1 that records
 * every statement and runs the upsert on an in-memory table. Guards: only an
 * exact `{version, age}` body counts; one ping is one `n = n + 1`; nothing
 * from the request but the version and age (no IP, no header, no request.cf)
 * reaches the database; the table has no column that could hold one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { handleRequest, MAX_BODY_BYTES, type PingDb } from "../src/handler";

const NOW = Date.parse("2026-11-03T12:34:56Z");

function fakeDb() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const table = new Map<string, { day: string; version: string; age: number; n: number }>();
  const db: PingDb = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            async run() {
              if (!sql.startsWith("INSERT INTO daily (day, version, age, n)") || !sql.includes("ON CONFLICT (day, version, age) DO UPDATE SET n = n + 1")) throw new Error(`unexpected write: ${sql}`);
              const [day, version, age] = values as [string, string, number];
              const key = `${day}|${version}|${age}`;
              const row = table.get(key);
              if (row) row.n += 1;
              else table.set(key, { day, version, age, n: 1 });
              return {};
            },
            async all<T>() {
              const [from] = values as [string];
              return { results: [...table.values()].filter((r) => r.day >= from) as T[] };
            },
          };
        },
      };
    },
  };
  return { db, calls, table };
}

const IP = "203.0.113.77";

function ping(body: string, init: RequestInit = {}): Request {
  const req = new Request("https://ping.plannotator.ai/ping", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "cf-connecting-ip": IP, "x-forwarded-for": IP, "x-real-ip": IP, "user-agent": "plannotator" },
    ...init,
  });
  // What Cloudflare attaches at the edge; the Worker must never read it.
  Object.defineProperty(req, "cf", { value: { country: "DE", city: "Berlin", asn: 3320, clientTcpRtt: 12 } });
  return req;
}

describe("POST /ping", () => {
  test("a valid ping adds 1 to today's (version, age) total and answers 204", async () => {
    const { db, table } = fakeDb();
    expect((await handleRequest(ping('{"version":"0.28.46","age":2}'), { DB: db }, NOW)).status).toBe(204);
    expect((await handleRequest(ping('{"age":2,"version":"0.28.46"}'), { DB: db }, NOW)).status).toBe(204);
    expect((await handleRequest(ping('{"version":"0.28.46","age":1}'), { DB: db }, NOW)).status).toBe(204);
    expect([...table.values()]).toEqual([
      { day: "2026-11-03", version: "0.28.46", age: 2, n: 2 },
      { day: "2026-11-03", version: "0.28.46", age: 1, n: 1 },
    ]);
  });

  test("anything but exactly {version: X.Y.Z, age: 1-4} is refused and counts nothing", async () => {
    const { db, calls } = fakeDb();
    const bad = [
      "",
      "not json",
      "[]",
      "null",
      '{"version":"0.28.46"}',
      '{"age":2}',
      '{"version":"0.28.46","age":2,"os":"darwin"}',
      '{"version":"0.28.46","age":2,"id":"abc"}',
      '{"version":"0.28","age":2}',
      '{"version":"0.28.46-dev","age":2}',
      '{"version":"v0.28.46","age":2}',
      '{"version":28,"age":2}',
      '{"version":"0.28.46","age":0}',
      '{"version":"0.28.46","age":5}',
      '{"version":"0.28.46","age":2.5}',
      '{"version":"0.28.46","age":"2"}',
    ];
    for (const body of bad) expect({ body, status: (await handleRequest(ping(body), { DB: db }, NOW)).status }).toEqual({ body, status: 400 });
    const big = JSON.stringify({ version: "0.28.46", age: 2, pad: "x".repeat(MAX_BODY_BYTES) });
    expect((await handleRequest(ping(big), { DB: db }, NOW)).status).toBe(413);
    expect((await handleRequest(new Request("https://ping.plannotator.ai/ping"), { DB: db }, NOW)).status).toBe(405);
    expect((await handleRequest(new Request("https://ping.plannotator.ai/other", { method: "POST", body: "{}" }), { DB: db }, NOW)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("stores no IP, header or request.cf field: only the day, the version and the age reach D1", async () => {
    const { db, calls } = fakeDb();
    await handleRequest(ping('{"version":"0.28.46","age":3}'), { DB: db }, NOW);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.values).toEqual(["2026-11-03", "0.28.46", 3]);
    const written = JSON.stringify(calls);
    for (const leak of [IP, "Berlin", "DE", "3320", "plannotator\"", "T12:34"]) expect(written).not.toContain(leak);
  });

  test("the table has no column for an IP, a time or an ID, and the handler never reads headers or request.cf", () => {
    const sql = readFileSync(join(import.meta.dir, "..", "migrations", "0001_daily.sql"), "utf-8").replace(/--.*$/gm, "");
    const columns = [...sql.matchAll(/^\s*(\w+)\s+(TEXT|INTEGER)\b/gm)].map((m) => m[1]);
    expect(columns).toEqual(["day", "version", "age", "n"]);
    const source = readFileSync(join(import.meta.dir, "..", "src", "handler.ts"), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(source).not.toMatch(/req\.headers|\.cf\b|console\./);
  });
});

describe("GET /totals", () => {
  test("public JSON of daily sums: per day, per age bucket and per version", async () => {
    const { db } = fakeDb();
    await handleRequest(ping('{"version":"0.28.46","age":1}'), { DB: db }, NOW);
    await handleRequest(ping('{"version":"0.28.46","age":4}'), { DB: db }, NOW);
    await handleRequest(ping('{"version":"0.28.45","age":4}'), { DB: db }, NOW);
    await handleRequest(ping('{"version":"0.28.46","age":4}'), { DB: db }, NOW + 86_400_000);
    const res = await handleRequest(new Request("https://ping.plannotator.ai/totals"), { DB: db }, NOW + 86_400_000);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      days: [
        { day: "2026-11-03", n: 3, age: { "1": 1, "4": 2 }, versions: { "0.28.46": 2, "0.28.45": 1 } },
        { day: "2026-11-04", n: 1, age: { "4": 1 }, versions: { "0.28.46": 1 } },
      ],
    });
    expect((await handleRequest(new Request("https://ping.plannotator.ai/totals", { method: "POST", body: "{}" }), { DB: db }, NOW)).status).toBe(405);
  });
});
