/**
 * The daily ping's client (daily-ping.ts) against a loopback receiver, never
 * the real host, in a temp PLANNOTATOR_DATA_DIR. Guards: what turns it off
 * (NO_ANON_PING, the do-not-track convention, CI, a dev build); once a day per
 * tool, also across two processes; `first` on one ping a day only; the exact
 * bytes; a failed send tries again at the next check.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TELEMETRY_CI_VARS } from "./config";
import { checkDailyPing, cliDailyPingTool, DAILY_PING_URL, dailyPingAge, dailyPingEndpoint, type DailyPingTool, readDailyPingState } from "./daily-ping";

const VERSION = "0.28.46";
const DAY = 86_400_000;
const NOW = Date.parse("2026-11-04T10:00:00Z"); // a Wednesday
const TODAY = "2026-11-04";

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

function check(tool: DailyPingTool, now = NOW, extra: Record<string, string> = {}, version: { v: string | undefined } = { v: VERSION }) {
  return checkDailyPing({ version: version.v, tool, env: env(extra), now });
}

function writeState(state: Record<string, unknown>): void {
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
  test("exactly one POST /ping with the exact body bytes, then nothing more from that tool that day", async () => {
    writeState({ firstWeek: "2026-10-12" });
    expect(await check("plan")).toBe("sent");
    expect(received).toHaveLength(1);
    const [r] = received;
    expect(r!.method).toBe("POST");
    expect(r!.path).toBe("/ping");
    // The payload, byte for byte: version, install-age bucket (3 weeks: 2), tool, first of the day. Nothing else.
    expect(r!.body).toBe('{"version":"0.28.46","age_week":2,"tool":"plan","first":1}');
    expect(r!.headers["content-type"]).toBe("application/json");
    expect(r!.headers["user-agent"]).toBe("plannotator");
    expect(Object.keys(r!.headers).filter((h) => !["accept", "accept-encoding", "connection", "content-length", "content-type", "host", "user-agent"].includes(h))).toEqual([]);
    expect(readDailyPingState(dataDir)).toEqual({ firstWeek: "2026-10-12", day: TODAY, sent: ["plan"] });

    expect(await check("plan", NOW + 3_600_000)).toBe("sent-today");
    expect(received).toHaveLength(1);
    expect(await check("plan", NOW + DAY)).toBe("sent");
    expect(received).toHaveLength(2);
    // A new day: the first ping of it carries first again.
    expect(received[1]!.body).toBe('{"version":"0.28.46","age_week":2,"tool":"plan","first":1}');
  });

  test("each tool sends its own ping once a day; only the day's first ping carries first: 1", async () => {
    writeState({ firstWeek: "2026-10-12" });
    const tools: DailyPingTool[] = ["inbox", "plan", "review", "annotate", "last"];
    for (const tool of tools) expect(await check(tool)).toBe("sent");
    for (const tool of tools) expect(await check(tool, NOW + 60_000)).toBe("sent-today");
    expect(received.map((r) => r.body)).toEqual([
      '{"version":"0.28.46","age_week":2,"tool":"inbox","first":1}',
      '{"version":"0.28.46","age_week":2,"tool":"plan","first":0}',
      '{"version":"0.28.46","age_week":2,"tool":"review","first":0}',
      '{"version":"0.28.46","age_week":2,"tool":"annotate","first":0}',
      '{"version":"0.28.46","age_week":2,"tool":"last","first":0}',
    ]);
  });

  test("a CLI session counts as its tool: every annotate-last command is last; archive and goal setup count as nothing", () => {
    expect(cliDailyPingTool("plan", undefined)).toBe("plan");
    expect(cliDailyPingTool("plan", "copilot-plan")).toBe("plan");
    expect(cliDailyPingTool("review", "review")).toBe("review");
    expect(cliDailyPingTool("annotate", "annotate")).toBe("annotate");
    for (const command of ["annotate-last", "last", "opencode-annotate-last", "copilot-last"]) expect(cliDailyPingTool("annotate", command)).toBe("last");
    expect(cliDailyPingTool("archive", "archive")).toBeNull();
    expect(cliDailyPingTool("goal-setup", "setup-goal")).toBeNull();
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

  test("the first check sends at once (no notice, no wait); a new data folder is this week, age_week 1", async () => {
    expect(await check("review")).toBe("sent");
    expect(readDailyPingState(dataDir).firstWeek).toBe("2026-11-02");
    expect(received[0]!.body).toBe('{"version":"0.28.46","age_week":1,"tool":"review","first":1}');
  });

  test("an existing user's first ping counts from first use: the oldest time in the data folder, never later than today", async () => {
    // Plannotator was used here 10 weeks before the ping arrived (a file it wrote then).
    const ten = (NOW - 70 * DAY) / 1000;
    mkdirSync(join(dataDir, "history"));
    writeFileSync(join(dataDir, "config.json"), "{}");
    utimesSync(join(dataDir, "config.json"), ten, ten);
    expect(await check("plan")).toBe("sent");
    expect(readDailyPingState(dataDir).firstWeek).toBe("2026-08-24");
    expect(received[0]!.body).toBe('{"version":"0.28.46","age_week":3,"tool":"plan","first":1}');
    // ping.json only holds the week: nothing else about the folder.
    expect(Object.keys(JSON.parse(readFileSync(join(dataDir, "ping.json"), "utf8")))).toEqual(["firstWeek", "day", "sent"]);
  });
});

describe("off means no request", () => {
  const cases: [string, Record<string, string>, string][] = [
    ["NO_ANON_PING=1", { NO_ANON_PING: "1" }, "NO_ANON_PING"],
    ["NO_ANON_PING=yes (any non-empty value but 0)", { NO_ANON_PING: "yes" }, "NO_ANON_PING"],
    ["NO_ANON_PING=false (still non-empty, not 0)", { NO_ANON_PING: "false" }, "NO_ANON_PING"],
    ["DO_NOT_TRACK=1 (honoured quietly)", { DO_NOT_TRACK: "1" }, "DO_NOT_TRACK"],
    ["DO_NOT_TRACK=true", { DO_NOT_TRACK: "true" }, "DO_NOT_TRACK"],
    ...TELEMETRY_CI_VARS.map((name): [string, Record<string, string>, string] => [`${name} set`, { [name]: name === "CI" ? "true" : "1" }, "CI"]),
  ];
  for (const [name, extra, reason] of cases) {
    test(name, async () => {
      expect(await check("plan", NOW, extra)).toBe(reason as never);
      expect(received).toEqual([]);
      // Nothing is written while the ping is off.
      expect(() => readFileSync(join(dataDir, "ping.json"))).toThrow();
    });
  }

  test("NO_ANON_PING=0, an empty NO_ANON_PING, DO_NOT_TRACK=0 and CI=false do not turn it off", async () => {
    expect(await check("plan", NOW, { DO_NOT_TRACK: "0", NO_ANON_PING: "0", CI: "false" })).toBe("sent");
    expect(await check("plan", NOW + DAY, { NO_ANON_PING: "" })).toBe("sent");
    expect(received).toHaveLength(2);
  });

  test("a dev or source build, whatever the endpoint", async () => {
    for (const version of [undefined, "dev", "0.0.0-dev", "0.28.46-rc.1", "0.28"]) {
      expect(await check("plan", NOW, {}, { v: version })).toBe("dev");
    }
    expect(received).toEqual([]);
  });

  test("under the test sandbox only a loopback URL counts; outside it the override is ignored", () => {
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TEST_SANDBOX: "1" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, { NODE_ENV: "test" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TELEMETRY_URL: "https://ping.plannotator.ai" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TEST_SANDBOX: "1", PLANNOTATOR_TELEMETRY_URL: "http://example.com" })).toBeNull();
  });

  test("outside the sandbox only a build release CI marked reaches the live host; the URL override is ignored", () => {
    // A test that spawns the CLI with a release __CLI_VERSION__ and a replaced env: no mark, nowhere to send.
    expect(dailyPingEndpoint(VERSION, {})).toBeNull();
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:9" })).toBeNull();
    expect(dailyPingEndpoint(VERSION, {}, true)).toBe(DAILY_PING_URL);
    expect(dailyPingEndpoint(VERSION, { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:9" }, true)).toBe(DAILY_PING_URL);
  });
});

describe("failures and the lock", () => {
  beforeEach(() => writeState({ firstWeek: "2026-10-12" }));

  test("a failed send records nothing and the next check tries again", async () => {
    answer = () => 503;
    expect(await check("annotate")).toBe("failed");
    expect(readDailyPingState(dataDir).sent).toBeUndefined();
    answer = () => 204;
    expect(await check("annotate", NOW + 60_000)).toBe("sent");
    expect(received).toHaveLength(2);
    // The retry is still the day's first ping: the failed one did not count.
    expect(received[1]!.body).toBe('{"version":"0.28.46","age_week":2,"tool":"annotate","first":1}');
  });

  test("offline (nothing listening) fails quietly and tries again next time", async () => {
    const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
    const deadPort = closed.port;
    closed.stop(true);
    expect(await check("plan", NOW, { PLANNOTATOR_TELEMETRY_URL: `http://127.0.0.1:${deadPort}` })).toBe("failed");
    expect(readDailyPingState(dataDir).sent).toBeUndefined();
    expect(await check("plan")).toBe("sent");
  });

  test("a held lock means another process is sending; a lock over a minute old is stale", async () => {
    const lock = join(dataDir, "ping.lock");
    writeFileSync(lock, "");
    expect(await check("plan")).toBe("busy");
    expect(received).toEqual([]);
    const old = (Date.now() - 2 * 60_000) / 1000;
    utimesSync(lock, old, old);
    expect(await check("plan")).toBe("sent");
    expect(received).toHaveLength(1);
  }, 15_000);

  test("a process whose lock was taken over mid-send writes nothing and leaves the other's lock alone", async () => {
    const lock = join(dataDir, "ping.lock");
    // While this process's POST is out it sleeps past the stale minute: another process takes the lock over.
    answer = () => {
      writeFileSync(lock, "the-other-process");
      return 204;
    };
    expect(await check("plan")).toBe("failed");
    expect(received).toHaveLength(1);
    // Its state stays the other process's to write, and its lock is still there.
    expect(readDailyPingState(dataDir).sent).toBeUndefined();
    expect(readFileSync(lock, "utf8")).toBe("the-other-process");
  });

  function spawnChecks(tools: DailyPingTool[]) {
    const module = join(import.meta.dir, "daily-ping.ts");
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) childEnv[k] = v;
    for (const name of [...TELEMETRY_CI_VARS, "DO_NOT_TRACK", "NO_ANON_PING"]) delete childEnv[name];
    Object.assign(childEnv, { PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_TEST_SANDBOX: dataDir, PLANNOTATOR_TELEMETRY_URL: `http://127.0.0.1:${server.port}` });
    const startAt = Date.now() + 1500;
    return Promise.all(
      tools.map(async (tool) => {
        const code = `const { checkDailyPing } = await import(${JSON.stringify(module)});
while (Date.now() < ${startAt}) {}
process.stdout.write(await checkDailyPing({ version: "${VERSION}", tool: "${tool}", now: ${NOW} }));`;
        const child = Bun.spawn([process.execPath, "-e", code], { env: childEnv, stdout: "pipe", stderr: "pipe" });
        const out = (await new Response(child.stdout).text()).trim();
        await child.exited;
        return out;
      }),
    );
  }

  test("two processes checking the same tool at once send one request", async () => {
    // The receiver holds its answer so both processes overlap on the lock.
    answer = () => new Promise((resolve) => setTimeout(() => resolve(204), 400));
    const results = await spawnChecks(["plan", "plan"]);
    expect(results.sort()).toEqual(["sent", "sent-today"]);
    expect(received).toHaveLength(1);
    expect(readDailyPingState(dataDir)).toEqual({ firstWeek: "2026-10-12", day: TODAY, sent: ["plan"] });
  });

  test("two processes with different tools at once: both send, exactly one says first", async () => {
    answer = () => new Promise((resolve) => setTimeout(() => resolve(204), 200));
    const results = await spawnChecks(["plan", "review"]);
    expect(results).toEqual(["sent", "sent"]);
    expect(received).toHaveLength(2);
    expect(received.map((r) => JSON.parse(r.body).first).sort()).toEqual([0, 1]);
    expect(readDailyPingState(dataDir).sent).toEqual(["plan", "review"]);
  });
});
