import { describe, expect, test } from "bun:test";

import { createPRContextLiveCache, type PRContextStreamEvent } from "./pr-context-live";
import type { PRContext, PRRef } from "./pr-types";

const REF: PRRef = {
  platform: "github",
  host: "github.com",
  owner: "owner",
  repo: "repo",
  number: 7,
};

const URL = "https://github.com/owner/repo/pull/7";

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (cause: unknown) => void;
};

type ScheduledTimer = {
  readonly callback: () => void;
  readonly delayMs: number;
  cleared: boolean;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {};
  let reject: (cause: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeContext(body: string): PRContext {
  return {
    body,
    state: "OPEN",
    isDraft: false,
    labels: [],
    reviewDecision: "",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    comments: [],
    reviews: [],
    reviewThreads: [],
    checks: [],
    linkedIssues: [],
  };
}

function makeTimerHarness() {
  const timers: ScheduledTimer[] = [];
  return {
    timers,
    setTimer(callback: () => void, delayMs: number): ScheduledTimer {
      const timer = { callback, delayMs, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer: unknown): void {
      if (isScheduledTimer(timer)) timer.cleared = true;
    },
  };
}

function isScheduledTimer(value: unknown): value is ScheduledTimer {
  return (
    typeof value === "object" &&
    value !== null &&
    "callback" in value &&
    "delayMs" in value &&
    "cleared" in value &&
    typeof value.callback === "function" &&
    typeof value.delayMs === "number" &&
    typeof value.cleared === "boolean"
  );
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe("PRContextLiveCache", () => {
  test("shares one in-flight refresh across warmup, GET, and watchers", async () => {
    const first = deferred<PRContext>();
    const calls: PRRef[] = [];
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        return first.promise;
      },
    });
    const events: PRContextStreamEvent[] = [];

    cache.warm(URL, REF);
    const fromGet = cache.getContext(URL, REF);
    const unsubscribe = cache.watch(URL, REF, (event) => events.push(event));
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "snapshot", loading: true });

    const context = makeContext("ready");
    first.resolve(context);

    await expect(fromGet).resolves.toBe(context);
    expect(events.map((event) => event.type)).toEqual(["snapshot", "updated"]);
    expect(events[1]).toMatchObject({ type: "updated", context });

    unsubscribe();
  });

  test("refreshes once per PR URL for multiple watchers and stops the timer after the last watcher leaves", async () => {
    const first = deferred<PRContext>();
    const timers = makeTimerHarness();
    const calls: PRRef[] = [];
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        return first.promise;
      },
      refreshIntervalMs: 100,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const unsubscribeA = cache.watch(URL, REF, () => {});
    const unsubscribeB = cache.watch(URL, REF, () => {});
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(timers.timers).toHaveLength(1);
    expect(timers.timers[0]?.delayMs).toBe(100);

    first.resolve(makeContext("ready"));
    await cache.getContext(URL, REF);

    unsubscribeA();
    expect(timers.timers[0]?.cleared).toBe(false);

    unsubscribeB();
    unsubscribeB();
    expect(timers.timers[0]?.cleared).toBe(true);
  });

  test("does not leak a watcher when the initial snapshot subscriber throws", async () => {
    const timers = makeTimerHarness();
    const calls: PRRef[] = [];
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        return Promise.resolve(makeContext("ready"));
      },
      refreshIntervalMs: 100,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const unsubscribe = cache.watch(URL, REF, () => {
      throw new Error("closed");
    });
    await flushAsync();

    expect(calls).toHaveLength(0);
    expect(timers.timers).toHaveLength(0);
    unsubscribe();
  });

  test("does not keep refreshing after a subscriber throws during broadcast", async () => {
    const timers = makeTimerHarness();
    const calls: PRRef[] = [];
    const events: string[] = [];
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        return Promise.resolve(makeContext("ready"));
      },
      refreshIntervalMs: 100,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const unsubscribe = cache.watch(URL, REF, (event) => {
      events.push(event.type);
      if (event.type === "updated") throw new Error("closed");
    });
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(events).toEqual(["snapshot", "loading", "updated"]);
    expect(timers.timers.every((timer) => timer.cleared)).toBe(true);
    unsubscribe();
  });

  test("refreshes watched context again when the scheduled timer fires", async () => {
    let now = 0;
    const timers = makeTimerHarness();
    const results = [makeContext("first"), makeContext("second")];
    const calls: PRRef[] = [];
    const events: PRContextStreamEvent[] = [];
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        const next = results.shift();
        if (!next) throw new Error("unexpected fetch");
        return Promise.resolve(next);
      },
      refreshIntervalMs: 100,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const unsubscribe = cache.watch(URL, REF, (event) => events.push(event));
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(events.some((event) => event.type === "updated" && event.context.body === "first")).toBe(true);

    now = 100;
    timers.timers[0]?.callback();
    await flushAsync();

    expect(calls).toHaveLength(2);
    expect(events.some((event) => event.type === "updated" && event.context.body === "second")).toBe(true);

    unsubscribe();
  });

  test("queues a post-write refresh after an in-flight refresh finishes", async () => {
    const first = deferred<PRContext>();
    const calls: PRRef[] = [];
    const events: PRContextStreamEvent[] = [];
    const secondContext = makeContext("after write");
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        if (calls.length === 1) return first.promise;
        return Promise.resolve(secondContext);
      },
    });

    const unsubscribe = cache.watch(URL, REF, (event) => events.push(event));
    await flushAsync();
    expect(calls).toHaveLength(1);

    cache.refreshAfterWrite(URL, REF);
    first.resolve(makeContext("before write"));
    await flushAsync();

    expect(calls).toHaveLength(2);
    await expect(cache.getContext(URL, REF)).resolves.toBe(secondContext);
    expect(events.some((event) => event.type === "updated" && event.context.body === "after write")).toBe(true);

    unsubscribe();
  });

  test("reschedules watched retries from forced refresh failures", async () => {
    let now = 0;
    const timers = makeTimerHarness();
    const calls: PRRef[] = [];
    const events: PRContextStreamEvent[] = [];
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        if (calls.length === 1) return Promise.resolve(makeContext("ready"));
        return Promise.reject(new Error("provider rate limited"));
      },
      refreshIntervalMs: 100,
      failureCooldownMs: 1_000,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const unsubscribe = cache.watch(URL, REF, (event) => events.push(event));
    await flushAsync();

    expect(calls).toHaveLength(1);
    expect(timers.timers).toHaveLength(1);
    expect(timers.timers[0]?.cleared).toBe(false);

    now = 10;
    cache.refreshAfterWrite(URL, REF);
    await flushAsync();

    expect(calls).toHaveLength(2);
    expect(timers.timers[0]?.cleared).toBe(true);
    const activeTimers = timers.timers.filter((timer) => !timer.cleared);
    expect(activeTimers).toHaveLength(1);
    expect(activeTimers[0]?.delayMs).toBe(1_000);
    expect(events.find((event) => event.type === "error")).toMatchObject({
      type: "error",
      retryAt: 1_010,
    });

    unsubscribe();
  });

  test("keeps the last good context visible and broadcasts stale errors after refresh failure", async () => {
    let now = 0;
    const timers = makeTimerHarness();
    const firstContext = makeContext("first");
    const calls: PRRef[] = [];
    const events: PRContextStreamEvent[] = [];
    const cache = createPRContextLiveCache({
      fetchContext(ref) {
        calls.push(ref);
        if (calls.length === 1) return Promise.resolve(firstContext);
        return Promise.reject(new Error("provider rate limited"));
      },
      refreshIntervalMs: 100,
      failureCooldownMs: 1_000,
      now: () => now,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });

    const unsubscribe = cache.watch(URL, REF, (event) => events.push(event));
    await flushAsync();

    now = 100;
    timers.timers[0]?.callback();
    await flushAsync();

    const errorEvent = events.find((event) => event.type === "error");
    expect(errorEvent).toMatchObject({
      type: "error",
      error: "provider rate limited",
      stale: true,
      retryAt: 1_100,
    });

    await expect(cache.getContext(URL, REF)).resolves.toBe(firstContext);

    unsubscribe();
  });
});
