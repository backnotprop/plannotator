/**
 * The variables the CLI scrubs at startup never reach a child process, run as
 * the real process.
 *
 * The CLI takes the pull bridge's token, host and modes, the host result file
 * and the review id from its environment at startup and deletes them, so
 * nothing it spawns inherits the bridge token. On Bun that only holds when
 * every spawn passes the LIVE env: `Bun.spawn`, `Bun.spawnSync` and node's
 * synchronous child_process calls without `env` hand a child the environment
 * the process STARTED with, deleted variables included. Before the fix, 31 of
 * 39 git calls of a review carried the token, and so did `agent models`,
 * `opencode models`, `pi --list-models` and `copilot help config`.
 *
 * The CLI runs as a child of this test (`bun run`, never in-process), so no
 * test preload can mask what the runtime does: tests/setup/gh-tripwire.ts
 * wraps Bun.spawn / Bun.spawnSync / Bun.which to use the live env, but only in
 * the `bun test` process, and `bun run` loads no `[test]` preload. The CLI
 * runs in a scratch git repository, with a
 * scratch HOME and data dir and a PATH that starts with logging stubs: `git`
 * logs and then runs the real git; `gh` and every agent CLI only log and exit
 * 0 (`--version` prints a version). No real
 * agent CLI or gh ever runs. tests/child-env-guard.test.ts is the matching
 * source scan.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];

/** What the CLI must scrub. Values are recognizable in a log line. */
const SCRUBBED = {
  PLANNOTATOR_SESSION_BRIDGE_TOKEN: "scrub-test-token-000000000000000000000000",
  PLANNOTATOR_SESSION_BRIDGE_HOST: "claude-code",
  PLANNOTATOR_SESSION_BRIDGE_MODES: "turn",
  PLANNOTATOR_HOST_REVIEW_ID: "pn-abc123",
} as const;

/** A variable nobody scrubs: every child must see it, which proves the stubs log what they get. */
const CANARY = "PLANNOTATOR_CHILD_ENV_CANARY";

/** Agent CLIs the review server looks for on PATH; each a stub that only logs. */
const AGENT_STUBS = ["claude", "codex", "agent", "opencode", "pi", "copilot", "cursor-agent", "gh"];

beforeAll(() => {
  // The CLI imports the built HTML; API-only tests need just a stub.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

/** One logged child: its argv line and the variables of interest it saw. */
interface LoggedChild {
  argv: string;
  env: Map<string, string>;
}

/** Every logged child, one file each (children run concurrently, so they never share a file). */
function readLog(dir: string): LoggedChild[] {
  if (!existsSync(dir)) return [];
  const children: LoggedChild[] = [];
  for (const name of readdirSync(dir)) {
    const [head, ...lines] = readFileSync(join(dir, name), "utf8").split("\n");
    if (!head?.startsWith("=== ")) continue;
    const child: LoggedChild = { argv: head.slice(4), env: new Map() };
    for (const line of lines) {
      const at = line.indexOf("=");
      if (at > 0) child.env.set(line.slice(0, at), line.slice(at + 1));
    }
    children.push(child);
  }
  return children;
}

function makeWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-scrubbed-env-")));
  roots.push(root);
  const home = join(root, "home");
  const bin = join(root, "bin");
  const repo = join(root, "repo");
  const dataDir = join(root, "data");
  const log = join(root, "children");
  for (const dir of [home, bin, repo, dataDir, log]) mkdirSync(dir, { recursive: true });

  // The host result file must sit where the CLI accepts it (isAllowedHostResultPath).
  const launch = join(dataDir, "claude-code-mod", "session-1", "launch-1");
  mkdirSync(launch, { recursive: true });
  const files = { ready: join(launch, "ready"), result: join(launch, "result.json") };

  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is required for this test");
  const logLines = `{ printf '=== %s %s\\n' "$(basename "$0")" "$*"; env | grep -E '^(PLANNOTATOR_SESSION_BRIDGE_|PLANNOTATOR_HOST_|${CANARY}=)' || true; } > "$(mktemp '${log}/child.XXXXXX')"`;
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${logLines}\nexec '${realGit}' "$@"\n`);
  for (const name of AGENT_STUBS) {
    // Never the real CLI: log and exit. `--version` gets a version so callers move on.
    writeFileSync(join(bin, name), `#!/bin/sh\n${logLines}\ncase "$1" in --version) echo "${name} 0.0.0";; esac\nexit 0\n`);
  }
  for (const name of ["git", ...AGENT_STUBS]) chmodSync(join(bin, name), 0o755);

  const gitEnv = {
    PATH: `/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
  const git = (...args: string[]) => {
    const r = Bun.spawnSync([realGit, ...args], { cwd: repo, env: gitEnv, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  };
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "app.ts"), "export const a = 1;\n");
  git("add", "app.ts");
  git("commit", "-q", "-m", "first");
  writeFileSync(join(repo, "app.ts"), "export const a = 2;\n");

  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TMPDIR: tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    // gh is only ever the stub above; even so, never a real token or config
    // (the rule tests/setup/gh-tripwire.ts holds for the test process).
    GH_CONFIG_DIR: join(home, "gh-config"),
    GH_TOKEN: "plannotator-test-fake-token",
    GH_PROMPT_DISABLED: "1",
    NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_CWD: repo,
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_READY_FILE: files.ready,
    PLANNOTATOR_HOST_RESULT_FILE: files.result,
    PLANNOTATOR_UPDATE_CHECK: "0",
    PLANNOTATOR_AUTO_UPDATE: "0",
    PLANNOTATOR_FEEDBACK_HISTORY: "0",
    PLANNOTATOR_REVIEW_PROGRESS: "0",
    PLANNOTATOR_GIT_REMOTE_CHECK: "0",
    PLANNOTATOR_SHARE: "disabled",
    [CANARY]: "present",
    ...SCRUBBED,
  };
  return { repo, log, files, env };
}

/** Every child saw the live env (the canary) and none of the scrubbed variables. */
function expectNoLeaks(children: LoggedChild[]): void {
  for (const child of children) expect(child.env.get(CANARY), child.argv).toBe("present");
  const leaks = children.flatMap((child) =>
    [...child.env.keys()].filter((key) => key !== CANARY).map((key) => `${child.argv.slice(0, 80)} :: ${key}`),
  );
  expect(leaks).toEqual([]);
}

describe("scrubbed variables never reach a child process", () => {
  test("plannotator review: git, and the agent CLIs /api/agents/capabilities runs, see none of them", async () => {
    const world = makeWorld();
    const proc = Bun.spawn([process.execPath, "run", entry, "review"], {
      cwd: world.repo,
      env: world.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    let stderr = "";
    try {
      const line = await waitFor(() => {
        if (proc.exitCode !== null) throw new Error(`review exited ${proc.exitCode}`);
        return existsSync(world.files.ready) ? readFileSync(world.files.ready, "utf8").split("\n")[0] : null;
      });
      const base = `http://localhost:${(JSON.parse(line) as { port: number }).port}`;

      const diff = await fetch(`${base}/api/diff`);
      expect(diff.status).toBe(200);
      expect(((await diff.json()) as { rawPatch: string }).rawPatch).toContain("+export const a = 2;");

      // Runs `cursor-agent models`, `opencode models`, `pi --list-models`, `copilot help config`.
      const capabilities = await fetch(`${base}/api/agents/capabilities`);
      expect(capabilities.status).toBe(200);
      await capabilities.json();

      const exit = await fetch(`${base}/api/exit`, { method: "POST" });
      expect(exit.status).toBe(200);
    } catch (error) {
      proc.kill(); // inbox-guard: own child (the review CLI this test started)
      throw error;
    } finally {
      await proc.exited;
      stderr = await new Response(proc.stderr).text();
    }

    const children = readLog(world.log);
    const names = new Set(children.map((child) => child.argv.split(" ")[0]));
    // The review ran git, and the capabilities request reached every marker engine.
    expect(children.filter((child) => child.argv.startsWith("git ")).length, stderr).toBeGreaterThan(5);
    // Cursor's CLI is `cursor-agent` (found first) or its own `agent`.
    expect(names.has("cursor-agent") || names.has("agent"), "Cursor's CLI was not run").toBe(true);
    for (const name of ["opencode", "pi", "copilot"]) expect(names.has(name), `${name} was not run`).toBe(true);
    expectNoLeaks(children);
  }, 60_000);

  test("plannotator review <PR URL>: gh sees none of them", async () => {
    const world = makeWorld();
    // The PR provider asks gh first (`gh auth status`, then the PR). The stub
    // exits 0 with no output, so the CLI cannot read the PR and stops; the gh
    // calls it made are what this checks.
    const proc = Bun.spawn([process.execPath, "run", entry, "review", "https://github.com/acme/widgets/pull/1"], {
      cwd: world.repo,
      env: world.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), 30_000); // inbox-guard: own child (the review CLI this test started)
    await proc.exited;
    clearTimeout(timer);
    const stderr = await new Response(proc.stderr).text();

    const children = readLog(world.log);
    expect(children.some((child) => child.argv.startsWith("gh ")), stderr).toBe(true);
    expectNoLeaks(children);
  }, 60_000);
});
