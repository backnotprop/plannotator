/**
 * The CLI's side of "the person turned the Inbox on here" (inbox-on-command.ts)
 * and the MCP server while it is off (inbox-mcp-shim.ts). Who counts as the
 * person, the refusal, `plannotator inbox on`/`off`, and an MCP client that
 * gets a clean answer with no tools and no start. No test here starts an
 * Inbox: every data dir is a scratch folder, and the off ones hold an off
 * record, which wins over any test knob.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { INBOX_OFF_AGENT_LINE, INBOX_OFF_PERSON_LINE, readInboxOnRecord, recordInboxOff } from "@plannotator/shared/inbox/inbox-on";
import { INBOX_ON_NOT_SAVED } from "@plannotator/shared/inbox/inbox-on-config";
import {
  assertInboxOn,
  INBOX_AGENT_SHELL_MARKERS,
  INBOX_ON_LINES,
  inboxAgentShell,
  InboxOffError,
  inboxOffLine,
  inboxOnCommand,
  inboxOnStatusLines,
  inboxRunMayStart,
  isPersonsInboxRun,
} from "./inbox-on-command";
import { runInboxMcpShim } from "./inbox-mcp-shim";

/** The real rule: no test knob, no sandbox marker. */
const PERSON: Record<string, string | undefined> = {};
/** A run in a terminal (stdin and stdout), as the person types it. */
const RUN = { detached: false, background: false, tty: true };
/** The same run with no terminal: an agent's shell tool, a pipe, launchd or systemd. */
const NO_TTY = { detached: false, background: false, tty: false };

let dataDir: string;
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.PLANNOTATOR_DATA_DIR;
  dataDir = mkdtempSync(join(tmpdir(), "inbox-on-cmd-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
});

describe("who runs plannotator inbox", () => {
  test("each agent's shell marker makes it an agent's run, never the person's, even in a terminal", () => {
    for (const marker of INBOX_AGENT_SHELL_MARKERS) {
      const env = { [marker]: "1" };
      expect(inboxAgentShell(env)).toBe(marker);
      expect(isPersonsInboxRun(env, RUN)).toBe(false);
      expect(inboxOffLine(env, true)).toBe(INBOX_OFF_AGENT_LINE);
    }
  });

  test("the person's own terminal: no marker and a terminal; a detached or --background start never is", () => {
    expect(isPersonsInboxRun(PERSON, RUN)).toBe(true);
    expect(isPersonsInboxRun(PERSON, { ...RUN, detached: true })).toBe(false);
    expect(isPersonsInboxRun(PERSON, { ...RUN, background: true })).toBe(false);
    expect(inboxOffLine(PERSON, true)).toBe(INBOX_OFF_PERSON_LINE);
  });

  // H2: Amp, Droid, Kiro, Cline, Hermes, OpenClaw... set none of the markers; their shell tools have no terminal.
  test("no marker and no terminal (an agent the list does not know) is an agent's run and gets the agents' line", () => {
    expect(isPersonsInboxRun(PERSON, NO_TTY)).toBe(false);
    expect(inboxOffLine(PERSON, false)).toBe(INBOX_OFF_AGENT_LINE);
  });

  test("the agents' line never names what turns the Inbox on", () => {
    expect(INBOX_OFF_AGENT_LINE).not.toContain("plannotator inbox");
    expect(INBOX_OFF_AGENT_LINE).not.toContain("--from-slash-command");
  });

  // H1: the routines' start at login, a new item (its variable) or one written before (launchd's label).
  test("the start at login is never the person, even with a terminal", () => {
    expect(isPersonsInboxRun({ PLANNOTATOR_INBOX_LOGIN_ITEM: "1" }, RUN)).toBe(false);
    expect(isPersonsInboxRun({ XPC_SERVICE_NAME: "ai.plannotator.inbox" }, RUN)).toBe(false);
    expect(isPersonsInboxRun({ XPC_SERVICE_NAME: "application.com.apple.Terminal.1" }, RUN)).toBe(true);
  });

  test("/plannotator-inbox's flag is the person's act even inside the agent with no terminal; never with --background", () => {
    expect(isPersonsInboxRun({ CLAUDECODE: "1" }, { ...NO_TTY, slashCommand: true })).toBe(true);
    expect(isPersonsInboxRun({ CLAUDECODE: "1" }, { ...NO_TTY, slashCommand: true, background: true })).toBe(false);
    // The environment variable an earlier build of this branch read is not a way in.
    expect(isPersonsInboxRun({ CLAUDECODE: "1", PLANNOTATOR_INBOX_SLASH_COMMAND: "1" }, NO_TTY)).toBe(false);
  });
});

describe("before a run starts anything", () => {
  test("the person's own run turns the Inbox on (command), /plannotator-inbox's (slash-command)", () => {
    expect(inboxRunMayStart(dataDir, PERSON, RUN)).toEqual({ ok: true });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "command" });
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, { CODEX_THREAD_ID: "t" }, { ...NO_TTY, slashCommand: true })).toEqual({ ok: true });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "slash-command" });
  });

  test("an agent's bare plannotator inbox while off is refused with the agents' line and sets nothing", () => {
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, { CLAUDECODE: "1" }, RUN)).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false });
  });

  test("H2: an unknown agent's --no-open with no terminal is refused and turns nothing on", () => {
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, PERSON, NO_TTY)).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "off" });
  });

  test("H1: after off, the start at login is refused and the record stays off", () => {
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, { PLANNOTATOR_INBOX_LOGIN_ITEM: "1" }, NO_TTY)).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "off" });
  });

  test("--background while off is refused even from the person's terminal (it is how agents and hosts start it)", () => {
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, PERSON, { ...RUN, background: true })).toEqual({ ok: false, line: INBOX_OFF_PERSON_LINE });
    expect(readInboxOnRecord(dataDir)?.on).toBe(false);
  });

  test("a fresh computer: an agent's start is refused and nothing is written", () => {
    expect(inboxRunMayStart(dataDir, { CLAUDECODE: "1" }, { ...NO_TTY, background: true })).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toBeNull();
  });

  // M1: the person's run whose record cannot be written says so and starts nothing.
  test("the person's run when state.json cannot be written: the plain line, nothing starts", () => {
    mkdirSync(join(dataDir, "state.json"));
    expect(inboxRunMayStart(dataDir, PERSON, RUN)).toEqual({ ok: false, line: INBOX_ON_NOT_SAVED });
  });

  test("assertInboxOn, in front of every start (ensureInboxRunning), throws the one line while off", () => {
    recordInboxOff(dataDir);
    expect(() => assertInboxOn(dataDir, { CLAUDECODE: "1" }, false)).toThrow(new InboxOffError({ CLAUDECODE: "1" }, false));
    expect(() => assertInboxOn(dataDir, { CLAUDECODE: "1" }, false)).toThrow(INBOX_OFF_AGENT_LINE);
  });
});

describe("plannotator inbox on", () => {
  test("the person's switch: turns it on and says so", () => {
    const lines: string[] = [];
    expect(inboxOnCommand(dataDir, PERSON, (line) => lines.push(line), true)).toBe(0);
    expect(lines).toEqual(INBOX_ON_LINES);
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "inbox-on" });
  });

  // M1: config.json is the person's settings file; a broken one never blocks the record (state.json).
  test("a hand-broken config.json does not block it", () => {
    writeFileSync(join(dataDir, "config.json"), "{ not json");
    expect(inboxOnCommand(dataDir, PERSON, () => undefined, true)).toBe(0);
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true });
  });

  test("in an agent's shell, or with no terminal, it is refused and sets nothing", () => {
    recordInboxOff(dataDir);
    for (const [env, tty] of [[{ OPENCODE: "1" }, true], [PERSON, false]] as const) {
      const lines: string[] = [];
      expect(inboxOnCommand(dataDir, env, (line) => lines.push(line), tty)).toBe(1);
      expect(lines).toEqual([INBOX_OFF_AGENT_LINE]);
      expect(readInboxOnRecord(dataDir)?.on).toBe(false);
    }
  });
});

describe("plannotator inbox status", () => {
  test("says on or off, why and since when, and notes that were left", () => {
    expect(inboxOnStatusLines(dataDir)).toEqual(["  turned:   off (never turned on here)"]);
    recordInboxOff(dataDir, new Date("2026-11-18T09:00:00.000Z"), "left");
    expect(inboxOnStatusLines(dataDir)[0]).toBe("  turned:   off (turned off, 2026-11-18T09:00:00.000Z)");
    expect(inboxOnStatusLines(dataDir)[1]).toContain("could not be removed");
  });
});

describe("the MCP server while the Inbox is off", () => {
  /** An MCP client (the SDK's own) on the shim's stdin/stdout, in this process. */
  async function clientOnShim() {
    let ensured = 0;
    let push: (line: string) => void = () => undefined;
    let end: () => void = () => undefined;
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (line) => controller.enqueue(new TextEncoder().encode(`${line}\n`));
        end = () => controller.close();
      },
    });
    const transport: any = {
      start: async () => undefined,
      send: async (message: unknown) => push(JSON.stringify(message)),
      close: async () => {
        end();
        transport.onclose?.();
      },
    };
    const done = runInboxMcpShim({
      dataDir,
      cwd: dataDir,
      inboxOff: true,
      ensureRunning: async () => {
        ensured++;
        throw new Error("started");
      },
      input,
      write: (line) => transport.onmessage?.(JSON.parse(line)),
    });
    const client = new Client({ name: "codex-mcp-client", version: "1" });
    await client.connect(transport);
    return { client, done, ensured: () => ensured };
  }

  test("initialize answers, tools/list is empty, a call is refused with the one line, and nothing starts", async () => {
    const { client, done, ensured } = await clientOnShim();
    // Why it has no tools, in the server's instructions (the agent reads them).
    expect(client.getInstructions()).toBe(INBOX_OFF_AGENT_LINE);
    expect((await client.listTools()).tools).toEqual([]);
    const call = await client.callTool({ name: "send_message", arguments: { body: "Ship it?" } }).then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(call).toContain(INBOX_OFF_AGENT_LINE);
    await client.close();
    await done;
    expect(ensured()).toBe(0);
  });
});
