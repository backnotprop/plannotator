/**
 * The usage-counts Worker, proved in action: it runs under `wrangler dev`
 * (local workerd, its D1 database on SQLite under
 * apps/telemetry/.wrangler/proof), on free ports, with the migration applied
 * by `wrangler d1 migrations apply --local`. Nothing is mocked. Requests go
 * from this script, as a Plannotator process would send them.
 *
 * Runs from this folder (`bun test`, its own bunfig): the root bunfig skips
 * apps/telemetry because it needs wrangler. Never deploys anything.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { addUtcDays, buildUsageCountsBatch, serializeUsageCountsBatch, utcDay } from "@plannotator/core/usage-counts";

const dir = resolve(import.meta.dir, "..");
const wrangler = join(dir, "node_modules", ".bin", "wrangler");
const persist = join(dir, ".wrangler", "proof");
const READ_TOKEN = "proof-read-token-0123456789abcdef";
const TODAY = utcDay(Date.now());
const D1 = addUtcDays(TODAY, -1);
const D2 = addUtcDays(TODAY, -2);
/** Days closed for good (older than the 3-day acceptance window), seeded straight into D1. */
const S1 = addUtcDays(TODAY, -10);
const S2 = addUtcDays(TODAY, -11);

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const wranglerEnv = { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" };

function wranglerSync(args: string[]): string {
  const run = Bun.spawnSync([wrangler, ...args, "--persist-to", persist], { cwd: dir, env: wranglerEnv, stdout: "pipe", stderr: "pipe" });
  const out = run.stdout.toString() + run.stderr.toString();
  if (run.exitCode !== 0) throw new Error(`wrangler ${args.join(" ")} failed:\n${out}`);
  return out;
}

let url = "";
let child: ReturnType<typeof Bun.spawn> | null = null;
let output = "";

beforeAll(async () => {
  rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  wranglerSync(["d1", "migrations", "apply", "COUNTS", "--local"]);
  // Rows the retention must remove: a day older than 400 days, and a feature
  // no longer in the registry. A row it must keep: a recent day.
  wranglerSync([
    "d1",
    "execute",
    "COUNTS",
    "--local",
    "--command",
    `INSERT INTO daily_totals VALUES ('2024-01-01','decisionMode',1,'_reports','',7,7),('${D2}','retiredFeature',1,'_reports','',9,9),('${D2}','decisionMode',1,'_kept','',1,1)`,
  ]);
  // Closed days for the read route: S1 has 6 reports, with two opened cells
  // under 5 reports; S2 has 4 reports in all.
  wranglerSync([
    "d1",
    "execute",
    "COUNTS",
    "--local",
    "--command",
    `INSERT INTO daily_totals VALUES ('${S1}','decisionMode',1,'_reports','',6,6),('${S1}','decisionMode',1,'active_day','1',6,6),('${S1}','decisionMode',1,'opened','1',2,2),('${S1}','decisionMode',1,'opened','2-3',5,12),('${S1}','decisionMode',1,'opened','30-100',1,64),('${S2}','decisionMode',1,'_reports','',4,4),('${S2}','decisionMode',1,'opened','2-3',4,9)`,
  ]);
  const envFile = join(persist, "proof.env");
  writeFileSync(envFile, `READ_TOKEN=${READ_TOKEN}\n`, { mode: 0o600 });
  const port = freePort();
  child = Bun.spawn(
    [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(freePort()), "--persist-to", persist, "--env-file", envFile, "--test-scheduled", "--show-interactive-dev-session=false"],
    { cwd: dir, stdout: "pipe", stderr: "pipe", env: wranglerEnv },
  );
  for (const stream of [child.stdout as ReadableStream<Uint8Array>, child.stderr as ReadableStream<Uint8Array>]) {
    void (async () => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    })();
  }
  url = `http://127.0.0.1:${port}`;
  const end = Date.now() + 60_000;
  for (;;) {
    const status = await fetch(`${url}/nothing`).then((r) => r.status).catch(() => 0);
    if (status === 404) break;
    if (Date.now() > end) throw new Error(`wrangler dev did not start:\n${output}`);
    await sleep(200);
  }
}, 120_000);

afterAll(async () => {
  child?.kill();
  await child?.exited;
  writeFileSync(join(persist, "wrangler.log"), output);
  rmSync(join(persist, "proof.env"), { force: true });
});

function post(body: string, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${url}/v1/counts`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

function batch(day: string, events: Record<string, number>): string {
  return serializeUsageCountsBatch(buildUsageCountsBatch("decisionMode", 1, day, events)!);
}

function totals(query: string, token: string | null = READ_TOKEN): Promise<Response> {
  return fetch(`${url}/v1/totals?${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

/** The D1 database's SQLite file. */
function d1File(): string {
  const base = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(base).find((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
  if (!file) throw new Error("no D1 file");
  return join(base, file);
}

function rows(): Record<string, unknown>[] {
  const db = new Database(d1File(), { readonly: true });
  try {
    return db.query("SELECT * FROM daily_totals ORDER BY day, feature, rev, event, bucket").all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe("POST /v1/counts", () => {
  test("refuses a browser, another type, a large body and anything the validator refuses", async () => {
    const good = batch(D1, { opened: 1 });
    expect((await post(good, { origin: "https://example.com" })).status).toBe(403);
    expect((await post(good, { "content-type": "text/plain" })).status).toBe(415);
    expect((await post(good + " ".repeat(1100))).status).toBe(413);
    const invalid = [
      "{",
      JSON.stringify({ schema: 1, feature: "decisionMode", rev: 1, day: D1, events: { opened: 1 }, version: "0.28.30" }),
      JSON.stringify({ schema: 1, feature: "decisionMode", rev: 1, day: D1, events: { path: 1 } }),
      JSON.stringify({ schema: 1, feature: "decisionMode", rev: 1, day: D1, events: { opened: 101 } }),
      JSON.stringify({ schema: 1, feature: "other", rev: 1, day: D1, events: { opened: 1 } }),
      JSON.stringify({ schema: 1, feature: "decisionMode", rev: 1, day: addUtcDays(TODAY, -40), events: { opened: 1 } }),
    ];
    for (const body of invalid) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ code: "invalid" });
    }
    expect((await fetch(`${url}/v1/counts`)).status).toBe(405);
    // Nothing above reached the table.
    expect(rows().filter((r) => r.day === D1)).toEqual([]);
  });

  test("a batch answers 204 with no body, no cookie and no CORS", async () => {
    const res = await post(batch(D1, { active_day: 1, opened: 1, first_day: 1, days_last7: 1 }));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("batches add into daily totals per (day, feature, rev, event, bucket)", async () => {
    // Five more for D1 (six in all with the one above), with a spread of counts.
    for (const [opened, last7] of [
      [3, 2],
      [3, 4],
      [12, 6],
      [100, 6],
      [1, 1],
    ] as const) {
      expect((await post(batch(D1, { active_day: 1, opened, days_last7: last7 }))).status).toBe(204);
    }
    const d1 = rows().filter((r) => r.day === D1);
    const at = (event: string, bucket: string) => d1.find((r) => r.event === event && r.bucket === bucket);
    expect(at("_reports", "")).toMatchObject({ reports: 6, total: 6 });
    expect(at("active_day", "1")).toMatchObject({ reports: 6, total: 6 });
    expect(at("opened", "1")).toMatchObject({ reports: 2, total: 2 });
    expect(at("opened", "2-3")).toMatchObject({ reports: 2, total: 6 });
    expect(at("opened", "10-29")).toMatchObject({ reports: 1, total: 12 });
    expect(at("opened", "30-100")).toMatchObject({ reports: 1, total: 100 });
    expect(at("first_day", "1")).toMatchObject({ reports: 1 });
    expect(at("days_last7", "1")).toMatchObject({ reports: 2, total: 0 });
    expect(at("days_last7", "6-7")).toMatchObject({ reports: 2 });
    // Four for D2: under the read route's floor.
    for (let i = 0; i < 4; i++) expect((await post(batch(D2, { opened: 2 }))).status).toBe(204);
  });

  test("the table holds only its columns, and no IP or request detail anywhere in storage", () => {
    const db = new Database(d1File(), { readonly: true });
    try {
      const columns = (db.query("PRAGMA table_info(daily_totals)").all() as { name: string }[]).map((c) => c.name);
      expect(columns).toEqual(["day", "feature", "rev", "event", "bucket", "reports", "total"]);
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name).filter((t) => !t.startsWith("_cf") && !t.startsWith("sqlite") && t !== "d1_migrations");
      expect(tables).toEqual(["daily_totals"]);
    } finally {
      db.close();
    }
    const base = join(persist, "v3", "d1");
    const bytes = Buffer.concat(
      readdirSync(base, { recursive: true })
        .map((f) => join(base, String(f)))
        .filter((f) => existsSync(f) && !f.endsWith("/") && /\.sqlite(-wal|-shm)?$/.test(f))
        .map((f) => readFileSync(f)),
    );
    for (const needle of ["127.0.0.1", "plannotator-telemetry", "Bun/", "content-type"]) expect(bytes.includes(Buffer.from(needle))).toBe(false);
  });
});

describe("GET /v1/totals", () => {
  test("needs the bearer token", async () => {
    expect((await totals(`feature=decisionMode&from=${S2}&to=${D1}`, null)).status).toBe(401);
    expect((await totals(`feature=decisionMode&from=${S2}&to=${D1}`, "wrong")).status).toBe(401);
    expect((await totals(`feature=decisionMode&from=${S2}&to=${D1}`)).status).toBe(200);
  });

  test("serves only days closed for good, and hides small days and small cells", async () => {
    const body = (await (await totals(`feature=decisionMode&from=${S2}&to=${D1}`)).json()) as any;
    expect(body.min_reports).toBe(5);
    expect(body.served_through).toBe(addUtcDays(TODAY, -4));
    // Yesterday's batches (D1) are still open: not served.
    expect(body.days.map((d: any) => d.day)).toEqual([S1]);
    expect(body.suppressed_days).toBe(1); // S2: 4 reports
    expect(body.suppressed_cells).toBe(2); // S1 opened "1" (2 reports) and "30-100" (1 report)
    expect(body.install_days).toBe(6);
    expect(body.totals).toEqual({
      active_day: { reports: 6, total: 6, buckets: { "1": 6 } },
      opened: { reports: 5, total: 12, buckets: { "2-3": 5 } },
    });
    const text = JSON.stringify(body.days);
    expect(text).not.toContain(D1);
    expect(text).not.toContain(S2);
    expect(text).not.toContain('"30-100"');
    // A range of only open days answers nothing.
    const open = (await (await totals(`feature=decisionMode&from=${D2}&to=${D1}`)).json()) as any;
    expect(open.days).toEqual([]);
  });

  test("refuses a bad query", async () => {
    for (const q of ["feature=decisionMode", `feature=x;DROP&from=${D2}&to=${D1}`, `feature=decisionMode&from=${D1}&to=${D2}`, `feature=decisionMode&from=2024-01-01&to=${D1}`]) {
      expect((await totals(q)).status).toBe(400);
    }
  });
});

describe("retention", () => {
  test("the daily cron deletes days past 400 days and features no longer listed, and keeps the rest", async () => {
    const before = rows();
    expect(before.some((r) => r.day === "2024-01-01")).toBe(true);
    expect(before.some((r) => r.feature === "retiredFeature")).toBe(true);
    const res = await fetch(`${url}/__scheduled?cron=${encodeURIComponent("0 4 * * *")}`);
    expect(res.status).toBe(200);
    const end = Date.now() + 10_000;
    while (rows().some((r) => r.day === "2024-01-01" || r.feature === "retiredFeature") && Date.now() < end) await sleep(100);
    const after = rows();
    expect(after.some((r) => r.day === "2024-01-01")).toBe(false);
    expect(after.some((r) => r.feature === "retiredFeature")).toBe(false);
    expect(after.some((r) => r.event === "_kept")).toBe(true);
    expect(after.filter((r) => r.day === D1).length).toBeGreaterThan(0);
  });
});

describe("the rate limit", () => {
  // Last: it spends this IP's minute. wrangler dev sets CF-Connecting-IP.
  test("past 60 a minute from one IP, 429 with Retry-After", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 70; i++) {
      const res = await post(batch(D2, { opened: 1 }));
      statuses.push(res.status);
      if (res.status === 429) {
        expect(res.headers.get("retry-after")).toBe("60");
        break;
      }
    }
    expect(statuses).toContain(429);
  });
});
