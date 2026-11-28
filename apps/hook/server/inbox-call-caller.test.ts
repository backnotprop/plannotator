/**
 * `plannotator inbox call --session <id>` with a bare id (no host) in a shell that names that very session: the call
 * is that session, host and name too. Before, it was refused as a mismatch with itself, and where it went through it
 * wrote as a session with no host: a reply to that message read as for "An agent", and the window could not tell it
 * from a script nothing wakes. Only the rule (inbox-call-command.test.ts proves the command through a real Inbox).
 */
import { expect, test } from "bun:test";
import type { InboxRegistryEntry } from "@plannotator/shared/inbox/registry";
import { inboxCallerOf, inboxShellAgentOf, runInboxCallCommand } from "./inbox-call-command";
import { fillInboxToolArguments } from "./inbox-mcp-shim";

const caller = (flag: string | null, env: Record<string, string>) => {
  const answer = inboxCallerOf(flag, env);
  return answer.ok ? answer.caller : answer.code;
};

test("a bare --session id this shell names is that session, with its host and name", () => {
  expect(caller("ses-ops", { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops" })).toEqual({ host: "claude-code", session: "ses-ops", name: "Claude Code" });
  expect(caller("ses-pi", { PI_SESSION_ID: "ses-pi" })).toEqual({ host: "pi", session: "ses-pi", name: "Pi" });
  // Beside another agent's marker the shell's own session still names it.
  expect(caller("ses-ops", { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops", OPENCODE: "1" })).toEqual({ host: "claude-code", session: "ses-ops", name: "Claude Code" });
});

test("anything else is as before: another id is refused, a shell that names no session keeps the bare id, no flag is the shell's session", () => {
  expect(caller("ses-other", { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops" })).toBe("session_mismatch");
  expect(caller("ses-ops", {})).toEqual({ session: "ses-ops" });
  expect(caller("ses-ops", { CLAUDECODE: "1" })).toEqual({ session: "ses-ops" });
  expect(caller(null, { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops" })).toEqual({ host: "claude-code", session: "ses-ops", name: "Claude Code" });
  expect(caller(null, {})).toBeNull();
});

/**
 * An agent's own shell that names no session (Gemini CLI, Copilot CLI, Cursor, OpenCode or Claude Code without a
 * session variable): `inbox call` writes as that agent, by name, so the window never takes its post for a script's
 * (`inboxSessionlessSend`) and passes a reply over it. A plain shell (a script, a hook, cron) is still nobody.
 */
test("the agent marker a shell with no session carries names its sender; with two, the one inside Claude Code; none names nobody", () => {
  expect(inboxShellAgentOf({ GEMINI_CLI: "1" })).toEqual({ name: "Gemini CLI" });
  expect(inboxShellAgentOf({ COPILOT_CLI: "1" })).toEqual({ name: "Copilot CLI" });
  expect(inboxShellAgentOf({ CURSOR_AGENT: "1" })).toEqual({ name: "Cursor" });
  expect(inboxShellAgentOf({ CLAUDECODE: "1" })).toEqual({ name: "Claude Code", host: "claude-code" });
  expect(inboxShellAgentOf({ OPENCODE: "1" })).toEqual({ name: "OpenCode", host: "opencode" });
  expect(inboxShellAgentOf({})).toBeNull();
  // Gemini CLI started from a Claude Code with the mod off: Gemini's own post.
  expect(inboxShellAgentOf({ CLAUDECODE: "1", GEMINI_CLI: "1" })).toEqual({ name: "Gemini CLI" });
  expect(inboxShellAgentOf({ CLAUDECODE: "1", OPENCODE: "1" })).toEqual({ name: "OpenCode", host: "opencode" });
});

test("send_message from a Gemini CLI shell carries its name; from a plain shell, no name and no host; a read carries neither", async () => {
  const bodies: { name: string; arguments: Record<string, unknown> }[] = [];
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const call = (await request.json()) as { params: { name: string; arguments: Record<string, unknown> } };
      bodies.push(call.params);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } } });
    },
  });
  try {
    const entry = { v: 1, pid: 1, port: stub.port, url: `http://127.0.0.1:${stub.port}`, version: "0", token: "t", serverSession: "s", startedAt: "2026-11-19T00:00:00.000Z" } as InboxRegistryEntry;
    const run = (env: Record<string, string>, action: string, json: string) =>
      runInboxCallCommand([action, json], { cwd: "/work/ledger", env, ensureRunning: async () => entry, out: () => {}, err: () => {}, timeoutMs: 5_000 });
    const send = JSON.stringify({ reply_to: "msg_01M4H6G73M9H3Z32T859E72DPY", body: "Which queue should I drain first?" });
    await run({ GEMINI_CLI: "1" }, "send_message", send);
    await run({}, "send_message", send);
    await run({ GEMINI_CLI: "1" }, "read_thread", JSON.stringify({ thread_id: "msg_01M4H6G73M9H3Z32T859E72DPY" }));
    expect(bodies.map((b) => [b.name, b.arguments.agent_name ?? null, b.arguments.agent_host ?? null, b.arguments.agent_session ?? null])).toEqual([
      ["send_message", "Gemini CLI", null, null],
      ["send_message", null, null, null],
      ["read_thread", null, null, null],
    ]);
  } finally {
    stub.stop(true);
  }
});

/**
 * resolve_message's `moved_to` needs the caller's session (the store checks the thread it names holds the caller's
 * question). The stdio shim and `inbox call` fill `agent_session` on a call with `moved_to`, as on send_message,
 * and nothing else: its schema is strict, so no `project_path` and no author. A plain archive is sent untouched:
 * an older Inbox still running has a strict schema without `agent_session`, and would refuse it.
 */
test("the stdio shim fills resolve_message's session only with moved_to (no project, no author); a plain archive goes untouched", () => {
  const fill = (args: Record<string, unknown>, hostSession: { host: string; session: string; name: string } | null, own: string | null = "ses_OWN") =>
    fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "resolve_message", arguments: args } }, "/work", own, hostSession).params!.arguments;
  const claude = { host: "claude-code", session: "ses-claude", name: "Claude Code" };
  expect(fill({ message_id: "msg_old", moved_to: "msg_brief" }, claude)).toEqual({ message_id: "msg_old", moved_to: "msg_brief", agent_session: "ses-claude" });
  // No host session: the shim's own id, the one its send_message wrote with.
  expect(fill({ message_id: "msg_old", moved_to: "msg_brief" }, null)).toEqual({ message_id: "msg_old", moved_to: "msg_brief", agent_session: "ses_OWN" });
  // The agent's own session stands.
  expect(fill({ message_id: "msg_old", moved_to: "msg_brief", agent_session: "mine" }, claude)).toEqual({ message_id: "msg_old", moved_to: "msg_brief", agent_session: "mine" });
  // A plain archive (or reopen) is sent as the agent wrote it: an older Inbox's strict schema refuses agent_session.
  expect(fill({ message_id: "msg_old" }, claude)).toEqual({ message_id: "msg_old" });
  expect(fill({ message_id: "msg_old", resolved: false }, null)).toEqual({ message_id: "msg_old", resolved: false });
  // A Codex call is its thread's, as its send_message is.
  const codex = fillInboxToolArguments(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "resolve_message", arguments: { message_id: "msg_old", moved_to: "msg_brief" }, _meta: { threadId: "019a7d3e-5c1b-7f20-9b8e-2d4c6a8e0f13" } } },
    "/work",
    "ses_OWN",
    claude,
    "codex-mcp-client",
  ).params!.arguments;
  expect(codex).toEqual({ message_id: "msg_old", moved_to: "msg_brief", agent_session: "019a7d3e-5c1b-7f20-9b8e-2d4c6a8e0f13" });
});

test("inbox call resolve_message with moved_to sends --session's session, with no project and no author; with no session, none; a plain one, none", async () => {
  const bodies: { name: string; arguments: Record<string, unknown> }[] = [];
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const call = (await request.json()) as { params: { name: string; arguments: Record<string, unknown> } };
      bodies.push(call.params);
      return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "ok" }], structuredContent: { ok: true } } });
    },
  });
  try {
    const entry = { v: 1, pid: 1, port: stub.port, url: `http://127.0.0.1:${stub.port}`, version: "0", token: "t", serverSession: "s", startedAt: "2026-11-19T00:00:00.000Z" } as InboxRegistryEntry;
    const run = (argv: string[], env: Record<string, string>) =>
      runInboxCallCommand(argv, { cwd: "/work/ledger", env, ensureRunning: async () => entry, out: () => {}, err: () => {}, timeoutMs: 5_000 });
    const args = JSON.stringify({ message_id: "msg_01M4H6G73M9H3Z32T859E72DPY", moved_to: "msg_01M4H6G73M9H3Z32T859E72DPZ" });
    expect(await run(["resolve_message", "--session", "claude-code:ses-ops", args], {})).toBe(0);
    expect(await run(["resolve_message", args], { PLANNOTATOR_SESSION_TAG: "claude-code:ses-ops" })).toBe(0);
    expect(await run(["resolve_message", args], { GEMINI_CLI: "1" })).toBe(0);
    expect(await run(["resolve_message", "--session", "claude-code:ses-ops", JSON.stringify({ message_id: "msg_01M4H6G73M9H3Z32T859E72DPY" })], {})).toBe(0);
    const want = { message_id: "msg_01M4H6G73M9H3Z32T859E72DPY", moved_to: "msg_01M4H6G73M9H3Z32T859E72DPZ" };
    expect(bodies.map((b) => [b.name, b.arguments])).toEqual([
      ["resolve_message", { ...want, agent_session: "ses-ops" }],
      ["resolve_message", { ...want, agent_session: "ses-ops" }],
      // A shell with no session sends none: the Inbox refuses moved_to with "needs your session".
      ["resolve_message", want],
      // A plain archive goes as before (an older Inbox's strict schema has no agent_session).
      ["resolve_message", { message_id: "msg_01M4H6G73M9H3Z32T859E72DPY" }],
    ]);
  } finally {
    stub.stop(true);
  }
});
