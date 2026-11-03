/**
 * Plannotator's daily ping: a Worker in front of one D1 table of daily totals.
 *
 *  - POST /ping     `{"version":"X.Y.Z","age_week":1-4,"tool":"plan","first":0|1}`
 *                   and nothing else: adds 1 to today's (UTC) total for that
 *                   version, age bucket and tool, and, when `first` is 1 (the
 *                   computer's first ping of the day), to the day's user
 *                   total. 204, no body. Anything else: 400 / 413 / 405.
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

export const MAX_BODY_BYTES = 160;
export const AGE_WEEKS = [1, 2, 3, 4] as const;
export const TOOLS = ["inbox", "plan", "review", "annotate", "last"] as const;
/** How many days GET /totals answers, newest last. */
export const TOTALS_DAYS = 400;

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const DAY_MS = 86_400_000;

export const TOOL_UPSERT_SQL =
  "INSERT INTO daily (day, version, age_week, tool, n) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT (day, version, age_week, tool) DO UPDATE SET n = n + 1";
export const TOTAL_UPSERT_SQL =
  "INSERT INTO daily_total (day, version, age_week, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, version, age_week) DO UPDATE SET n = n + 1";
export const TOOL_TOTALS_SQL = "SELECT day, version, age_week, tool, n FROM daily WHERE day >= ?1";
export const USER_TOTALS_SQL = "SELECT day, version, age_week, n FROM daily_total WHERE day >= ?1";

export interface Ping {
  version: string;
  age_week: (typeof AGE_WEEKS)[number];
  tool: (typeof TOOLS)[number];
  first: 0 | 1;
}

/**
 * The body, or null: exactly the keys `version` (X.Y.Z), `age_week` (1-4),
 * `tool` (one of TOOLS) and `first` (0 or 1).
 */
export function parsePing(text: string): Ping | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "age_week,first,tool,version") return null;
  const { version, age_week, tool, first } = value as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (typeof age_week !== "number" || !(AGE_WEEKS as readonly number[]).includes(age_week)) return null;
  if (typeof tool !== "string" || !(TOOLS as readonly string[]).includes(tool)) return null;
  if (first !== 0 && first !== 1) return null;
  return { version, age_week: age_week as Ping["age_week"], tool: tool as Ping["tool"], first };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

export interface DayTotals {
  day: string;
  /** Computers that sent any ping that day (the pings with `first: 1`). */
  users: number;
  /** Users per install-age bucket. */
  age_week: Record<string, number>;
  /** Users per version. */
  versions: Record<string, number>;
  /** Computers that used each tool that day. */
  tools: Record<string, number>;
}

type ToolRow = { day: string; version: string; age_week: number; tool: string; n: number };
type UserRow = { day: string; version: string; age_week: number; n: number };

/** The rows, summed per day. */
export function sumDays(users: UserRow[], tools: ToolRow[]): DayTotals[] {
  const days = new Map<string, DayTotals>();
  const day = (d: string) => {
    let t = days.get(d);
    if (!t) days.set(d, (t = { day: d, users: 0, age_week: {}, versions: {}, tools: {} }));
    return t;
  };
  for (const row of users) {
    const t = day(row.day);
    t.users += row.n;
    t.age_week[String(row.age_week)] = (t.age_week[String(row.age_week)] ?? 0) + row.n;
    t.versions[row.version] = (t.versions[row.version] ?? 0) + row.n;
  }
  for (const row of tools) {
    const t = day(row.day);
    t.tools[row.tool] = (t.tools[row.tool] ?? 0) + row.n;
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
    const day = utcDay(now);
    await env.DB.prepare(TOOL_UPSERT_SQL).bind(day, ping.version, ping.age_week, ping.tool).run();
    if (ping.first === 1) await env.DB.prepare(TOTAL_UPSERT_SQL).bind(day, ping.version, ping.age_week).run();
    return empty(204);
  }
  if (path === "/totals") {
    if (req.method !== "GET") return empty(405);
    const from = utcDay(now - (TOTALS_DAYS - 1) * DAY_MS);
    const users = await env.DB.prepare(USER_TOTALS_SQL).bind(from).all<UserRow>();
    const tools = await env.DB.prepare(TOOL_TOTALS_SQL).bind(from).all<ToolRow>();
    return new Response(JSON.stringify({ days: sumDays(users.results, tools.results) }), {
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
