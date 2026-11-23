/**
 * resolve_message's `moved_to`, the agent's side, through the MCP handlers (no server): an orchestrator session
 * closes out a sub-agent's thread pointing at its brief, the refusal names the field and archives nothing, the
 * archived thread's read says where its questions went, and the agent tool built from the default tool list carries
 * the field while the connection fills the caller's session.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_DEFAULT_TOOLS } from "../../apps/hook/hooks/mod/inbox-default-tools";
import { INBOX_MOVED_TO_FIELD_DESCRIPTION, INBOX_MOVED_TO_RULE, inboxAgentTool, inboxToolCall } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createInboxMcpServer, type InboxMcpContext } from "./inbox-mcp";
import { inboxPushSummary } from "./inbox-relay-push";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Result = { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
type Tool = { handler: (input: Record<string, unknown>, ctx: unknown) => Promise<Result> };

function world(far: Record<string, string> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-mcp-moved-to-")));
  roots.push(root);
  const store = InboxStore.open(join(root, "data"));
  const project = store.ensureProject({ name: "billing", root: join(root, "billing") });
  const context = { store, baseUrl: () => "http://localhost:1/", resolveProject: async () => project, farThreadMachine: (id: string) => far[id] ?? null } as unknown as InboxMcpContext;
  const tools = (createInboxMcpServer(context) as unknown as { _registeredTools: Record<string, Tool> })._registeredTools;
  const call = (name: string, session: string, input: Record<string, unknown>) =>
    tools[name]!.handler({ project_path: project.root, agent_session: session, agent_host: "claude-code", ...input }, {});
  const text = (result: Result) => result.content.map((c) => c.text).join("\n");
  return { store, project, call, text };
}

const ASK = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

test("the orchestrator archives a sub-agent's thread pointing at its brief; a read of the old thread says where the questions went", async () => {
  const w = world();
  const old = (await w.call("send_message", "ses_sub", { subject: "Retry policy", body: ASK("Retry failed charges?") })).structuredContent!;
  const brief = (await w.call("send_message", "ses_orch", { subject: "Morning brief", body: ASK("Retry failed charges?") })).structuredContent!;
  const resolved = await w.call("resolve_message", "ses_orch", { message_id: old.thread_id, moved_to: brief.thread_id });
  expect(resolved.isError).toBeUndefined();
  expect(w.text(resolved)).toBe(`Thread ${old.thread_id} is resolved; its questions point to thread ${brief.thread_id} ("Morning brief").`);
  const read = w.text(await w.call("read_thread", "ses_sub", { thread_id: old.thread_id }));
  expect(read).toContain(`Its questions moved to thread ${brief.thread_id} (Morning brief)`);
  // No message was written in the old thread.
  expect(w.store.thread(String(old.thread_id))!.messages.length).toBe(1);
});

test("read_thread of the old thread by the orchestrator or a third session (window and full) leaves the sub-agent's note waiting for its wake", async () => {
  const w = world();
  const old = (await w.call("send_message", "ses_sub", { subject: "Retry policy", body: ASK("Retry failed charges?") })).structuredContent!;
  const brief = (await w.call("send_message", "ses_orch", { subject: "Morning brief", body: ASK("Retry failed charges?") })).structuredContent!;
  await w.call("resolve_message", "ses_orch", { message_id: old.thread_id, moved_to: brief.thread_id });
  for (const session of ["ses_orch", "ses_third"]) {
    await w.call("read_thread", session, { thread_id: old.thread_id });
    await w.call("read_thread", session, { thread_id: old.thread_id, format: "full" });
  }
  const waiting = w.store.pendingReplies("ses_sub");
  expect(waiting.map((m) => m.moved_note?.thread_id)).toEqual([String(brief.thread_id)]);
  expect(w.store.pendingReplies("ses_orch")).toEqual([]);
  expect(w.store.pendingReplies("ses_third")).toEqual([]);
});

test("the close-out pushes nothing to the person's phone: its one new message is the note, which pushes nothing", async () => {
  const w = world();
  const old = (await w.call("send_message", "ses_sub", { subject: "Retry policy", body: ASK("Retry failed charges?") })).structuredContent!;
  const brief = (await w.call("send_message", "ses_orch", { subject: "Morning brief", body: ASK("Retry failed charges?") })).structuredContent!;
  const written: string[] = [];
  const stop = w.store.subscribe((line) => void (line.kind === "message" && written.push(line.record.id)));
  await w.call("resolve_message", "ses_orch", { message_id: old.thread_id, moved_to: brief.thread_id });
  stop();
  const [note] = w.store.pendingReplies("ses_sub");
  expect(note?.moved_note).toBeTruthy();
  // The only new message the close-out wrote is the note (the archive is one more line on the old root), and it pushes nothing.
  expect([...new Set(written)].filter((id) => id !== old.thread_id)).toEqual([note!.id]);
  expect(inboxPushSummary(w.store, note!.id, () => w.store.listRows())).toBeNull();
});

test("a brief on a linked computer is refused as a thread there, as send_message says it, and nothing is archived", async () => {
  const w = world({ msg_01FARBRIEF: "Mini" });
  const old = (await w.call("send_message", "ses_sub", { subject: "Retry policy", body: ASK("Retry failed charges?") })).structuredContent!;
  const refused = await w.call("resolve_message", "ses_orch", { message_id: old.thread_id, moved_to: "msg_01FARBRIEF" });
  expect(refused.isError).toBe(true);
  expect(w.text(refused)).toStartWith("thread_on_other_machine: moved_to: msg_01FARBRIEF is a thread on ");
  expect(w.text(refused)).toEndWith(" Nothing was archived.");
  expect(w.store.message(String(old.thread_id))!.resolved_at).toBeNull();
});

test("a thread the caller never wrote in is refused, naming the field, and nothing is archived", async () => {
  const w = world();
  const old = (await w.call("send_message", "ses_sub", { subject: "Retry policy", body: ASK("Retry failed charges?") })).structuredContent!;
  const brief = (await w.call("send_message", "ses_orch", { subject: "Morning brief", body: "Notes." })).structuredContent!;
  const refused = await w.call("resolve_message", "ses_other", { message_id: old.thread_id, moved_to: brief.thread_id });
  expect(refused.isError).toBe(true);
  expect(w.text(refused)).toStartWith("validation_error: moved_to: ");
  expect(w.store.message(String(old.thread_id))!.resolved_at).toBeNull();
});

test("the agent tool carries moved_to and the supersedes rule; the session is filled, never asked of the agent", () => {
  const spec = inboxAgentTool(INBOX_DEFAULT_TOOLS)!;
  const properties = spec.inputSchema.properties as Record<string, { description: string }>;
  expect(properties.moved_to!.description).toBe(`(resolve_message) ${INBOX_MOVED_TO_FIELD_DESCRIPTION}`);
  expect(properties.supersedes!.description).toEndWith(INBOX_MOVED_TO_RULE);
  expect("agent_session" in properties).toBe(false);
  expect(spec.description.length).toBeLessThan(2_048);
  const call = inboxToolCall({ action: "resolve_message", message_id: "msg_1", moved_to: "msg_2" }, INBOX_DEFAULT_TOOLS, { project_path: "/p", agent_session: "ses_orch", agent_host: "claude-code", agent_name: "Claude Code" });
  expect(call).toMatchObject({ name: "resolve_message", arguments: { message_id: "msg_1", moved_to: "msg_2", agent_session: "ses_orch" } });
});
