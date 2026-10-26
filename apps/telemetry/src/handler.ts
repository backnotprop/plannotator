/**
 * Usage counts for Plannotator's experimental features: a Worker in front of
 * one D1 table of daily totals (approval record "experimental-telemetry").
 *
 *  - POST /v1/counts    one batch from a Plannotator process: validated
 *                       against the registry the client builds from
 *                       (@plannotator/core/usage-counts), then added into
 *                       the day's totals. 204, no body.
 *  - GET  /v1/totals    the totals for agents, with a bearer token: only
 *                       days closed for good (older than the 3 days a batch
 *                       is accepted for); a (day, rev) with fewer than 5
 *                       reporting install-days, and any cell with fewer than
 *                       5 reports, is left out and counted as suppressed.
 *  - GET  /             one sentence about the service.
 *  - scheduled          retention: a feature's totals go 180 days after its
 *                       counting ends; anything older than 400 days goes; a
 *                       feature no longer in the registry goes.
 *
 * Stores no IP, no per-request row, no time beyond the day. Reads
 * CF-Connecting-IP only to hand it to the rate limiter, never `request.cf`,
 * and logs nothing about a request (the only log lines are fixed codes).
 */
import {
  addUtcDays,
  countBucketLabel,
  daysLast7Label,
  isUtcDay,
  parseUsageCountsBatch,
  USAGE_COUNT_FEATURES,
  USAGE_COUNTS_MAX_BODY_BYTES,
  USAGE_COUNTS_MIN_REPORTS,
  USAGE_COUNTS_PATH,
  USAGE_COUNTS_RETENTION_DAYS,
  usageCountsServedThrough,
  usageCountEvent,
  usageCountFeature,
  utcDay,
  utcDaysBetween,
  type UsageCountsBatch,
} from "@plannotator/core/usage-counts";

export interface Env {
  COUNTS: D1Database;
  /** `[[ratelimits]] name = "COUNTS_LIMITER"`. Optional: without it nothing is braked. */
  COUNTS_LIMITER?: RateLimit;
  /** The read route's bearer token (a secret). Without it every read is 401. */
  READ_TOKEN?: string;
}

/** The pseudo-event that counts batches (reporting install-days) per (day, feature, rev). */
export const REPORTS_EVENT = "_reports";
/** The longest range GET /v1/totals answers. */
export const MAX_TOTALS_RANGE_DAYS = 400;
/** Nothing is kept longer than this, whatever the registry says. */
export const MAX_KEEP_DAYS = 400;
const RATE_LIMIT_PERIOD_SECONDS = 60;

const BASE_HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, "content-type": "application/json", ...extra } });
}

function empty(status: number, extra: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { ...BASE_HEADERS, ...extra } });
}

/** The rows one batch adds 1 to: the reports row, then one per event. */
export function rowsForBatch(batch: UsageCountsBatch): { event: string; bucket: string; total: number }[] {
  const feature = usageCountFeature(batch.feature)!;
  const rows = [{ event: REPORTS_EVENT, bucket: "", total: 1 }];
  for (const [id, value] of Object.entries(batch.events)) {
    const def = usageCountEvent(feature, id)!;
    if (def.kind === "count") rows.push({ event: id, bucket: countBucketLabel(value), total: value });
    else if (def.kind === "days_last7") rows.push({ event: id, bucket: daysLast7Label(value)!, total: 0 });
    else rows.push({ event: id, bucket: "1", total: 1 });
  }
  return rows;
}

const UPSERT = `INSERT INTO daily_totals (day, feature, rev, event, bucket, reports, total) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)
ON CONFLICT (day, feature, rev, event, bucket) DO UPDATE SET reports = reports + 1, total = total + excluded.total`;

/** Read the body, refusing it the moment it passes the limit. Null when too large. */
async function readLimited(req: Request, limit: number): Promise<string | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return "\u0000";
  }
}

async function rateLimited(req: Request, limiter: RateLimit | undefined): Promise<boolean> {
  if (!limiter) return false;
  const ip = req.headers.get("cf-connecting-ip");
  if (!ip) return false;
  try {
    return !(await limiter.limit({ key: ip })).success;
  } catch {
    console.error("counts: limiter_failed");
    return false;
  }
}

async function postCounts(req: Request, env: Env, now: number): Promise<Response> {
  if (req.headers.has("origin")) return json({ code: "forbidden" }, 403);
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return json({ code: "unsupported_media_type" }, 415);
  const body = await readLimited(req, USAGE_COUNTS_MAX_BODY_BYTES);
  if (body === null) return json({ code: "too_large" }, 413);
  if (await rateLimited(req, env.COUNTS_LIMITER)) return json({ code: "rate_limited" }, 429, { "retry-after": String(RATE_LIMIT_PERIOD_SECONDS) });
  const batch = parseUsageCountsBatch(body, { today: utcDay(now) });
  if (!batch) return json({ code: "invalid" }, 400);
  try {
    await env.COUNTS.batch(
      rowsForBatch(batch).map((r) => env.COUNTS.prepare(UPSERT).bind(batch.day, batch.feature, batch.rev, r.event, r.bucket, r.total)),
    );
  } catch {
    console.error("counts: write_failed");
    return json({ code: "unavailable" }, 503);
  }
  return empty(204);
}

/** Constant-time comparison of two strings by their SHA-256 digests. */
async function sameSecret(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const ua = new Uint8Array(x);
  const ub = new Uint8Array(y);
  let diff = 0;
  for (let i = 0; i < ua.length; i++) diff |= ua[i]! ^ ub[i]!;
  return diff === 0;
}

interface EventTotals {
  reports: number;
  total: number;
  buckets: Record<string, number>;
}

interface DayTotals {
  day: string;
  rev: number;
  reports: number;
  events: Record<string, EventTotals>;
}

function addTo(target: Record<string, EventTotals>, event: string, bucket: string, reports: number, total: number): void {
  const t = (target[event] ??= { reports: 0, total: 0, buckets: {} });
  t.reports += reports;
  t.total += total;
  t.buckets[bucket] = (t.buckets[bucket] ?? 0) + reports;
}

async function getTotals(req: Request, env: Env, url: URL, now: number): Promise<Response> {
  const auth = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!env.READ_TOKEN || !auth || !(await sameSecret(auth, env.READ_TOKEN))) {
    return json({ code: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
  }
  const feature = url.searchParams.get("feature") ?? "";
  const from = url.searchParams.get("from") ?? "";
  const to = url.searchParams.get("to") ?? "";
  const revParam = url.searchParams.get("rev");
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(feature) || !isUtcDay(from) || !isUtcDay(to) || from > to) {
    return json({ code: "invalid", hint: "feature, from and to (YYYY-MM-DD, from <= to) are required" }, 400);
  }
  if (utcDaysBetween(from, to) >= MAX_TOTALS_RANGE_DAYS) return json({ code: "invalid", hint: `at most ${MAX_TOTALS_RANGE_DAYS} days` }, 400);
  if (revParam !== null && !/^[1-9]\d{0,5}$/.test(revParam)) return json({ code: "invalid", hint: "rev is a whole number" }, 400);

  // Only days no batch can still change: a day is accepted for
  // USAGE_COUNTS_MAX_DAYS_BACK days, so reading a total before and after one
  // install's batch is never possible through this route.
  const servedThrough = usageCountsServedThrough(utcDay(now));
  const upTo = to < servedThrough ? to : servedThrough;
  const where = revParam === null ? "" : " AND rev = ?4";
  const params: (string | number)[] = [feature, from, upTo, ...(revParam === null ? [] : [Number(revParam)])];
  const { results } =
    from > upTo
      ? { results: [] as { day: string; rev: number; event: string; bucket: string; reports: number; total: number }[] }
      : await env.COUNTS.prepare(
          `SELECT day, rev, event, bucket, reports, total FROM daily_totals WHERE feature = ?1 AND day BETWEEN ?2 AND ?3${where} ORDER BY day, rev, event, bucket`,
        )
          .bind(...params)
          .all<{ day: string; rev: number; event: string; bucket: string; reports: number; total: number }>();

  // A (day, rev) with fewer than 5 reports is hidden whole; inside a shown
  // day, any (event, bucket) cell with fewer than 5 reports is hidden too, and
  // never enters a sum, so no total can be subtracted from another to find it.
  const groups = new Map<string, { day: string; rev: number; reports: number; cells: typeof results }>();
  for (const row of results) {
    const key = `${row.day}\u0000${row.rev}`;
    const g = groups.get(key) ?? { day: row.day, rev: row.rev, reports: 0, cells: [] };
    groups.set(key, g);
    if (row.event === REPORTS_EVENT) g.reports += row.reports;
    else g.cells.push(row);
  }
  const days: DayTotals[] = [];
  let suppressedDays = 0;
  let suppressedCells = 0;
  const totals: Record<string, EventTotals> = {};
  let installDays = 0;
  for (const g of groups.values()) {
    if (g.reports < USAGE_COUNTS_MIN_REPORTS) {
      suppressedDays++;
      continue;
    }
    const day: DayTotals = { day: g.day, rev: g.rev, reports: g.reports, events: {} };
    for (const cell of g.cells) {
      if (cell.reports < USAGE_COUNTS_MIN_REPORTS) {
        suppressedCells++;
        continue;
      }
      addTo(day.events, cell.event, cell.bucket, cell.reports, cell.total);
      addTo(totals, cell.event, cell.bucket, cell.reports, cell.total);
    }
    days.push(day);
    installDays += g.reports;
  }
  return json(
    {
      feature,
      from,
      to,
      served_through: servedThrough,
      rev: revParam === null ? null : Number(revParam),
      min_reports: USAGE_COUNTS_MIN_REPORTS,
      install_days: installDays,
      suppressed_days: suppressedDays,
      suppressed_cells: suppressedCells,
      totals,
      days,
    },
    200,
  );
}

const HOME_TEXT =
  "Plannotator usage counts: daily totals of how often experimental features are used, sent by people who keep usage counts on. No IP addresses, no ids, no content. https://plannotator.ai/docs/privacy\n";

export async function handleRequest(req: Request, env: Env, now: number = Date.now()): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === USAGE_COUNTS_PATH) {
    if (req.method !== "POST") return json({ code: "method_not_allowed" }, 405, { allow: "POST" });
    return postCounts(req, env, now);
  }
  if (url.pathname === "/v1/totals") {
    if (req.method !== "GET") return json({ code: "method_not_allowed" }, 405, { allow: "GET" });
    return getTotals(req, env, url, now);
  }
  if (url.pathname === "/" && (req.method === "GET" || req.method === "HEAD")) {
    return new Response(req.method === "HEAD" ? null : HOME_TEXT, { status: 200, headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8" } });
  }
  return json({ code: "not_found" }, 404);
}

/**
 * Retention, run once a day: a feature's totals go 180 days after its
 * counting ends; any day older than 400 days goes; a feature no longer in the
 * registry goes (keep a feature listed until its totals are gone).
 */
export async function runRetention(db: D1Database, now: number = Date.now()): Promise<void> {
  const today = utcDay(now);
  const statements: D1PreparedStatement[] = [];
  for (const feature of USAGE_COUNT_FEATURES) {
    if (today > addUtcDays(feature.collectUntil, USAGE_COUNTS_RETENTION_DAYS)) {
      statements.push(db.prepare("DELETE FROM daily_totals WHERE feature = ?1").bind(feature.id));
    }
  }
  const ids = USAGE_COUNT_FEATURES.map((f) => f.id);
  statements.push(db.prepare(`DELETE FROM daily_totals WHERE feature NOT IN (${ids.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...ids));
  statements.push(db.prepare("DELETE FROM daily_totals WHERE day < ?1").bind(addUtcDays(today, -MAX_KEEP_DAYS)));
  await db.batch(statements);
}
