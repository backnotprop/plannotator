import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const CLAUDE_EXIT_PLAN_MODE = {
  session_id: "0b7c1f7e-1111-4222-8333-444455556666",
  transcript_path: "/nowhere/transcript.jsonl",
  cwd: "/work",
  permission_mode: "plan",
  hook_event_name: "PermissionRequest",
  tool_name: "ExitPlanMode",
  tool_input: { plan: "# Ship it\n\n1. Do the thing.\n" },
};

async function runHook(opts: { env?: string; config?: Record<string, unknown>; timeoutMs: number }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-plan-review-off-")));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  if (opts.config) writeFileSync(join(dataDir, "config.json"), JSON.stringify(opts.config));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: join(root, "home"),
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    NO_BROWSER,
    BROWSER: NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_PLAN_REVIEW: opts.env,
  };
  delete env.PLANNOTATOR_ASK_AI_CHILD;
  if (opts.env === undefined) delete env.PLANNOTATOR_PLAN_REVIEW;
  const proc = Bun.spawn([process.execPath, "run", entry], {
    cwd: root,
    stdin: new TextEncoder().encode(JSON.stringify(CLAUDE_EXIT_PLAN_MODE)),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const timer = setTimeout(() => proc.kill(), opts.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const sessions = join(dataDir, "sessions");
  return { stdout, stderr, code, sessions: existsSync(sessions) ? readdirSync(sessions) : [] };
}

describe("Claude Code's ExitPlanMode with plan review off", () => {
  test.each<{ name: string; env?: string; config?: Record<string, unknown> }>([
    { name: "PLANNOTATOR_PLAN_REVIEW=0", env: "0" },
    { name: "config planReview false", config: { planReview: false } },
    { name: "env off over config on", env: "off", config: { planReview: true } },
  ])("$name: exits 0 with no decision, no server", async ({ env, config }) => {
    const run = await runHook({ env, config, timeoutMs: 20_000 });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain("http://");
    expect(run.sessions).toEqual([]);
  }, 30_000);

  test("env on over config off: the review opens", async () => {
    const run = await runHook({ env: "1", config: { planReview: false }, timeoutMs: 6_000 });
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("http://");
  }, 30_000);
});
