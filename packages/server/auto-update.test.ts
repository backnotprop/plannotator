import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_UPDATE_INTERVAL_MS,
  AUTO_UPDATE_LOCK_STALE_MS,
  autoUpdatePaths,
  autoUpdateCanInstall,
  compareStableVersions,
  deriveAutoUpdateNotice,
  installerCommand,
  installerFlagArgs,
  parseInstallFlags,
  readInstallFlags,
  isCheckDue,
  isManagedBinary,
  isMismatchBackedOff,
  isNewerStableVersion,
  managedBinaryPath,
  mismatchBackoffMs,
  noteMismatchResult,
  readAutoUpdateState,
  runAutoUpdateCheck,
  runInstallerForeground,
  startManualUpdate,
  type AutoUpdateDeps,
  type InstallerLaunch,
} from "./auto-update";
import { RELEASE_API_FALLBACK_INTERVAL_MS, RELEASE_CHECK_RETRY_MS } from "@plannotator/shared/update-check";
import { sweepStaleUpdateDirs } from "./update-prepare";
import { UPDATE_STAGING_PREFIX } from "./update-log";
import { UPDATE_EXIT_CHECKSUM_MISMATCH as MISMATCH } from "@plannotator/core/update-exit-codes";
import type { SessionInfo } from "./sessions";

const NOW = 1_800_000_000_000;

function session(pid: number): SessionInfo {
  return { pid, port: 1, url: "http://localhost:1", mode: "review", project: "p", startedAt: "2026-01-01", label: "x" };
}

let dataDir: string;
let launches: InstallerLaunch[];
let fetches: number;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-auto-update-"));
  launches = [];
  fetches = 0;
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function deps(overrides: Partial<AutoUpdateDeps> = {}): AutoUpdateDeps {
  return {
    currentVersion: "0.27.22",
    execPath: "/home/u/.local/bin/plannotator",
    platform: "linux",
    pid: 100,
    dataDir,
    now: () => NOW,
    enabled: () => true,
    isManaged: () => true,
    fetchLatestTag: async () => {
      fetches++;
      return "v0.28.0";
    },
    listSessions: () => [session(100)],
    launchInstaller: (launch) => {
      launches.push(launch);
    },
    ...overrides,
  };
}

describe("version comparison", () => {
  test("numeric, not lexicographic", () => {
    expect(isNewerStableVersion("v0.10.0", "0.9.9")).toBe(true);
    expect(isNewerStableVersion("v1.0.0", "0.99.99")).toBe(true);
  });

  test("never a downgrade or a same-version reinstall", () => {
    expect(isNewerStableVersion("v0.27.21", "0.27.22")).toBe(false);
    expect(isNewerStableVersion("v0.27.22", "0.27.22")).toBe(false);
  });

  test("pre-release and malformed tags are never newer", () => {
    expect(isNewerStableVersion("v0.28.0-rc.1", "0.27.22")).toBe(false);
    expect(isNewerStableVersion("latest", "0.27.22")).toBe(false);
    expect(compareStableVersions("v1.2.3", "dev")).toBeNull();
  });
});

describe("24h throttle", () => {
  test("due with no record, not due inside 24h, due again after", () => {
    expect(isCheckDue({}, NOW)).toBe(true);
    expect(isCheckDue({ lastCheckAt: NOW - 1000 }, NOW)).toBe(false);
    expect(isCheckDue({ lastCheckAt: NOW - AUTO_UPDATE_INTERVAL_MS + 1 }, NOW)).toBe(false);
    expect(isCheckDue({ lastCheckAt: NOW - AUTO_UPDATE_INTERVAL_MS }, NOW)).toBe(true);
  });

  test("a check inside the window never reaches the network", async () => {
    expect(await runAutoUpdateCheck(deps())).toBe("launched");
    rmSync(autoUpdatePaths(dataDir).lock);
    expect(await runAutoUpdateCheck(deps({ now: () => NOW + 60_000 }))).toBe("throttled");
    expect(fetches).toBe(1);
    expect(launches).toHaveLength(1);
  });

  test("an up-to-date check still spends the window", async () => {
    const d = deps({ fetchLatestTag: async () => (fetches++, "v0.27.22") });
    expect(await runAutoUpdateCheck(d)).toBe("up-to-date");
    expect(readAutoUpdateState(dataDir).lastCheckAt).toBe(NOW);
    expect(await runAutoUpdateCheck(d)).toBe("throttled");
    expect(fetches).toBe(1);
  });
});

describe("runAutoUpdateCheck gates", () => {
  test("dev builds, disabled setting, and unmanaged binaries do nothing at all", async () => {
    expect(await runAutoUpdateCheck(deps({ currentVersion: undefined }))).toBe("dev-build");
    expect(await runAutoUpdateCheck(deps({ enabled: () => false }))).toBe("disabled");
    expect(await runAutoUpdateCheck(deps({ isManaged: () => false }))).toBe("unmanaged");
    expect(fetches).toBe(0);
    expect(existsSync(autoUpdatePaths(dataDir).state)).toBe(false);
  });

  test("never downgrades", async () => {
    const d = deps({ fetchLatestTag: async () => "v0.27.0" });
    expect(await runAutoUpdateCheck(d)).toBe("up-to-date");
    expect(launches).toHaveLength(0);
  });

  test("skips while another session is open, and retries on the next start", async () => {
    const d = deps({ listSessions: () => [session(100), session(200)] });
    expect(await runAutoUpdateCheck(d)).toBe("sessions-open");
    expect(launches).toHaveLength(0);
    expect(readFileSync(autoUpdatePaths(dataDir).log, "utf-8")).toContain("other Plannotator session");
    // Our own session is not "another" one, and the skip did not spend the window.
    expect(await runAutoUpdateCheck(deps())).toBe("launched");
  });

  test("an OpenCode in-process session never holds an update back", async () => {
    const opencode: SessionInfo = { ...session(200), host: "opencode" };
    expect(autoUpdateCanInstall({ lockHeld: false, windowOpen: true, sessions: [opencode], ownPid: 100 })).toBe(true);
    expect(await runAutoUpdateCheck(deps({ listSessions: () => [session(100), opencode] }))).toBe("launched");
  });

  test("a skip for open sessions answers later starts from the cached release, not GitHub", async () => {
    const busy = deps({ listSessions: () => [session(100), session(200)] });
    expect(await runAutoUpdateCheck(busy)).toBe("sessions-open");
    expect(await runAutoUpdateCheck(deps({ ...busy, now: () => NOW + 60_000 }))).toBe("sessions-open");
    expect(await runAutoUpdateCheck(deps({ now: () => NOW + 120_000 }))).toBe("launched");
    expect(fetches).toBe(1);
    expect(launches[0].version).toBe("v0.28.0");
    // A day later the cached answer is stale and GitHub is asked again.
    rmSync(autoUpdatePaths(dataDir).lock);
    expect(
      await runAutoUpdateCheck(deps({ ...busy, now: () => NOW + 120_000 + AUTO_UPDATE_INTERVAL_MS })),
    ).toBe("sessions-open");
    expect(fetches).toBe(2);
  });

  test("the tag is reduced to a canonical X.Y.Z before it reaches the installer", async () => {
    expect(await runAutoUpdateCheck(deps({ fetchLatestTag: async () => " v0.28.0\n" }))).toBe("launched");
    expect(launches[0].version).toBe("v0.28.0");
    expect(readAutoUpdateState(dataDir).pending?.version).toBe("0.28.0");
  });

  test("tags that are not a plain stable version are refused", async () => {
    for (const tag of ["v0.28.0-rc.1", "v0.28.0; rm -rf ~", "v0.28", "$(id)", "v1.2.3\nv9.9.9"]) {
      rmSync(autoUpdatePaths(dataDir).state, { force: true });
      expect(await runAutoUpdateCheck(deps({ fetchLatestTag: async () => tag }))).toBe("no-release");
    }
    expect(launches).toHaveLength(0);
  });

  test("launches the installer for exactly the latest tag and records the attempt", async () => {
    expect(await runAutoUpdateCheck(deps())).toBe("launched");
    expect(launches).toEqual([
      {
        version: "v0.28.0",
        logPath: autoUpdatePaths(dataDir).log,
        resultPath: autoUpdatePaths(dataDir).result,
        lockPath: autoUpdatePaths(dataDir).lock,
        platform: "linux",
        flags: [],
      },
    ]);
    expect(readAutoUpdateState(dataDir).pending).toEqual({ version: "0.28.0", fromVersion: "0.27.22", startedAt: NOW });
    expect(existsSync(autoUpdatePaths(dataDir).lock)).toBe(true);
  });

  test("a held lock blocks a second run; a stale one is reclaimed", async () => {
    const { lock } = autoUpdatePaths(dataDir);
    writeFileSync(lock, "1");
    expect(await runAutoUpdateCheck(deps())).toBe("locked");
    const old = (Date.now() - 2 * 60 * 60 * 1000) / 1000;
    utimesSync(lock, old, old);
    expect(await runAutoUpdateCheck(deps({ now: () => NOW + AUTO_UPDATE_INTERVAL_MS }))).toBe("launched");
  });

  test("a launch that throws is recorded as a failed result and releases the lock", async () => {
    const d = deps({
      launchInstaller: () => {
        throw new Error("spawn EACCES");
      },
    });
    expect(await runAutoUpdateCheck(d)).toBe("launch-failed");
    const paths = autoUpdatePaths(dataDir);
    expect(existsSync(paths.lock)).toBe(false);
    expect(JSON.parse(readFileSync(paths.result, "utf-8")).exitCode).toBe(-1);
  });
});

describe("post-update notice", () => {
  const pending = { version: "0.28.0", fromVersion: "0.27.22", startedAt: NOW };

  test("updated once the running binary is the new version", () => {
    const n = deriveAutoUpdateNotice({ pending }, null, "0.28.0", "/d/update.log");
    expect(n?.kind).toBe("updated");
    expect(n?.releaseUrl).toBe("https://github.com/backnotprop/plannotator/releases/tag/v0.28.0");
  });

  test("failed with the log path when the script exited non-zero", () => {
    const n = deriveAutoUpdateNotice({ pending }, { version: "v0.28.0", exitCode: 1 }, "0.27.22", "/d/update.log");
    expect(n).toMatchObject({ kind: "failed", logPath: "/d/update.log" });
  });

  test("nothing while the install is still running or succeeded but this process is the old binary", () => {
    expect(deriveAutoUpdateNotice({ pending }, null, "0.27.22", "/d/update.log")).toBeUndefined();
    expect(deriveAutoUpdateNotice({ pending }, { version: "v0.28.0", exitCode: 0 }, "0.27.22", "/d/update.log")).toBeUndefined();
    expect(deriveAutoUpdateNotice({}, null, "0.28.0", "/d/update.log")).toBeUndefined();
  });
});

describe("safe-update failures in the notice", () => {
  const bg = { version: "0.28.0", fromVersion: "0.27.22", startedAt: NOW };
  const person = { ...bg, by: "person" as const };

  test("a mismatch is shown once per version, whatever the attempt", () => {
    const a = deriveAutoUpdateNotice({ pending: bg }, { version: "v0.28.0", exitCode: MISMATCH }, "0.27.22", "/d/update.log");
    const b = deriveAutoUpdateNotice({ pending: { ...bg, startedAt: NOW + 5 } }, { version: "v0.28.0", exitCode: MISMATCH }, "0.27.22", "/d/update.log");
    expect(a).toMatchObject({ kind: "failed", reason: "mismatch" });
    expect(a!.id).toBe(b!.id);
  });

  test("a background run that couldn't download (75) changed nothing and shows nothing; one the person asked for does", () => {
    expect(deriveAutoUpdateNotice({ pending: bg }, { version: "v0.28.0", exitCode: 75 }, "0.27.22", "/d/update.log")).toBeUndefined();
    expect(deriveAutoUpdateNotice({ pending: person }, { version: "v0.28.0", exitCode: 75 }, "0.27.22", "/d/update.log")).toMatchObject({
      kind: "failed",
      reason: "download",
    });
  });

  // Downloaded, but the temp folder could not hold it: not "couldn't download".
  test("a person's 75 whose run could not stage the update is `prepare`, read from that run's log lines", () => {
    const log = join(dataDir, "update.log");
    writeFileSync(
      log,
      `update: could not download the update (offline); nothing was changed\n[t] update: install.sh exited 75\n` +
        `${UPDATE_STAGING_PREFIX}the temp folder /tmp is full (ENOSPC); nothing was changed\n[t] update: install.sh exited 75\n`,
    );
    expect(deriveAutoUpdateNotice({ pending: person }, { version: "v0.28.0", exitCode: 75 }, "0.27.22", log)).toMatchObject({ reason: "prepare" });
    writeFileSync(log, `${UPDATE_STAGING_PREFIX}the temp folder /tmp is full (ENOSPC); nothing was changed\n[t] update: install.sh exited 75\nupdate: could not download the update (offline); nothing was changed\n[t] update: install.sh exited 75\n`);
    expect(deriveAutoUpdateNotice({ pending: person }, { version: "v0.28.0", exitCode: 75 }, "0.27.22", log)).toMatchObject({ reason: "download" });
  });
});

describe("mismatch back-off (1, 3, then 7 days)", () => {
  const DAY = AUTO_UPDATE_INTERVAL_MS;
  /** One background install of v0.28.0 at `at` that ended with `exitCode`. */
  async function attempt(at: number, exitCode: number) {
    const outcome = await runAutoUpdateCheck(deps({ now: () => at }));
    if (outcome === "launched") {
      const paths = autoUpdatePaths(dataDir);
      writeFileSync(paths.result, JSON.stringify({ version: "v0.28.0", exitCode }));
      rmSync(paths.lock, { force: true });
    }
    return outcome;
  }

  test("each mismatch waits longer; the window is spent while it waits, so nothing loops", async () => {
    expect(await attempt(NOW, MISMATCH)).toBe("launched");
    // 1 day: the next daily check tries again.
    expect(await attempt(NOW + DAY, MISMATCH)).toBe("launched");
    expect(readAutoUpdateState(dataDir).mismatchBackoff).toEqual({ version: "0.28.0", attempts: 1, lastAttemptAt: NOW });
    // Second mismatch: 3 days from it.
    expect(await attempt(NOW + 2 * DAY, MISMATCH)).toBe("backed-off");
    // A back-off spends the 24 h window: the same day asks nothing more.
    expect(await attempt(NOW + 2 * DAY + 60_000, MISMATCH)).toBe("throttled");
    expect(await attempt(NOW + 3 * DAY, MISMATCH)).toBe("backed-off");
    expect(await attempt(NOW + 4 * DAY, MISMATCH)).toBe("launched");
    // Third: 7 days, and 7 after that.
    expect(await attempt(NOW + 10 * DAY, MISMATCH)).toBe("backed-off");
    expect(await attempt(NOW + 11 * DAY, MISMATCH)).toBe("launched");
    expect(await attempt(NOW + 17 * DAY, MISMATCH)).toBe("backed-off");
    expect(await attempt(NOW + 18 * DAY, MISMATCH)).toBe("launched");
    expect(readAutoUpdateState(dataDir).mismatchBackoff?.attempts).toBe(4);
    expect(launches).toHaveLength(5);
  });

  test("a newer release is tried at once, and other failures never back off", async () => {
    expect(await attempt(NOW, MISMATCH)).toBe("launched");
    expect(await attempt(NOW + DAY, MISMATCH)).toBe("launched");
    // v0.28.1 ships: the hold on 0.28.0 does not apply to it.
    const newer = await runAutoUpdateCheck(deps({ now: () => NOW + 2 * DAY, fetchLatestTag: async () => "v0.28.1" }));
    expect(newer).toBe("launched");
    expect(launches.at(-1)?.version).toBe("v0.28.1");
    expect(isMismatchBackedOff({ version: "0.28.0", attempts: 3, lastAttemptAt: NOW }, "0.28.1", NOW + 1)).toBe(false);
    // A failed download (75) or another installer failure is not a mismatch.
    expect(noteMismatchResult({ pending: { version: "0.28.0", fromVersion: "0.27.22", startedAt: NOW } }, { version: "v0.28.0", exitCode: 75 })).toBeUndefined();
    expect(noteMismatchResult({ pending: { version: "0.28.0", fromVersion: "0.27.22", startedAt: NOW } }, { version: "v0.28.0", exitCode: 1 })).toBeUndefined();
  });

  test("the same attempt is counted once, however many checks read its result", () => {
    const state = { pending: { version: "0.28.0", fromVersion: "0.27.22", startedAt: NOW } };
    const first = noteMismatchResult(state, { version: "v0.28.0", exitCode: MISMATCH });
    expect(first).toEqual({ version: "0.28.0", attempts: 1, lastAttemptAt: NOW });
    expect(noteMismatchResult({ ...state, mismatchBackoff: first }, { version: "v0.28.0", exitCode: MISMATCH })).toBe(first);
  });

  test("Update now ignores the back-off", async () => {
    expect(await attempt(NOW, MISMATCH)).toBe("launched");
    expect(await attempt(NOW + DAY, MISMATCH)).toBe("launched");
    expect(await attempt(NOW + 2 * DAY, MISMATCH)).toBe("backed-off");
    const r = startManualUpdate({
      currentVersion: "0.27.22",
      dataDir,
      now: () => NOW + 2 * DAY + 1,
      platform: "linux",
      isManaged: () => true,
      launchInstaller: (launch) => {
        launches.push(launch);
      },
    });
    expect(r.outcome).toBe("launched");
  });

  test("a clock that went backwards or a garbled record never holds an update back", () => {
    expect(isMismatchBackedOff({ version: "0.28.0", attempts: 1, lastAttemptAt: NOW + DAY }, "0.28.0", NOW)).toBe(false);
    expect(isMismatchBackedOff({ version: "0.28.0", attempts: 1, lastAttemptAt: Number.NaN }, "0.28.0", NOW)).toBe(false);
    expect(mismatchBackoffMs(0)).toBe(DAY);
    expect(mismatchBackoffMs(99)).toBe(7 * DAY);
  });
});

describe("managed binary", () => {
  test("only the path the install script writes counts", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    expect(isManagedBinary("/home/u/.local/bin/plannotator", "linux", env, "/home/u")).toBe(true);
    expect(isManagedBinary("/opt/homebrew/bin/plannotator", "darwin", env, "/home/u")).toBe(false);
    expect(managedBinaryPath("win32", env, "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Local\\plannotator\\plannotator.exe");
  });
});

describe("installer command", () => {
  test("Windows passes the wrapper encoded, so it survives command-line quoting intact", () => {
    const { file, args } = installerCommand("win32");
    expect(file).toBe("powershell.exe");
    const encoded = args[args.indexOf("-EncodedCommand") + 1];
    const script = Buffer.from(encoded, "base64").toString("utf16le");
    expect(script).toContain("$env:PLANNOTATOR_UPDATE_VERSION");
    expect(script).toContain('\'{"version":"\'');
  });

  test("POSIX runs the wrapper through /bin/sh with inputs only in the environment", () => {
    const { file, args } = installerCommand("darwin");
    expect(file).toBe("/bin/sh");
    expect(args[1]).toContain('--version "$PLANNOTATOR_UPDATE_VERSION"');
  });
});

describe("remembered install flags", () => {
  const writeFlags = (body: string) => writeFileSync(autoUpdatePaths(dataDir).installFlags, body);

  test("a well-formed file yields its flags in a stable order", () => {
    writeFlags('{"v":1,"flags":["skip-skills","minimal","skip-codex"]}\n');
    expect(readInstallFlags(dataDir)).toEqual({ flags: ["minimal", "skip-codex", "skip-skills"] });
  });

  test("an empty set is a valid file, not a problem", () => {
    writeFlags('{"v":1,"flags":[]}\n');
    expect(readInstallFlags(dataDir)).toEqual({ flags: [] });
  });

  test("missing and malformed files mean no flags, with a reason for update.log", () => {
    expect(readInstallFlags(dataDir).flags).toEqual([]);
    expect(readInstallFlags(dataDir).problem).toContain("no install-flags.json");
    writeFlags("{not json");
    expect(readInstallFlags(dataDir)).toMatchObject({ flags: [], problem: expect.stringContaining("malformed") });
    writeFlags('{"flags":"--minimal"}');
    expect(readInstallFlags(dataDir)).toMatchObject({ flags: [], problem: expect.stringContaining("malformed") });
  });

  test("unknown and hostile entries are dropped, known ones kept", () => {
    const r = parseInstallFlags({
      flags: ["skip-codex", "--minimal", "evil; rm -rf ~", "-SkipSkills", "version", 7, null, { id: "minimal" }, "__proto__", "toString"],
    });
    expect(r.flags).toEqual(["skip-codex"]);
    expect(r.problem).toContain("dropped");
  });

  test("a mutually-exclusive pair drops both sides", () => {
    expect(parseInstallFlags({ flags: ["minimal", "no-minimal", "skip-kiro"] }).flags).toEqual(["skip-kiro"]);
    expect(parseInstallFlags({ flags: ["verify-attestation", "skip-attestation"] }).flags).toEqual([]);
    expect(parseInstallFlags({ flags: ["with-t3", "without-t3", "skip-skills"] }).flags).toEqual(["skip-skills"]);
  });

  test("skip-claude-plugin is replayed with each installer's spelling", () => {
    // Recorded by install.sh / install.ps1 / install.cmd for --skip-claude-plugin
    // (-SkipClaudePlugin), so an auto-update keeps a plugin opt-out. A binary
    // that predates the id drops it as unrecognized (the test above).
    const r = parseInstallFlags({ v: 1, flags: ["skip-claude-plugin", "skip-codex", "skip-future-thing"] });
    expect(r.flags).toEqual(["skip-codex", "skip-claude-plugin"]);
    expect(r.problem).toContain("dropped 1");
    expect(installerFlagArgs(["skip-claude-plugin"], "linux")).toEqual(["--skip-claude-plugin"]);
    expect(installerFlagArgs(["skip-claude-plugin"], "win32")).toEqual(["-SkipClaudePlugin"]);
  });

  test("flags are spelled for each installer", () => {
    const flags = ["minimal", "with-call-flow", "skip-opencode"] as const;
    expect(installerFlagArgs(flags, "linux")).toEqual(["--minimal", "--with-call-flow", "--skip-opencode"]);
    expect(installerFlagArgs(flags, "win32")).toEqual(["-Minimal", "-WithCallFlow", "-SkipOpencode"]);
  });

  test("T3 hook choices survive updates only on the Bash installer platforms", () => {
    const flags = parseInstallFlags({ flags: ["with-t3", "skip-skills"] }).flags;
    expect(installerFlagArgs(flags, "darwin")).toEqual(["--with-t3", "--skip-skills"]);
    expect(installerFlagArgs(flags, "linux")).toEqual(["--with-t3", "--skip-skills"]);
    expect(installerFlagArgs(flags, "win32")).toEqual(["-SkipSkills"]);
    expect(installerFlagArgs(parseInstallFlags({ flags: ["without-t3"] }).flags, "linux")).toEqual(["--without-t3"]);
  });

  test("the check passes the remembered flags to the installer and logs them", async () => {
    writeFlags('{"v":1,"flags":["minimal","bogus"]}');
    expect(await runAutoUpdateCheck(deps())).toBe("launched");
    expect(launches[0].flags).toEqual(["minimal"]);
    const log = readFileSync(autoUpdatePaths(dataDir).log, "utf-8");
    expect(log).toContain("dropped 1");
    expect(log).toContain("with minimal");
  });

  test("with no file the check launches with no flags and says so in update.log", async () => {
    expect(await runAutoUpdateCheck(deps())).toBe("launched");
    expect(launches[0].flags).toEqual([]);
    expect(readFileSync(autoUpdatePaths(dataDir).log, "utf-8")).toContain("no install-flags.json");
  });

  test("POSIX passes flags as argv after the script, never inside it", () => {
    const { args, env } = installerCommand("linux", ["minimal", "skip-skills"]);
    expect(args.slice(0, 2)).toEqual(["-c", args[1]]);
    expect(args[1]).toContain('--non-interactive "$@"');
    expect(args[1]).not.toContain("--minimal");
    expect(args.slice(2)).toEqual(["plannotator-auto-update", "--minimal", "--skip-skills"]);
    expect(env).toEqual({});
  });

  test("Windows carries the flags in the environment and the encoded wrapper splats them", () => {
    const { args, env } = installerCommand("win32", ["minimal", "skip-codex"]);
    expect(env).toEqual({ PLANNOTATOR_UPDATE_FLAGS: "-Minimal -SkipCodex" });
    const script = Buffer.from(args[args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
    expect(script).toContain("$env:PLANNOTATOR_UPDATE_FLAGS");
    expect(script).toContain("-NonInteractive @installFlags");
    // The wrapper re-checks every switch against the same allowlist.
    for (const flag of installerFlagArgs(["minimal", "skip-codex", "skip-skills", "no-minimal"], "win32")) {
      expect(script).toContain(`'${flag}'`);
    }
    // No flag value is ever baked into the encoded text.
    expect(installerCommand("win32", []).args).toEqual(args);
  });
});

/**
 * A loopback stand-in for plannotator.ai and the release downloads: the
 * install script (with the two lines update-prepare requires) and a `.sha256`
 * per binary. The POSIX wrapper's `update-prepare` runs from source
 * (update-prepare-entry.ts) against it.
 */
function fakeRelease(scriptBody: string) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/install.sh") return new Response(`#!/bin/bash\nREPO="backnotprop/plannotator"\n${scriptBody}`);
      if (/^\/download\/v\d+\.\d+\.\d+\/plannotator-[a-z]+-(arm64|x64)\.sha256$/.test(path)) return new Response(`${"c".repeat(64)}  x\n`);
      return new Response("not found", { status: 404 });
    },
  });
  const env = {
    PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
    PLANNOTATOR_RELEASE_DOWNLOAD_URL: `http://127.0.0.1:${server.port}/download`,
  };
  return { server, env };
}
const PREPARE = { binary: process.execPath, entry: join(import.meta.dir, "update-prepare-entry.ts") };
const PREPARE_ENV = { PLANNOTATOR_UPDATE_BINARY: PREPARE.binary, PLANNOTATOR_UPDATE_ENTRY: PREPARE.entry };

describe.skipIf(process.platform === "win32")("POSIX wrapper end to end", () => {
  test("the downloaded installer receives the version and the remembered flags as argv", async () => {
    const { server, env } = fakeRelease('for a in "$@"; do echo "ARG:$a"; done\n');
    try {
      const { file, args } = installerCommand("linux", ["minimal", "skip-codex"]);
      const paths = autoUpdatePaths(dataDir);
      const proc = Bun.spawn([file, ...args], {
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: dataDir,
          PLANNOTATOR_UPDATE_VERSION: "v0.28.0",
          PLANNOTATOR_UPDATE_RESULT: paths.result,
          PLANNOTATOR_UPDATE_LOCK: paths.lock,
          ...PREPARE_ENV,
          ...env,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = await new Response(proc.stdout).text();
      await proc.exited;
      const argv = stdout.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
      expect(argv).toEqual(["--version", "v0.28.0", "--non-interactive", "--minimal", "--skip-codex"]);
      expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "v0.28.0", exitCode: 0 });
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

// Runs the real encoded wrapper under Windows PowerShell (the same
// powershell.exe launchInstaller spawns), downloading a stand-in installer
// from a local server. The stand-in declares the real installer's switches, so
// this proves the flags bind as switches rather than arriving as text.
describe.skipIf(process.platform !== "win32" || !Bun.which("powershell.exe"))("Windows wrapper end to end", () => {
  test("the downloaded installer is bound with the version and the remembered switches", async () => {
    const fake = [
      "param([string]$Version, [switch]$NonInteractive, [switch]$Minimal, [switch]$SkipCodex, [switch]$SkipSkills)",
      'Write-Output ("BOUND:" + $Version + "|" + [bool]$NonInteractive + "|" + [bool]$Minimal + "|" + [bool]$SkipCodex + "|" + [bool]$SkipSkills)',
      "exit 0",
    ].join("\r\n");
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(fake) });
    try {
      const { file, args, env } = installerCommand("win32", ["minimal", "skip-codex"]);
      const paths = autoUpdatePaths(dataDir);
      const proc = Bun.spawn([file, ...args], {
        env: {
          ...process.env,
          ...env,
          PLANNOTATOR_UPDATE_VERSION: "v0.28.0",
          PLANNOTATOR_UPDATE_RESULT: paths.result,
          PLANNOTATOR_UPDATE_LOCK: paths.lock,
          PLANNOTATOR_UPDATE_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.ps1`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out).toContain("BOUND:v0.28.0|True|True|True|False");
      expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "v0.28.0", exitCode: 0 });
    } finally {
      server.stop(true);
    }
  }, 60_000);
});

describe("update checks off", () => {
  test("auto-update needs the check: off means no request and no install", async () => {
    expect(await runAutoUpdateCheck(deps({ checksEnabled: () => false }))).toBe("checks-off");
    expect(fetches).toBe(0);
    expect(launches).toHaveLength(0);
  });

  test("auto-update answers from the release the shared check already cached", async () => {
    writeFileSync(
      autoUpdatePaths(dataDir).state,
      JSON.stringify({ latestRelease: { tag: "0.28.0", fetchedAt: NOW - 1000 } }),
    );
    expect(await runAutoUpdateCheck(deps())).toBe("launched");
    expect(fetches).toBe(0);
  });
});

describe("Update now (the person asked)", () => {
  const manual = (overrides: Partial<Parameters<typeof startManualUpdate>[0]> = {}) =>
    startManualUpdate({
      currentVersion: "0.27.22",
      dataDir,
      now: () => NOW,
      platform: "linux",
      isManaged: () => true,
      launchInstaller: (launch) => {
        launches.push(launch);
      },
      ...overrides,
    });
  const seed = () =>
    writeFileSync(autoUpdatePaths(dataDir).state, JSON.stringify({ latestRelease: { tag: "0.28.0", fetchedAt: NOW - 1000 } }));

  test("runs the installer once: a second press while it runs finds the lock", () => {
    seed();
    expect(manual()).toEqual({ outcome: "launched", version: "0.28.0" });
    expect(manual()).toEqual({ outcome: "locked" });
    expect(launches).toHaveLength(1);
    expect(launches[0].version).toBe("v0.28.0");
    expect(readAutoUpdateState(dataDir).pending).toEqual({ version: "0.28.0", fromVersion: "0.27.22", startedAt: NOW, by: "person" });
  });

  test("ignores the sessions gate and the 24h window that auto-update keeps", () => {
    writeFileSync(
      autoUpdatePaths(dataDir).state,
      JSON.stringify({ lastCheckAt: NOW - 10, latestRelease: { tag: "0.28.0", fetchedAt: NOW - 1000 } }),
    );
    expect(manual().outcome).toBe("launched");
  });

  test("only the known newer release, never a dev build or an unmanaged binary", () => {
    expect(manual().outcome).toBe("no-release");
    seed();
    expect(manual({ currentVersion: "0.28.0" }).outcome).toBe("up-to-date");
    expect(manual({ currentVersion: undefined }).outcome).toBe("dev-build");
    expect(manual({ isManaged: () => false }).outcome).toBe("unmanaged");
    expect(launches).toHaveLength(0);
  });

  test("a launch that throws releases the lock and records the failure", () => {
    seed();
    expect(
      manual({
        launchInstaller: () => {
          throw new Error("spawn EACCES");
        },
      }).outcome,
    ).toBe("launch-failed");
    expect(existsSync(autoUpdatePaths(dataDir).lock)).toBe(false);
    expect(JSON.parse(readFileSync(autoUpdatePaths(dataDir).result, "utf-8")).exitCode).toBe(-1);
    expect(manual().outcome).toBe("launched");
  });
});

describe("a failed fetch gives the install window back", () => {
  test("no release: lastCheckAt is restored, so the next start retries once the release check's backoff allows", async () => {
    const d = deps({ fetchLatestTag: async () => (fetches++, null) });
    expect(await runAutoUpdateCheck(d)).toBe("no-release");
    expect(readAutoUpdateState(dataDir).lastCheckAt).toBeUndefined();
    // Inside the release check's backoff: no second request yet.
    expect(await runAutoUpdateCheck(deps({ now: () => NOW + 60_000, fetchLatestTag: async () => (fetches++, "v0.28.0") }))).toBe("no-release");
    expect(fetches).toBe(1);
    // After it (only the API answers here, as behind a mirror: its hourly
    // back-off): the install window was not spent, so it asks and installs.
    expect(await runAutoUpdateCheck(deps({ now: () => NOW + RELEASE_CHECK_RETRY_MS }))).toBe("no-release");
    expect(fetches).toBe(1);
    expect(await runAutoUpdateCheck(deps({ now: () => NOW + RELEASE_API_FALLBACK_INTERVAL_MS }))).toBe("launched");
    expect(fetches).toBe(2);
  });
});

describe("the toast steps aside for auto-update only when it can install", () => {
  test("an install running; or its 24 h window open and no other session. Otherwise the toast must show", () => {
    const can = (lockHeld: boolean, windowOpen: boolean, sessions: SessionInfo[]) => autoUpdateCanInstall({ lockHeld, windowOpen, sessions, ownPid: 100 });
    expect(can(false, true, [session(100)])).toBe(true);
    // Another session open: auto-update skips this start.
    expect(can(false, true, [session(100), session(200)])).toBe(false);
    // Its window was spent today: it will not install for up to a day.
    expect(can(false, false, [session(100)])).toBe(false);
    // An install runs: the post-update toast speaks.
    expect(can(true, false, [session(100), session(200)])).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")("interrupted installs release the lock", () => {
  test("a group SIGINT (Ctrl-C) to the wrapper records 130 and removes update.lock", async () => {
    // `exec`: the line is printed by the process that then becomes the sleep, so
    // the group SIGINT finds either the shell or the sleep, never a child between
    // fork and exec. With a plain `sleep 30` a SIGINT landing in that window left
    // the sleep running, holding stdout, and `close` waited its 30 s (the wrapper
    // had already recorded 130 and removed the lock).
    const { server, env: releaseEnv } = fakeRelease('echo "fake installer started"\nexec sleep 30\n');
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, "1");
    try {
      const { file, args } = installerCommand("linux", []);
      const child = spawn(file, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: dataDir,
          PLANNOTATOR_UPDATE_VERSION: "v0.28.0",
          PLANNOTATOR_UPDATE_RESULT: paths.result,
          PLANNOTATOR_UPDATE_LOCK: paths.lock,
          ...PREPARE_ENV,
          ...releaseEnv,
        },
      });
      let out = "";
      child.stdout!.on("data", (c) => (out += c));
      const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
      const deadline = Date.now() + 20_000;
      while (!out.includes("fake installer started") && Date.now() < deadline) await Bun.sleep(20);
      process.kill(-child.pid!, "SIGINT");
      expect(await exited).toBe(130);
      expect(existsSync(paths.lock)).toBe(false);
      expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "v0.28.0", exitCode: 130 });
      // The trap removed the staged copy too.
      expect(readdirSync(dataDir).filter((n) => n.startsWith("plannotator-update-"))).toEqual([]);
    } finally {
      server.stop(true);
    }
  }, 30_000);

  test("a wrapper killed outright (no trap runs) still ends with the lock released and a failed result", async () => {
    const { server, env: releaseEnv } = fakeRelease('echo "fake installer started"\nsleep 3\n');
    const saved = { url: process.env.PLANNOTATOR_INSTALL_SCRIPT_URL, dl: process.env.PLANNOTATOR_RELEASE_DOWNLOAD_URL, tmp: process.env.TMPDIR };
    process.env.TMPDIR = dataDir;
    process.env.PLANNOTATOR_INSTALL_SCRIPT_URL = releaseEnv.PLANNOTATOR_INSTALL_SCRIPT_URL;
    process.env.PLANNOTATOR_RELEASE_DOWNLOAD_URL = releaseEnv.PLANNOTATOR_RELEASE_DOWNLOAD_URL;
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, "1");
    try {
      let out = "";
      const code = await runInstallerForeground(
        { version: "v0.28.0", logPath: paths.log, resultPath: paths.result, lockPath: paths.lock, platform: "linux", flags: [], prepare: PREPARE },
        (chunk) => (out += chunk),
        {
          onSpawn: (child) => {
            void (async () => {
              const deadline = Date.now() + 20_000;
              while (!out.includes("fake installer started") && Date.now() < deadline) await Bun.sleep(20);
              child.kill("SIGKILL");
            })();
          },
        },
      );
      expect(code).toBe(-1);
      expect(existsSync(paths.lock)).toBe(false);
      expect(JSON.parse(readFileSync(paths.result, "utf-8")).exitCode).toBe(-1);
      // No trap ran, so the staged copy is left; the next update's sweep
      // removes it once it is as old as a stale lock, never sooner.
      const staged = () => readdirSync(dataDir).filter((n) => n.startsWith("plannotator-update-"));
      expect(staged()).toHaveLength(1);
      expect(sweepStaleUpdateDirs(dataDir, Date.now())).toBe(0);
      expect(sweepStaleUpdateDirs(dataDir, Date.now() + AUTO_UPDATE_LOCK_STALE_MS + 1000)).toBe(1);
      expect(staged()).toEqual([]);
    } finally {
      if (saved.tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved.tmp;
      if (saved.url === undefined) delete process.env.PLANNOTATOR_INSTALL_SCRIPT_URL;
      else process.env.PLANNOTATOR_INSTALL_SCRIPT_URL = saved.url;
      if (saved.dl === undefined) delete process.env.PLANNOTATOR_RELEASE_DOWNLOAD_URL;
      else process.env.PLANNOTATOR_RELEASE_DOWNLOAD_URL = saved.dl;
      server.stop(true);
    }
  }, 30_000);
});
