/**
 * The CLI's side of "the person turned the Inbox on here" (inbox-on-command.ts)
 * and the MCP server while it is off (inbox-mcp-shim.ts). Who counts as the
 * person, the refusal, `plannotator inbox on`/`off`, and an MCP client that
 * gets a clean answer with no tools and no start. No test here starts an
 * Inbox: every data dir is a scratch folder, and the off ones hold an off
 * record, which wins over any test knob.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { INBOX_OFF_AGENT_LINE, INBOX_OFF_PERSON_LINE, readInboxOnRecord, recordInboxOff } from "@plannotator/shared/inbox/inbox-on";
import {
  assertInboxOn,
  INBOX_AGENT_SHELL_MARKERS,
  INBOX_ON_LINES,
  inboxAgentShell,
  InboxOffError,
  inboxOffLine,
  inboxOnCommand,
  inboxRunMayStart,
  isPersonsInboxRun,
} from "./inbox-on-command";
import { runInboxMcpShim } from "./inbox-mcp-shim";

/** The real rule: no test knob, no sandbox marker. */
const PERSON: Record<string, string | undefined> = {};
const RUN = { detached: false, background: false };

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
  test("each agent's shell marker makes it an agent's run, never the person's", () => {
    for (const marker of INBOX_AGENT_SHELL_MARKERS) {
      const env = { [marker]: "1" };
      expect(inboxAgentShell(env)).toBe(marker);
      expect(isPersonsInboxRun(env, RUN)).toBe(false);
      expect(inboxOffLine(env)).toBe(INBOX_OFF_AGENT_LINE);
    }
  });

  test("a terminal with no agent marker is the person's; a detached or --background start never is", () => {
    expect(isPersonsInboxRun(PERSON, RUN)).toBe(true);
    expect(isPersonsInboxRun(PERSON, { detached: true, background: false })).toBe(false);
    expect(isPersonsInboxRun(PERSON, { detached: false, background: true })).toBe(false);
    expect(inboxOffLine(PERSON)).toBe(INBOX_OFF_PERSON_LINE);
  });

  test("/plannotator-inbox's marker is the person's act even inside the agent", () => {
    expect(isPersonsInboxRun({ CLAUDECODE: "1", PLANNOTATOR_INBOX_SLASH_COMMAND: "1" }, RUN)).toBe(true);
    expect(isPersonsInboxRun({ CLAUDECODE: "1", PLANNOTATOR_INBOX_SLASH_COMMAND: "1" }, { detached: false, background: true })).toBe(false);
  });
});

describe("before a run starts anything", () => {
  test("the person's own run turns the Inbox on (command), /plannotator-inbox's (slash-command)", () => {
    expect(inboxRunMayStart(dataDir, PERSON, RUN)).toEqual({ ok: true });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "command" });
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, { CODEX_THREAD_ID: "t", PLANNOTATOR_INBOX_SLASH_COMMAND: "1" }, RUN)).toEqual({ ok: true });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "slash-command" });
  });

  test("an agent's bare plannotator inbox while off is refused with the agents' line and sets nothing", () => {
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, { CLAUDECODE: "1" }, RUN)).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false });
  });

  test("--background while off is refused even from the person's terminal (it is how agents and hosts start it)", () => {
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, PERSON, { detached: false, background: true })).toEqual({ ok: false, line: INBOX_OFF_PERSON_LINE });
    expect(readInboxOnRecord(dataDir)?.on).toBe(false);
  });

  test("a fresh computer: an agent's start is refused and the record says never ran", () => {
    expect(inboxRunMayStart(dataDir, { CLAUDECODE: "1" }, { detached: false, background: true })).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "update-never-ran" });
  });

  test("assertInboxOn, in front of every start (ensureInboxRunning), throws the one line while off", () => {
    recordInboxOff(dataDir);
    expect(() => assertInboxOn(dataDir, { CLAUDECODE: "1" })).toThrow(new InboxOffError({ CLAUDECODE: "1" }));
    expect(() => assertInboxOn(dataDir, { CLAUDECODE: "1" })).toThrow(INBOX_OFF_AGENT_LINE);
  });
});

describe("plannotator inbox on", () => {
  test("the person's switch: turns it on and says so", () => {
    const lines: string[] = [];
    expect(inboxOnCommand(dataDir, PERSON, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual(INBOX_ON_LINES);
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "inbox-on" });
  });

  test("in an agent's shell it is refused and sets nothing", () => {
    recordInboxOff(dataDir);
    const lines: string[] = [];
    expect(inboxOnCommand(dataDir, { OPENCODE: "1" }, (line) => lines.push(line))).toBe(1);
    expect(lines).toEqual([INBOX_OFF_AGENT_LINE]);
    expect(readInboxOnRecord(dataDir)?.on).toBe(false);
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
