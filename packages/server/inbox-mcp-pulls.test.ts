/**
 * The `thread_pulls` tool and read_thread's lines (approval "inbox-pr-binding",
 * 2026-11-08), run through the tool's own handler on a real store. The
 * failures these guard: an agent outside the thread that changes its PRs (or
 * one with no session); a bad ref that still writes the good ones; a call
 * whose answer does not say that nothing reached the person; read_thread
 * that hides who removed a PR (so an agent adds back what the person took
 * off); and a list call that changes something.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { parseInboxThreadPullRefs, type InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_NOT_IN_THREAD_TEXT, registerInboxThreadPullsTool, threadPullsText, type InboxPullsMcpContext } from "./inbox-mcp-pulls";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: InboxAuthor = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" };
const FILLED = { agent_session: "ses_a", agent_host: "claude-code", agent_name: "Claude Code" };
const STRANGER = { agent_session: "ses_z", agent_host: "pi", agent_name: "Pi" };

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };

function world(projectHost?: InboxPullsMcpContext["projectHost"]) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-pulls-"));
  roots.push(dir);
  let now = Date.parse("2026-11-08T10:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date(now) });
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const thread = store.sendMessage({ project_id: project.id, author: AGENT, body: "Opened the retry PR.", subject: "Invoice retries" }).message.id;
  const refreshed: string[][] = [];
  const context: InboxPullsMcpContext = {
    store,
    now: () => now,
    projectHost,
    pulls: {
      live: (key) => (key.endsWith("#1") ? { checks: "failing", review: null } : undefined),
      refresh: async (pulls) => {
        refreshed.push(pulls.map((p) => p.pull));
        for (const p of pulls) store.setThreadPullState(p.thread_id, p.pull, { state: "open", title: null, base: null, head: null });
      },
    },
  };
  let handler: ((input: Record<string, unknown>) => Promise<Result>) | null = null;
  const fake = { registerTool: (_name: string, _config: unknown, run: typeof handler) => (handler = run) } as unknown as McpServer;
  registerInboxThreadPullsTool(fake, context);
  const call = (input: Record<string, unknown>) => handler!(input);
  return { store, project, thread, context, call, refreshed, advance: (ms: number) => (now += ms) };
}

const textOf = (result: Result) => result.content.map((c) => c.text).join("\n");

describe("thread_pulls", () => {
  test("an agent in the thread adds PRs: the answer says what changed and that nothing was sent, with each PR's state", async () => {
    const w = world();
    const result = await w.call({ thread_id: w.thread, add: ["o/r#1", "https://gitlab.com/acme/api/-/merge_requests/7"], ...FILLED });
    expect(result.isError).toBeUndefined();
    const text = textOf(result);
    expect(text.split("\n")[0]).toBe(`Thread ${w.thread}: Added o/r#1, acme/api!7. Nothing was sent to the person.`);
    expect(text).toContain("- o/r#1 open · checks failing · added by you");
    expect(w.refreshed).toEqual([["github.com/o/r#1", "gitlab.com/acme/api#7:pull"]]);
  });

  test("a short group/project!n is on the thread's project's own GitLab host, and is shown back as its URL", async () => {
    const asked: string[] = [];
    const w = world(async (projectId) => (asked.push(projectId), "gitlab.acme.dev"));
    const result = await w.call({ thread_id: w.thread, add: ["acme/api!7"], ...FILLED });
    expect(asked).toEqual([w.project.id]);
    expect(textOf(result).split("\n")[0]).toBe(`Thread ${w.thread}: Added https://gitlab.acme.dev/acme/api/-/merge_requests/7. Nothing was sent to the person.`);
    expect(w.store.threadPulls(w.thread).map((p) => p.url)).toEqual(["https://gitlab.acme.dev/acme/api/-/merge_requests/7"]);
    await w.call({ thread_id: w.thread, remove: ["acme/api!7"], ...FILLED });
    expect(w.store.threadPulls(w.thread)).toEqual([]);
  });

  test("an agent that is not in the thread is refused, and so is a call with no session: nothing is written", async () => {
    const w = world();
    for (const who of [STRANGER, {}]) {
      const result = await w.call({ thread_id: w.thread, add: ["o/r#1"], ...who });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(`not_in_thread: ${INBOX_NOT_IN_THREAD_TEXT}`);
    }
    expect(w.store.threadPulls(w.thread)).toEqual([]);
  });

  test("another agent that wrote in the thread may change its PRs", async () => {
    const w = world();
    w.store.sendMessage({ project_id: w.store.message(w.thread)!.project_id, author: STRANGER_AUTHOR, body: "Taking a look.", reply_to: w.thread });
    const result = await w.call({ thread_id: w.thread, add: ["o/r#2"], ...STRANGER });
    expect(result.isError).toBeUndefined();
  });

  test("one bad ref refuses the call with how to write it; the good ref is not written", async () => {
    const w = world();
    const result = await w.call({ thread_id: w.thread, add: ["o/r#1", "#123"], ...FILLED });
    expect(textOf(result)).toBe("validation_error: '#123' is not a full PR ref. Write owner/repo#123, group/project!45 or the PR's URL; nothing was changed.");
    expect(w.store.threadPulls(w.thread)).toEqual([]);
  });

  test("neither add nor remove lists them and changes nothing, open to an agent outside the thread", async () => {
    const w = world();
    await w.call({ thread_id: w.thread, add: ["o/r#1"], ...FILLED });
    const events = w.store.threadPullEvents(w.thread).length;
    const result = await w.call({ thread_id: w.thread, ...STRANGER });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain("PRs (1):");
    expect(textOf(result)).not.toContain("Nothing was sent");
    expect(w.store.threadPullEvents(w.thread).length).toBe(events);
  });

  test("remove [\"all\"] takes off every PR", async () => {
    const w = world();
    await w.call({ thread_id: w.thread, add: ["o/r#1", "o/r#2"], ...FILLED });
    const result = await w.call({ thread_id: w.thread, remove: ["all"], ...FILLED });
    expect(textOf(result).split("\n")[0]).toBe(`Thread ${w.thread}: Removed o/r#1, o/r#2. Nothing was sent to the person.`);
    expect(w.store.threadPulls(w.thread)).toEqual([]);
  });
});

describe("read_thread's PR lines", () => {
  test("who added each PR, and what the person removed lately, so the agent does not add it back", async () => {
    const w = world();
    await w.call({ thread_id: w.thread, add: ["o/r#1", "o/r#2"], ...FILLED });
    const parsed = parseInboxThreadPullRefs(["o/r#2", "o/r#3"], "x");
    if ("error" in parsed) throw new Error(parsed.error);
    w.store.changeThreadPulls({ thread_id: w.thread, remove: [parsed.refs[0]!], add: [parsed.refs[1]!], by: { kind: "person" } });
    const lines = threadPullsText(w.context, w.thread, "ses_a");
    expect(lines[0]).toBe("PRs (2):");
    expect(lines[1]).toStartWith("- o/r#1 open · checks failing · added by you");
    expect(lines[2]).toStartWith("- o/r#3 state unknown · added by the person ");
    expect(lines[3]).toStartWith("Removed by the person ");
    expect(lines[3]).toEndWith(": o/r#2");
    // Another session reads the agent by name and session.
    expect(threadPullsText(w.context, w.thread, "ses_other")[1]).toContain("added by Claude Code (ses_a)");
    // Past 7 days the removal is no longer shown.
    w.advance(8 * 24 * 60 * 60_000);
    expect(threadPullsText(w.context, w.thread, "ses_a").some((line) => line.startsWith("Removed"))).toBe(false);
  });

  test("a thread that never had a PR adds no lines", () => {
    const w = world();
    expect(threadPullsText(w.context, w.thread, "ses_a")).toEqual([]);
  });
});

const STRANGER_AUTHOR: InboxAuthor = { kind: "agent", host: "pi", session: "ses_z", name: "Pi" };
