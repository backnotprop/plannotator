/**
 * "No user ever stuck on a version" (QA item 30): the install path's ways to
 * hang or hide. An install whose process group is gone, a lock or snooze
 * stamped while the clock was wrong, a holder on another machine, the
 * reaper racing a new lock, and auto-update meeting a check that keeps
 * failing. Every case ends bounded or visible, and a live installer is never
 * judged gone.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireUpdateLock,
  AUTO_UPDATE_LOCK_LIVE_MAX_MS,
  autoUpdatePaths,
  installerCommand,
  isUpdateLockHeld,
  launchInstaller,
  parseUpdateLockHolder,
  readAutoUpdateResult,
  reapDeadUpdateLock,
  removeJudgedLock,
  runAutoUpdateCheck,
  thisLockMachine,
  UPDATE_LOCK_HANDOFF_MS,
  type AutoUpdateDeps,
  type InstallerLaunch,
} from "./auto-update";
import { deriveInboxUpdate } from "./inbox-updates";
import { readUpdateState, writeUpdateState, type FetchReleaseResult } from "@plannotator/shared/update-check";

const NOW = 1_800_000_000_000;
const posix = process.platform !== "win32";
let dataDir: string;
const started: ChildProcess[] = [];
// Process groups of wrappers launchInstaller started in this file (it names them in the lock).
const launchedGroups: number[] = [];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-stuck-"));
});
afterEach(() => {
  // Only processes this file started, by their own group.
  for (const child of started.splice(0)) {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {}
  }
  for (const group of launchedGroups.splice(0)) {
    try {
      process.kill(-group, "SIGKILL");
    } catch {}
  }
  rmSync(dataDir, { recursive: true, force: true });
});

/** What the Inbox's button shows for the facts on disk (version 0.28.31 running). */
function inboxButton() {
  return deriveInboxUpdate({
    current: "0.28.31",
    onDisk: null,
    checksOn: true,
    managed: true,
    lockHeld: isUpdateLockHeld(dataDir),
    state: readUpdateState(dataDir),
    result: readAutoUpdateResult(dataDir),
    now: Date.now(),
  })?.state;
}

function personPressedUpdateNow() {
  writeUpdateState(
    {
      latestRelease: { tag: "0.28.32", fetchedAt: Date.now() },
      pending: { version: "0.28.32", fromVersion: "0.28.31", startedAt: Date.now(), by: "person" },
    },
    dataDir,
  );
}

/** A pid that is certainly not running (nor its group): a child of ours that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore", detached: true });
  await new Promise((r) => child.on("exit", r));
  return child.pid!;
}

/** A live process group of ours (a detached sleeper leads it). */
function liveGroup(): number {
  const child = spawn("/bin/sh", ["-c", "sleep 60"], { stdio: "ignore", detached: true });
  started.push(child);
  return child.pid!;
}

function backdate(path: string, ms: number) {
  const at = (Date.now() - ms) / 1000;
  utimesSync(path, at, at);
}

/** The lock line the detached wrapper writes, for this machine unless overridden. */
function holderLine(pid: number, group: number, over: Partial<ReturnType<typeof thisLockMachine>> = {}) {
  const m = { ...thisLockMachine(), ...over };
  return `pid=${pid} group=${group} host=${m.host} boot=${m.boot} pidns=${m.pidns}\n`;
}

describe.skipIf(!posix)("update.lock never holds Updating… for good, and never drops a live install", () => {
  test("a holder whose process group is gone is released after the grace, and the install reads as failed", async () => {
    const paths = autoUpdatePaths(dataDir);
    writeUpdateState({ pending: { version: "0.28.32", fromVersion: "0.28.31", startedAt: NOW, by: "person" } }, dataDir);
    const dead = await deadPid();
    writeFileSync(paths.lock, holderLine(dead, dead));
    expect(isUpdateLockHeld(dataDir)).toBe(true);
    expect(reapDeadUpdateLock(dataDir)).toBe(false);
    backdate(paths.lock, UPDATE_LOCK_HANDOFF_MS + 1_000);
    expect(isUpdateLockHeld(dataDir)).toBe(false);
    expect(reapDeadUpdateLock(dataDir)).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
    expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "0.28.32", exitCode: -1 });
    expect(acquireUpdateLock(paths.lock)).toBe(true);
  });

  test("the wrapper dead but a process left in its group (the installer): still held", async () => {
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, holderLine(await deadPid(), liveGroup()));
    backdate(paths.lock, 10 * 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(true);
    expect(reapDeadUpdateLock(dataDir)).toBe(false);
    expect(acquireUpdateLock(paths.lock)).toBe(false);
  });

  test("a holder on another machine, boot or pid namespace is unknown: the hour's rule only", async () => {
    const paths = autoUpdatePaths(dataDir);
    const dead = await deadPid();
    for (const over of [{ host: "another-machine" }, { boot: "0b0b0b0b-dead-beef-0000-000000000000" }, { pidns: "pid:[1]" }, { host: "" }]) {
      writeFileSync(paths.lock, holderLine(dead, dead, over));
      backdate(paths.lock, 10 * 60_000);
      expect([over, isUpdateLockHeld(dataDir)]).toEqual([over, true]);
      expect(reapDeadUpdateLock(dataDir)).toBe(false);
      backdate(paths.lock, 61 * 60_000);
      expect([over, isUpdateLockHeld(dataDir)]).toEqual([over, false]);
    }
  });

  test("a lock without the wrapper's line (an older wrapper, the bare pid the taker writes) keeps the hour's rule", async () => {
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, String(await deadPid()));
    backdate(paths.lock, 30 * 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(true);
    expect(reapDeadUpdateLock(dataDir)).toBe(false);
    backdate(paths.lock, 61 * 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(false);
  });

  test("a lock stamped more than an hour in the future (the clock moved back) is not held", () => {
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, "123");
    const future = (Date.now() + 5 * 60 * 60_000) / 1000;
    utimesSync(paths.lock, future, future);
    expect(isUpdateLockHeld(dataDir)).toBe(false);
    expect(acquireUpdateLock(paths.lock)).toBe(true);
  });

  test("the reaper never deletes a lock another process took after it judged the old one", async () => {
    const paths = autoUpdatePaths(dataDir);
    const dead = await deadPid();
    writeFileSync(paths.lock, holderLine(dead, dead));
    const judged = { ino: statSync(paths.lock).ino, content: readFileSync(paths.lock, "utf-8") };
    // In between: the old lock is cleared and a new install takes a fresh one.
    renameSync(paths.lock, `${paths.lock}.gone`);
    writeFileSync(paths.lock, holderLine(process.pid, liveGroup()));
    expect(removeJudgedLock(paths.lock, judged)).toBe(false);
    expect(readFileSync(paths.lock, "utf-8")).toContain(`pid=${process.pid} `);
    // The lock it judged is removed.
    renameSync(`${paths.lock}.gone`, paths.lock);
    expect(removeJudgedLock(paths.lock, judged)).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
  });
});

describe.skipIf(!posix)("the detached wrapper names its process group and machine in the lock", () => {
  /**
   * A loopback stand-in for plannotator.ai and the release downloads, as the
   * wrapper's `update-prepare` (run from source, update-prepare-entry.ts)
   * fetches them: the install script with the lines it requires, and a
   * `.sha256` per binary.
   */
  async function startWrapper(script: string) {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/install.sh") return new Response(`#!/bin/bash\nREPO="backnotprop/plannotator"\n${script}`);
        if (/^\/download\/v\d+\.\d+\.\d+\/plannotator-[a-z]+-(arm64|x64)\.sha256$/.test(path)) return new Response(`${"c".repeat(64)}  x\n`);
        return new Response("not found", { status: 404 });
      },
    });
    const paths = autoUpdatePaths(dataDir);
    writeUpdateState({ pending: { version: "0.28.32", fromVersion: "0.28.31", startedAt: NOW, by: "person" } }, dataDir);
    writeFileSync(paths.lock, String(process.pid));
    const { file, args } = installerCommand("linux", []);
    const child = spawn(file, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: dataDir,
        PLANNOTATOR_UPDATE_DETACHED: "1",
        PLANNOTATOR_UPDATE_VERSION: "v0.28.32",
        PLANNOTATOR_UPDATE_RESULT: paths.result,
        PLANNOTATOR_UPDATE_LOCK: paths.lock,
        PLANNOTATOR_UPDATE_BINARY: process.execPath,
        PLANNOTATOR_UPDATE_ENTRY: join(import.meta.dir, "update-prepare-entry.ts"),
        PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
        PLANNOTATOR_RELEASE_DOWNLOAD_URL: `http://127.0.0.1:${server.port}/download`,
      },
    });
    started.push(child);
    let out = "";
    child.stdout!.on("data", (c) => (out += c));
    const deadline = Date.now() + 20_000;
    while (!out.includes("fake installer started") && Date.now() < deadline) await Bun.sleep(20);
    return { server, child, paths };
  }

  test("only the wrapper killed while its installer runs: still held; the whole group gone: Failed at once", async () => {
    const { server, child, paths } = await startWrapper('echo "fake installer started"\nsleep 30\n');
    try {
      const line = readFileSync(paths.lock, "utf-8");
      expect(line).toStartWith(`pid=${child.pid} group=${child.pid} host=`);
      // The wrapper alone (SIGKILL, so no trap runs): its installer keeps the group.
      const exited = new Promise((r) => child.on("exit", r));
      process.kill(child.pid!, "SIGKILL");
      await exited;
      backdate(paths.lock, UPDATE_LOCK_HANDOFF_MS + 1_000);
      expect(isUpdateLockHeld(dataDir)).toBe(true);
      expect(reapDeadUpdateLock(dataDir)).toBe(false);
      // Now everything in the group.
      process.kill(-child.pid!, "SIGKILL");
      const deadline = Date.now() + 5_000;
      while (isUpdateLockHeld(dataDir) && Date.now() < deadline) await Bun.sleep(20);
      expect(isUpdateLockHeld(dataDir)).toBe(false);
      expect(reapDeadUpdateLock(dataDir)).toBe(true);
      expect(JSON.parse(readFileSync(paths.result, "utf-8")).exitCode).toBe(-1);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a wrapper never removes a lock another install took (F5)", async () => {
    const { server, child, paths } = await startWrapper('echo "fake installer started"\nsleep 1\n');
    try {
      const other = holderLine(process.pid, liveGroup());
      writeFileSync(paths.lock, other);
      if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.on("exit", r));
      expect(JSON.parse(readFileSync(paths.result, "utf-8")).exitCode).toBe(0);
      expect(readFileSync(paths.lock, "utf-8")).toBe(other);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a wrapper that finishes records its result and releases the lock itself", async () => {
    const { server, child, paths } = await startWrapper('echo "fake installer started"\nexit 0\n');
    try {
      if (child.exitCode === null && child.signalCode === null) await new Promise((r) => child.on("exit", r));
      expect(existsSync(paths.lock)).toBe(false);
      expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "v0.28.32", exitCode: 0 });
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

// F6 (#2338): an install that died before anything named it in the lock showed
// "Updating…" for the hour, then "available", never Failed.
describe("a killed or failed-to-start install shows Failed with Try again", () => {
  test("a holder line whose process is gone is reaped, on every platform (Windows judges the pid)", async () => {
    personPressedUpdateNow();
    const paths = autoUpdatePaths(dataDir);
    const dead = await deadPid();
    writeFileSync(paths.lock, holderLine(dead, dead));
    backdate(paths.lock, UPDATE_LOCK_HANDOFF_MS + 1_000);
    expect(reapDeadUpdateLock(dataDir)).toBe(true);
    expect(inboxButton()).toBe("failed");
  });

  test("a lock past its hour that nothing can judge is released as failed, not dropped silently", () => {
    personPressedUpdateNow();
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, "123");
    backdate(paths.lock, 61 * 60_000);
    expect(reapDeadUpdateLock(dataDir)).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
    expect(inboxButton()).toBe("failed");
  });

  test.skipIf(!posix)("the lock names the wrapper from the spawn on: killed before its first line, it reads as Failed", async () => {
    personPressedUpdateNow();
    const paths = autoUpdatePaths(dataDir);
    // The wrapper's update-prepare step is this script: it sleeps, nothing is downloaded.
    const sleeper = join(dataDir, "sleeper.sh");
    writeFileSync(sleeper, "exec sleep 30\n");
    expect(acquireUpdateLock(paths.lock)).toBe(true);
    launchInstaller({
      version: "v0.28.32",
      logPath: paths.log,
      resultPath: paths.result,
      lockPath: paths.lock,
      platform: process.platform,
      flags: [],
      prepare: { binary: "/bin/sh", entry: sleeper },
    });
    const holder = parseUpdateLockHolder(readFileSync(paths.lock, "utf-8"));
    expect(holder).not.toBeNull();
    launchedGroups.push(holder!.group);
    process.kill(-holder!.group, "SIGKILL");
    backdate(paths.lock, UPDATE_LOCK_HANDOFF_MS + 1_000);
    // Until this process reaps the killed wrapper, its group still exists.
    const deadline = Date.now() + 5_000;
    while (!reapDeadUpdateLock(dataDir) && Date.now() < deadline) await Bun.sleep(20);
    expect(existsSync(paths.lock)).toBe(false);
    expect(inboxButton()).toBe("failed");
  });

  test.skipIf(!posix || !!Bun.which("powershell.exe"))("an installer that cannot be spawned reads as Failed at once", async () => {
    personPressedUpdateNow();
    const paths = autoUpdatePaths(dataDir);
    expect(acquireUpdateLock(paths.lock)).toBe(true);
    // The Windows wrapper's powershell.exe is not on this machine: the spawn fails after it returns.
    launchInstaller({ version: "v0.28.32", logPath: paths.log, resultPath: paths.result, lockPath: paths.lock, platform: "win32", flags: [] });
    const deadline = Date.now() + 5_000;
    while (existsSync(paths.lock) && Date.now() < deadline) await Bun.sleep(10);
    expect(existsSync(paths.lock)).toBe(false);
    expect(readAutoUpdateResult(dataDir)).toEqual({ version: "0.28.32", exitCode: -1 });
    expect(inboxButton()).toBe("failed");
  });
});

// F5 (#2338): a lock past its hour was taken while its install still ran, and
// the first wrapper's final `rm -f` then deleted the second install's lock.
describe.skipIf(!posix)("never two installers at once", () => {
  test("a lock past its hour whose installer still runs is still held, up to a day", () => {
    const paths = autoUpdatePaths(dataDir);
    const group = liveGroup();
    writeFileSync(paths.lock, holderLine(group, group));
    backdate(paths.lock, 61 * 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(true);
    expect(reapDeadUpdateLock(dataDir)).toBe(false);
    expect(acquireUpdateLock(paths.lock)).toBe(false);
    // A hung install never holds for good.
    backdate(paths.lock, AUTO_UPDATE_LOCK_LIVE_MAX_MS + 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(false);
  });
});

describe("auto-update while the check keeps failing", () => {
  function deps(overrides: Partial<AutoUpdateDeps> = {}): AutoUpdateDeps & { launches: InstallerLaunch[] } {
    const launches: InstallerLaunch[] = [];
    return {
      currentVersion: "0.28.30",
      execPath: "/home/u/.local/bin/plannotator",
      platform: "linux",
      pid: 100,
      dataDir,
      now: () => NOW,
      enabled: () => true,
      isManaged: () => true,
      fetchReleasePage: async (): Promise<FetchReleaseResult> => ({ ok: false, error: "HTTP 200" }),
      fetchRelease: async (): Promise<FetchReleaseResult> => ({ ok: false, error: "HTTP 403", rateLimited: true }),
      listSessions: () => [],
      launchInstaller: (launch) => {
        launches.push(launch);
      },
      launches,
      ...overrides,
    };
  }

  test("installs the newer release an earlier check named, instead of staying 'active' and installing nothing", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.31", fetchedAt: NOW - 2 * 60 * 60_000 } }, dataDir);
    const d = deps();
    expect(await runAutoUpdateCheck(d)).toBe("launched");
    expect(d.launches.map((l) => l.version)).toEqual(["v0.28.31"]);
    expect(readFileSync(autoUpdatePaths(dataDir).log, "utf-8")).toContain("installing 0.28.31, the newest one known");
  });

  test("nothing newer known: no install, and the 24 h window is given back", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.30", fetchedAt: NOW - 2 * 60 * 60_000 } }, dataDir);
    const d = deps();
    expect(await runAutoUpdateCheck(d)).toBe("no-release");
    expect(d.launches).toEqual([]);
    expect(readUpdateState(dataDir).lastCheckAt).toBeUndefined();
  });
});
