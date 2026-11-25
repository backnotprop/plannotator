/**
 * `plannotator inbox swarm` (inbox-swarm-command.ts): what it asks the Inbox. No Inbox runs: a stand-in for the
 * Inbox's route. What regresses: a subcommand sent as someone else or with the wrong words; bad usage starting the
 * Inbox; the task subcommands (named by the approved /swarm text, built later) answering "unknown"; a refusal printed
 * as a result; an Inbox too old for the command not said so; the help naming a subcommand that does not exist yet.
 */
import { expect, test } from "bun:test";
import { INBOX_AGENT_WRITE_ACTIONS } from "@plannotator/shared/inbox/agent-relay-client";
import { INBOX_MCP_TOOLS } from "@plannotator/server/inbox-mcp";
import { INBOX_TOOL_ACTIONS } from "../hooks/mod/inbox-contract";
import { INBOX_DEFAULT_TOOLS } from "../hooks/mod/inbox-default-tools";
import { INBOX_SWARM_HELP_SECTION, INBOX_SWARM_USAGE, SWARM_NOT_YET_WORDS, parseSwarmCommand, runInboxSwarmCommand } from "./inbox-swarm-command";

const CODEX_SESSION = "019a2b3c-1111-7222-8333-444455556666";

function inbox(answer: (body: Record<string, unknown> | null) => { status: number; json: unknown }) {
  const asked: { method: string; path: string; body: Record<string, unknown> | null }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  let started = 0;
  const deps = {
    cwd: "/work/harbor",
    env: { CODEX_THREAD_ID: CODEX_SESSION } as Record<string, string | undefined>,
    ensureRunning: async () => {
      started++;
      return {} as never;
    },
    out: async (text: string) => void out.push(text),
    err: (text: string) => void err.push(text),
    fetchRoute: async (path: string, init?: { method?: string; body?: string }) => {
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      asked.push({ method: init?.method ?? "GET", path, body });
      const { status, json } = answer(body);
      return Response.json(json, { status });
    },
  };
  return { deps, asked, out, err, started: () => started };
}

test("each subcommand's words and flags", () => {
  expect(parseSwarmCommand(["join", "msg_1", "--as", "Pricing", "--for", "Claude Code"])).toEqual({ ok: true, call: { action: "join", thread: "msg_1", as: "Pricing", for: "Claude Code" }, session: null, json: false });
  expect(parseSwarmCommand(["say", "Shape?", "--to", "Codex", "--thread", "msg_1"])).toEqual({ ok: true, call: { action: "say", text: "Shape?", to: "Codex", thread: "msg_1" }, session: null, json: false });
  expect(parseSwarmCommand(["doing", "Berth screen", "--session", "ses_1", "--json"])).toEqual({ ok: true, call: { action: "doing", text: "Berth screen" }, session: "ses_1", json: true });
  expect(parseSwarmCommand(["status"])).toEqual({ ok: true, call: { action: "status" }, session: null, json: false });
  expect(parseSwarmCommand(["leave"])).toEqual({ ok: true, call: { action: "leave" }, session: null, json: false });
  // The plan, its lines in one argument, as `swarm propose` sends it.
  expect(parseSwarmCommand(["propose", "- Codex: Prices\n- Pi: Invoices", "--thread", "msg_1"])).toEqual({ ok: true, call: { action: "propose", text: "- Codex: Prices\n- Pi: Invoices", thread: "msg_1" }, session: null, json: false });
  for (const argv of [["join"], ["join", "a", "b"], ["say"], ["say", "  "], ["doing", "x", "--to", "Codex"], ["leave", "now"], ["dance"], ["say", "x", "--loud"], ["join", "msg_1", "--as"], ["propose"], ["propose", "x", "--to", "Codex"]]) {
    expect([argv, parseSwarmCommand(argv).ok]).toEqual([argv, false]);
  }
});

test("a subcommand is one POST as this shell's session; the Inbox's text is stdout", async () => {
  const w = inbox(() => ({ status: 200, json: { text: "Said to Codex in the ghost thread.", thread_id: "msg_1" } }));
  expect(await runInboxSwarmCommand(["say", "Shape?", "--to", "Codex"], w.deps)).toBe(0);
  expect(w.asked).toEqual([{ method: "POST", path: "/api/inbox/swarm", body: { action: "say", text: "Shape?", to: "Codex", by: expect.objectContaining({ session: CODEX_SESSION, host: "codex" }) } }]);
  expect(w.out.join("")).toBe("Said to Codex in the ghost thread.\n");
});

test("bad usage and the task subcommands never reach the Inbox; the tasks are refused plainly, not as unknown", async () => {
  const w = inbox(() => ({ status: 200, json: { text: "x" } }));
  expect(await runInboxSwarmCommand(["join"], w.deps)).toBe(2);
  for (const sub of ["add", "take", "done", "tasks"]) {
    const t = inbox(() => ({ status: 200, json: { text: "x" } }));
    expect(await runInboxSwarmCommand([sub, "Price endpoint"], t.deps)).toBe(1);
    expect(t.err.join("")).toBe(`not_available: ${SWARM_NOT_YET_WORDS}\n`);
    expect(t.asked).toEqual([]);
  }
  expect(w.started()).toBe(0);
  expect(w.asked).toEqual([]);
});

test("a refusal is stderr with its code, never stdout; an Inbox without the route is told to update", async () => {
  const refused = inbox(() => ({ status: 409, json: { code: "not_in_swarm", error: "You have not joined a swarm." } }));
  expect(await runInboxSwarmCommand(["doing", "x"], refused.deps)).toBe(1);
  expect(refused.out).toEqual([]);
  expect(refused.err.join("")).toBe("not_in_swarm: You have not joined a swarm.\n");
  const old = inbox(() => ({ status: 404, json: { error: "Not found" } }));
  expect(await runInboxSwarmCommand(["status"], old.deps)).toBe(1);
  expect(old.err.join("")).toStartWith("inbox_needs_update:");
});

test("a shell that names no agent session is refused before anything is asked", async () => {
  const w = inbox(() => ({ status: 200, json: { text: "x" } }));
  w.deps.env = {};
  expect(await runInboxSwarmCommand(["status"], w.deps)).toBe(1);
  expect(w.asked).toEqual([]);
});

test("the agent tool does not grow: no swarm action, and no swarm words in its tools", () => {
  // The owner, 2026-11-24: "don't bloat or change the tool". Swarm is the command alone.
  expect([...INBOX_TOOL_ACTIONS, ...INBOX_MCP_TOOLS, ...INBOX_AGENT_WRITE_ACTIONS].filter((action) => /swarm/i.test(action))).toEqual([]);
  expect(JSON.stringify(INBOX_DEFAULT_TOOLS)).not.toMatch(/swarm|ghost/i);
});

test("the help names every subcommand that exists and none that does not", () => {
  for (const text of [INBOX_SWARM_USAGE, INBOX_SWARM_HELP_SECTION.join("\n")]) {
    for (const sub of ["join", "propose", "doing", "status", "say", "leave"]) expect(text).toContain(`plannotator inbox swarm ${sub}`);
    for (const sub of ["add", "take", "done", "tasks"]) expect(text).not.toContain(`swarm ${sub}`);
  }
});
