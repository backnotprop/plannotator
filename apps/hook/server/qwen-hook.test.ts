/**
 * Qwen Code end to end: the real CLI as a process, the way Qwen runs it.
 *
 * - Plan review: Qwen's PermissionRequest hook on exit_plan_mode. The CLI
 *   must know Qwen from the payload alone (no PLANNOTATOR_ORIGIN, no Qwen
 *   variables), show the Qwen badge, and answer in Qwen's decision shape: a
 *   deny carries the feedback to the model; an allow carries nothing
 *   Claude-only (Qwen still asks the person in the terminal).
 * - Claude Code's ExitPlanMode payload keeps its own answer.
 * - `plannotator last` from Qwen's shell (QWEN_CODE_SESSION_ID +
 *   QWEN_CODE_PROJECT_DIR) reads that session's log.
 *
 * Scratch data dir and temp Qwen folders; never a browser, never the Inbox.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const roots: string[] = [];
const procs: { kill(): void }[] = [];
let stubs: string[] = [];

beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => {
  // A failed assertion leaves its CLI waiting for a decision: stop it.
  for (const proc of procs) proc.kill();
  removeStubbedHtml(stubs);
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const AGENT_MARKERS = [
  "PLANNOTATOR_ORIGIN", "CLAUDE_PROJECT_DIR", "PLANNOTATOR_CWD", "CODEX_THREAD_ID", "COPILOT_CLI", "OPENCODE",
  "GEMINI_CLI", "OMPCODE", "QWEN_CODE", "QWEN_CODE_SESSION_ID", "QWEN_CODE_PROJECT_DIR", "QWEN_PROJECT_DIR",
  "QWEN_HOME", "QWEN_RUNTIME_DIR", "PLANNOTATOR_HOST_RESULT_FILE",
];

function scratch(): { root: string; data: string; ready: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-qwen-hook-")));
  roots.push(root);
  return { root, data: join(root, "data"), ready: join(root, "ready") };
}

function env(s: { root: string; data: string; ready: string }, extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string | undefined> = { ...process.env };
  for (const key of AGENT_MARKERS) delete base[key];
  return {
    ...(base as Record<string, string>),
    HOME: s.root,
    QWEN_HOME: join(s.root, ".qwen"),
    PLANNOTATOR_DATA_DIR: s.data,
    PLANNOTATOR_PORT: "0",
    PLANNOTATOR_REMOTE: "0",
    PLANNOTATOR_SKIP_BROWSER_OPEN: "1",
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_READY_FILE: s.ready,
    PLANNOTATOR_AI: "disabled",
    PLANNOTATOR_SHARE: "disabled",
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    ...extra,
  };
}

async function waitForBase(ready: string, ms = 20_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (existsSync(ready)) {
      const line = readFileSync(ready, "utf8").split("\n")[0];
      if (line) return `http://localhost:${(JSON.parse(line) as { port: number }).port}`;
    }
    if (Date.now() > deadline) throw new Error("server never became ready");
    await Bun.sleep(25);
  }
}

function startHook(s: ReturnType<typeof scratch>, payload: Record<string, unknown>, extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn([process.execPath, "run", entry], {
    cwd: s.root,
    env: env(s, extraEnv),
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });
  procs.push(proc);
  return proc;
}

const PLAN = "# Add a cache\n\n1. Read through.\n2. Write back.\n";

function qwenPayload(): Record<string, unknown> {
  return {
    hook_event_name: "PermissionRequest",
    tool_name: "exit_plan_mode",
    tool_input: { plan: PLAN },
    session_id: "qwen-session-1",
    transcript_path: "/nonexistent/chats/qwen-session-1.jsonl",
    cwd: "/nonexistent",
    permission_mode: "plan",
  };
}

async function post(base: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
}

describe("Qwen Code plan review hook", () => {
  test("known from the payload alone: Qwen badge, and a deny hands the feedback to the model", async () => {
    const s = scratch();
    const proc = startHook(s, qwenPayload());
    const base = await waitForBase(s.ready);
    const view = (await (await fetch(`${base}/api/plan`)).json()) as { plan: string; origin: string; approvalNotesSupported?: boolean };
    expect(view.origin).toBe("qwen-code");
    expect(view.plan).toBe(PLAN);
    // Qwen ignores a hook's allow on exit_plan_mode, so notes could not travel.
    expect(view.approvalNotesSupported ?? false).toBe(false);

    await post(base, "/api/deny", { feedback: "Use an LRU, not a map." });
    expect(await proc.exited).toBe(0);
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(out.hookSpecificOutput.hookEventName).toBe("PermissionRequest");
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(out.hookSpecificOutput.decision.message).toContain("Use an LRU, not a map.");
    expect(out.hookSpecificOutput.decision.message).toContain("exit_plan_mode");
    expect(out.hookSpecificOutput.decision.message).not.toContain("ExitPlanMode");
  }, 30_000);

  test("an approval is a bare allow: no Claude-only permission mode, no rewritten input", async () => {
    const s = scratch();
    const proc = startHook(s, qwenPayload());
    const base = await waitForBase(s.ready);
    await post(base, "/api/approve", { feedback: "", permissionMode: "acceptEdits" });
    expect(await proc.exited).toBe(0);
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
  }, 30_000);

  test("Claude Code's ExitPlanMode payload still gets Claude's answer", async () => {
    const s = scratch();
    const proc = startHook(s, { ...qwenPayload(), tool_name: "ExitPlanMode" }, { PLANNOTATOR_ORIGIN: "claude-code" });
    const base = await waitForBase(s.ready);
    const view = (await (await fetch(`${base}/api/plan`)).json()) as { origin: string };
    expect(view.origin).toBe("claude-code");
    await post(base, "/api/approve", { feedback: "" });
    expect(await proc.exited).toBe(0);
    const out = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(out.hookSpecificOutput.decision.behavior).toBe("allow");
    expect(out.hookSpecificOutput.decision.updatedInput.plan).toBe(PLAN);
  }, 30_000);
});

describe("plannotator last under Qwen Code", () => {
  test("the session variables pick that session's log, newest reply first", async () => {
    const s = scratch();
    const projectDir = join(s.root, ".qwen", "projects", "-work-app");
    mkdirSync(join(projectDir, "chats"), { recursive: true });
    const line = (fields: Record<string, unknown>) => JSON.stringify({ sessionId: "sid-7", timestamp: "2026-10-27T10:00:00.000Z", ...fields });
    writeFileSync(join(projectDir, "chats", "sid-7.jsonl"), [
      line({ uuid: "u1", parentUuid: null, type: "user", message: { parts: [{ text: "explain" }] } }),
      line({ uuid: "a1", parentUuid: "u1", type: "assistant", message: { parts: [{ text: "Earlier reply." }] } }),
      line({ uuid: "u2", parentUuid: "a1", type: "user", message: { parts: [{ text: "more" }] } }),
      line({ uuid: "a2", parentUuid: "u2", type: "assistant", message: { parts: [{ text: "thinking", thought: true }, { text: "Latest reply." }] } }),
    ].join("\n") + "\n");
    // Another session of the same project, newer on disk: must not be picked.
    writeFileSync(join(projectDir, "chats", "other.jsonl"), line({ uuid: "x", parentUuid: null, type: "assistant", message: { parts: [{ text: "Other session." }] } }) + "\n");

    const proc = Bun.spawn([process.execPath, "run", entry, "last"], {
      cwd: s.root,
      env: env(s, { QWEN_CODE: "1", QWEN_CODE_SESSION_ID: "sid-7", QWEN_CODE_PROJECT_DIR: projectDir }),
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.push(proc);
    const base = await waitForBase(s.ready);
    const view = (await (await fetch(`${base}/api/plan`)).json()) as {
      plan: string;
      origin: string;
      mode: string;
      recentMessages?: { text: string }[];
    };
    expect(view.origin).toBe("qwen-code");
    expect(view.mode).toBe("annotate-last");
    expect(view.plan).toBe("Latest reply.");
    await post(base, "/api/exit", {});
    expect(await proc.exited).toBe(0);
  }, 30_000);
});
