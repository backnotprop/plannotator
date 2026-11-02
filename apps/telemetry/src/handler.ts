/**
 * Plannotator's daily ping: a Worker in front of one D1 table of daily totals.
 *
 *  - POST /ping     `{"version":"X.Y.Z","age":1|2|3|4}` and nothing else:
 *                   adds 1 to today's (UTC) total for that version and age
 *                   bucket. 204, no body. Anything else: 400 / 413 / 405.
 *  - GET  /totals   read-only JSON of the daily sums, for a public page.
 *
 * It stores no IP, no header, no `request.cf` field, no time finer than the
 * UTC day, and no row per request. It never reads a request header and never
 * logs. The client is packages/shared/daily-ping.ts.
 */

/** The part of D1 this Worker uses (D1Database fits; tests pass a fake). */
export interface PingDb {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<unknown>;
      all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
    };
  };
}

export interface Env {
  DB: PingDb;
}

export const MAX_BODY_BYTES = 128;
export const AGES = [1, 2, 3, 4] as const;
/** How many days GET /totals answers, newest last. */
export const TOTALS_DAYS = 400;

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const DAY_MS = 86_400_000;

export const UPSERT_SQL = "INSERT INTO daily (day, version, age, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, version, age) DO UPDATE SET n = n + 1";
export const TOTALS_SQL = "SELECT day, version, age, n FROM daily WHERE day >= ?1 ORDER BY day, version, age";

export interface Ping {
  version: string;
  age: (typeof AGES)[number];
}

/** The body, or null: exactly the keys `version` and `age`, a X.Y.Z version, an age from AGES. */
export function parsePing(text: string): Ping | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "age" || keys[1] !== "version") return null;
  const { version, age } = value as { version: unknown; age: unknown };
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (typeof age !== "number" || !(AGES as readonly number[]).includes(age)) return null;
  return { version, age: age as Ping["age"] };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

export interface DayTotals {
  day: string;
  n: number;
  age: Record<string, number>;
  versions: Record<string, number>;
}

/** The rows, summed per day: the whole day, per age bucket, per version. */
export function sumDays(rows: { day: string; version: string; age: number; n: number }[]): DayTotals[] {
  const days = new Map<string, DayTotals>();
  for (const row of rows) {
    let d = days.get(row.day);
    if (!d) days.set(row.day, (d = { day: row.day, n: 0, age: {}, versions: {} }));
    d.n += row.n;
    d.age[String(row.age)] = (d.age[String(row.age)] ?? 0) + row.n;
    d.versions[row.version] = (d.versions[row.version] ?? 0) + row.n;
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

export async function handleRequest(req: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/ping") {
    if (req.method !== "POST") return empty(405);
    const bytes = await req.arrayBuffer();
    if (bytes.byteLength > MAX_BODY_BYTES) return empty(413);
    const ping = parsePing(new TextDecoder().decode(bytes));
    if (!ping) return empty(400);
    await env.DB.prepare(UPSERT_SQL).bind(utcDay(now), ping.version, ping.age).run();
    return empty(204);
  }
  if (path === "/totals") {
    if (req.method !== "GET") return empty(405);
    const from = utcDay(now - (TOTALS_DAYS - 1) * DAY_MS);
    const { results } = await env.DB.prepare(TOTALS_SQL).bind(from).all<{ day: string; version: string; age: number; n: number }>();
    return new Response(JSON.stringify({ days: sumDays(results) }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    });
  }
  return empty(404);
}
