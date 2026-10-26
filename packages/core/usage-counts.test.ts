import { describe, expect, test } from "bun:test";
import {
  addUtcDays,
  buildUsageCountsBatch,
  buildUsageCountsRequest,
  countBucketLabel,
  daysLast7Label,
  daysLast7Value,
  isRecordableUsageCountEvent,
  isUtcDay,
  parseUsageCountsBatch,
  serializeUsageCountsBatch,
  USAGE_COUNT_FEATURES,
  usageCountFeature,
} from "./usage-counts";

const TODAY = "2026-10-24";
const FULL = { active_day: 1, entry_shown: 1, opened: 3, decided: 14, sent: 4, to_thread: 1, finished: 2, first_day: 1, days_last7: 2 };
const body = (over: Record<string, unknown> = {}) => JSON.stringify({ schema: 1, feature: "decisionMode", rev: 1, day: "2026-10-23", events: { opened: 3 }, ...over });

describe("the batch on the wire", () => {
  // Pinned on purpose: this is the byte table of the approval record. Every
  // computer sends exactly these bytes for these counts; a change here is a
  // change to what people agreed to send.
  test("one real batch, every byte", () => {
    const batch = buildUsageCountsBatch("decisionMode", 1, "2026-10-23", FULL)!;
    const text = serializeUsageCountsBatch(batch);
    expect(text).toBe(
      '{"schema":1,"feature":"decisionMode","rev":1,"day":"2026-10-23","events":{"active_day":1,"entry_shown":1,"opened":3,"decided":14,"sent":4,"to_thread":1,"finished":2,"first_day":1,"days_last7":2}}',
    );
    const request = buildUsageCountsRequest("counts.plannotator.ai", text);
    expect(request).toBe(
      "POST /v1/counts HTTP/1.1\r\n" +
        "Host: counts.plannotator.ai\r\n" +
        "User-Agent: plannotator-telemetry\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: 195\r\n" +
        "Accept: */*\r\n" +
        "Accept-Encoding: identity\r\n" +
        "Connection: close\r\n" +
        "\r\n" +
        text,
    );
    const lines = request.split("\r\n");
    // [line, bytes including its CRLF]
    expect(lines.slice(0, 9).map((l) => l.length + 2)).toEqual([26, 29, 35, 32, 21, 13, 27, 19, 2]);
    expect(new TextEncoder().encode(text).length).toBe(195);
    expect(new TextEncoder().encode(request).length).toBe(399);
  });

  test("events go in registry order whatever order the store holds them, and zeros are left out", () => {
    const batch = buildUsageCountsBatch("decisionMode", 1, "2026-10-23", { finished: 2, opened: 3, decided: 0, active_day: 1 })!;
    expect(serializeUsageCountsBatch(batch)).toBe('{"schema":1,"feature":"decisionMode","rev":1,"day":"2026-10-23","events":{"active_day":1,"opened":3,"finished":2}}');
  });

  test("counts are capped at 100 and bad values dropped", () => {
    const batch = buildUsageCountsBatch("decisionMode", 1, "2026-10-23", {
      opened: 1000,
      decided: 2.5,
      sent: -1,
      to_thread: "3",
      active_day: 2,
      days_last7: 3,
      first_day: 1,
      path: "/Users/me/secret",
    })!;
    expect(batch.events).toEqual({ opened: 100, first_day: 1 });
  });

  test("nothing valid, an unknown feature, a bad revision or a day past the end is no batch", () => {
    expect(buildUsageCountsBatch("decisionMode", 1, "2026-10-23", { nope: 1 })).toBeNull();
    expect(buildUsageCountsBatch("otherThing", 1, "2026-10-23", { opened: 1 })).toBeNull();
    expect(buildUsageCountsBatch("decisionMode", 2, "2026-10-23", { opened: 1 })).toBeNull();
    expect(buildUsageCountsBatch("decisionMode", 0, "2026-10-23", { opened: 1 })).toBeNull();
    expect(buildUsageCountsBatch("decisionMode", 1, "2027-05-01", { opened: 1 })).toBeNull();
    expect(buildUsageCountsBatch("decisionMode", 1, "2026-02-30", { opened: 1 })).toBeNull();
  });
});

describe("the validator the client and the Worker share", () => {
  test("accepts a real batch", () => {
    const b = parseUsageCountsBatch(serializeUsageCountsBatch(buildUsageCountsBatch("decisionMode", 1, "2026-10-23", FULL)!), { today: TODAY });
    expect(b?.events).toEqual(FULL);
  });

  const refused: [string, string][] = [
    ["not JSON", "{"],
    ["an array", "[]"],
    ["an extra key", body({ version: "0.28.30" })],
    ["a missing key", JSON.stringify({ schema: 1, feature: "decisionMode", rev: 1, day: "2026-10-23" })],
    ["another schema", body({ schema: 2 })],
    ["an unknown feature", body({ feature: "secretFeature" })],
    ["a revision past the feature's", body({ rev: 2 })],
    ["a fractional revision", body({ rev: 1.5 })],
    ["a day that is not a day", body({ day: "2026-13-01" })],
    ["a day with a time", body({ day: "2026-10-23T10:00:00Z" })],
    ["a day 4 days back", body({ day: addUtcDays(TODAY, -4) })],
    ["a day two days ahead", body({ day: addUtcDays(TODAY, 2) })],
    ["an unknown event", body({ events: { opened: 1, path: 1 } })],
    ["no events", body({ events: {} })],
    ["a string value", body({ events: { opened: "3" } })],
    ["a zero", body({ events: { opened: 0 } })],
    ["a count over 100", body({ events: { opened: 101 } })],
    ["a day event of 2", body({ events: { active_day: 2 } })],
    ["first_day of 2", body({ events: { first_day: 2 } })],
    ["a days_last7 that is not a bucket", body({ events: { days_last7: 3 } })],
    ["nested events", body({ events: { opened: { n: 1 } } })],
    ["a body over 1024 bytes", body({ pad: "x".repeat(1100) })],
  ];
  for (const [what, text] of refused) {
    test(`refuses ${what}`, () => {
      expect(parseUsageCountsBatch(text, { today: TODAY })).toBeNull();
    });
  }

  test("refuses a day past the feature's end even when it is recent", () => {
    const end = usageCountFeature("decisionMode")!.collectUntil;
    expect(parseUsageCountsBatch(body({ day: addUtcDays(end, 1) }), { today: addUtcDays(end, 2) })).toBeNull();
    expect(parseUsageCountsBatch(body({ day: end }), { today: addUtcDays(end, 2) })).not.toBeNull();
  });

  test("allows one day of clock skew ahead and 3 days back", () => {
    expect(parseUsageCountsBatch(body({ day: addUtcDays(TODAY, 1) }), { today: TODAY })).not.toBeNull();
    expect(parseUsageCountsBatch(body({ day: addUtcDays(TODAY, -3) }), { today: TODAY })).not.toBeNull();
  });
});

describe("the registry", () => {
  test("decision mode's events, the two facts, its end date", () => {
    const f = usageCountFeature("decisionMode")!;
    expect(f.events.map((e) => e.id)).toEqual(["active_day", "entry_shown", "opened", "decided", "sent", "to_thread", "finished", "first_day", "days_last7"]);
    expect(f.collectUntil).toBe("2027-04-30");
    expect(isRecordableUsageCountEvent(f, "opened")).toBe(true);
    expect(isRecordableUsageCountEvent(f, "first_day")).toBe(false);
    expect(isRecordableUsageCountEvent(f, "days_last7")).toBe(false);
    expect(isRecordableUsageCountEvent(f, "nope")).toBe(false);
  });

  test("every feature names a recordable use event and a real end day; ids are unique", () => {
    const ids = new Set<string>();
    for (const f of USAGE_COUNT_FEATURES) {
      expect(ids.has(f.id)).toBe(false);
      ids.add(f.id);
      expect(isUtcDay(f.collectUntil)).toBe(true);
      expect(isRecordableUsageCountEvent(f, f.useEvent)).toBe(true);
      expect(new Set(f.events.map((e) => e.id)).size).toBe(f.events.length);
    }
  });

  test("days_last7 buckets and the Worker's spread buckets", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 9].map(daysLast7Value)).toEqual([null, 1, 2, 2, 4, 4, 6, 6, 6]);
    expect([1, 2, 4, 6, 3].map(daysLast7Label)).toEqual(["1", "2-3", "4-5", "6-7", null]);
    expect([1, 2, 3, 4, 9, 10, 29, 30, 100].map(countBucketLabel)).toEqual(["1", "2-3", "2-3", "4-9", "4-9", "10-29", "10-29", "30-100", "30-100"]);
  });
});
