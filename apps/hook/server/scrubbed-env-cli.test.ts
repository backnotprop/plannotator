import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];

const SCRUBBED = {
  PLANNOTATOR_SESSION_BRIDGE_TOKEN: "scrub-test-token-000000000000000000000000",
  PLANNOTATOR_SESSION_BRIDGE_HOST: "claude-code",
  PLANNOTATOR_SESSION_BRIDGE_MODES: "turn",
  PLANNOTATOR_HOST_REVIEW_ID: "pn-abc123",
} as const;

const CANARY = "PLANNOTATOR_CHILD_ENV_CANARY";

const AGENT_STUBS = ["claude", "codex", "agent", "opencode", "pi", "copilot", "cursor-agent", "gh"];

beforeAll(() => {
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

interface LoggedChild {
  argv: string;
  env: Map<string, string>;
}

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

  const launch = join(dataDir, "claude-code-mod", "session-1", "launch-1");
  mkdirSync(launch, { recursive: true });
  const files = { ready: join(launch, "ready"), result: join(launch, "result.json") };

  const realGit = Bun.which("git");
  if (!realGit) throw new Error("git is required for this test");
  const logLines = `{ printf '=== %s %s\\n' "$(basename "$0")" "$*"; env | grep -E '^(PLANNOTATOR_SESSION_BRIDGE_|PLANNOTATOR_HOST_|${CANARY}=)' || true; } > "$(mktemp '${log}/child.XXXXXX')"`;
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${logLines}\nexec '${realGit}' "$@"\n`);
  for (const name of AGENT_STUBS) {
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
    expect(children.filter((child) => child.argv.startsWith("git ")).length, stderr).toBeGreaterThan(5);
    expect(names.has("cursor-agent") || names.has("agent"), "Cursor's CLI was not run").toBe(true);
    for (const name of ["opencode", "pi", "copilot"]) expect(names.has(name), `${name} was not run`).toBe(true);
    expectNoLeaks(children);
  }, 60_000);

  test("plannotator review <PR URL>: gh sees none of them", async () => {
    const world = makeWorld();
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
