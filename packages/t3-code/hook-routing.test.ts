import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { T3Credentials } from "./auth";
import { claudeToolItemId, findHookThread } from "./hook-routing";
import { prepareT3Hook, runT3Hook } from "./hook";
import type { T3Rpc } from "./t3-client";

const tool = "toolu_CurrentCall";
const sdk = { CLAUDE_CODE_ENTRYPOINT: "sdk-ts" };
const itemId = claudeToolItemId(tool);

function scripted(owners: Record<string, { visibility?: string; source?: string; status?: string }>): T3Rpc {
  return { async call(name, args) {
    if (name === "t3_project_list") return args.cursor === undefined
      ? { projects: [{ id: "other-project", workspaceRoot: "/same-folder" }], nextCursor: 1 }
      : { projects: [{ id: "project", workspaceRoot: "/same-folder" }], nextCursor: null };
    if (name === "t3_thread_list") {
      if (args.projectId === "other-project") return { threads: [], nextCursor: null };
      return args.cursor === undefined ? { threads: [{ threadId: "thread-a" }], nextCursor: 1 } : { threads: [{ threadId: "thread-b" }], nextCursor: null };
    }
    const thread = String(args.threadId);
    const owner = owners[thread];
    return { thread: { threadId: thread, projectId: "project", worktreePath: null, archived: false },
      items: owner ? [{ itemId, sourceThreadId: owner.source ?? thread, visibility: owner.visibility ?? "local", status: owner.status ?? "running" }] : [] };
  } };
}

describe("T3 routing from Claude's actual tool-call identity", () => {
  test("finds the exact owner across project and thread pages, despite identical folders", async () => {
    expect(await findHookThread(scripted({ "thread-b": {} }), tool)).toEqual({ thread: "thread-b", cwd: "/same-folder" });
  });
  test("does not bind inherited calls, another source, or settled historical calls", async () => {
    for (const owner of [{ visibility: "inherited" }, { source: "another-thread" }, { status: "completed" }]) {
      expect(await findHookThread(scripted({ "thread-a": owner }), tool)).toBeUndefined();
    }
  });
  test("refuses ambiguous owners", async () => {
    await expect(findHookThread(scripted({ "thread-a": {}, "thread-b": {} }), tool)).rejects.toThrow("More than one");
  });
  test("preserves ordinary commands without a configured connection or for scripted gates", async () => {
    const event = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: tool, session_id: "session", cwd: "/same-folder", tool_input: { command: "plannotator review" } };
    expect(await prepareT3Hook(event, ["plannotator"], "/a-data-directory-that-does-not-exist", sdk)).toEqual({});
    expect(await prepareT3Hook({ ...event, tool_input: { command: "plannotator annotate notes.md --require-approval" } }, ["plannotator"], "/missing", sdk)).toEqual({});
    expect(await prepareT3Hook({ ...event, agent_id: "subagent" }, ["plannotator"], "/missing", sdk)).toEqual({});
  });
  test("Bedrock and Vertex tool-call ids are routed like first-party ones", async () => {
    for (const id of ["toolu_bdrk_01AbC-dEf_9", "toolu_vrtx_01XyZ"]) {
      expect(claudeToolItemId(id)).toBe(`turn-item:provider:claudeAgent:native-item:${id}`);
    }
    for (const id of ["toolu_", "tool_abc", "toolu_a b", "toolu_a/b", "toolu_a:b"]) expect(() => claudeToolItemId(id)).toThrow();
  });
  test("an endpoint that never answers the MCP handshake fails within the hook's own deadline", async () => {
    // What regresses: connect() sat outside the abort, so a hanging T3 ran into Claude's 10 s hook timeout.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Promise<Response>(() => {}) });
    const root = mkdtempSync(join(tmpdir(), "plannotator-t3-hang-"));
    try {
      const endpoint = new URL(`http://127.0.0.1:${server.port}/mcp`);
      new T3Credentials(root, endpoint).save({ endpoint: endpoint.href, epoch: "grant", tokens: { access_token: "token", token_type: "Bearer" } });
      const event = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: tool, session_id: "session", cwd: root, tool_input: { command: "plannotator review" } };
      const started = Date.now();
      await expect(prepareT3Hook(event, ["plannotator"], root, sdk, 300)).rejects.toThrow("timed out");
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("a hook launch file is used once, also when opening fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "plannotator-t3-launch-"));
    try {
      const hooks = join(root, "t3-code", "hooks");
      mkdirSync(hooks, { recursive: true });
      const path = join(hooks, "00000000-0000-4000-8000-000000000000.json");
      writeFileSync(path, JSON.stringify({ v: 1, endpoint: "http://127.0.0.1:3773/mcp", thread: "thread-a", input: { action: "not-an-action" } }));
      await expect(runT3Hook(["open", path, "--data-dir", root], ["plannotator"])).rejects.toThrow();
      expect(existsSync(path)).toBe(false);
      // A path outside the launch folder is refused and never removed.
      const outside = join(root, "00000000-0000-4000-8000-000000000001.json");
      writeFileSync(outside, "{}");
      await expect(runT3Hook(["open", outside, "--data-dir", root], ["plannotator"])).rejects.toThrow("Invalid T3 hook launch path");
      expect(existsSync(outside)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  test("only an Agent SDK session reaches T3; every other Claude session is answered without a request", async () => {
    // What regresses: the hook contacting T3 (or reading the data dir) on
    // every Bash call of an interactive Claude session that loads the settings file.
    let requests = 0;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return new Response("Unauthorized", { status: 401 }); } });
    const root = mkdtempSync(join(tmpdir(), "plannotator-t3-gate-"));
    try {
      const endpoint = new URL(`http://127.0.0.1:${server.port}/mcp`);
      new T3Credentials(root, endpoint).save({ endpoint: endpoint.href, epoch: "grant", tokens: { access_token: "token", token_type: "Bearer" } });
      const event = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: tool, session_id: "session", cwd: root, tool_input: { command: "plannotator review" } };
      for (const entrypoint of ["cli", "claude-desktop", "", undefined]) {
        expect(await prepareT3Hook(event, ["plannotator"], root, { CLAUDE_CODE_ENTRYPOINT: entrypoint })).toEqual({});
      }
      expect(requests).toBe(0);
      await expect(prepareT3Hook(event, ["plannotator"], root, sdk)).rejects.toThrow();
      expect(requests).toBeGreaterThan(0);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
