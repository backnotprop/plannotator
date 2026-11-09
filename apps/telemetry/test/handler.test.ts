/**
 * The daily ping's Worker (src/handler.ts) against a fake D1 that records
 * every statement and runs the three upserts on in-memory tables. Guards: only
 * an exact `{version, age_week, tool, first}` body, with or without
 * `favicon`, counts; one ping is one `n = n + 1` on its tool's row, and a
 * `first: 1` ping one more on the day's user total and, when it names a
 * favicon, on the day's favicon row, which holds nothing but the day; nothing
 * from the request but those fields (no IP, no header, no request.cf) reaches
 * the database; no table has a column that could hold one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FAVICON_TOTALS_SQL,
  FAVICON_UPSERT_SQL,
  handleRequest,
  MAX_BODY_BYTES,
  type PingDb,
  TOOL_TOTALS_SQL,
  TOOL_UPSERT_SQL,
  TOTAL_UPSERT_SQL,
  TOTALS_DAYS,
  type TotalsCache,
  USER_TOTALS_SQL,
} from "../src/handler";

const NOW = Date.parse("2026-11-03T12:34:56Z");

function fakeDb() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const daily = new Map<string, { day: string; version: string; age_week: number; tool: string; n: number }>();
  const total = new Map<string, { day: string; version: string; age_week: number; n: number }>();
  const favicon = new Map<string, { day: string; favicon: string; n: number }>();
  const db: PingDb = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          calls.push({ sql, values });
          return {
            async run() {
              if (sql === TOOL_UPSERT_SQL) {
                const [day, version, age_week, tool] = values as [string, string, number, string];
                const key = `${day}|${version}|${age_week}|${tool}`;
                const row = daily.get(key);
                if (row) row.n += 1;
                else daily.set(key, { day, version, age_week, tool, n: 1 });
              } else if (sql === TOTAL_UPSERT_SQL) {
                const [day, version, age_week] = values as [string, string, number];
                const key = `${day}|${version}|${age_week}`;
                const row = total.get(key);
                if (row) row.n += 1;
                else total.set(key, { day, version, age_week, n: 1 });
              } else if (sql === FAVICON_UPSERT_SQL) {
                const [day, value] = values as [string, string];
                const key = `${day}|${value}`;
                const row = favicon.get(key);
                if (row) row.n += 1;
                else favicon.set(key, { day, favicon: value, n: 1 });
              } else throw new Error(`unexpected write: ${sql}`);
              return {};
            },
            async all<T>() {
              const [from] = values as [string];
              if (sql === TOOL_TOTALS_SQL) return { results: [...daily.values()].filter((r) => r.day >= from) as T[] };
              if (sql === USER_TOTALS_SQL) return { results: [...total.values()].filter((r) => r.day >= from) as T[] };
              if (sql === FAVICON_TOTALS_SQL) return { results: [...favicon.values()].filter((r) => r.day >= from) as T[] };
              throw new Error(`unexpected read: ${sql}`);
            },
          };
        },
      };
    },
  };
  return { db, calls, daily, total, favicon };
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

const body = (version: string, age_week: number, tool: string, first: 0 | 1) => JSON.stringify({ version, age_week, tool, first });
const withFavicon = (version: string, age_week: number, tool: string, first: 0 | 1, favicon: string) => JSON.stringify({ version, age_week, tool, first, favicon });

describe("POST /ping", () => {
  test("a ping adds 1 to today's tool row; first: 1 also adds 1 to the day's user total; 204", async () => {
    const { db, daily, total } = fakeDb();
    expect((await handleRequest(ping(body("0.28.46", 2, "plan", 1)), { DB: db }, NOW)).status).toBe(204);
    expect((await handleRequest(ping(body("0.28.46", 2, "review", 0)), { DB: db }, NOW)).status).toBe(204);
    // Key order does not matter.
    expect((await handleRequest(ping('{"first":1,"tool":"plan","age_week":2,"version":"0.28.46"}'), { DB: db }, NOW)).status).toBe(204);
    expect((await handleRequest(ping(body("0.28.46", 1, "inbox", 1)), { DB: db }, NOW)).status).toBe(204);
    expect([...daily.values()]).toEqual([
      { day: "2026-11-03", version: "0.28.46", age_week: 2, tool: "plan", n: 2 },
      { day: "2026-11-03", version: "0.28.46", age_week: 2, tool: "review", n: 1 },
      { day: "2026-11-03", version: "0.28.46", age_week: 1, tool: "inbox", n: 1 },
    ]);
    expect([...total.values()]).toEqual([
      { day: "2026-11-03", version: "0.28.46", age_week: 2, n: 2 },
      { day: "2026-11-03", version: "0.28.46", age_week: 1, n: 1 },
    ]);
  });

  test("the five-key body counts like the four-key one, and its favicon once a computer a day: only on first: 1, in its own table", async () => {
    const { db, calls, daily, total, favicon } = fakeDb();
    for (const b of [
      withFavicon("0.28.57", 2, "plan", 1, "glass"),
      withFavicon("0.28.57", 2, "review", 0, "glass"),
      withFavicon("0.28.57", 2, "annotate", 0, "glass"),
      withFavicon("0.28.57", 1, "inbox", 1, "face"),
      withFavicon("0.28.57", 4, "last", 1, "face"),
      withFavicon("0.28.57", 3, "plan", 1, "none"),
      withFavicon("0.28.57", 2, "plan", 1, "yellow"),
      withFavicon("0.28.57", 2, "review", 0, "yellow"),
      withFavicon("0.28.57", 3, "inbox", 1, "glass"),
      // Key order does not matter.
      '{"favicon":"face","first":1,"tool":"review","age_week":2,"version":"0.28.57"}',
      // An older release: no favicon, counted as before, no favicon row.
      body("0.28.46", 2, "plan", 1),
    ])
      expect({ b, status: (await handleRequest(ping(b), { DB: db }, NOW)).status }).toEqual({ b, status: 204 });
    expect([...favicon.values()]).toEqual([
      { day: "2026-11-03", favicon: "glass", n: 2 },
      { day: "2026-11-03", favicon: "face", n: 3 },
      { day: "2026-11-03", favicon: "none", n: 1 },
      { day: "2026-11-03", favicon: "yellow", n: 1 },
    ]);
    expect([...total.values()].reduce((n, r) => n + r.n, 0)).toBe(8);
    expect([...daily.values()].reduce((n, r) => n + r.n, 0)).toBe(11);
    // The favicon row is written with the day alone: never the version, age bucket or tool.
    expect(calls.filter((c) => c.sql === FAVICON_UPSERT_SQL).map((c) => c.values)).toEqual([
      ["2026-11-03", "glass"],
      ["2026-11-03", "face"],
      ["2026-11-03", "face"],
      ["2026-11-03", "none"],
      ["2026-11-03", "yellow"],
      ["2026-11-03", "glass"],
      ["2026-11-03", "face"],
    ]);
  });

  test("the longest five-key body a release can send fits under the byte cap", () => {
    const longest = withFavicon("9999.9999.9999", 4, "annotate", 1, "yellow");
    expect(new TextEncoder().encode(longest).byteLength).toBeLessThanOrEqual(MAX_BODY_BYTES);
  });

  test("anything but exactly {version: X.Y.Z, age_week: 1-4, tool, first: 0|1} is refused and counts nothing", async () => {
    const { db, calls } = fakeDb();
    const bad = [
      "",
      "not json",
      "[]",
      "null",
      '{"version":"0.28.46","age_week":2,"tool":"plan"}',
      '{"version":"0.28.46","age_week":2,"first":1}',
      '{"version":"0.28.46","tool":"plan","first":1}',
      '{"age_week":2,"tool":"plan","first":1}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":1,"os":"darwin"}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":1,"id":"abc"}',
      '{"version":"0.28.46","age":2,"tool":"plan","first":1}',
      body("0.28", 2, "plan", 1),
      body("0.28.46-dev", 2, "plan", 1),
      body("v0.28.46", 2, "plan", 1),
      '{"version":28,"age_week":2,"tool":"plan","first":1}',
      body("0.28.46", 0, "plan", 1),
      body("0.28.46", 5, "plan", 1),
      body("0.28.46", 2.5, "plan", 1),
      '{"version":"0.28.46","age_week":"2","tool":"plan","first":1}',
      body("0.28.46", 2, "chat", 1),
      body("0.28.46", 2, "Plan", 1),
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":2}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":true}',
      withFavicon("0.28.46", 2, "plan", 1, "totman"),
      withFavicon("0.28.46", 2, "plan", 1, "classic"),
      withFavicon("0.28.46", 2, "plan", 1, "p"),
      withFavicon("0.28.46", 2, "plan", 1, "Glass"),
      withFavicon("0.28.46", 2, "plan", 1, "Yellow"),
      withFavicon("0.28.46", 2, "plan", 1, ""),
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":1,"favicon":null}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":1,"favicon":1}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","favicon":"glass"}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":1,"favicon":"glass","os":"darwin"}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":1,"icon":"glass"}',
    ];
    for (const b of bad) expect({ b, status: (await handleRequest(ping(b), { DB: db }, NOW)).status }).toEqual({ b, status: 400 });
    const big = JSON.stringify({ version: "0.28.46", age_week: 2, tool: "plan", first: 1, pad: "x".repeat(MAX_BODY_BYTES) });
    expect((await handleRequest(ping(big), { DB: db }, NOW)).status).toBe(413);
    expect((await handleRequest(new Request("https://ping.plannotator.ai/ping"), { DB: db }, NOW)).status).toBe(405);
    expect((await handleRequest(new Request("https://ping.plannotator.ai/other", { method: "POST", body: "{}" }), { DB: db }, NOW)).status).toBe(404);
    expect(calls).toEqual([]);
  });

  test("a large body is refused unread: by its Content-Length, or once it passes the cap", async () => {
    const { db, calls } = fakeDb();
    // A declared size over the cap: refused before any byte is read.
    let pulled = 0;
    // highWaterMark 0: a chunk is made only when the Worker reads.
    const endless = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(64 * 1024));
        },
      },
      { highWaterMark: 0 },
    );
    const declared = new Request("https://ping.plannotator.ai/ping", { method: "POST", body: endless, headers: { "content-length": String(10 * 1024 * 1024) }, duplex: "half" } as RequestInit);
    expect((await handleRequest(declared, { DB: db }, NOW)).status).toBe(413);
    expect(pulled).toBe(0);
    // No length, or a false one: read only until it passes the cap.
    const lying = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(100));
      },
    });
    pulled = 0;
    const undeclared = new Request("https://ping.plannotator.ai/ping", { method: "POST", body: lying, duplex: "half" } as RequestInit);
    expect((await handleRequest(undeclared, { DB: db }, NOW)).status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(3);
    expect(calls).toEqual([]);
  });

  test("stores no IP, header or request.cf field: only the day, version, age_week and tool reach D1", async () => {
    const { db, calls } = fakeDb();
    await handleRequest(ping(body("0.28.46", 3, "annotate", 1)), { DB: db }, NOW);
    expect(calls.map((c) => c.values)).toEqual([
      ["2026-11-03", "0.28.46", 3, "annotate"],
      ["2026-11-03", "0.28.46", 3],
    ]);
    const written = JSON.stringify(calls);
    for (const leak of [IP, "Berlin", "DE", "3320", "plannotator\"", "T12:34"]) expect(written).not.toContain(leak);
  });

  test("no table has a column for an IP, a time or an ID, and the handler never reads headers or request.cf", () => {
    const migrations = join(import.meta.dir, "..", "migrations");
    const sql = readdirSync(migrations)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => readFileSync(join(migrations, f), "utf-8"))
      .join("\n")
      .replace(/--.*$/gm, "");
    const tables = [...sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\) WITHOUT ROWID;/g)].map((m) => [m[1], [...m[2]!.matchAll(/^\s*(\w+)\s+(TEXT|INTEGER)\b/gm)].map((c) => c[1])]);
    expect(tables).toEqual([
      ["daily", ["day", "version", "age_week", "tool", "n"]],
      ["daily_total", ["day", "version", "age_week", "n"]],
      ["daily_favicon", ["day", "favicon", "n"]],
    ]);
    const source = readFileSync(join(import.meta.dir, "..", "src", "handler.ts"), "utf-8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // The one header it reads is Content-Length, to refuse a large body unread.
    expect([...source.matchAll(/req\.headers[^;]*/g)].map((m) => m[0])).toEqual(['req.headers.get("content-length") ?? "0")']);
    expect(source).not.toMatch(/\.cf\b|console\./);
  });
});

function fakeCache() {
  const store = new Map<string, Response>();
  const cache: TotalsCache = {
    async match(key) {
      return store.get(key.url)?.clone();
    },
    async put(key, res) {
      store.set(key.url, res);
    },
  };
  return { cache, store };
}

describe("GET /totals", () => {
  test("answered from the cache after the first read: repeat GETs, with any query string, never touch D1", async () => {
    const { db, calls } = fakeDb();
    const { cache } = fakeCache();
    await handleRequest(ping(body("0.28.46", 1, "plan", 1)), { DB: db }, NOW);
    const first = await handleRequest(new Request("https://ping.plannotator.ai/totals"), { DB: db }, NOW, cache);
    const reads = () => calls.filter((c) => c.sql === TOOL_TOTALS_SQL || c.sql === USER_TOTALS_SQL || c.sql === FAVICON_TOTALS_SQL).length;
    expect(reads()).toBe(3);
    expect(first.headers.get("cache-control")).toBe("public, max-age=300");
    for (const url of ["https://ping.plannotator.ai/totals", "https://ping.plannotator.ai/totals?x=1"]) {
      const again = await handleRequest(new Request(url), { DB: db }, NOW, cache);
      expect(again.status).toBe(200);
      expect(await again.json()).toEqual(await first.clone().json());
    }
    expect(reads()).toBe(3);
  });

  test("reads only the last 90 days", async () => {
    const { db, calls } = fakeDb();
    await handleRequest(new Request("https://ping.plannotator.ai/totals"), { DB: db }, NOW);
    expect(TOTALS_DAYS).toBe(90);
    expect(calls.map((c) => c.values)).toEqual([["2026-08-06"], ["2026-08-06"], ["2026-08-06"]]);
  });

  test("public JSON of daily sums: users, per age bucket, per version, per tool, per favicon", async () => {
    const { db } = fakeDb();
    const send = (b: string, at = NOW) => handleRequest(ping(b), { DB: db }, at);
    await send(body("0.28.46", 1, "plan", 1));
    await send(body("0.28.46", 1, "review", 0));
    await send(body("0.28.46", 4, "inbox", 1));
    await send(body("0.28.46", 4, "plan", 0));
    await send(body("0.28.45", 4, "last", 1));
    await send(withFavicon("0.28.57", 2, "plan", 1, "face"));
    await send(withFavicon("0.28.57", 2, "review", 0, "face"));
    await send(withFavicon("0.28.57", 3, "inbox", 1, "none"));
    await send(body("0.28.46", 4, "annotate", 1), NOW + 86_400_000);
    await send(withFavicon("0.28.57", 1, "plan", 1, "glass"), NOW + 86_400_000);
    const res = await handleRequest(new Request("https://ping.plannotator.ai/totals"), { DB: db }, NOW + 86_400_000);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({
      days: [
        {
          day: "2026-11-03",
          users: 5,
          age_week: { "1": 1, "4": 2, "2": 1, "3": 1 },
          versions: { "0.28.46": 2, "0.28.45": 1, "0.28.57": 2 },
          tools: { plan: 3, review: 2, inbox: 2, last: 1 },
          favicon: { face: 1, none: 1 },
        },
        { day: "2026-11-04", users: 2, age_week: { "4": 1, "1": 1 }, versions: { "0.28.46": 1, "0.28.57": 1 }, tools: { annotate: 1, plan: 1 }, favicon: { glass: 1 } },
      ],
    });
    expect((await handleRequest(new Request("https://ping.plannotator.ai/totals", { method: "POST", body: "{}" }), { DB: db }, NOW)).status).toBe(405);
  });
});
