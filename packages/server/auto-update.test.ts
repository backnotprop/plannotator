import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTO_UPDATE_INTERVAL_MS,
  autoUpdatePaths,
  compareStableVersions,
  deriveAutoUpdateNotice,
  installerCommand,
  installerFlagArgs,
  parseInstallFlags,
  readInstallFlags,
  isCheckDue,
  isManagedBinary,
  isNewerStableVersion,
  managedBinaryPath,
  readAutoUpdateState,
  runAutoUpdateCheck,
  type AutoUpdateDeps,
  type InstallerLaunch,
} from "./auto-update";
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

describe.skipIf(process.platform === "win32" || !Bun.which("curl"))("POSIX wrapper end to end", () => {
  test("the downloaded installer receives the version and the remembered flags as argv", () => {
    const script = join(dataDir, "fake-install.sh");
    writeFileSync(script, 'for a in "$@"; do echo "ARG:$a"; done\n');
    const { file, args } = installerCommand("linux", ["minimal", "skip-codex"]);
    const paths = autoUpdatePaths(dataDir);
    const r = Bun.spawnSync([file, ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: dataDir,
        PLANNOTATOR_UPDATE_VERSION: "v0.28.0",
        PLANNOTATOR_UPDATE_RESULT: paths.result,
        PLANNOTATOR_UPDATE_LOCK: paths.lock,
        PLANNOTATOR_UPDATE_SCRIPT_URL: `file://${script}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const argv = r.stdout.toString().split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
    expect(argv).toEqual(["--version", "v0.28.0", "--non-interactive", "--minimal", "--skip-codex"]);
    expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "v0.28.0", exitCode: 0 });
  });
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
