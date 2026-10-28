/**
 * `plannotator update`: the command's outcomes over injected seams, and the
 * real CLI as a process against a fake GitHub API and a fake install script
 * (both on a loopback server), under a temp HOME and data dir. Nothing here
 * reaches GitHub or runs the real install script.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runUpdateCommand, type UpdateCommandDeps } from "./update-command";
import { UPDATE_EXIT_CHECKSUM_MISMATCH } from "@plannotator/core/update-exit-codes";
import { UPDATE_OLD_SCRIPT_NOTE, UPDATE_STAGING_PREFIX, UPDATE_TLS_HINT } from "@plannotator/server/update-log";
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

  test("a failed install says so, with the log and the install command (exit 1)", async () => {
    expect(await run([], { runInstaller: async () => 5 })).toBe(1);
    expect(err).toContain("exited with code 5");
    expect(err).toContain("update.log");
    expect(err).toContain("Or run the install script yourself: curl -fsSL");
  });

  // Safe updates: after a mismatch (install.sh's pin check) or a failed download
  // (the wrapper's 75) the old version is kept, and the `curl | bash` line is
  // never offered: it would go through the connection that just failed.
  test("a download that didn't match its checksum: the old version still works, no install command", async () => {
    expect(await run([], { runInstaller: async () => UPDATE_EXIT_CHECKSUM_MISMATCH })).toBe(1);
    expect(err).toContain("The update to 0.28.11 stopped: the download didn't match the checksum Plannotator fetched for it.");
    expect(err).toContain("0.28.10 is still installed and works. Try again later, or on another network: plannotator update");
    expect(err).toContain("update.log");
    expect(err).not.toContain("curl");
    expect(err).not.toContain("exited with code");
  });

  // A failed download can be lasting (a proxy, a network that inspects HTTPS):
  // the person always gets a way out, except over a network that presented a
  // revoked certificate (a blocked key), where curl would trust it.
  test("an update that couldn't be downloaded: the old version still works, and the way out is shown", async () => {
    expect(await run([], { runInstaller: async () => 75 })).toBe(1);
    expect(err).toContain("Couldn't download the update. 0.28.10 is still installed and works. Try again later: plannotator update");
    expect(err).toContain("If this keeps happening, install it yourself:\n  curl -fsSL https://plannotator.ai/install.sh | bash\n");
    expect(err).toContain("or download it from https://github.com/backnotprop/plannotator/releases/tag/v0.28.11");
    expect(err).toContain("update.log");
    expect(err).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  test("a certificate neither Plannotator nor this computer trusts: also how to add the network's certificate", async () => {
    const runInstaller = async (_: unknown, write: (t: string) => void) => (write(`${UPDATE_TLS_HINT.untrusted}\n`), 75);
    expect(await run([], { runInstaller })).toBe(1);
    expect(err).toContain("  NODE_EXTRA_CA_CERTS=/path/to/its-root.pem plannotator update\n");
    expect(err).toContain("If this keeps happening, install it yourself:\n  curl -fsSL");
  });

  // macOS curl still trusts emSign G3: there, an untrusted certificate puts
  // the release page before the `curl | bash` line. Elsewhere the order stays.
  test("an untrusted certificate on macOS: the release page comes before the install command", async () => {
    const runInstaller = async (_: unknown, write: (t: string) => void) => (write(`${UPDATE_TLS_HINT.untrusted}\n`), 75);
    expect(await run([], { runInstaller, platform: "darwin" })).toBe(1);
    const release = err.indexOf("download it from https://github.com/backnotprop/plannotator/releases/tag/v0.28.11");
    const curl = err.indexOf("curl -fsSL https://plannotator.ai/install.sh");
    expect(release).toBeGreaterThan(-1);
    expect(curl).toBeGreaterThan(release);
    expect(err).toContain("NODE_EXTRA_CA_CERTS=/path/to/its-root.pem plannotator update");
    err = "";
    rmSync(join(dataDir, "update.lock"), { force: true });
    expect(await run([], { runInstaller, platform: "linux" })).toBe(1);
    expect(err.indexOf("curl -fsSL")).toBeLessThan(err.indexOf("download it from"));
  });

  test("a temp folder that can't hold the update: its own words, not \"couldn't download\", no install command", async () => {
    const runInstaller = async (_: unknown, write: (t: string) => void) => (
      write(`${UPDATE_STAGING_PREFIX}the temp folder /tmp/x is full (ENOSPC); nothing was changed\n`), 75
    );
    expect(await run([], { runInstaller })).toBe(1);
    expect(err).toContain("Couldn't prepare the update: the temp folder /tmp/x is full (ENOSPC). 0.28.10 is still installed and works.");
    expect(err).toContain("Free some space there, then: plannotator update");
    expect(err).toContain("TMPDIR=/another/folder plannotator update");
    expect(err).not.toContain("Couldn't download");
    expect(err).not.toContain("curl");
  });

  // Permissions or a missing folder are not fixed by freeing space.
  for (const [reason, advice] of [
    ["the temp folder /tmp/x can't be written (EACCES)", "Make it writable, then: plannotator update"],
    ["the temp folder /tmp/x does not exist (ENOENT)", "Create it, then: plannotator update"],
  ] as const) {
    test(`a temp folder that ${reason.includes("exist") ? "does not exist" : "can't be written"}: advice for that cause`, async () => {
      const runInstaller = async (_: unknown, write: (t: string) => void) => (
        write(`${UPDATE_STAGING_PREFIX}${reason}; nothing was changed\n`), 75
      );
      expect(await run([], { runInstaller })).toBe(1);
      expect(err).toContain(`Couldn't prepare the update: ${reason}.`);
      expect(err).toContain(advice);
      expect(err).toContain("TMPDIR=/another/folder plannotator update");
      expect(err).not.toContain("Free some space");
    });
  }

  // Before the S3 sync every update printed this; it belongs in update.log only.
  test("the old install script's note stays off the terminal", async () => {
    const runInstaller = async (_: unknown, write: (t: string) => void) => (write(`${UPDATE_OLD_SCRIPT_NOTE}\n`), write("  installer output\n"), 0);
    expect(await run([], { runInstaller })).toBe(0);
    expect(out).toContain("installer output");
    expect(out + err).not.toContain("does not check the pinned checksum yet");
  });

  test("a revoked certificate: never the install command, try another network", async () => {
    const runInstaller = async (_: unknown, write: (t: string) => void) => (write(`${UPDATE_TLS_HINT.revoked}\n`), 75);
    expect(await run([], { runInstaller })).toBe(1);
    expect(err).toContain("the connection presented a revoked certificate. 0.28.10 is still installed and works.");
    expect(err).toContain("Try again on another network: plannotator update");
    expect(err).not.toContain("curl");
    expect(err).not.toContain("NODE_EXTRA_CA_CERTS");
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
describe.skipIf(process.platform === "win32")("plannotator update (process)", () => {
  const entry = resolve(import.meta.dir, "update-command-entry.ts");
  let home: string;
  let server: ReturnType<typeof Bun.serve>;
  let installerExit = 0;
  let installerSleeps = false;
  let sumsBroken = false;
  let apiHits = 0;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plannotator-update-home-"));
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    symlinkSync(realpathSync(process.execPath), join(home, ".local", "bin", "plannotator"));
    apiHits = 0;
    installerExit = 0;
    installerSleeps = false;
    sumsBroken = false;
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
          // The fake installer: records its argv, HOME and the pinned
          // checksums, exits as told. The first two lines are what
          // update-prepare requires of any script it saves.
          return new Response(
            '#!/bin/bash\nREPO="backnotprop/plannotator"\n' +
              (installerSleeps
                ? `echo "fake installer started"\nsleep 30\n`
                : `printf '%s\\n' "$@" > "$HOME/installer-args"\nprintf '%s' "$PLANNOTATOR_EXPECTED_SHA256" > "$HOME/installer-pins"\necho "fake installer ran"\nexit ${installerExit}\n`),
          );
        }
        const sum = /^\/download\/v9\.9\.9\/(plannotator-(?:darwin|linux)-(?:arm64|x64))\.sha256$/.exec(path);
        if (sum && sumsBroken) return new Response("<html>captive portal</html>");
        if (sum) return new Response(`${sum[1]!.endsWith("arm64") ? "a".repeat(64) : "b".repeat(64)}  ${sum[1]}\n`);
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
    return cliWith({}, ...args);
  }
  async function cliWith(extraEnv: Record<string, string>, ...args: string[]) {
    const proc = Bun.spawn(["bun", "--define", '__CLI_VERSION__="0.1.0"', entry, ...args], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TMPDIR: home,
        PLANNOTATOR_DATA_DIR: dataDir,
        PLANNOTATOR_UPDATE_API_URL: `http://127.0.0.1:${server.port}/releases/latest`,
        PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
        PLANNOTATOR_RELEASE_DOWNLOAD_URL: `http://127.0.0.1:${server.port}/download`,
        ...extraEnv,
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
    // Safe updates: the script ran from the copy Plannotator downloaded, with
    // the checksums it fetched (this machine's CPU type first), and the staged
    // copy is gone afterwards.
    const os = process.platform === "darwin" ? "darwin" : "linux";
    const pins = readFileSync(join(home, "installer-pins"), "utf-8").split(" ");
    expect(pins[0]).toStartWith(`plannotator-${os}-${process.arch === "x64" ? "x64" : "arm64"}=`);
    expect(pins.toSorted()).toEqual([`plannotator-${os}-arm64=${"a".repeat(64)}`, `plannotator-${os}-x64=${"b".repeat(64)}`]);
    expect(readdirSync(home).filter((n) => n.startsWith("plannotator-update-"))).toEqual([]);
  }, 60_000);

  test("a checksum Plannotator can't read means nothing runs: exit 1, the old version kept, the way out shown", async () => {
    sumsBroken = true;
    const r = await cli();
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Couldn't download the update. 0.1.0 is still installed and works.");
    expect(r.stderr).toContain("If this keeps happening, install it yourself:\n  curl -fsSL https://plannotator.ai/install.sh | bash\n");
    expect(existsSync(join(home, "installer-args"))).toBe(false);
    expect(existsSync(join(dataDir, "update.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(join(dataDir, "update-result.json"), "utf-8"))).toEqual({ version: "v9.9.9", exitCode: 75 });
    expect(readFileSync(join(dataDir, "update.log"), "utf-8")).toContain("not a SHA-256 checksum");
    expect(readdirSync(home).filter((n) => n.startsWith("plannotator-update-"))).toEqual([]);
  }, 60_000);

  // A network that inspects HTTPS with its own root, which neither Bun's roots
  // nor this test's computer store hold: the stand-in serves the same release
  // over HTTPS with a certificate from a private root. The update must either
  // succeed or fail with the way out, and the way out it names must work.
  test("a network that inspects HTTPS: the way out is shown, and NODE_EXTRA_CA_CERTS gets the update through", async () => {
    const { makeSelfSignedTls } = await import("../../../tests/helpers/self-signed-tls");
    const certs = join(home, "certs");
    mkdirSync(certs);
    const tls = makeSelfSignedTls(certs);
    const inspected = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      tls: { cert: tls.cert, key: tls.key },
      fetch: (req) => fetch(`http://127.0.0.1:${server.port}${new URL(req.url).pathname}`),
    });
    try {
      const overHttps = {
        PLANNOTATOR_INSTALL_SCRIPT_URL: `https://127.0.0.1:${inspected.port}/install.sh`,
        PLANNOTATOR_RELEASE_DOWNLOAD_URL: `https://127.0.0.1:${inspected.port}/download`,
      };
      const refused = await cliWith(overHttps);
      expect(refused.exitCode).toBe(1);
      expect(existsSync(join(home, "installer-args"))).toBe(false);
      expect(JSON.parse(readFileSync(join(dataDir, "update-result.json"), "utf-8"))).toEqual({ version: "v9.9.9", exitCode: 75 });
      // macOS puts the release page first for an untrusted certificate (its curl still trusts emSign G3).
      if (process.platform === "darwin") {
        expect(refused.stderr).toContain(
          "If this keeps happening, download it from https://github.com/backnotprop/plannotator/releases/tag/v9.9.9\nor install it yourself:\n  curl -fsSL https://plannotator.ai/install.sh | bash\n",
        );
      } else {
        expect(refused.stderr).toContain("If this keeps happening, install it yourself:\n  curl -fsSL https://plannotator.ai/install.sh | bash\n");
        expect(refused.stderr).toContain("or download it from https://github.com/backnotprop/plannotator/releases/tag/v9.9.9\n");
      }
      expect(refused.stderr).toContain("  NODE_EXTRA_CA_CERTS=/path/to/its-root.pem plannotator update\n");
      expect(existsSync(join(dataDir, "update.lock"))).toBe(false);

      const through = await cliWith({ ...overHttps, NODE_EXTRA_CA_CERTS: tls.caFile });
      expect(through.exitCode, through.stderr).toBe(0);
      expect(through.stdout).toContain("Updated to 9.9.9.");
      expect(readFileSync(join(home, "installer-pins"), "utf-8")).toContain(`=${"a".repeat(64)}`);
    } finally {
      inspected.stop(true);
    }
  }, 90_000);

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
        PLANNOTATOR_RELEASE_DOWNLOAD_URL: `http://127.0.0.1:${server.port}/download`,
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

// The update wrapper calls `<binary> update-prepare <version>` and trusts its
// stdout to be exactly the staged dir. This runs it through the real CLI
// entrypoint (index.ts, from source), so losing the dispatch, or any stdout
// printed before it, fails here. (The compiled binary is checked the same way
// in release.yml's smoke-binaries job.) index.ts imports the built HTML at
// load, so missing pages are stubbed as in cli.test.ts.
describe.skipIf(process.platform === "win32")("update-prepare through the CLI entrypoint", () => {
  const entry = resolve(import.meta.dir, "index.ts");

  test("prints exactly the staged dir; a failed download prints nothing and exits 75", async () => {
    const { removeStubbedHtml, stubHookDistHtml } = await import("../../../tests/helpers/hook-dist-stub");
    const stubbed = stubHookDistHtml();
    const work = mkdtempSync(join(tmpdir(), "plannotator-prepare-entry-"));
    let sumsUp = true;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === "/install.sh") return new Response('#!/bin/bash\nREPO="backnotprop/plannotator"\n# PLANNOTATOR_EXPECTED_SHA256\n');
        if (sumsUp && path.endsWith(".sha256")) return new Response(`${"d".repeat(64)}  x\n`);
        return new Response("not found", { status: 404 });
      },
    });
    try {
      const run = async () => {
        const proc = Bun.spawn(["bun", "run", entry, "update-prepare", "v9.9.9"], {
          cwd: work,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: work,
            TMPDIR: work,
            PLANNOTATOR_DATA_DIR: join(work, "data"),
            PLANNOTATOR_UPDATE_CHECK: "0",
            PLANNOTATOR_INSTALL_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
            PLANNOTATOR_RELEASE_DOWNLOAD_URL: `http://127.0.0.1:${server.port}/dl`,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { stdout, stderr, code };
      };
      const ok = await run();
      expect(ok.code, ok.stderr).toBe(0);
      expect(ok.stdout).toMatch(/^\/[^\n]*\/plannotator-update-[^/\n]+\n$/);
      const dir = ok.stdout.trim();
      expect(realpathSync(join(dir, ".."))).toBe(realpathSync(work));
      expect(readFileSync(join(dir, "expected-sha256"), "utf-8")).toContain(`=${"d".repeat(64)}`);
      sumsUp = false;
      const bad = await run();
      expect(bad.code).toBe(75);
      expect(bad.stdout).toBe("");
      expect(bad.stderr).toContain("could not download the update");
    } finally {
      server.stop(true);
      rmSync(work, { recursive: true, force: true });
      removeStubbedHtml(stubbed);
    }
  }, 60_000);
});
