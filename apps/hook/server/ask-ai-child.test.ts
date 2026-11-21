/**
 * The plan-review hook (`plannotator` with no arguments) inside an agent that
 * Plannotator's Ask AI started (`PLANNOTATOR_ASK_AI_CHILD=1`, set by
 * `askAiChildEnv`): it exits 0 at once with no answer, so no plan hook opens
 * a review nobody waits for.
 * Every run gets a temp HOME and data dir, no browser and no Inbox connect.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const PLAN = "# Ship it\n\n1. Do the thing.\n";
const roots: string[] = [];
let stubs: string[] = [];

beforeAll(() => {
  // The CLI imports the built HTML; these runs never serve it.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-ask-ai-child-")));
  roots.push(root);
  return root;
}

/** Claude Code's PermissionRequest for ExitPlanMode with a plan inline. */
function claudeExitPlanMode(): Record<string, unknown> {
  return {
    session_id: "0b7c1f7e-1111-4222-8333-444455556666",
    transcript_path: "/nowhere/transcript.jsonl",
    cwd: "/work",
    permission_mode: "plan",
    hook_event_name: "PermissionRequest",
    tool_name: "ExitPlanMode",
    tool_input: { plan: PLAN },
  };
}

async function runHook(root: string, event: Record<string, unknown>, askAiChild: string | undefined, timeoutMs: number) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: join(root, "home"),
    PLANNOTATOR_DATA_DIR: join(root, "data"),
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    NO_BROWSER,
    BROWSER: NO_BROWSER,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_ASK_AI_CHILD: askAiChild,
  };
  if (askAiChild === undefined) delete env.PLANNOTATOR_ASK_AI_CHILD;
  const started = Date.now();
  const proc = Bun.spawn([process.execPath, "run", entry], {
    cwd: root,
    stdin: new TextEncoder().encode(JSON.stringify(event)),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  const sessions = join(root, "data", "sessions");
  return { stdout, stderr, code, ms: Date.now() - started, sessions: existsSync(sessions) ? readdirSync(sessions) : [] };
}

describe("the plan-review hook in an agent Ask AI started", () => {
  // The check comes before the hook reads which agent sent the event, so this
  // one event stands for every plan hook (Codex Stop, Qwen Code, Gemini, Vibe).
  test("Claude Code's ExitPlanMode exits 0 at once: no answer, no server, no browser", async () => {
    const root = scratch();
    const run = await runHook(root, claudeExitPlanMode(), "1", 20_000);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).not.toContain("http://");
    expect(run.sessions).toEqual([]);
    expect(run.ms).toBeLessThan(15_000);
  }, 30_000);

  test("only the exact value 1 counts: without it (or with another value) the review opens as before", async () => {
    for (const value of [undefined, "true"]) {
      const root = scratch();
      // The server waits for a decision; it is killed once it is up.
      const run = await runHook(root, claudeExitPlanMode(), value, 6_000);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("http://");
    }
  }, 30_000);
});
