import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { agentByShort, claudeAttachCommand, createClaudeHost, parseAgentsJson, parseBackgrounded, refusedForMode, startFailureOf, versionAtLeast } from "./inbox-launch-claude";

describe("parseBackgrounded", () => {
  test("reads the short id and name from the line Claude Code 2.1.314 prints (bg-test RESULTS)", () => {
    const stdout = "Starting background service…\nbackgrounded · 844d238d · bgtest-B (idle — send a prompt to start)\n";
    expect(parseBackgrounded(stdout)).toEqual({ short: "844d238d", name: "bgtest-B" });
    expect(parseBackgrounded("backgrounded · ad91b9e9 · bgperm")).toEqual({ short: "ad91b9e9", name: "bgperm" });
  });

  test("anything else is not a start", () => {
    expect(parseBackgrounded("Error: Workspace not trusted")).toBeNull();
    expect(parseBackgrounded("backgrounded · XYZ · name")).toBeNull();
  });
});

describe("agentByShort", () => {
  const agents = parseAgentsJson(
    JSON.stringify([
      { id: "844d238d", sessionId: "844d238d-0000-4000-8000-000000000001", status: "idle", state: "running" },
      { sessionId: "2b2ff057-0000-4000-8000-000000000002", status: null, state: "stopped" },
      { sessionId: "2b2ff099-0000-4000-8000-000000000003", status: "busy", state: "running" },
      { id: "no-session" },
    ]),
  )!;

  test("drops entries without a session id and falls back to the session id's prefix", () => {
    expect(agents.map((a) => a.id)).toEqual(["844d238d", "2b2ff057", "2b2ff099"]);
    expect(agentByShort(agents, "844d238d")?.sessionId).toBe("844d238d-0000-4000-8000-000000000001");
    expect(agentByShort(agents, "2b2ff057")?.state).toBe("stopped");
  });

  test("an ambiguous prefix matches nothing, so a launch never adopts another session", () => {
    expect(agentByShort(agents, "2b2ff0")).toBeNull();
  });

  test("output that is not a JSON list is unreadable", () => {
    expect(parseAgentsJson("not json")).toBeNull();
    expect(parseAgentsJson("{}")).toBeNull();
  });
});

describe("startFailureOf", () => {
  test("Claude's untrusted-folder error becomes the run line's untrusted cause with the folder", () => {
    const failure = startFailureOf({ exitCode: 1, timedOut: false, stdout: "", stderr: "Error: Workspace not trusted. Run claude in /x first." }, "~/oss/side");
    expect(failure.code).toBe("untrusted");
    expect(failure.text).toStartWith("~/oss/side isn't a trusted folder yet.");
  });

  test("otherwise the first real output line, skipping the supervisor's banner", () => {
    expect(startFailureOf({ exitCode: 2, timedOut: false, stdout: "Starting background service…\nboom: no tty", stderr: "" }, "/x")).toEqual({ code: "failed", text: "boom: no tty" });
    expect(startFailureOf({ exitCode: 3, timedOut: false, stdout: "", stderr: "" }, "/x").text).toBe("claude exited with code 3.");
    expect(startFailureOf({ exitCode: -1, timedOut: true, stdout: "", stderr: "" }, "/x").text).toContain("too long");
  });
});

test("versionAtLeast compares numerically, not as text", () => {
  expect(versionAtLeast("2.1.314", "2.1.314")).toBe(true);
  expect(versionAtLeast("2.10.0", "2.1.314")).toBe(true);
  expect(versionAtLeast("2.1.99", "2.1.314")).toBe(false);
});

test("the attach command quotes the folder for the shell", () => {
  expect(claudeAttachCommand("/Users/me/it's here", "4f1c9a2e")).toBe("cd '/Users/me/it'\\''s here' && claude attach 4f1c9a2e");
});

describe("the person's shared Claude supervisor survives our calls", () => {
  const dirs: string[] = [];
  const pids: number[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  /** A CLI that starts a background daemon (as `claude` may start `claude daemon run`), then hangs. `sleep 30 &` in a non-interactive sh stays in the CLI's process group: the case a group kill would take down. */
  const hangingCli = () => {
    const dir = mkdtempSync(join(tmpdir(), "launch-group-"));
    dirs.push(dir);
    const cli = join(dir, "cli.sh");
    writeFileSync(cli, `#!/bin/sh\nsleep 30 &\necho $! > ${JSON.stringify(join(dir, "daemon.pid"))}\nexec sleep 30\n`, { mode: 0o755 });
    const env = createAgentEnvironmentFor({ platform: process.platform, homeDir: dir, env: { PATH: "/usr/bin:/bin" } });
    const daemonPid = () => {
      const pid = Number(readFileSync(join(dir, "daemon.pid"), "utf8").trim());
      pids.push(pid);
      return pid;
    };
    return { cli, env, daemonPid };
  };

  test.skipIf(process.platform === "win32")("a launch call that times out ends only itself; the daemon it started lives (a group kill would end it)", async () => {
    const own = hangingCli();
    const timedOut = await own.env.run([own.cli], { timeoutMs: 400, killGroup: false });
    expect(timedOut.timedOut).toBe(true);
    expect(alive(own.daemonPid())).toBe(true);

    // The default (every other agent CLI) still kills the whole group: the contrast this guards.
    const grouped = hangingCli();
    await grouped.env.run([grouped.cli], { timeoutMs: 400 });
    const pid = grouped.daemonPid();
    for (let i = 0; i < 20 && alive(pid); i++) await Bun.sleep(50);
    expect(alive(pid)).toBe(false);
  });

  test("every claude call asks for that: start, status, stop, respawn, rm", async () => {
    const seen: { argv: readonly string[]; killGroup: boolean | undefined }[] = [];
    const recording = (stdout: (argv: readonly string[]) => string): AgentEnvironment => ({
      platform: "darwin",
      homeDir: "/home",
      env: {},
      which: () => "/bin/claude",
      run: async (argv, options) => {
        seen.push({ argv, killGroup: options.killGroup });
        return { exitCode: 0, timedOut: false, stdout: stdout(argv), stderr: "" };
      },
    });
    const listing = JSON.stringify([{ id: "4f1c9a2e", sessionId: "4f1c9a2e-0000-0000-0000-000000000000", status: "idle", state: "running" }]);
    const plain = recording(() => listing);
    const host = createClaudeHost({ environment: async () => plain });
    const start = recording(() => "backgrounded · 4f1c9a2e · Smoke\n");
    expect((await host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", mode: "auto", environment: start })).ok).toBe(true);
    await host.agents();
    await host.stop("4f1c9a2e");
    await host.respawn("4f1c9a2e");
    await host.rm("4f1c9a2e");
    expect(seen.map((call) => call.argv[1])).toEqual(["--bg", "agents", "agents", "stop", "respawn", "rm"]);
    expect(seen.every((call) => call.killGroup === false)).toBe(true);
  });
});

test("a session --bg started but the supervisor never lists is stopped and removed before the failure (Try again makes no second one)", async () => {
  const calls: string[] = [];
  const env = (stdout: string): AgentEnvironment => ({
    platform: "darwin",
    homeDir: "/home",
    env: {},
    which: () => "/bin/claude",
    run: async (argv) => {
      calls.push(argv.slice(1).join(" "));
      return { exitCode: 0, timedOut: false, stdout, stderr: "" };
    },
  });
  const host = createClaudeHost({ environment: async () => env("[]") });
  const result = await host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", mode: "auto", environment: env("backgrounded · 4f1c9a2e · Smoke\n") });
  expect(result.ok).toBe(false);
  expect(calls.slice(-2)).toEqual(["stop 4f1c9a2e", "rm 4f1c9a2e"]);
});

describe("the start's permission mode", () => {
  const listing = JSON.stringify([{ id: "4f1c9a2e", sessionId: "4f1c9a2e-0000-0000-0000-000000000000", status: "idle", state: "running" }]);
  /** A CLI that refuses a start in `mode` (as `refuse` words it), and starts otherwise. */
  const cli = (refuse: string | null, mode = "auto") => {
    const starts: string[][] = [];
    const env: AgentEnvironment = {
      platform: "darwin",
      homeDir: "/home",
      env: {},
      which: () => "/bin/claude",
      run: async (argv) => {
        const args = argv.slice(1);
        if (args[0] !== "--bg") return { exitCode: 0, timedOut: false, stdout: listing, stderr: "" };
        starts.push(args);
        if (refuse && args.includes(mode)) return { exitCode: 1, timedOut: false, stdout: "", stderr: refuse };
        return { exitCode: 0, timedOut: false, stdout: "backgrounded · 4f1c9a2e · Smoke\n", stderr: "" };
      },
    };
    return { env, starts, host: createClaudeHost({ environment: async () => env }) };
  };
  const base = ["--bg", "--name", "Smoke", "--settings", "/s.json", "--allow-dangerously-skip-permissions"];

  test("every launch may switch to bypass later, and starts in auto mode or in bypass mode", async () => {
    for (const mode of ["auto", "bypassPermissions"] as const) {
      const { env, starts, host } = cli(null);
      const result = await host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", mode, environment: env });
      expect(result).toMatchObject({ ok: true });
      expect(result.modeRefused).toBeUndefined();
      expect(starts).toEqual([[...base, "--permission-mode", mode]]);
    }
  });

  test("auto mode refused (an account or a CLI without it): started again with no mode, and why is kept", async () => {
    const { env, starts, host } = cli("Error: Auto mode is not available for your account.");
    const result = await host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", mode: "auto", environment: env });
    expect(result).toMatchObject({ ok: true, modeRefused: "Error: Auto mode is not available for your account." });
    expect(starts).toEqual([[...base, "--permission-mode", "auto"], base]);
    expect(result.output).toContain("auto mode refused");
  });

  test("a failure that is not the mode's is never retried, and bypass mode is never dropped", async () => {
    const untrusted = cli("Error: Workspace not trusted. Run `claude` in /p once.");
    expect(await untrusted.host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", mode: "auto", environment: untrusted.env })).toMatchObject({ ok: false, code: "untrusted" });
    expect(untrusted.starts).toHaveLength(1);
    expect(refusedForMode({ exitCode: 1, timedOut: false, stdout: "", stderr: "Error: Not logged in." })).toBe(false);
    expect(refusedForMode({ exitCode: 1, timedOut: false, stdout: "", stderr: "error: option '--permission-mode <mode>' argument 'auto' is invalid." })).toBe(true);
    // Bypass mode refused: the launch fails as it is, never started in another mode than the one it records.
    const bypass = cli("Error: bypassPermissions mode is disabled by your organization.", "bypassPermissions");
    const result = await bypass.host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", mode: "bypassPermissions", environment: bypass.env });
    expect(result).toMatchObject({ ok: false, text: "Error: bypassPermissions mode is disabled by your organization." });
    expect(bypass.starts).toHaveLength(1);
  });
});
