/**
 * `plannotator inbox antigravity` (inbox-antigravity-command.ts): the hand-over
 * an Antigravity CLI conversation's agent writes, and the stdio shim filing an
 * Antigravity call as its conversation (inbox-mcp-shim.ts). A scratch data
 * folder; nothing is run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INBOX_ANTIGRAVITY_APP_TEXT,
  INBOX_ANTIGRAVITY_LINKED_TEXT,
  INBOX_ANTIGRAVITY_OUTSIDE_TEXT,
  INBOX_ANTIGRAVITY_PRINT_TEXT,
  agyArgsPrint,
  runInboxAntigravityCommand,
  type AgyAncestor,
} from "./inbox-antigravity-command";
import { fillInboxToolArguments } from "./inbox-mcp-shim";

const CONVERSATION = "2cb0b3d5-163d-4a94-a19b-5b564a906739";
const TOKEN = "7b46aaaa-bbbb-cccc-dddd-eeeeffff0000";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A pid no process has (above the largest pid macOS and Linux hand out). */
const GONE_PID = 2 ** 22 + 12345;
const AGY: AgyAncestor[] = [
  { pid: GONE_PID + 1, args: ["zsh", "-c", "plannotator inbox antigravity"] },
  { pid: process.pid, args: ["/home/x/.local/bin/agy", "--dangerously-skip-permissions"] },
];

function run(env: Record<string, string>, ancestors: AgyAncestor[] = AGY, dataDir = mkdtempSync(join(tmpdir(), "plannotator-agy-link-"))) {
  roots.push(dataDir);
  const out: string[] = [];
  const err: string[] = [];
  const linkPath = join(dataDir, "inbox", "antigravity", "links", `${CONVERSATION}.json`);
  const code = runInboxAntigravityCommand([], { env, dataDir, write: (line) => out.push(line), writeError: (line) => err.push(line), ancestors: () => ancestors });
  return { code, out, err, linkPath, dataDir };
}

const cliEnv = {
  ANTIGRAVITY_AGENT: "1",
  ANTIGRAVITY_CONVERSATION_ID: CONVERSATION,
  ANTIGRAVITY_LS_ADDRESS: "localhost:56548",
  ANTIGRAVITY_CSRF_TOKEN: TOKEN,
  ANTIGRAVITY_APP_DATA_DIR: "/home/x/.gemini/antigravity-cli",
};

describe("plannotator inbox antigravity", () => {
  test("a CLI conversation: the hand-over is written 0600 in a 0700 folder, and the token is never printed", async () => {
    const r = run(cliEnv);
    expect(await r.code).toBe(0);
    expect(r.out).toEqual([INBOX_ANTIGRAVITY_LINKED_TEXT]);
    expect([...r.out, ...r.err].join("\n")).not.toContain(TOKEN);
    expect(statSync(r.linkPath).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.dataDir, "inbox", "antigravity", "links")).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(r.linkPath, "utf8"))).toMatchObject({ conversation: CONVERSATION, address: "localhost:56548", token: TOKEN, pid: process.pid });
  });

  test("writing a hand-over removes the ones whose agy is gone, and keeps a running one's", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "plannotator-agy-link-"));
    const dir = join(dataDir, "inbox", "antigravity", "links");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ended = "11111111-2222-4333-8444-555555555555";
    const running = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    const old = (conversation: string, pid: number) =>
      writeFileSync(join(dir, `${conversation}.json`), JSON.stringify({ conversation, address: "localhost:50001", token: "old-token-0123456789", at: "2026-01-01T00:00:00.000Z", pid }), { mode: 0o600 });
    old(ended, GONE_PID);
    old(running, process.pid);
    const r = run(cliEnv, AGY, dataDir);
    expect(await r.code).toBe(0);
    expect(existsSync(join(dir, `${ended}.json`))).toBe(false);
    expect(existsSync(join(dir, `${running}.json`))).toBe(true);
    expect(existsSync(r.linkPath)).toBe(true);
  });

  test("the App or the IDE: nothing to write, the Inbox reads their own file", async () => {
    const r = run({ ...cliEnv, ANTIGRAVITY_APP_DATA_DIR: "/home/x/.gemini/antigravity" });
    expect(await r.code).toBe(0);
    expect(r.out).toEqual([INBOX_ANTIGRAVITY_APP_TEXT]);
    expect(existsSync(r.linkPath)).toBe(false);
  });

  test("agy -p ends after its turn: refused, nothing written", async () => {
    const r = run(cliEnv, [
      { pid: GONE_PID, args: ["zsh", "-c", "x"] },
      { pid: process.pid, args: ["agy", "--dangerously-skip-permissions", "-p", "do", "it"] },
    ]);
    expect(await r.code).toBe(1);
    expect(r.out).toEqual([INBOX_ANTIGRAVITY_PRINT_TEXT]);
    expect(existsSync(r.linkPath)).toBe(false);
  });

  test("outside a conversation's command (no agent API in the environment): refused", async () => {
    const r = run({ ANTIGRAVITY_CONVERSATION_ID: CONVERSATION });
    expect(await r.code).toBe(1);
    expect(r.err).toEqual([INBOX_ANTIGRAVITY_OUTSIDE_TEXT]);
    const remote = run({ ...cliEnv, ANTIGRAVITY_LS_ADDRESS: "example.com:56548" });
    expect(await remote.code).toBe(1);
    expect(existsSync(remote.linkPath)).toBe(false);
  });

  test("print mode is read from agy's own arguments only", () => {
    expect(agyArgsPrint(["agy", "-p", "x"])).toBe(true);
    expect(agyArgsPrint(["/u/.local/bin/agy", "--print=x"])).toBe(true);
    expect(agyArgsPrint(["agy", "--prompt", "x"])).toBe(true);
    expect(agyArgsPrint(["agy", "--prompt-interactive", "x"])).toBe(false);
    expect(agyArgsPrint(["agy", "-i", "x"])).toBe(false);
    expect(agyArgsPrint(["agy", "--", "-p"])).toBe(false);
    expect(agyArgsPrint(["zsh", "-c", "agy -p x"])).toBe(false);
  });
});

test("the shim files an Antigravity call as its conversation", () => {
  const meta = {
    "antigravity.google/artifacts_dir": `/home/x/.gemini/antigravity-cli/brain/${CONVERSATION}`,
    "antigravity.google/conversation_id": CONVERSATION,
    "antigravity.google/root_conversation_id": CONVERSATION,
  };
  const call = (m: unknown) =>
    fillInboxToolArguments({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send_message", arguments: { body: "hi" }, _meta: m as Record<string, unknown> } }, "/work", "ses_OWN", null).params!
      .arguments as Record<string, unknown>;
  expect(call(meta)).toMatchObject({ agent_host: "antigravity", agent_session: CONVERSATION, agent_name: "Antigravity" });
  // A subagent's call is not its root conversation's: the shim's own session.
  expect(call({ ...meta, "antigravity.google/root_conversation_id": "6640fa39-c263-49df-b314-312ed85b242f" })).toMatchObject({ agent_session: "ses_OWN" });
});
