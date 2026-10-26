import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUsageCountsRequest, parseUsageCountsBatch, USAGE_COUNT_FEATURES, utcDay } from "@plannotator/core/usage-counts";
import type { PlannotatorConfig } from "./config";
import {
  describeUsageCounts,
  forgetUsageCounts,
  isUsageCountsSendDue,
  nextUsageCountsConfig,
  pendingUsageCountBatches,
  recordUsageCount,
  resolveUsageCounts,
  resolveUsageCountsEndpoint,
  sendUsageCounts,
  sentUsageCounts,
  todayUsageCounts,
  usageCountsDir,
  usageCountsEnvBlock,
  usageCountFeatureOn,
  usageCountsStatus,
  USAGE_COUNTS_CLOSE_DELAY_MAX_MS,
  USAGE_COUNTS_ENDPOINT,
} from "./usage-counts";

const DAY = 86_400_000;
const NOON = Date.UTC(2026, 9, 24, 12); // 2026-10-24
/** The feature on in config.json and the counts notice shown at its version. */
const ON: PlannotatorConfig = { experimental: { decisionMode: true }, usageCountsNotice: { decisionMode: 1 } } as PlannotatorConfig;
/**
 * A source run records only where it could send: every test env names a
 * loopback endpoint (a closed port unless a test passes its own), so nothing
 * here can ever reach the network.
 */
const LOOPBACK = { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:9" };

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-usage-counts-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A loopback endpoint that keeps every raw request it gets, and answers with `answer`. */
function fakeEndpoint(answer: (n: number) => string = () => "HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n") {
  const requests: string[] = [];
  const buffers = new Map<unknown, string>();
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, chunk) {
        const text = (buffers.get(socket) ?? "") + Buffer.from(chunk).toString("latin1");
        buffers.set(socket, text);
        const end = text.indexOf("\r\n\r\n");
        if (end === -1) return;
        const length = Number(/content-length: (\d+)/i.exec(text.slice(0, end))?.[1] ?? 0);
        if (Buffer.byteLength(text.slice(end + 4), "latin1") < length) return;
        requests.push(text);
        socket.write(answer(requests.length));
        socket.end();
      },
      close(socket) {
        buffers.delete(socket);
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, host: `127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

function deps(dataDir: string, config: PlannotatorConfig, now: number, env: NodeJS.ProcessEnv = {}) {
  return { dataDir, config: () => config, now, env: { ...LOOPBACK, ...env }, version: undefined, random: () => 0, sleep: async () => {} };
}

/** Record `events` (name → times) for the UTC day of `at`. */
function recordDay(dataDir: string, config: PlannotatorConfig, at: number, events: Record<string, number>, env: NodeJS.ProcessEnv = {}) {
  for (const [event, times] of Object.entries(events)) {
    for (let i = 0; i < times; i++) recordUsageCount("decisionMode", event as "opened", deps(dataDir, config, at, env));
  }
}

describe("on or off", () => {
  test("on by default while the feature is on, off while it is off", () => {
    expect(resolveUsageCounts(ON, "decisionMode", { env: {}, now: NOON })).toBe(true);
    expect(usageCountsStatus({}, "decisionMode", { env: {}, now: NOON }).reason).toBe("feature_off");
    expect(usageCountsStatus({ experimental: { decisionMode: "yes" } } as PlannotatorConfig, "decisionMode", { env: {}, now: NOON }).on).toBe(false);
  });

  test("DO_NOT_TRACK wins over everything, and so does PLANNOTATOR_TELEMETRY=0", () => {
    const allOn = { ...ON, usageCounts: { decisionMode: true } } as PlannotatorConfig;
    for (const v of ["1", "true", "yes", " 1 "]) {
      expect(usageCountsStatus(allOn, "decisionMode", { env: { DO_NOT_TRACK: v }, now: NOON }).reason).toBe("DO_NOT_TRACK");
    }
    for (const v of ["0", "false", "off", "disabled", "OFF"]) {
      expect(usageCountsStatus(allOn, "decisionMode", { env: { PLANNOTATOR_TELEMETRY: v }, now: NOON }).reason).toBe("PLANNOTATOR_TELEMETRY");
    }
    expect(usageCountsEnvBlock({ DO_NOT_TRACK: "1", PLANNOTATOR_TELEMETRY: "1" })).toBe("DO_NOT_TRACK");
  });

  test("nothing in the environment turns counts on", () => {
    const off = { ...ON, usageCounts: false } as PlannotatorConfig;
    for (const env of [{ PLANNOTATOR_TELEMETRY: "1" }, { PLANNOTATOR_TELEMETRY: "on" }, { DO_NOT_TRACK: "0" }, { PLANNOTATOR_EXPERIMENTAL: "decisionMode" }]) {
      expect(resolveUsageCounts(off, "decisionMode", { env, now: NOON })).toBe(false);
      expect(resolveUsageCounts({}, "decisionMode", { env, now: NOON })).toBe(false);
    }
  });

  test("config turns it off for all features or one", () => {
    expect(usageCountsStatus({ ...ON, usageCounts: false } as PlannotatorConfig, "decisionMode", { env: {}, now: NOON }).reason).toBe("config");
    expect(usageCountsStatus({ ...ON, usageCounts: { decisionMode: false } } as PlannotatorConfig, "decisionMode", { env: {}, now: NOON }).reason).toBe("config");
    expect(resolveUsageCounts({ ...ON, usageCounts: { otherFeature: false } } as PlannotatorConfig, "decisionMode", { env: {}, now: NOON })).toBe(true);
  });

  test("counting ends after the feature's end day", () => {
    expect(resolveUsageCounts(ON, "decisionMode", { env: {}, now: Date.UTC(2027, 3, 30, 23) })).toBe(true);
    expect(usageCountsStatus(ON, "decisionMode", { env: {}, now: Date.UTC(2027, 4, 1, 0) }).reason).toBe("ended");
  });

  test("counting needs the notice shown at the feature's version", () => {
    const noNotice = { experimental: { decisionMode: true } } as PlannotatorConfig;
    expect(usageCountsStatus(noNotice, "decisionMode", { env: {}, now: NOON }).reason).toBe("notice");
    expect(usageCountsStatus({ ...ON, usageCountsNotice: { decisionMode: 0 } } as PlannotatorConfig, "decisionMode", { env: {}, now: NOON }).reason).toBe("notice");
    expect(usageCountsStatus({ ...ON, usageCountsNotice: { decisionMode: "1" } } as unknown as PlannotatorConfig, "decisionMode", { env: {}, now: NOON }).reason).toBe("notice");
    expect(usageCountsStatus({ ...ON, usageCountsNotice: { decisionMode: 2 } } as PlannotatorConfig, "decisionMode", { env: {}, now: NOON }).on).toBe(true);
  });

  test("the feature counts only when its resolver AND config.json say on: never from the env alone", () => {
    const envOnly = () => true; // what resolveExperimental answers for PLANNOTATOR_EXPERIMENTAL=decisionMode
    const envOff = () => false; // and for PLANNOTATOR_EXPERIMENTAL=-decisionMode
    const notInConfig = { usageCountsNotice: { decisionMode: 1 } } as PlannotatorConfig;
    expect(usageCountFeatureOn(notInConfig, "decisionMode", envOnly)).toBe(false);
    expect(usageCountsStatus(notInConfig, "decisionMode", { env: {}, now: NOON, resolveExperimental: envOnly }).reason).toBe("feature_off");
    expect(usageCountFeatureOn(ON, "decisionMode", envOff)).toBe(false);
    expect(usageCountFeatureOn(ON, "decisionMode", envOnly)).toBe(true);
    expect(usageCountFeatureOn(ON, "decisionMode")).toBe(true);
    expect(usageCountFeatureOn({ experimental: { decisionMode: 1 } } as unknown as PlannotatorConfig, "decisionMode", envOnly)).toBe(false);
  });

  test("--off and --on write config.json's value", () => {
    expect(nextUsageCountsConfig(undefined, false)).toBe(false);
    expect(nextUsageCountsConfig(false, true)).toBeUndefined();
    expect(nextUsageCountsConfig(undefined, false, "decisionMode")).toEqual({ decisionMode: false });
    expect(nextUsageCountsConfig({ decisionMode: false }, true, "decisionMode")).toBeUndefined();
    expect(nextUsageCountsConfig(false, true, "decisionMode")).toBeUndefined();
  });
});

describe("recording", () => {
  test("off records nothing and makes no folder", () => {
    const dataDir = scratch();
    for (const [config, env] of [
      [{}, {}],
      [{ ...ON, usageCounts: false }, {}],
      [ON, { DO_NOT_TRACK: "1" }],
      [ON, { PLANNOTATOR_TELEMETRY: "0" }],
    ] as [PlannotatorConfig, NodeJS.ProcessEnv][]) {
      expect(recordUsageCount("decisionMode", "opened", deps(dataDir, config, NOON, env))).toBe(false);
    }
    expect(recordUsageCount("decisionMode", "opened", deps(dataDir, ON, Date.UTC(2027, 4, 1)))).toBe(false);
    expect(existsSync(usageCountsDir(dataDir))).toBe(false);
  });

  test("no notice records nothing; an older notice records nothing until the new one is shown", () => {
    const dataDir = scratch();
    expect(recordUsageCount("decisionMode", "opened", deps(dataDir, { experimental: { decisionMode: true } } as PlannotatorConfig, NOON))).toBe(false);
    const older = { ...ON, usageCountsNotice: { decisionMode: 0 } } as PlannotatorConfig;
    expect(recordUsageCount("decisionMode", "opened", deps(dataDir, older, NOON))).toBe(false);
    expect(existsSync(usageCountsDir(dataDir))).toBe(false);
    expect(recordUsageCount("decisionMode", "opened", deps(dataDir, ON, NOON))).toBe(true);
    // The notice version drops back (a newer registry): what waits is deleted, nothing more is recorded.
    expect(recordUsageCount("decisionMode", "opened", deps(dataDir, older, NOON))).toBe(false);
    expect(existsSync(join(usageCountsDir(dataDir), "counts.json"))).toBe(false);
  });

  test("a build that sends nowhere records nothing", () => {
    const dataDir = scratch();
    for (const version of [undefined, "0.0.0-dev"]) {
      expect(recordUsageCount("decisionMode", "opened", { ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: "" }), version })).toBe(false);
      expect(recordUsageCount("decisionMode", "opened", { ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: "https://example.com" }), version })).toBe(false);
    }
    expect(existsSync(usageCountsDir(dataDir))).toBe(false);
    // A release records (and would send to the service; nothing here sends).
    expect(recordUsageCount("decisionMode", "opened", { ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: "" }), version: "9.9.9" })).toBe(true);
  });

  test("counts add and cap at 100, day events stay 1, files are owner-only", () => {
    const dataDir = scratch();
    recordDay(dataDir, ON, NOON, { opened: 130, active_day: 3, decided: 2 });
    expect(todayUsageCounts(deps(dataDir, ON, NOON))).toEqual({ decisionMode: { active_day: 1, opened: 100, decided: 2 } });
    if (process.platform !== "win32") {
      expect(statSync(usageCountsDir(dataDir)).mode & 0o777).toBe(0o700);
      expect(statSync(join(usageCountsDir(dataDir), "counts.json")).mode & 0o777).toBe(0o600);
    }
  });

  test("an id outside the registry is never recorded", () => {
    const dataDir = scratch();
    const record = recordUsageCount as (f: string, e: string, d: unknown) => boolean;
    expect(record("decisionMode", "/Users/me/notes.md", deps(dataDir, ON, NOON))).toBe(false);
    expect(record("decisionMode", "first_day", deps(dataDir, ON, NOON))).toBe(false);
    expect(record("somethingElse", "opened", deps(dataDir, ON, NOON))).toBe(false);
    expect(existsSync(usageCountsDir(dataDir))).toBe(false);
  });

  test("today is never waiting; a day waits once it is complete in UTC", () => {
    const dataDir = scratch();
    recordDay(dataDir, ON, NOON, { opened: 1 });
    expect(pendingUsageCountBatches(deps(dataDir, ON, NOON))).toEqual([]);
    expect(pendingUsageCountBatches(deps(dataDir, ON, Date.UTC(2026, 9, 24, 23, 59)))).toEqual([]);
    expect(pendingUsageCountBatches(deps(dataDir, ON, Date.UTC(2026, 9, 25, 0, 0, 1))).map((b) => b.day)).toEqual(["2026-10-24"]);
  });

  test("turning counts off deletes what was not sent", () => {
    const dataDir = scratch();
    recordDay(dataDir, ON, NOON - DAY, { opened: 2 });
    recordDay(dataDir, ON, NOON, { opened: 1 });
    // Off in config: the next record call deletes and records nothing.
    expect(recordUsageCount("decisionMode", "opened", deps(dataDir, { ...ON, usageCounts: false } as PlannotatorConfig, NOON))).toBe(false);
    expect(existsSync(join(usageCountsDir(dataDir), "counts.json"))).toBe(false);
    const facts = JSON.parse(readFileSync(join(usageCountsDir(dataDir), "facts.json"), "utf-8"));
    expect(facts).toEqual({ v: 1, features: { decisionMode: { used: true } } });
  });

  test("forgetting every feature leaves only the first-day marker", () => {
    const dataDir = scratch();
    recordDay(dataDir, ON, NOON, { opened: 1 });
    forgetUsageCounts({ dataDir });
    expect(existsSync(join(usageCountsDir(dataDir), "counts.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(usageCountsDir(dataDir), "facts.json"), "utf-8")).features.decisionMode).toEqual({ used: true });
  });

  test("a day older than 3 days is dropped unsent (the service would refuse it)", () => {
    const dataDir = scratch();
    recordDay(dataDir, ON, NOON - 4 * DAY, { opened: 1 });
    recordDay(dataDir, ON, NOON - 3 * DAY, { opened: 1 });
    expect(pendingUsageCountBatches(deps(dataDir, ON, NOON)).map((b) => b.day)).toEqual(["2026-10-21"]);
  });
});

describe("the two facts, worked out on this computer", () => {
  test("first_day once, and days_last7 across days", () => {
    const dataDir = scratch();
    const at = (d: number) => Date.UTC(2026, 9, d, 15);
    // Used (opened) on the 1st, 2nd, 4th, 5th, 6th, 7th and 20th; on the 3rd the
    // Inbox was open with it on but it was not used. Each day is read back the
    // next day, as the sender would.
    const byDay: Record<string, Record<string, number>> = {};
    for (const d of [1, 2, 3, 4, 5, 6, 7, 20]) {
      recordDay(dataDir, ON, at(d), d === 3 ? { active_day: 1 } : { active_day: 1, opened: 1 });
      for (const b of pendingUsageCountBatches(deps(dataDir, ON, at(d) + DAY))) byDay[b.day] = JSON.parse(b.body).events;
    }
    expect(byDay["2026-10-01"]).toEqual({ active_day: 1, opened: 1, first_day: 1, days_last7: 1 });
    expect(byDay["2026-10-02"]).toEqual({ active_day: 1, opened: 1, days_last7: 2 }); // 2 days: 2-3
    expect(byDay["2026-10-03"]).toEqual({ active_day: 1, days_last7: 2 }); // 1st, 2nd: 2-3
    expect(byDay["2026-10-05"]!.days_last7).toBe(4); // 1, 2, 4, 5: 4-5
    expect(byDay["2026-10-07"]!.days_last7).toBe(6); // 1, 2, 4, 5, 6, 7: 6-7
    expect(byDay["2026-10-20"]).toEqual({ active_day: 1, opened: 1, days_last7: 1 });
    expect(Object.values(byDay).filter((e) => e.first_day).length).toBe(1);
    // facts.json holds no date but the used days of the last 10 days.
    const facts = JSON.parse(readFileSync(join(usageCountsDir(dataDir), "facts.json"), "utf-8"));
    expect(facts.features.decisionMode.used).toBe(true);
    expect(Object.keys(facts.features.decisionMode).sort()).toEqual(["used", "usedDays"]);
  });

  test("first_day is sent once per install, even after counts went off and on", async () => {
    const dataDir = scratch();
    const endpoint = fakeEndpoint();
    try {
      const env = { PLANNOTATOR_TELEMETRY_URL: endpoint.url };
      recordDay(dataDir, ON, NOON - 2 * DAY, { opened: 1 });
      const first = await sendUsageCounts({ ...deps(dataDir, ON, NOON, env), version: undefined });
      expect(first.sent).toBe(1);
      expect(endpoint.requests[0]).toContain('"first_day":1');
      forgetUsageCounts({ dataDir });
      recordDay(dataDir, ON, NOON, { opened: 1 });
      await sendUsageCounts({ ...deps(dataDir, ON, NOON + DAY, env), version: undefined, force: true });
      expect(endpoint.requests.length).toBe(2);
      expect(endpoint.requests[1]).not.toContain("first_day");
    } finally {
      endpoint.stop();
    }
  });
});

describe("the allowlist is the only path into a batch", () => {
  // Whatever the files on disk hold, a batch carries only registry ids, a
  // revision, a day and whole numbers: no string from the files reaches it.
  const featureIds = USAGE_COUNT_FEATURES.map((f) => f.id);
  const eventIds = USAGE_COUNT_FEATURES.flatMap((f) => f.events.map((e) => e.id));
  const key = fc.oneof(fc.constantFrom(...featureIds, ...eventIds, "rev", "events", "closed", "__proto__", "constructor"), fc.string(), fc.constantFrom("/Users/me/secret.md", "msg_01ABC", "ses_x"));
  const junk = fc.letrec((tie) => ({
    value: fc.oneof(
      { depthSize: "small" },
      fc.integer({ min: -5, max: 1e9 }),
      fc.double(),
      fc.string(),
      fc.boolean(),
      fc.constant(null),
      fc.array(tie("value"), { maxLength: 3 }),
      fc.dictionary(key, tie("value"), { maxKeys: 5 }),
    ),
  })).value;
  const dayKey = fc.oneof(fc.integer({ min: 1, max: 40 }).map((n) => utcDay(NOON - n * DAY)), fc.string());
  const counts = fc.record({
    v: junk,
    days: fc.dictionary(dayKey, fc.dictionary(fc.oneof(fc.constantFrom(...featureIds), fc.string()), fc.record({ rev: fc.oneof(fc.constant(1), junk), events: fc.oneof(fc.dictionary(key, junk, { maxKeys: 12 }), junk), closed: fc.oneof(fc.constant(true), junk) }, { requiredKeys: [] }), { maxKeys: 3 }), { maxKeys: 6 }),
  });

  const allowedStrings = new Set<string>([...featureIds, ...eventIds, "schema", "feature", "rev", "day", "events"]);
  const grammar = new RegExp(
    `^\\{"schema":1,"feature":"(${featureIds.join("|")})","rev":[1-9]\\d*,"day":"\\d{4}-\\d{2}-\\d{2}","events":\\{("(${eventIds.join("|")})":(100|[1-9]\\d?)(,"(${eventIds.join("|")})":(100|[1-9]\\d?))*)\\}\\}$`,
  );

  test("junk counts.json and facts.json yield only grammatical batches", () => {
    fc.assert(
      fc.property(counts, junk, (countsFile, factsFile) => {
        const dataDir = scratch();
        const dir = usageCountsDir(dataDir);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "counts.json"), JSON.stringify(countsFile));
        writeFileSync(join(dir, "facts.json"), JSON.stringify(factsFile));
        for (const batch of pendingUsageCountBatches(deps(dataDir, ON, NOON))) {
          expect(batch.body).toMatch(grammar);
          expect(parseUsageCountsBatch(batch.body, { today: utcDay(NOON) })).not.toBeNull();
          const strings = [...batch.body.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
          for (const s of strings) expect(allowedStrings.has(s) || s === batch.day).toBe(true);
        }
        rmSync(dataDir, { recursive: true, force: true });
      }),
      { numRuns: 300 },
    );
  });

  test("a recorder given any string records only registry events", () => {
    const record = recordUsageCount as (f: unknown, e: unknown, d: unknown) => boolean;
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.constantFrom(...featureIds)), fc.oneof(fc.string(), fc.constantFrom(...eventIds)), (feature, event) => {
        const dataDir = scratch();
        const recorded = record(feature, event, deps(dataDir, ON, NOON - DAY));
        const recordable = feature === "decisionMode" && ["active_day", "entry_shown", "opened", "decided", "sent", "to_thread", "finished"].includes(event);
        expect(recorded).toBe(recordable);
        for (const b of pendingUsageCountBatches(deps(dataDir, ON, NOON))) expect(b.body).toMatch(grammar);
        rmSync(dataDir, { recursive: true, force: true });
      }),
      { numRuns: 200 },
    );
  });
});

describe("where counts go", () => {
  test("a build that is not a release sends nowhere without a loopback test endpoint", () => {
    expect(resolveUsageCountsEndpoint(undefined, {})).toBeNull();
    expect(resolveUsageCountsEndpoint("0.0.0-dev", {})).toBeNull();
    expect(resolveUsageCountsEndpoint(undefined, { PLANNOTATOR_TELEMETRY_URL: "https://example.com" })).toBeNull();
    expect(resolveUsageCountsEndpoint(undefined, { PLANNOTATOR_TELEMETRY_URL: "http://10.0.0.1:8787" })).toBeNull();
    expect(resolveUsageCountsEndpoint(undefined, { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1.evil.example:80" })).toBeNull();
    expect(resolveUsageCountsEndpoint(undefined, { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:8787/elsewhere" })).toBeNull();
    expect(resolveUsageCountsEndpoint(undefined, { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:8787" })?.host).toBe("127.0.0.1:8787");
    expect(resolveUsageCountsEndpoint(undefined, { PLANNOTATOR_TELEMETRY_URL: "http://[::1]:8787" })?.hostname).toBe("::1");
  });

  test("a release sends to the service and ignores the test endpoint outside the test sandbox", () => {
    expect(resolveUsageCountsEndpoint("0.28.30", {})).toEqual(USAGE_COUNTS_ENDPOINT);
    expect(resolveUsageCountsEndpoint("0.28.30", { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:8787" })).toEqual(USAGE_COUNTS_ENDPOINT);
    expect(resolveUsageCountsEndpoint("0.28.30", { PLANNOTATOR_TELEMETRY_URL: "http://127.0.0.1:8787", PLANNOTATOR_TEST_SANDBOX: "/tmp/x" })?.host).toBe("127.0.0.1:8787");
    expect(USAGE_COUNTS_ENDPOINT.url).toBe("https://counts.plannotator.ai/v1/counts");
  });
});

describe("sending", () => {
  test("one request per complete day, exactly the bytes in the table, oldest first", async () => {
    const dataDir = scratch();
    const endpoint = fakeEndpoint();
    try {
      recordDay(dataDir, ON, NOON - 2 * DAY, { active_day: 1, opened: 3, decided: 14 });
      recordDay(dataDir, ON, NOON - DAY, { active_day: 1, entry_shown: 1, sent: 4 });
      recordDay(dataDir, ON, NOON, { opened: 1 });
      const waiting = pendingUsageCountBatches(deps(dataDir, ON, NOON));
      const result = await sendUsageCounts({ ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: endpoint.url }), version: undefined });
      expect(result).toMatchObject({ status: "sent", sent: 2, dropped: 0 });
      expect(endpoint.requests).toEqual(waiting.map((b) => buildUsageCountsRequest(endpoint.host, b.body)));
      expect(endpoint.requests[0]).toBe(
        `POST /v1/counts HTTP/1.1\r\nHost: ${endpoint.host}\r\nUser-Agent: plannotator-telemetry\r\nContent-Type: application/json\r\nContent-Length: 143\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n` +
          '{"schema":1,"feature":"decisionMode","rev":1,"day":"2026-10-22","events":{"active_day":1,"opened":3,"decided":14,"first_day":1,"days_last7":1}}',
      );
      // Sent days leave the store; today stays; the sent log keeps the bodies.
      expect(pendingUsageCountBatches(deps(dataDir, ON, NOON))).toEqual([]);
      expect(todayUsageCounts(deps(dataDir, ON, NOON))).toEqual({ decisionMode: { opened: 1 } });
      expect(sentUsageCounts({ dataDir }).map((s) => s.body)).toEqual(waiting.map((b) => b.body));
      // At most one attempt an hour: today's day goes after midnight, then a day
      // that waits again within the hour waits for the next hour.
      const env = { PLANNOTATOR_TELEMETRY_URL: endpoint.url };
      const tomorrow = Date.UTC(2026, 9, 25, 0, 10);
      expect((await sendUsageCounts({ ...deps(dataDir, ON, tomorrow, env), version: undefined })).sent).toBe(1);
      recordDay(dataDir, ON, Date.UTC(2026, 9, 24, 23, 0), { opened: 1 });
      expect((await sendUsageCounts({ ...deps(dataDir, ON, tomorrow + 20 * 60_000, env), version: undefined })).status).toBe("not_due");
      expect((await sendUsageCounts({ ...deps(dataDir, ON, tomorrow + 61 * 60_000, env), version: undefined })).status).toBe("sent");
      expect(endpoint.requests.length).toBe(4);
    } finally {
      endpoint.stop();
    }
  });

  const offCases: [string, PlannotatorConfig, NodeJS.ProcessEnv][] = [
    ["counts turned off in config", { ...ON, usageCounts: false } as PlannotatorConfig, {}],
    ["counts turned off for the feature", { ...ON, usageCounts: { decisionMode: false } } as PlannotatorConfig, {}],
    ["the feature off", {}, {}],
    ["DO_NOT_TRACK=1", { ...ON, usageCounts: { decisionMode: true } } as PlannotatorConfig, { DO_NOT_TRACK: "1" }],
    ["PLANNOTATOR_TELEMETRY=0", ON, { PLANNOTATOR_TELEMETRY: "0" }],
  ];
  for (const [what, config, env] of offCases) {
    test(`nothing is sent and unsent counts are deleted: ${what}`, async () => {
      const dataDir = scratch();
      const endpoint = fakeEndpoint();
      try {
        recordDay(dataDir, ON, NOON - 2 * DAY, { opened: 2 });
        recordDay(dataDir, ON, NOON - DAY, { opened: 2 });
        const result = await sendUsageCounts({ ...deps(dataDir, config, NOON, { ...env, PLANNOTATOR_TELEMETRY_URL: endpoint.url }), version: undefined, force: true });
        expect(result.sent).toBe(0);
        expect(endpoint.requests.length).toBe(0);
        expect(existsSync(join(usageCountsDir(dataDir), "counts.json"))).toBe(false);
      } finally {
        endpoint.stop();
      }
    });
  }

  test("past the end day nothing is sent", async () => {
    const dataDir = scratch();
    const endpoint = fakeEndpoint();
    try {
      recordDay(dataDir, ON, Date.UTC(2027, 3, 30, 12), { opened: 2 });
      const result = await sendUsageCounts({ ...deps(dataDir, ON, Date.UTC(2027, 4, 1, 12), { PLANNOTATOR_TELEMETRY_URL: endpoint.url }), version: undefined, force: true });
      expect(result.status).toBe("off");
      expect(endpoint.requests.length).toBe(0);
    } finally {
      endpoint.stop();
    }
  });

  test("a build that is not a release with no test endpoint sends nothing and connects nowhere", async () => {
    const dataDir = scratch();
    // Recorded by a build that could send (a test endpoint), then read by one that cannot.
    recordDay(dataDir, ON, NOON - DAY, { opened: 2 });
    let called = 0;
    const result = await sendUsageCounts({
      ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: "" }),
      version: "0.0.0-dev",
      force: true,
      transport: async () => {
        called++;
        return { status: 204, retryAfter: null };
      },
    });
    expect(result.status).toBe("nowhere");
    expect(called).toBe(0);
  });

  test("a failure waits 6 hours, a 429 waits for Retry-After, a 400 drops the batch", async () => {
    const dataDir = scratch();
    const answers = ["HTTP/1.1 503 Service Unavailable\r\n\r\n", "HTTP/1.1 429 Too Many Requests\r\nRetry-After: 7200\r\n\r\n", "HTTP/1.1 400 Bad Request\r\n\r\n", "HTTP/1.1 204 No Content\r\n\r\n"];
    const endpoint = fakeEndpoint((n) => answers[n - 1] ?? answers[3]!);
    try {
      const env = { PLANNOTATOR_TELEMETRY_URL: endpoint.url };
      recordDay(dataDir, ON, NOON - 2 * DAY, { opened: 1 });
      recordDay(dataDir, ON, NOON - DAY, { opened: 1 });
      const send = (at: number) => sendUsageCounts({ ...deps(dataDir, ON, at, env), version: undefined });
      expect((await send(NOON)).status).toBe("failed");
      expect((await send(NOON + 5 * 3_600_000)).status).toBe("not_due");
      expect((await send(NOON + 6 * 3_600_000)).status).toBe("rate_limited");
      expect((await send(NOON + 7 * 3_600_000)).status).toBe("not_due");
      const after = await send(NOON + 8 * 3_600_000 + 1);
      expect(after).toMatchObject({ dropped: 1, sent: 1 });
      expect(endpoint.requests.length).toBe(4);
      expect(pendingUsageCountBatches(deps(dataDir, ON, NOON + DAY))).toEqual([]);
    } finally {
      endpoint.stop();
    }
  });

  test("a closed day waits a random delay past its close; --send (force) does not wait", async () => {
    const dataDir = scratch();
    const endpoint = fakeEndpoint();
    try {
      const env = { PLANNOTATOR_TELEMETRY_URL: endpoint.url };
      const half = { random: () => 0.5 };
      recordDay(dataDir, ON, NOON - DAY, { opened: 1 });
      const closedAt = Date.UTC(2026, 9, 24, 0, 0);
      // The day closes at the first look after midnight; random 0.5 puts its send 2 hours later.
      expect((await sendUsageCounts({ ...deps(dataDir, ON, closedAt, env), ...half })).status).toBe("nothing");
      expect(pendingUsageCountBatches(deps(dataDir, ON, closedAt))[0]!.notBefore).toBe(closedAt + USAGE_COUNTS_CLOSE_DELAY_MAX_MS / 2);
      expect((await sendUsageCounts({ ...deps(dataDir, ON, closedAt + 3_600_000, env), ...half })).status).toBe("nothing");
      expect(endpoint.requests.length).toBe(0);
      expect((await sendUsageCounts({ ...deps(dataDir, ON, closedAt + USAGE_COUNTS_CLOSE_DELAY_MAX_MS / 2, env), ...half })).sent).toBe(1);
      recordDay(dataDir, ON, NOON, { opened: 1 });
      expect((await sendUsageCounts({ ...deps(dataDir, ON, NOON + DAY, env), ...half, force: true })).sent).toBe(1);
    } finally {
      endpoint.stop();
    }
  });

  test("batches of one attempt go with a random gap of 2 to 20 seconds between them", async () => {
    const dataDir = scratch();
    const endpoint = fakeEndpoint();
    try {
      recordDay(dataDir, ON, NOON - 3 * DAY, { opened: 1 });
      recordDay(dataDir, ON, NOON - 2 * DAY, { opened: 1 });
      recordDay(dataDir, ON, NOON - DAY, { opened: 1 });
      const gaps: number[] = [];
      const randoms = [0, 0.999, 0, 0.5];
      const result = await sendUsageCounts({
        ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: endpoint.url }),
        random: () => randoms.shift() ?? 0,
        sleep: async (ms) => void gaps.push(ms),
      });
      expect(result.sent).toBe(3);
      expect(gaps).toHaveLength(2);
      for (const g of gaps) expect(g >= 2_000 && g <= 20_000).toBe(true);
    } finally {
      endpoint.stop();
    }
  });

  test("turning one feature off removes its sent-log lines and the send state", async () => {
    const dataDir = scratch();
    const endpoint = fakeEndpoint();
    try {
      recordDay(dataDir, ON, NOON - DAY, { opened: 1 });
      await sendUsageCounts({ ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: endpoint.url }) });
      expect(sentUsageCounts({ dataDir })).toHaveLength(1);
      expect(existsSync(join(usageCountsDir(dataDir), "state.json"))).toBe(true);
      forgetUsageCounts({ dataDir, feature: "decisionMode" });
      expect(sentUsageCounts({ dataDir })).toEqual([]);
      expect(existsSync(join(usageCountsDir(dataDir), "sent.jsonl"))).toBe(false);
      expect(existsSync(join(usageCountsDir(dataDir), "state.json"))).toBe(false);
      // Only the marker stays.
      expect(JSON.parse(readFileSync(join(usageCountsDir(dataDir), "facts.json"), "utf-8"))).toEqual({ v: 1, features: { decisionMode: { used: true } } });
    } finally {
      endpoint.stop();
    }
  });

  test("the send window rules", () => {
    expect(isUsageCountsSendDue({}, NOON)).toBe(true);
    expect(isUsageCountsSendDue({ attemptedAt: NOON - 59 * 60_000 }, NOON)).toBe(false);
    expect(isUsageCountsSendDue({ attemptedAt: NOON - 60 * 60_000 }, NOON)).toBe(true);
    expect(isUsageCountsSendDue({ attemptedAt: NOON + 60_000 }, NOON)).toBe(true); // a clock that moved back
  });

  test("--show's report names the batches waiting and never sends", () => {
    const dataDir = scratch();
    recordDay(dataDir, ON, NOON - DAY, { opened: 2 });
    const report = describeUsageCounts({ ...deps(dataDir, ON, NOON), version: undefined });
    expect(report.endpoint).toBe("http://127.0.0.1:9/v1/counts");
    expect(report.records).toBe(true);
    expect(describeUsageCounts({ ...deps(dataDir, ON, NOON, { PLANNOTATOR_TELEMETRY_URL: "" }), version: undefined }).records).toBe(false);
    expect(report.features[0]!.counts).toEqual({ on: true, reason: "on" });
    expect(report.features[0]!.waiting.map((b) => b.body)).toEqual([
      '{"schema":1,"feature":"decisionMode","rev":1,"day":"2026-10-23","events":{"opened":2,"first_day":1,"days_last7":1}}',
    ]);
  });
});
