import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { agentByShort, claudeAttachCommand, createClaudeHost, parseAgentsJson, parseBackgrounded, startFailureOf, versionAtLeast } from "./inbox-launch-claude";

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
    expect((await host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", fullPermissions: false, environment: start })).ok).toBe(true);
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
  const result = await host.start({ folder: "/p", shownFolder: "~/p", name: "Smoke", settingsPath: "/s.json", fullPermissions: false, environment: env("backgrounded · 4f1c9a2e · Smoke\n") });
  expect(result.ok).toBe(false);
  expect(calls.slice(-2)).toEqual(["stop 4f1c9a2e", "rm 4f1c9a2e"]);
});
