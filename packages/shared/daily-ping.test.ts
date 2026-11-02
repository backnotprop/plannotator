/**
 * The daily ping's client (daily-ping.ts) against a loopback receiver, never
 * the real host, in a temp PLANNOTATOR_DATA_DIR. Guards: what turns it off
 * (DO_NOT_TRACK, NO_ANON_PING, CI, config.json, a dev build); nothing
 * before the notice or on its day; once a day across two processes; the exact
 * bytes; a failed send tries again at the next check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig, TELEMETRY_CI_VARS } from "./config";
import {
  checkDailyPing,
  claimDailyPingNotice,
  DAILY_PING_URL,
  dailyPingAge,
  dailyPingEndpoint,
  dailyPingNoticeDue,
  readDailyPingState,
} from "./daily-ping";

const VERSION = "0.28.46";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T10:00:00Z"); // a Wednesday
const TODAY = "2026-11-04";
const YESTERDAY = "2026-11-03";

interface Received {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

let dataDir: string;
let savedDataDir: string | undefined;
let server: ReturnType<typeof Bun.serve>;
let received: Received[];
let answer: () => number | Promise<number>;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TELEMETRY_URL: `http://127.0.0.1:${server.port}`, ...extra };
}

function writeState(state: Record<string, string>): void {
  writeFileSync(join(dataDir, "ping.json"), JSON.stringify(state));
}

beforeEach(() => {
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-daily-ping-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  received = [];
  answer = () => 204;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      received.push({ method: req.method, path: new URL(req.url).pathname, headers: Object.fromEntries(req.headers), body: await req.text() });
      return new Response(null, { status: await answer() });
    },
  });
});

afterEach(() => {
  server.stop(true);
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("the request", () => {
  test("exactly one POST /ping with the exact body bytes, then nothing more that day", async () => {
    writeState({ firstWeek: "2026-10-12", noticeDay: YESTERDAY });
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("sent");
    expect(received).toHaveLength(1);
    const [r] = received;
    expect(r!.method).toBe("POST");
    expect(r!.path).toBe("/ping");
    // The payload, byte for byte: the version and the install-age bucket (3 weeks: bucket 2). Nothing else.
    expect(r!.body).toBe('{"version":"0.28.46","age":2}');
    expect(r!.headers["content-type"]).toBe("application/json");
    expect(r!.headers["user-agent"]).toBe("plannotator");
    expect(Object.keys(r!.headers).filter((h) => !["accept", "accept-encoding", "connection", "content-length", "content-type", "host", "user-agent"].includes(h))).toEqual([]);
    expect(readDailyPingState(dataDir).lastDay).toBe(TODAY);

    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW + 3_600_000 })).toBe("sent-today");
    expect(received).toHaveLength(1);
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW + DAY })).toBe("sent");
    expect(received).toHaveLength(2);
  });

  test("the age bucket is Fedora countme's: first week, weeks 2-4, 5-24, older", () => {
    const monday = "2026-11-02";
    expect(dailyPingAge(monday, "2026-11-08")).toBe(1);
    expect(dailyPingAge(monday, "2026-11-09")).toBe(2);
    expect(dailyPingAge(monday, "2026-11-29")).toBe(2);
    expect(dailyPingAge(monday, "2026-11-30")).toBe(3);
    expect(dailyPingAge(monday, "2027-04-18")).toBe(3);
    expect(dailyPingAge(monday, "2027-04-19")).toBe(4);
  });

  test("the first check records this week (its Monday) as the first-use week, and the ping says age 1", async () => {
    claimDailyPingNotice({ version: VERSION, env: env(), now: NOW - DAY });
    expect(readDailyPingState(dataDir).firstWeek).toBe("2026-11-02");
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("sent");
    expect(received[0]!.body).toBe('{"version":"0.28.46","age":1}');
  });
});

describe("off means no request", () => {
  beforeEach(() => writeState({ firstWeek: "2026-10-12", noticeDay: YESTERDAY }));

  const cases: [string, Record<string, string>, string][] = [
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }, "DO_NOT_TRACK"],
    ["DO_NOT_TRACK=true", { DO_NOT_TRACK: "true" }, "DO_NOT_TRACK"],
    ["NO_ANON_PING=1", { NO_ANON_PING: "1" }, "NO_ANON_PING"],
    ["NO_ANON_PING=yes (any non-empty value but 0)", { NO_ANON_PING: "yes" }, "NO_ANON_PING"],
    ...TELEMETRY_CI_VARS.map((name): [string, Record<string, string>, string] => [`${name} set`, { [name]: name === "CI" ? "true" : "1" }, "CI"]),
  ];
  for (const [name, extra, reason] of cases) {
    test(name, async () => {
      expect(await checkDailyPing({ version: VERSION, env: env(extra), now: NOW })).toBe(reason as never);
      expect(received).toEqual([]);
      expect(dailyPingNoticeDue({ version: VERSION, env: env(extra) })).toBe(false);
    });
  }

  test("DO_NOT_TRACK=0, NO_ANON_PING=0, an empty NO_ANON_PING and CI=false do not turn it off", async () => {
    expect(await checkDailyPing({ version: VERSION, env: env({ DO_NOT_TRACK: "0", NO_ANON_PING: "0", CI: "false" }), now: NOW })).toBe("sent");
    expect(await checkDailyPing({ version: VERSION, env: env({ NO_ANON_PING: "" }), now: NOW + DAY })).toBe("sent");
  });

  test("config.json telemetry: false (what the Settings switch writes)", async () => {
    saveConfig({ telemetry: false });
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("config");
    expect(received).toEqual([]);
  });

  test("a dev or source build, whatever the endpoint", async () => {
    for (const version of [undefined, "dev", "0.0.0-dev", "0.28.46-rc.1", "0.28"]) {
      expect(await checkDailyPing({ version, env: env(), now: NOW })).toBe("dev");
    }
    expect(received).toEqual([]);
  });

  test("under the test sandbox only a loopback URL counts; outside it the override is ignored", () => {
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TEST_SANDBOX: "1" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, { NODE_ENV: "test" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TELEMETRY_URL: "https://ping.plannotator.ai" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TELEMETRY_URL: "http://example.com" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:9" })).toBe(DAILY_PING_URL);
  });
});

describe("the notice", () => {
  test("nothing before the notice, nothing on its day, a ping the next day", async () => {
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("no-notice");
    expect(dailyPingNoticeDue({ version: VERSION, env: env() })).toBe(true);
    expect(claimDailyPingNotice({ version: VERSION, env: env(), now: NOW })).toBe(true);
    // Shown once: a second surface does not show it again.
    expect(claimDailyPingNotice({ version: VERSION, env: env(), now: NOW })).toBe(false);
    expect(dailyPingNoticeDue({ version: VERSION, env: env() })).toBe(false);
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW + 13 * 3_600_000 })).toBe("notice-today");
    expect(received).toEqual([]);
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW + DAY })).toBe("sent");
    expect(received).toHaveLength(1);
  });

  test("never due, never claimed, nothing written while the ping is off", () => {
    expect(claimDailyPingNotice({ version: VERSION, env: env({ DO_NOT_TRACK: "1" }), now: NOW })).toBe(false);
    expect(() => readFileSync(join(dataDir, "ping.json"))).toThrow();
  });
});

describe("failures and the lock", () => {
  beforeEach(() => writeState({ firstWeek: "2026-10-12", noticeDay: YESTERDAY }));

  test("a failed send writes nothing and the next check tries again", async () => {
    answer = () => 503;
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("failed");
    expect(readDailyPingState(dataDir).lastDay).toBeUndefined();
    answer = () => 204;
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW + 60_000 })).toBe("sent");
    expect(received).toHaveLength(2);
  });

  test("offline (nothing listening) fails quietly and tries again next time", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const deadPort = closed.port;
    closed.stop(true);
    expect(await checkDailyPing({ version: VERSION, env: env({ PLANNOTATOR_TELEMETRY_URL: `http://127.0.0.1:${deadPort}` }), now: NOW })).toBe("failed");
    expect(readDailyPingState(dataDir).lastDay).toBeUndefined();
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("sent");
  });

  test("a held lock means another process is sending; a lock over a minute old is stale", async () => {
    const lock = join(dataDir, "ping.lock");
    writeFileSync(lock, "");
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("busy");
    expect(received).toEqual([]);
    const old = (Date.now() - 2 * 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(await checkDailyPing({ version: VERSION, env: env(), now: NOW })).toBe("sent");
    expect(received).toHaveLength(1);
  });

  test("two processes checking at once send one request", async () => {
    // The receiver holds its answer so both processes overlap on the lock.
    answer = () => new Promise((resolve) => setTimeout(() => resolve(204), 400));
    const module = join(import.meta.dir, "daily-ping.ts");
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    for (const name of [...TELEMETRY_CI_VARS, "DO_NOT_TRACK", "NO_ANON_PING"]) delete childEnv[name];
    Object.assign(childEnv, { PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: dataDir, PLANNOTATOR_TELEMETRY_URL: `http://127.0.0.1:${server.port}` });
    const startAt = Date.now() + 1500;
    const code = `const { checkDailyPing } = await import(${JSON.stringify(module)});
while (Date.now() < ${startAt}) {}
process.stdout.write(await checkDailyPing({ version: "${VERSION}", now: ${NOW} }));`;
    const children = [0, 1].map(() => Bun.spawn([process.execPath, "-e", code], { env: childEnv, stdout: "pipe", stderr: "pipe" }));
    const results = await Promise.all(children.map(async (c) => (await new Response(c.stdout).text()).trim()));
    await Promise.all(children.map((c) => c.exited));
    expect(results.sort()).toEqual(["busy", "sent"]);
    expect(received).toHaveLength(1);
    expect(readDailyPingState(dataDir).lastDay).toBe(TODAY);
  });
});
