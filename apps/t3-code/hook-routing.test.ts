import { describe, expect, test } from "bun:test";
import { claudeToolItemId, findHookThread } from "./hook-routing";
import { prepareT3Hook } from "./hook";
import type { T3Rpc } from "./t3-client";

const tool = "toolu_CurrentCall";
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
    expect(await prepareT3Hook(event, ["plannotator"], "/a-data-directory-that-does-not-exist")).toEqual({});
    expect(await prepareT3Hook({ ...event, tool_input: { command: "plannotator annotate notes.md --require-approval" } }, ["plannotator"], "/missing")).toEqual({});
    expect(await prepareT3Hook({ ...event, agent_id: "subagent" }, ["plannotator"], "/missing")).toEqual({});
  });
});
