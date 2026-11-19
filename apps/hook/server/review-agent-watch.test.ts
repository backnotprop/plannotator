/**
 * Whether a local code review's agent is gone (review-agent-watch.ts).
 *
 * What regresses if this fails: a review whose agent quit keeps its server
 * forever (the pile of leftover programs), or a review whose agent is still
 * there (a backgrounded launch still read, a live Claude Code session whose
 * timer stalled, a quick `claude --continue`, a laptop that slept) is ended
 * under the person, or Send says "gone" to a session that came back.
 */
import { describe, expect, test } from "bun:test";
import { PlannotatorMod } from "../hooks/mod/controller";
import { fakeHost, type RunCall } from "../hooks/mod/testing/fake-host";
import {
  AGENT_GONE_EXIT_CODE,
  type AgentWatch,
  MOD_AGENT_GONE_AFTER_MS,
  PROBE_EVERY_MS,
  PROBE_MAX_GAP_MS,
  endReviewWhenAgentGone,
  modLeaseAgentWatch,
  parentAgentWatch,
  parseWatcherLease,
  reviewAgentWatch,
  SLEEP_GAP_MS,
} from "./review-agent-watch";

describe("the process that reads stdout", () => {
  function parentRun(platform: NodeJS.Platform = "darwin") {
    let ppid = 4242;
    let parentAlive = true;
    let reader: "open" | "closed" = "open";
    let now = 0;
    let probes = 0;
    const watch = parentAgentWatch({
      startPpid: 4242,
      platform,
      currentPpid: () => ppid,
      parentExists: () => parentAlive,
      probeReader: () => {
        probes += 1;
        return reader;
      },
      now: () => now,
    });
    return {
      watch,
      reparent: () => { ppid = 1; },
      parentQuits: () => { parentAlive = false; },
      readerQuits: () => { reader = "closed"; },
      pass: (ms: number) => { now += ms; },
      probes: () => probes,
    };
  }

  test("a parent that never changed: here, and stdout is never probed", () => {
    const run = parentRun();
    for (let i = 0; i < 10; i += 1) {
      run.pass(PROBE_EVERY_MS);
      expect(run.watch.ended()).toBe(false);
    }
    expect(run.watch.presence()).toBe("here");
    expect(run.probes()).toBe(0);
  });

  // H1: `plannotator review &`, nohup, setsid, or an agent's background shell: reparented at once, still read.
  test("reparented but still read (a backgrounded launch): never ends, and probes back off", () => {
    const run = parentRun();
    run.reparent();
    for (let i = 0; i < 100; i += 1) {
      run.pass(PROBE_EVERY_MS);
      expect(run.watch.ended()).toBe(false);
    }
    expect(run.watch.presence()).toBe("here");
    // 1000 s of 10 s looks: the back-off keeps it to a probe a minute at most.
    expect(run.probes()).toBeLessThan(1_000_000 / PROBE_MAX_GAP_MS + 8);
  });

  test("reparented and the reader is gone (EPIPE): ends, and stays gone", () => {
    const run = parentRun();
    run.reparent();
    run.pass(PROBE_EVERY_MS);
    expect(run.watch.ended()).toBe(false);
    run.readerQuits();
    run.pass(PROBE_MAX_GAP_MS);
    expect(run.watch.ended()).toBe(true);
    expect(run.watch.presence()).toBe("gone");
  });

  test("Send probes at once (not on the back-off): a reader gone a second ago refuses the send", () => {
    const run = parentRun();
    run.reparent();
    run.watch.ended();
    run.readerQuits();
    expect(run.watch.presence()).toBe("gone");
  });

  test("on Windows (never reparented): a parent pid that no longer exists is only a suspicion too", () => {
    const run = parentRun("win32");
    run.parentQuits();
    run.pass(PROBE_EVERY_MS);
    expect(run.watch.ended()).toBe(false);
    run.readerQuits();
    run.pass(PROBE_MAX_GAP_MS);
    expect(run.watch.ended()).toBe(true);
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
  /** The CLI's clock and the mod's stamps are unrelated on purpose (M4): the mod's `at` runs an hour ahead. */
  function leaseRun(start = 1_000_000, modClockAhead = 60 * 60_000) {
    let now = start;
    let lease: string | null = null;
    let hostAlive = true;
    const watch = modLeaseAgentWatch({ readLease: () => lease, now: () => now, pidAlive: () => hostAlive });
    return {
      watch,
      set: (value: object | null) => { lease = value ? JSON.stringify(value) : null; },
      renew: (owner = "mod-a", pid: number | undefined = 777) =>
        { lease = JSON.stringify({ owner, at: now + modClockAhead, touchedAt: 0, ...(pid ? { pid } : {}) }); },
      hostQuits: () => { hostAlive = false; },
      /** Advance the CLI's clock in steps the timer would look at; the end decision's answer after. */
      pass: (ms: number, step = 10_000) => {
        let result = watch.ended();
        for (let left = ms; left > 0; left -= step) {
          now += Math.min(step, left);
          result = watch.ended();
        }
        return result;
      },
      now: () => now,
    };
  }

  test("renewed every 5 s by a live process: never gone, whatever its clock says", () => {
    const run = leaseRun(1_000_000, -10 * 60_000);
    for (let i = 0; i < 60; i += 1) {
      run.renew();
      expect(run.pass(5_000, 5_000)).toBe(false);
    }
    expect(run.watch.presence()).toBe("here");
  });

  // H2: an idle or compacting session whose timer stalled must keep its review.
  test("not renewed for long, but its Claude Code process still runs: never gone", () => {
    const run = leaseRun();
    run.renew();
    expect(run.pass(60 * 60_000)).toBe(false);
    expect(run.watch.presence()).toBe("here");
  });

  test("released at session end and the process quit: here for a quick resume, gone two minutes later", () => {
    const run = leaseRun();
    run.set({ owner: null, at: 0, touchedAt: 0, pid: 777 });
    run.hostQuits();
    expect(run.pass(MOD_AGENT_GONE_AFTER_MS - 10_000)).toBe(false);
    expect(run.pass(10_000)).toBe(true);
  });

  test("a resume that takes the lease again within the grace keeps the review", () => {
    const run = leaseRun();
    run.set({ owner: null, at: 0, touchedAt: 0, pid: 777 });
    run.hostQuits();
    run.pass(60_000);
    run.renew("mod-b", 888);
    for (let i = 0; i < 40; i += 1) {
      expect(run.pass(5_000, 5_000)).toBe(false);
      run.renew("mod-b", 888);
    }
  });

  test("a lease with no pid (an older mod, Git Bash): never gone", () => {
    const run = leaseRun();
    run.set({ owner: null, at: 0, touchedAt: 0 });
    run.hostQuits();
    expect(run.pass(60 * 60_000)).toBe(false);
  });

  test("a machine that slept: the stamp did not move, but the count starts again", () => {
    const run = leaseRun();
    run.renew();
    run.hostQuits();
    expect(run.pass(60 * 60_000, 60 * 60_000)).toBe(false);
    expect(SLEEP_GAP_MS).toBeLessThan(MOD_AGENT_GONE_AFTER_MS);
    expect(run.pass(MOD_AGENT_GONE_AFTER_MS - 10_000)).toBe(false);
  });

  test("no lease file (not written yet): never gone", () => {
    const run = leaseRun();
    run.set(null);
    run.hostQuits();
    expect(run.pass(60 * 60_000)).toBe(false);
  });

  // H3: Send asks live. A session that came back is "here" for Send even after a look said "gone".
  test("Send's answer is never latched; only the end decision is", () => {
    const run = leaseRun();
    run.set({ owner: null, at: 0, touchedAt: 0, pid: 777 });
    run.hostQuits();
    run.pass(MOD_AGENT_GONE_AFTER_MS + 10_000);
    expect(run.watch.presence()).toBe("gone");
    run.renew("mod-b", 888);
    expect(run.watch.presence()).toBe("here");
  });

  test("the lease's pid is read only when it is a real pid", () => {
    expect(parseWatcherLease(JSON.stringify({ owner: "a", at: 1, touchedAt: 0, pid: 777 }))?.pid).toBe(777);
    expect(parseWatcherLease(JSON.stringify({ owner: "a", at: 1, touchedAt: 0, pid: 1 }))?.pid).toBeNull();
    expect(parseWatcherLease(JSON.stringify({ owner: "a", at: 1, touchedAt: 0, pid: "777" }))?.pid).toBeNull();
  });

  // The coupling: the lease is the one the mod really writes, in the place it
  // writes it, with the pid it learns from its shell. A renamed file or field
  // would turn every mod review into one that is never ended, or one ended
  // under a live session.
  test("reads the lease the mod writes: here while it watches and while its process runs, gone once it quit", async () => {
    const host = fakeHost();
    const isLaunch = (call: RunCall) => call.argv[0] === "/bin/sh" && call.argv[3] === "plannotator-launch";
    host.onRun = (call) => {
      if (isLaunch(call)) host.files.set(`${call.argv[4]}/ready`, `${JSON.stringify({ url: "http://localhost:4321", isRemote: false, port: 4321 })}\n`);
      if (call.argv[3] === "plannotator-host-pid") return { exitCode: 0, stdout: "777\n", stderr: "" };
      return undefined;
    };
    const mod = new PlannotatorMod(host, { sessionId: "session-1", dataDir: "/data", interactive: true });
    await mod.runCommand("review", "");
    const dir = String(host.runs.find(isLaunch)!.argv[4]);
    for (let i = 0; i < 10; i += 1) {
      host.clock += 1_000;
      await host.tick();
    }
    expect(JSON.parse(host.files.get(`${dir}/watcher.json`)!)).toMatchObject({ pid: 777 });

    let now = 5;
    let alive = true;
    const watch = modLeaseAgentWatch({ readLease: () => host.files.get(`${dir}/watcher.json`) ?? null, now: () => now, pidAlive: (pid) => pid === 777 && alive });
    expect(watch.presence()).toBe("here");

    mod.dispose();
    await Bun.sleep(0);
    expect(JSON.parse(host.files.get(`${dir}/watcher.json`)!)).toMatchObject({ owner: null, pid: 777 });
    // The CLI's 10 s looks, past the grace.
    for (let look = 0; look <= MOD_AGENT_GONE_AFTER_MS; look += 10_000) {
      now += 10_000;
      // Released but its Claude Code process still runs (`/clear`): kept.
      expect(watch.ended()).toBe(false);
    }
    alive = false;
    expect(watch.ended()).toBe(true);
  });
});

describe("ending the review", () => {
  function watchOf(ended: () => boolean): AgentWatch {
    return { kind: "parent", presence: () => (ended() ? "gone" : "here"), ended };
  }

  test("once gone: tells the tab, then stops the server and exits with the agent-gone code; never while here", async () => {
    let gone = false;
    const events: string[] = [];
    const exits: number[] = [];
    const stop = endReviewWhenAgentGone(
      watchOf(() => gone),
      { announceAgentGone: () => (events.push("announce"), true), stop: () => events.push("stop") },
      { everyMs: 5, exit: (code) => exits.push(code) },
    );
    try {
      await Bun.sleep(40);
      expect(events).toEqual([]);
      gone = true;
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

  // M1: a decision taken during the second the tab is told must still be delivered.
  test("a decision taken while the end is pending: the end is cancelled, the process lives to deliver it", async () => {
    const events: string[] = [];
    const exits: number[] = [];
    const stop = endReviewWhenAgentGone(
      watchOf(() => true),
      { announceAgentGone: () => (events.push("announce"), true), stop: () => events.push("stop") },
      { everyMs: 5, exit: (code) => exits.push(code) },
    );
    await Bun.sleep(40);
    expect(events).toEqual(["announce"]);
    // index.ts: waitForDecision resolved.
    stop();
    await Bun.sleep(1_100);
    expect(events).toEqual(["announce"]);
    expect(exits).toEqual([]);
  });

  test("a review already decided when the look finds it gone: never ended", async () => {
    const events: string[] = [];
    const exits: number[] = [];
    const stop = endReviewWhenAgentGone(
      watchOf(() => true),
      { announceAgentGone: () => false, stop: () => events.push("stop") },
      { everyMs: 5, exit: (code) => exits.push(code) },
    );
    try {
      await Bun.sleep(1_100);
      expect(events).toEqual([]);
      expect(exits).toEqual([]);
    } finally {
      stop();
    }
  });
});
