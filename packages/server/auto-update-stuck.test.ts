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
  autoUpdatePaths,
  installerCommand,
  isUpdateLockHeld,
  reapDeadUpdateLock,
  removeJudgedLock,
  runAutoUpdateCheck,
  thisLockMachine,
  UPDATE_LOCK_HANDOFF_MS,
  type AutoUpdateDeps,
  type InstallerLaunch,
} from "./auto-update";
import { readUpdateState, writeUpdateState, type FetchReleaseResult } from "@plannotator/shared/update-check";

const NOW = 1_800_000_000_000;
const posix = process.platform !== "win32";
let dataDir: string;
const started: ChildProcess[] = [];

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
  rmSync(dataDir, { recursive: true, force: true });
});

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

describe.skipIf(!posix || !Bun.which("curl"))("the detached wrapper names its process group and machine in the lock", () => {
  async function startWrapper(script: string) {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(script) });
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
        PLANNOTATOR_UPDATE_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
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
