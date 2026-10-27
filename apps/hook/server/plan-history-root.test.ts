/**
 * #2197: a plan's version history is keyed `history/{project}/{slug}`. The
 * Claude Code hosts also hand the CLI the session's root (the mod's
 * `$.session.root()` as `projectRoot` on `claude-mod-plan`'s stdin, the
 * classic hook's CLAUDE_PROJECT_DIR), which a shell cd does not move. A chain
 * the root's project holds is continued when the cwd's project has none, so a
 * resubmit made after the session changed directory into a nested clone still
 * diffs against the earlier version. A new chain still starts under the cwd's
 * project, exactly as before.
 *
 * Runs the real CLI as a process against a scratch data dir and a workspace
 * folder holding a separate git clone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

async function waitFor<T>(read: () => T | null | undefined, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(25);
  }
}

function gitInit(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  if (init.exitCode !== 0) throw new Error(`git init failed in ${dir}`);
}

/** A workspace repository holding a separate clone, and a scratch data dir. */
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-plan-history-root-")));
  roots.push(root);
  const workspace = join(root, "workspace");
  const serviceA = join(workspace, "service-a");
  gitInit(workspace);
  const serviceB = join(workspace, "service-b");
  gitInit(serviceA);
  gitInit(serviceB);
  return { root, workspace, serviceA, serviceB, data: join(root, "data") };
}

/** The test env: no agent markers, no inherited CLAUDE_PROJECT_DIR, never a browser. */
function baseEnv(data: string, ready: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of ["CLAUDE_PROJECT_DIR", "PLANNOTATOR_CWD", "CODEX_THREAD_ID", "COPILOT_CLI", "OPENCODE", "GEMINI_CLI", "OMPCODE", "PLANNOTATOR_HOST_RESULT_FILE"]) {
    delete env[key];
  }
  return {
    ...(env as Record<string, string>),
    PLANNOTATOR_DATA_DIR: data,
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_READY_FILE: ready,
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_ORIGIN: "claude-code",
    ...extra,
  };
}

interface PlanView {
  plan: string;
  previousPlan: string | null;
  versionInfo: { version: number; totalVersions: number; project: string };
}

let launchSeq = 0;

/**
 * One plan submit: start the CLI in `cwd`, read `/api/plan`, deny, wait for exit.
 * `kind` "mod" runs `claude-mod-plan` (the stdin may carry `projectRoot`);
 * "classic" runs the PermissionRequest hook with `env`.
 */
async function submit(
  w: ReturnType<typeof world>,
  opts: { kind: "mod" | "classic"; cwd: string; plan: string; projectRoot?: string; env?: Record<string, string> },
): Promise<PlanView> {
  const launch = join(w.data, "claude-code-mod", "session-1", `launch-${++launchSeq}`);
  mkdirSync(launch, { recursive: true });
  const ready = join(launch, "ready");
  const stdin =
    opts.kind === "mod"
      ? { plan: opts.plan, ...(opts.projectRoot ? { projectRoot: opts.projectRoot } : {}) }
      : {
          hook_event_name: "PermissionRequest",
          tool_name: "ExitPlanMode",
          session_id: "session-1",
          permission_mode: "plan",
          tool_input: { plan: opts.plan },
        };
  const proc = Bun.spawn([process.execPath, "run", entry, ...(opts.kind === "mod" ? ["claude-mod-plan"] : [])], {
    cwd: opts.cwd,
    env: baseEnv(w.data, ready, {
      ...(opts.kind === "mod" ? { PLANNOTATOR_HOST_RESULT_FILE: join(launch, "result.json") } : {}),
      ...opts.env,
    }),
    stdin: new TextEncoder().encode(JSON.stringify(stdin)),
    stdout: "pipe",
    stderr: "pipe",
  });
  const line = await waitFor(() => (existsSync(ready) ? readFileSync(ready, "utf8").split("\n")[0] : null));
  const base = `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
  const view = (await (await fetch(`${base}/api/plan`)).json()) as PlanView;
  const deny = await fetch(`${base}/api/deny`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ feedback: "Not yet." }),
  });
  expect(deny.status).toBe(200);
  expect(await proc.exited).toBe(0);
  return view;
}

const V1 = "# Ship it\n\n1. First.\n";
const V2 = "# Ship it\n\n1. First.\n2. Second.\n";

describe("plan history follows the session root, not the shell's cwd (#2197)", () => {
  test("claude-mod-plan: a resubmit after cd into a nested clone is version 2 of the same chain", async () => {
    const w = world();
    const first = await submit(w, { kind: "mod", cwd: w.workspace, plan: V1, projectRoot: w.workspace });
    expect(first.versionInfo).toMatchObject({ version: 1, project: "workspace" });

    const second = await submit(w, { kind: "mod", cwd: w.serviceA, plan: V2, projectRoot: w.workspace });
    expect(second.versionInfo).toMatchObject({ version: 2, totalVersions: 2, project: "workspace" });
    expect(second.previousPlan).toBe(V1);
    expect(existsSync(join(w.data, "history", "service-a"))).toBe(false);
  }, 60_000);

  test("classic hook: CLAUDE_PROJECT_DIR names the project, so the cd keeps the chain", async () => {
    const w = world();
    const env = { CLAUDE_PROJECT_DIR: w.workspace };
    const first = await submit(w, { kind: "classic", cwd: w.workspace, plan: V1, env });
    expect(first.versionInfo).toMatchObject({ version: 1, project: "workspace" });

    const second = await submit(w, { kind: "classic", cwd: w.serviceA, plan: V2, env });
    expect(second.versionInfo).toMatchObject({ version: 2, totalVersions: 2, project: "workspace" });
    expect(second.previousPlan).toBe(V1);
  }, 60_000);

  test("a brand-new plan from a nested clone starts under the clone's project, as before", async () => {
    const w = world();
    const view = await submit(w, { kind: "mod", cwd: w.serviceA, plan: V1, projectRoot: w.workspace });
    expect(view.versionInfo).toMatchObject({ version: 1, project: "service-a" });
    expect(view.previousPlan).toBeNull();
    expect(existsSync(join(w.data, "history", "workspace"))).toBe(false);

    const classic = await submit(w, { kind: "classic", cwd: w.serviceB, plan: "# Other plan\n\n1. One.\n", env: { CLAUDE_PROJECT_DIR: w.workspace } });
    expect(classic.versionInfo).toMatchObject({ version: 1, project: "service-b" });
    expect(existsSync(join(w.data, "history", "workspace"))).toBe(false);
  }, 60_000);

  test("same-heading plans from two clones under one root stay separate chains", async () => {
    const w = world();
    const a = await submit(w, { kind: "mod", cwd: w.serviceA, plan: V1, projectRoot: w.workspace });
    const b = await submit(w, { kind: "mod", cwd: w.serviceB, plan: V2, projectRoot: w.workspace });
    expect(a.versionInfo).toMatchObject({ version: 1, project: "service-a" });
    expect(b.versionInfo).toMatchObject({ version: 1, totalVersions: 1, project: "service-b" });
    expect(b.previousPlan).toBeNull();
  }, 60_000);

  test("no root given: history lands under the cwd's repository, exactly as before", async () => {
    const w = world();
    const mod = await submit(w, { kind: "mod", cwd: w.serviceA, plan: V1 });
    expect(mod.versionInfo).toMatchObject({ version: 1, project: "service-a" });
    const classic = await submit(w, { kind: "classic", cwd: w.serviceA, plan: V2 });
    expect(classic.versionInfo).toMatchObject({ version: 2, project: "service-a" });

    const projects = (await Array.fromAsync(new Bun.Glob("*/*/*.md").scan({ cwd: join(w.data, "history") }))).sort();
    expect(projects.map((path) => path.replace(/\/[^/]+-\d{4}-\d{2}-\d{2}\//, "/<slug>/"))).toEqual([
      "service-a/<slug>/001.md",
      "service-a/<slug>/002.md",
    ]);
  }, 60_000);

  test("a root that is not an existing folder is ignored", async () => {
    const w = world();
    const view = await submit(w, { kind: "mod", cwd: w.serviceA, plan: V1, projectRoot: join(w.root, "missing") });
    expect(view.versionInfo).toMatchObject({ version: 1, project: "service-a" });
  }, 60_000);
});
