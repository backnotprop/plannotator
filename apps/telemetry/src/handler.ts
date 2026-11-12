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

export interface TotalsCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}

export const TOTALS_CACHE_SECONDS = 300;
const TOTALS_CACHE_KEY = "https://ping.plannotator.ai/totals";

export const MAX_BODY_BYTES = 160;
export const AGE_WEEKS = [1, 2, 3, 4] as const;
export const TOOLS = ["inbox", "plan", "review", "annotate", "last"] as const;
export const FAVICONS = ["glass", "yellow", "face", "none"] as const;
export const TOTALS_DAYS = 90;

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const DAY_MS = 86_400_000;

export const TOOL_UPSERT_SQL =
  "INSERT INTO daily (day, version, age_week, tool, n) VALUES (?1, ?2, ?3, ?4, 1) ON CONFLICT (day, version, age_week, tool) DO UPDATE SET n = n + 1";
export const TOTAL_UPSERT_SQL =
  "INSERT INTO daily_total (day, version, age_week, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, version, age_week) DO UPDATE SET n = n + 1";
export const FAVICON_UPSERT_SQL =
  "INSERT INTO daily_favicon (day, favicon, n) VALUES (?1, ?2, 1) ON CONFLICT (day, favicon) DO UPDATE SET n = n + 1";
export const TOOL_TOTALS_SQL = "SELECT day, version, age_week, tool, n FROM daily WHERE day >= ?1";
export const USER_TOTALS_SQL = "SELECT day, version, age_week, n FROM daily_total WHERE day >= ?1";
export const FAVICON_TOTALS_SQL = "SELECT day, favicon, n FROM daily_favicon WHERE day >= ?1";

export interface Ping {
  version: string;
  age_week: (typeof AGE_WEEKS)[number];
  tool: (typeof TOOLS)[number];
  first: 0 | 1;
  favicon?: (typeof FAVICONS)[number];
}

export function parsePing(text: string): Ping | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "age_week,first,tool,version" && keys !== "age_week,favicon,first,tool,version") return null;
  const { version, age_week, tool, first, favicon } = value as Record<string, unknown>;
  if (typeof version !== "string" || !VERSION_RE.test(version)) return null;
  if (typeof age_week !== "number" || !(AGE_WEEKS as readonly number[]).includes(age_week)) return null;
  if (typeof tool !== "string" || !(TOOLS as readonly string[]).includes(tool)) return null;
  if (first !== 0 && first !== 1) return null;
  const out: Ping = { version, age_week: age_week as Ping["age_week"], tool: tool as Ping["tool"], first };
  if (favicon === undefined) return out;
  if (typeof favicon !== "string" || !(FAVICONS as readonly string[]).includes(favicon)) return null;
  return { ...out, favicon: favicon as Ping["favicon"] };
}

function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function empty(status: number): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

export interface DayTotals {
  day: string;
  users: number;
  age_week: Record<string, number>;
  versions: Record<string, number>;
  tools: Record<string, number>;
  favicon: Record<string, number>;
}

type ToolRow = { day: string; version: string; age_week: number; tool: string; n: number };
type UserRow = { day: string; version: string; age_week: number; n: number };
type FaviconRow = { day: string; favicon: string; n: number };

export function sumDays(users: UserRow[], tools: ToolRow[], favicons: FaviconRow[]): DayTotals[] {
  const days = new Map<string, DayTotals>();
  const day = (d: string) => {
    let t = days.get(d);
    if (!t) days.set(d, (t = { day: d, users: 0, age_week: {}, versions: {}, tools: {}, favicon: {} }));
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
  for (const row of favicons) {
    const t = day(row.day);
    t.favicon[row.favicon] = (t.favicon[row.favicon] ?? 0) + row.n;
  }
  return [...days.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}

async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

export async function handleRequest(req: Request, env: Env, now: number = Date.now(), cache?: TotalsCache): Promise<Response> {
  const path = new URL(req.url).pathname;
  if (path === "/ping") {
    if (req.method !== "POST") return empty(405);
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (!(declared <= MAX_BODY_BYTES)) return empty(413);
    const bytes = await readCapped(req, MAX_BODY_BYTES);
    if (!bytes) return empty(413);
    const ping = parsePing(new TextDecoder().decode(bytes));
    if (!ping) return empty(400);
    const day = utcDay(now);
    await env.DB.prepare(TOOL_UPSERT_SQL).bind(day, ping.version, ping.age_week, ping.tool).run();
    if (ping.first === 1) {
      await env.DB.prepare(TOTAL_UPSERT_SQL).bind(day, ping.version, ping.age_week).run();
      if (ping.favicon) await env.DB.prepare(FAVICON_UPSERT_SQL).bind(day, ping.favicon).run();
    }
    return empty(204);
  }
  if (path === "/totals") {
    if (req.method !== "GET") return empty(405);
    const key = new Request(TOTALS_CACHE_KEY);
    const hit = await cache?.match(key);
    if (hit) return hit;
    const from = utcDay(now - (TOTALS_DAYS - 1) * DAY_MS);
    const users = await env.DB.prepare(USER_TOTALS_SQL).bind(from).all<UserRow>();
    const tools = await env.DB.prepare(TOOL_TOTALS_SQL).bind(from).all<ToolRow>();
    const favicons = await env.DB.prepare(FAVICON_TOTALS_SQL).bind(from).all<FaviconRow>();
    const res = new Response(JSON.stringify({ days: sumDays(users.results, tools.results, favicons.results) }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${TOTALS_CACHE_SECONDS}`,
        "access-control-allow-origin": "*",
      },
    });
    await cache?.put(key, res.clone());
    return res;
  }
  return empty(404);
}
