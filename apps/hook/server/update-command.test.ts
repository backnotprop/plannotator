/**
 * `plannotator update`: the command's outcomes over injected seams, and the
 * real CLI as a process against a fake GitHub API and a fake install script
 * (both on a loopback server), under a temp HOME and data dir. Nothing here
 * reaches GitHub or runs the real install script.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runUpdateCommand, type UpdateCommandDeps } from "./update-command";
import type { FetchReleaseResult } from "@plannotator/shared/update-check";

let dataDir: string;
let out: string;
let err: string;
let installs: string[];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-cmd-"));
  out = "";
  err = "";
  installs = [];
});
afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

const latest = (tag: string): (() => Promise<FetchReleaseResult>) => async () => ({ ok: true, release: { tag } });

function run(args: string[], overrides: Partial<UpdateCommandDeps> = {}) {
  return runUpdateCommand(args, {
    currentVersion: "0.28.10",
    dataDir,
    execPath: "/home/u/.local/bin/plannotator",
    platform: "linux",
    env: { HOME: "/home/u" },
    out: (t) => (out += t),
    err: (t) => (err += t),
    fetchRelease: latest("v0.28.11"),
    runInstaller: async (launch, write) => {
      installs.push(launch.version);
      write("  installer output\n");
      return 0;
    },
    ...overrides,
  });
}

describe("plannotator update (seams)", () => {
  test("installs the newer release once and says what happened", async () => {
    writeFileSync(join(dataDir, "install-flags.json"), '{"v":1,"flags":["skip-gemini","skip-claude-plugin"]}');
    expect(await run([])).toBe(0);
    expect(installs).toEqual(["v0.28.11"]);
    expect(out).toContain("Plannotator 0.28.11 is available (you have 0.28.10).");
    expect(out).toContain("Installing v0.28.11 with your last install's choices: --skip-gemini --skip-claude-plugin");
    expect(out).toContain("installer output");
    expect(out).toContain("Updated to 0.28.11.");
    // The plugin opt-out was remembered, so the plugin is the person's to update.
    expect(out).toContain("claude plugin update plannotator@plannotator");
  });

  test("up to date: exit 0, nothing installed", async () => {
    expect(await run([], { fetchRelease: latest("v0.28.10") })).toBe(0);
    expect(out).toContain("Plannotator 0.28.10 is installed. Up to date");
    expect(installs).toEqual([]);
  });

  test("--check reports and installs nothing", async () => {
    expect(await run(["--check"])).toBe(0);
    expect(out).toContain("Plannotator 0.28.11 is available (you have 0.28.10).");
    expect(installs).toEqual([]);
  });

  test("an unknown option is a usage error (exit 2)", async () => {
    expect(await run(["--force"])).toBe(2);
    expect(err).toContain("Usage:");
  });

  test("a binary the install script does not manage gets the command, not an install (exit 1)", async () => {
    expect(await run([], { execPath: "/opt/homebrew/bin/plannotator" })).toBe(1);
    expect(err).toContain("curl -fsSL https://plannotator.ai/install.sh | bash");
    expect(installs).toEqual([]);
  });

  test("a dev build cannot update itself (exit 1), and asks nobody", async () => {
    let asked = 0;
    expect(await run([], { currentVersion: undefined, fetchRelease: async () => (asked++, { ok: true, release: { tag: "v1.0.0" } }) })).toBe(1);
    expect(asked).toBe(0);
    // The e2e and CI binaries are built as 0.0.0-dev: not a release either.
    expect(await run([], { currentVersion: "0.0.0-dev", fetchRelease: async () => (asked++, { ok: true, release: { tag: "v1.0.0" } }) })).toBe(1);
    expect(asked).toBe(0);
  });

  test("an unreachable GitHub is a failure (exit 1)", async () => {
    expect(await run([], { fetchRelease: async () => ({ ok: false, error: "HTTP 429" }) })).toBe(1);
    expect(err).toContain("HTTP 429");
  });

  test("a failed install says so, with the log (exit 1)", async () => {
    expect(await run([], { runInstaller: async () => 3 })).toBe(1);
    expect(err).toContain("exited with code 3");
    expect(err).toContain("update.log");
  });

  test("another update holding the lock: exit 1, no second install", async () => {
    writeFileSync(join(dataDir, "update.lock"), "1");
    expect(await run([])).toBe(1);
    expect(err).toContain("Another update is already running");
    expect(installs).toEqual([]);
  });

  test("checks off: still asks because the person asked, and says so", async () => {
    expect(await run(["--check"], { env: { HOME: "/home/u", PLANNOTATOR_UPDATE_CHECK: "0" } })).toBe(0);
    expect(err).toContain("Update checks are off (PLANNOTATOR_UPDATE_CHECK=0). Checking because you asked.");
  });
});

// `plannotator update` from source (update-command-entry.ts, the function
// index.ts dispatches, without the built HTML the full entry imports), made a
// "release" with --define and made "managed" by a temp HOME whose
// ~/.local/bin/plannotator links to this bun.
describe.skipIf(process.platform === "win32" || !Bun.which("curl"))("plannotator update (process)", () => {
  const entry = resolve(import.meta.dir, "update-command-entry.ts");
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let installerExit = 0;
  let installerSleeps = false;
  let apiHits = 0;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plannotator-update-home-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(realpathSync(process.execPath), join(home, ".local", "bin", "plannotator"));
    apiHits = 0;
    installerExit = 0;
    installerSleeps = false;
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/releases/latest") {
          apiHits++;
          return Response.json({ tag_name: "v9.9.9", published_at: "2026-10-10T00:00:00Z", body: "## What's New in v9.9.9\n\nThings." });
        }
        if (path === "/install.sh") {
          // The fake installer: records its argv and HOME, exits as told.
          return new Response(
            installerSleeps
              ? `echo "fake installer started"\nsleep 30\n`
              : `printf '%s\\n' "$@" > "$HOME/installer-args"\necho "fake installer ran"\nexit ${installerExit}\n`,
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
  });
  afterEach(() => {
    server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  // Async: the fake API and installer are served from this process, so a
  // spawnSync would block the server it is waiting on.
  async function cli(...args: string[]) {
    const proc = Bun.spawn(["bun", "--define", '__CLI_VERSION__="0.1.0"', entry, ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        PLANNOTATOR_DATA_DIR: dataDir,
        PLANNOTATOR_UPDATE_API_URL: `http://127.0.0.1:${server.port}/releases/latest`,
        PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  }

  test("runs the install script for the newest release with the remembered flags, then releases the lock", async () => {
    writeFileSync(join(dataDir, "install-flags.json"), '{"v":1,"flags":["skip-codex"]}');
    const r = await cli();
    const stdout = r.stdout;
    expect(r.exitCode).toBe(0);
    expect(stdout).toContain("Plannotator 9.9.9 is available (you have 0.1.0).");
    expect(stdout).toContain("fake installer ran");
    expect(stdout).toContain("Updated to 9.9.9.");
    expect(readFileSync(join(home, "installer-args"), "utf-8").trim().split("\n")).toEqual([
      "--version",
      "v9.9.9",
      "--non-interactive",
      "--skip-codex",
    ]);
    expect(existsSync(join(dataDir, "update.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "update-result.json"), "utf-8"))).toEqual({ version: "v9.9.9", exitCode: 0 });
    expect(readFileSync(join(dataDir, "update.log"), "utf-8")).toContain("fake installer ran");
    expect(apiHits).toBe(1);
  }, 60_000);

  test("a failing install script exits 1 and says where the log is", async () => {
    installerExit = 4;
    const r = await cli();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("exited with code 4");
    expect(existsSync(join(dataDir, "update.lock"))).toBe(false);
  }, 60_000);

  test("Ctrl-C while the installer runs: exit 130, the lock released, the result recorded", async () => {
    installerSleeps = true;
    // Its own process group, so a group SIGINT is what a terminal's Ctrl-C sends.
    const child = spawn("bun", ["--define", '__CLI_VERSION__="0.1.0"', entry], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        PLANNOTATOR_DATA_DIR: dataDir,
        PLANNOTATOR_UPDATE_API_URL: `http://127.0.0.1:${server.port}/releases/latest`,
        PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
      },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout!.on("data", (c) => (out += c));
    child.stderr!.on("data", (c) => (err += c));
    const exited = new Promise<number | null>((r) => child.on("close", (code) => r(code)));
    const deadline = Date.now() + 30_000;
    while (!out.includes("fake installer started") && Date.now() < deadline) await Bun.sleep(25);
    expect(existsSync(join(dataDir, "update.lock"))).toBe(true);
    process.kill(-child.pid!, "SIGINT");
    expect(await exited).toBe(130);
    expect(err).toContain("The update was interrupted");
    expect(existsSync(join(dataDir, "update.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "update-result.json"), "utf-8"))).toEqual({ version: "v9.9.9", exitCode: 130 });
  }, 60_000);

  test("--check installs nothing", async () => {
    const r = await cli("--check");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Plannotator 9.9.9 is available (you have 0.1.0).");
    expect(existsSync(join(home, "installer-args"))).toBe(false);
  }, 60_000);
});
