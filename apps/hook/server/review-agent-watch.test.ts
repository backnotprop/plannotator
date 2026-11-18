/**
 * Whether a local code review's agent is gone (review-agent-watch.ts).
 *
 * What regresses if this fails: a review whose agent quit keeps its server
 * forever (the pile of leftover programs), or a review whose agent is still
 * there (a live Claude Code session, a quick `claude --continue`, a laptop
 * that slept) is ended under the person.
 */
import { describe, expect, test } from "bun:test";
import { PlannotatorMod } from "../hooks/mod/controller";
import { fakeHost, type RunCall } from "../hooks/mod/testing/fake-host";
import {
  AGENT_GONE_EXIT_CODE,
  MOD_AGENT_GONE_AFTER_MS,
  endReviewWhenAgentGone,
  modLeaseAgentWatch,
  parentAgentWatch,
  reviewAgentWatch,
  SLEEP_GAP_MS,
} from "./review-agent-watch";

describe("the parent that reads stdout", () => {
  test("off Windows: gone once the review is reparented, and stays gone", () => {
    let ppid = 4242;
    const watch = parentAgentWatch({ startPpid: 4242, platform: "darwin", currentPpid: () => ppid, parentExists: () => true });
    expect(watch.presence()).toBe("here");
    ppid = 1;
    expect(watch.presence()).toBe("gone");
    ppid = 4242;
    expect(watch.presence()).toBe("gone");
  });

  test("on Windows (never reparented): gone once the parent pid no longer exists", () => {
    let alive = true;
    const watch = parentAgentWatch({ startPpid: 4242, platform: "win32", currentPpid: () => 4242, parentExists: () => alive });
    expect(watch.presence()).toBe("here");
    alive = false;
    expect(watch.presence()).toBe("gone");
  });

  test("stdout to a terminal or a file, or no real parent: nothing to watch", () => {
    const base = { hostResultFile: undefined, startPpid: 4242, platform: "linux" as const, dataDir: "/data" };
    expect(reviewAgentWatch({ ...base, stdoutPiped: true })?.kind).toBe("parent");
    expect(reviewAgentWatch({ ...base, stdoutPiped: false })).toBeNull();
    expect(reviewAgentWatch({ ...base, stdoutPiped: true, startPpid: 1 })).toBeNull();
  });

  test("a host result file outside the Claude Code mod's launches (T3, DeepSeek Harness): nothing to watch", () => {
    const base = { stdoutPiped: false, startPpid: 4242, platform: "linux" as const, dataDir: "/data" };
    expect(reviewAgentWatch({ ...base, hostResultFile: "/data/t3-code/t/l/result.json" })).toBeNull();
    expect(reviewAgentWatch({ ...base, hostResultFile: "/data/dsh/s/l/result.json" })).toBeNull();
    expect(reviewAgentWatch({ ...base, hostResultFile: "/data/claude-code-mod/s/l/result.json" })?.kind).toBe("mod");
  });
});

describe("a Claude Code mod launch's lease", () => {
  function leaseWatch(start = 1_000_000) {
    let now = start;
    let lease: string | null = null;
    const watch = modLeaseAgentWatch({ readLease: () => lease, now: () => now });
    return {
      watch,
      set: (value: object | null) => { lease = value ? JSON.stringify(value) : null; },
      /** Advance the clock in steps the timer would look at. */
      pass: (ms: number, step = 10_000) => {
        let result = watch.presence();
        for (let left = ms; left > 0; left -= step) {
          now += Math.min(step, left);
          result = watch.presence();
        }
        return result;
      },
      now: () => now,
    };
  }

  test("held by a live process: never gone", () => {
    const run = leaseWatch();
    const renew = () => run.set({ owner: "mod-a", at: run.now(), touchedAt: 0 });
    renew();
    for (let i = 0; i < 60; i += 1) {
      run.pass(5_000, 5_000);
      renew();
    }
    expect(run.watch.presence()).toBe("here");
  });

  test("released at session end: still here for a quick resume, gone two minutes later", () => {
    const run = leaseWatch();
    run.set({ owner: null, at: 0, touchedAt: 0 });
    expect(run.pass(MOD_AGENT_GONE_AFTER_MS - 10_000)).toBe("here");
    expect(run.pass(10_000)).toBe("gone");
  });

  test("a resume that takes the lease again within the grace keeps the review", () => {
    const run = leaseWatch();
    run.set({ owner: null, at: 0, touchedAt: 0 });
    run.pass(60_000);
    run.set({ owner: "mod-b", at: run.now(), touchedAt: 0 });
    expect(run.watch.presence()).toBe("here");
    // Renewed from then on: the earlier minute does not count.
    for (let i = 0; i < 40; i += 1) {
      run.pass(5_000, 5_000);
      run.set({ owner: "mod-b", at: run.now(), touchedAt: 0 });
    }
    expect(run.watch.presence()).toBe("here");
  });

  test("a holder that stopped renewing (a crash): gone once the lease is stale long enough", () => {
    const run = leaseWatch();
    run.set({ owner: "mod-a", at: run.now(), touchedAt: 0 });
    expect(run.pass(MOD_AGENT_GONE_AFTER_MS)).toBe("here");
    expect(run.pass(30_000)).toBe("gone");
  });

  test("a machine that slept: the lease is old on wake, but the count starts again", () => {
    const run = leaseWatch();
    run.set({ owner: "mod-a", at: run.now(), touchedAt: 0 });
    // One look after an hour asleep.
    expect(run.pass(60 * 60_000, 60 * 60_000)).toBe("here");
    expect(SLEEP_GAP_MS).toBeLessThan(MOD_AGENT_GONE_AFTER_MS);
    // The mod renews on wake.
    run.set({ owner: "mod-a", at: run.now(), touchedAt: 0 });
    expect(run.pass(30_000)).toBe("here");
  });

  test("no lease file (not written yet, an older mod): never gone", () => {
    const run = leaseWatch();
    run.set(null);
    expect(run.pass(60 * 60_000)).toBe("here");
  });

  // The coupling: the lease is the one the mod really writes, in the place it
  // writes it. A renamed file or field would turn every mod review into one
  // that is never ended, or one ended under a live session.
  test("reads the lease the mod writes: here while it watches, here just after it quits, gone later", async () => {
    const host = fakeHost();
    const isLaunch = (call: RunCall) => call.argv[0] === "/bin/sh" && call.argv[3] === "plannotator-launch";
    host.onRun = (call) => {
      if (isLaunch(call)) host.files.set(`${call.argv[4]}/ready`, `${JSON.stringify({ url: "http://localhost:4321", isRemote: false, port: 4321 })}\n`);
    };
    const mod = new PlannotatorMod(host, { sessionId: "session-1", dataDir: "/data", interactive: true });
    await mod.runCommand("review", "");
    const dir = String(host.runs.find(isLaunch)!.argv[4]);
    for (let i = 0; i < 10; i += 1) {
      host.clock += 1_000;
      await host.tick();
    }

    expect(reviewAgentWatch({ hostResultFile: `${dir}/result.json`, stdoutPiped: false, startPpid: 4242, platform: "linux", dataDir: "/data" })?.kind).toBe("mod");
    // The CLI reads `watcher.json` beside its result file; here, from the fake host's disk.
    let now = host.clock;
    const watch = modLeaseAgentWatch({ readLease: () => host.files.get(`${dir}/watcher.json`) ?? null, now: () => now });
    expect(host.files.has(`${dir}/watcher.json`)).toBe(true);
    expect(watch.presence()).toBe("here");

    mod.dispose();
    await Bun.sleep(0);
    expect(JSON.parse(host.files.get(`${dir}/watcher.json`)!)).toMatchObject({ owner: null });
    for (let step = 0; step < MOD_AGENT_GONE_AFTER_MS - 10_000; step += 10_000) {
      now += 10_000;
      expect(watch.presence()).toBe("here");
    }
    now += 10_000;
    expect(watch.presence()).toBe("gone");
  });
});

describe("ending the review", () => {
  test("once gone: tells the tab, then stops the server and exits with the agent-gone code; never while here", async () => {
    let presence: "here" | "gone" = "here";
    const events: string[] = [];
    const exits: number[] = [];
    const stop = endReviewWhenAgentGone(
      { kind: "parent", presence: () => presence },
      { announceAgentGone: () => events.push("announce"), stop: () => events.push("stop") },
      { everyMs: 5, exit: (code) => exits.push(code) },
    );
    try {
      await Bun.sleep(40);
      expect(events).toEqual([]);
      presence = "gone";
      await Bun.sleep(40);
      expect(events).toEqual(["announce"]);
      await Bun.sleep(1_100);
      expect(events).toEqual(["announce", "stop"]);
      expect(exits).toEqual([AGENT_GONE_EXIT_CODE]);
      expect(AGENT_GONE_EXIT_CODE).not.toBe(0);
    } finally {
      stop();
    }
  });
});
