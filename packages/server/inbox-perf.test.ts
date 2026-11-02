/**
 * The Inbox's server timings (inbox-perf.ts): every `/api/inbox/` answer says where its time went, a slow one
 * reaches the debug log with its phases, and a stalled event loop is noticed. No server, no data dir: the
 * wrapper is tested around a plain handler.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_SLOW_REQUEST_MS, perfPhase, withServerTiming, watchLoopStalls, type SlowRequest } from "./inbox-perf";

const busy = (ms: number) => {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Synchronous work, as a store read is.
  }
};
const route = (pathname: string) => pathname.replace(/msg_[A-Z0-9]+/, "*");

describe("withServerTiming", () => {
  test("an /api/inbox/ answer carries Server-Timing: each phase (repeats summed) and app", async () => {
    const served = withServerTiming(
      async () => {
        perfPhase("rows", () => busy(3));
        perfPhase("rows", () => busy(3));
        return perfPhase("json", () => new Response("{}"));
      },
      route,
      null,
    );
    const header = (await served(new Request("http://127.0.0.1/api/inbox/threads"), "local")).headers.get("Server-Timing") ?? "";
    const dur = (name: string) => Number(new RegExp(`(?:^|, )${name};dur=([0-9.]+)`).exec(header)?.[1] ?? NaN);
    expect(dur("rows")).toBeGreaterThanOrEqual(6);
    expect(dur("json")).toBeGreaterThanOrEqual(0);
    expect(dur("app")).toBeGreaterThanOrEqual(dur("rows"));
    expect(header.match(/rows;/g)?.length).toBe(1);
  });

  test("the page and other routes get no header", async () => {
    const served = withServerTiming(async () => new Response("<html>"), route, null);
    expect((await served(new Request("http://127.0.0.1/"), "local")).headers.get("Server-Timing")).toBeNull();
  });

  test("a slow request is reported once with its route and phases; a fast one is not", async () => {
    const heard: SlowRequest[] = [];
    let wait = 0;
    const served = withServerTiming(
      async () => {
        perfPhase("thread", () => busy(wait));
        return new Response("{}");
      },
      route,
      (slow) => heard.push(slow),
    );
    await served(new Request("http://127.0.0.1/api/inbox/threads/msg_01ABC"), "local");
    expect(heard).toEqual([]);
    wait = INBOX_SLOW_REQUEST_MS + 20;
    await served(new Request("http://127.0.0.1/api/inbox/threads/msg_01ABC"), "local");
    expect(heard).toHaveLength(1);
    expect(heard[0]!.route).toBe("/api/inbox/threads/*");
    expect(heard[0]!.ms).toBeGreaterThanOrEqual(INBOX_SLOW_REQUEST_MS);
    expect(heard[0]!.phases.thread).toBeGreaterThanOrEqual(INBOX_SLOW_REQUEST_MS);
  });

  test("a log that throws never costs the answer", async () => {
    const served = withServerTiming(
      async () => {
        busy(INBOX_SLOW_REQUEST_MS + 10);
        return new Response("ok");
      },
      route,
      () => {
        throw new Error("disk full");
      },
    );
    const response = await served(new Request("http://127.0.0.1/api/inbox/drafts"), "local");
    expect(await response.text()).toBe("ok");
  });

  test("perfPhase outside a request just runs", () => {
    expect(perfPhase("rows", () => 7)).toBe(7);
  });
});

test("watchLoopStalls hears a blocked event loop, and stops", async () => {
  const stalls: number[] = [];
  const stop = watchLoopStalls((ms) => stalls.push(ms));
  await Bun.sleep(300);
  busy(450);
  await Bun.sleep(300);
  stop();
  expect(stalls.some((ms) => ms >= 100)).toBe(true);
  const seen = stalls.length;
  busy(450);
  await Bun.sleep(300);
  expect(stalls.length).toBe(seen);
});
