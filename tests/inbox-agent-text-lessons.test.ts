/**
 * The owner's lessons for agents (approved word for word, 2026-11-15): each
 * sentence is on every surface an agent reads it from, built from the real
 * sources the way agents get them. What regresses: a sentence dropped or
 * reworded on one copy (the mod's contract copy, the bundled tool list, the
 * MCP server's fields, `--help`, llms.txt), or the thumbs-up's "go" read into
 * another reaction.
 *
 * Nothing here starts an Inbox, reads the real home or opens a browser: the
 * help is formatted against a scratch home.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxAckLine, inboxAgentTool, inboxWakeText } from "../packages/shared/inbox/connection";
import { inboxAckLine as modAckLine, inboxAgentTool as modAgentTool, inboxWakeText as modWakeText } from "../apps/hook/hooks/mod/inbox-contract";
import { INBOX_DEFAULT_TOOLS } from "../apps/hook/hooks/mod/inbox-default-tools";
import { createAgentEnvironmentFor } from "../packages/server/inbox-agents";
import { formatInboxHelp } from "../apps/hook/server/inbox-help";
import { buildLlmsInbox } from "../apps/marketing/src/lib/llms";

const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-agent-lessons-")));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const PROTOTYPE = "Open it and click through its main flow yourself before you send it.";
const OWN_WORDS = "When you show the person their own idea, use their words for it; if it changed, say how and why. When work starts from their request, say what they asked first.";
const SCREEN_PART = "Name a part of the screen as the person sees it, and show it.";
const AFTER_CLICK = "To show what happens after a click, use numbered pictures in order, or a video.";
const NOT_A_PICK = "An answer that asks something back or thinks out loud is not a pick: read it back and wait for a yes. A yes covers that question only.";
const REAL_SCREEN = "A mock that ends on a screen the product already has shows a real screenshot of that screen.";
const SEARCH_FIRST = "Search before you say something was never discussed.";
const NEW_ISSUE = "A new big issue gets its own thread, even when it came up in another: ask its questions there, and say where they went in the old one.";
const REREAD = "Reread the body once before you send; check each date and duration.";
const RECOGNISE = "Ask only about things the person would recognise from using the product; decide the rest and say so in one line.";
const GO = "Take it as a go.";

type Fields = Record<string, { description?: string }>;
const fieldsOf = (tool: { inputSchema: Record<string, unknown> } | null | undefined): Fields => {
  expect(tool).toBeTruthy();
  return (tool!.inputSchema.properties ?? {}) as Fields;
};
const served = (name: string) => INBOX_DEFAULT_TOOLS.find((tool) => tool.name === name)!;

const agentTools = {
  "tool: Pi, OpenCode (shared contract)": inboxAgentTool(INBOX_DEFAULT_TOOLS),
  "tool: Claude Code (mod copy)": modAgentTool(INBOX_DEFAULT_TOOLS),
};
const help = formatInboxHelp({
  command: ["plannotator"],
  dataDir: join(home, ".plannotator"),
  platform: "linux",
  agentEnvironment: createAgentEnvironmentFor({ platform: "linux", homeDir: home, env: { HOME: home, PATH: "" } }),
});
const llms = buildLlmsInbox();

/** Every copy of send_message's `body` an agent reads, and the guides that carry its rules. */
const bodies: Record<string, string> = {
  ...Object.fromEntries(Object.entries(agentTools).map(([name, tool]) => [`${name} body`, fieldsOf(tool).body!.description!])),
  "MCP send_message body (Codex, Gemini, Cursor, MCP clients)": fieldsOf(served("send_message")).body!.description!,
  "plannotator inbox --help": help,
};

const missing = (sentence: string, surfaces: Record<string, string>) =>
  Object.entries(surfaces)
    .filter(([, text]) => !text.includes(sentence))
    .map(([surface]) => surface);

describe("the owner's lessons reach every copy agents read", () => {
  test("a prototype is clicked through before it is sent", () => {
    expect(missing(PROTOTYPE, bodies)).toEqual([]);
  });

  test("the person's own idea, a part of the screen, what happens after a click, a real screenshot, a reread: every body and llms.txt", () => {
    for (const sentence of [OWN_WORDS, SCREEN_PART, AFTER_CLICK, REAL_SCREEN, REREAD]) {
      expect([sentence, missing(sentence, { ...bodies, "llms.txt Inbox page": llms })]).toEqual([sentence, []]);
    }
  });

  test("the reread is the body's last line on the agent tool and the MCP field", () => {
    const fields = Object.entries(bodies).filter(([name]) => name !== "plannotator inbox --help");
    for (const [name, body] of fields) expect([name, body.trimEnd().endsWith(REREAD)]).toEqual([name, true]);
  });

  test("ask only what the person would recognise: right after 'Ask only what you cannot decide alone' on the agent tool, and on the MCP body, --help and llms.txt", () => {
    for (const [name, tool] of Object.entries(agentTools)) {
      expect([name, fieldsOf(tool).body!.description!.includes(`Ask only what you cannot decide alone, about 8 a round at most. ${RECOGNISE}`)]).toEqual([name, true]);
    }
    expect(missing(RECOGNISE, { ...bodies, "llms.txt Inbox page": llms })).toEqual([]);
  });

  test("a new big issue gets its own thread: every `thread` field, --help and llms.txt", () => {
    const threads: Record<string, string> = {
      ...Object.fromEntries(Object.entries(agentTools).map(([name, tool]) => [`${name} thread`, fieldsOf(tool).thread!.description!])),
      "MCP send_message thread": fieldsOf(served("send_message")).thread!.description!,
      "MCP submit_guide thread": fieldsOf(served("submit_guide")).thread!.description!,
      "plannotator inbox --help": help,
      "llms.txt Inbox page": llms,
    };
    expect(missing(NEW_ISSUE, threads)).toEqual([]);
  });

  test("search before saying something was never discussed: the MCP search tool and --help", () => {
    expect(missing(SEARCH_FIRST, { "MCP search": served("search").description, "plannotator inbox --help": help })).toEqual([]);
  });

  test("an answer that is not a pick: the wake of a reply with answers (both contract copies), --help and llms.txt; never a reply without answers or a New message", () => {
    const answered = { id: "msg_01REPLY", subject: "Retries", body: "Hmm, what about retrying twice?\n\n## Answers to your questions\n\n### Q1. Retry how?\n\nOther: what about retrying twice?", thread_id: "msg_01THREAD" };
    for (const wake of [inboxWakeText, modWakeText]) {
      expect(wake(answered, 0)).toContain(`\n\n${NOT_A_PICK}\n\n`);
      expect(wake({ ...answered, body: "Go with backoff." }, 0)).not.toContain(NOT_A_PICK);
      expect(wake({ ...answered, type: "message" }, 0)).not.toContain(NOT_A_PICK);
    }
    expect(missing(NOT_A_PICK, { "plannotator inbox --help": help, "llms.txt Inbox page": llms })).toEqual([]);
  });

  test("👍 Looks good is a go; no other reaction says so", () => {
    for (const line of [inboxAckLine, modAckLine]) {
      expect(line("msg_01AGENT")).toBe(`The person reacted 👍 Looks good to your message (msg_01AGENT). ${GO}`);
      expect(line("msg_01AGENT", { emoji: "👍" })).toEndWith(GO);
      for (const other of [{ emoji: "🎉", label: "Ship it" }, { emoji: "🦄" }, { emoji: "👍", label: "Maybe" }]) {
        expect(line("msg_01AGENT", other)).not.toContain(GO);
      }
    }
    expect(inboxWakeText({ id: "msg_01NOTE", subject: "Retries", body: "", ack_of: "msg_01AGENT", thread_id: "msg_01THREAD" }).split("\n")[1]).toEndWith(GO);
  });
});
