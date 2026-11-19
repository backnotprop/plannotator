/**
 * The CLI's side of "the Inbox is on here" (inbox-on-command.ts) and the MCP
 * server while it is off (inbox-mcp-shim.ts). Regressions guarded: a run of
 * `plannotator inbox` that does not turn it on (in an agent's shell too: there
 * is no detection of who runs it); Plannotator's own starts (`--background`,
 * a detached start, the start at login) turning it on or starting anything
 * while off; a record that cannot be written starting the Inbox anyway; the
 * off line naming what turns it on; status not saying on or off and why. No
 * test here starts an Inbox: every data dir is a scratch folder, and the off
 * ones hold an off record, which wins over any test knob.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { INBOX_OFF_AGENT_LINE, readInboxOnRecord, recordInboxOff, writeInboxOnRecord } from "@plannotator/shared/inbox/inbox-on";
import { INBOX_ON_NOT_SAVED } from "@plannotator/shared/inbox/inbox-on-config";
import { assertInboxOn, InboxOffError, inboxOnStatusLines, inboxRunMayStart, isOurLoginItem, takeLoginItemMarker } from "./inbox-on-command";
import { runInboxMcpShim } from "./inbox-mcp-shim";

/** The real rule: no test knob, no sandbox marker. */
const ENV: Record<string, string | undefined> = {};
/** A run of plannotator inbox (bare, --no-open or --open). */
const RUN = { detached: false, background: false, loginItem: false };

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

describe("what turns the Inbox on", () => {
  test("a run of plannotator inbox turns it on, whoever runs it (an agent's shell included)", () => {
    recordInboxOff(dataDir);
    expect(inboxRunMayStart(dataDir, { CLAUDECODE: "1" }, RUN)).toEqual({ ok: true });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: true, by: "command" });
  });

  test("while off, --background, a detached start and the start at login are refused with the one line and set nothing", () => {
    recordInboxOff(dataDir);
    for (const run of [{ ...RUN, background: true }, { ...RUN, detached: true }, { ...RUN, loginItem: true }]) {
      expect(inboxRunMayStart(dataDir, ENV, run)).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    }
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "off" });
  });

  test("a fresh computer: Plannotator's own start is refused and nothing is written", () => {
    expect(inboxRunMayStart(dataDir, ENV, { ...RUN, background: true })).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toBeNull();
  });

  const NOT_A_UNIT = { pid: 4242, cgroup: "0::/user.slice/user-1000.slice/session-2.scope\n", parentName: "zsh" };
  test("the start at login names itself: its own variable, or launchd's label for one written before", () => {
    expect(isOurLoginItem({ PLANNOTATOR_INBOX_LOGIN_ITEM: "1" }, NOT_A_UNIT)).toBe(true);
    expect(isOurLoginItem({ XPC_SERVICE_NAME: "ai.plannotator.inbox" }, NOT_A_UNIT)).toBe(true);
    expect(isOurLoginItem({ XPC_SERVICE_NAME: "application.com.apple.Terminal.1" }, NOT_A_UNIT)).toBe(false);
    expect(isOurLoginItem({}, NOT_A_UNIT)).toBe(false);
  });

  // T1: a systemd unit written before the marker (0.29) runs plannotator inbox --no-open with no variable of ours.
  test("a systemd unit written before the marker: its own main process is the start at login; what the Inbox starts is not", () => {
    const unit = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/plannotator-inbox.service\n";
    expect(isOurLoginItem({ SYSTEMD_EXEC_PID: "4242" }, { pid: 4242, cgroup: unit, parentName: "systemd" })).toBe(true);
    expect(isOurLoginItem({}, { pid: 4242, cgroup: `1:name=systemd:/user.slice/user@1000.service/plannotator-inbox.service\n`, parentName: "systemd" })).toBe(true);
    // An agent session or terminal the Inbox started: same cgroup, not the unit's main process.
    expect(isOurLoginItem({ SYSTEMD_EXEC_PID: "4242" }, { pid: 5151, cgroup: unit, parentName: "plannotator" })).toBe(false);
    expect(isOurLoginItem({}, { pid: 5151, cgroup: unit, parentName: "plannotator" })).toBe(false);
    recordInboxOff(dataDir);
    const loginItem = isOurLoginItem({ SYSTEMD_EXEC_PID: "4242" }, { pid: 4242, cgroup: unit, parentName: "systemd" });
    expect(inboxRunMayStart(dataDir, ENV, { ...RUN, loginItem })).toEqual({ ok: false, line: INBOX_OFF_AGENT_LINE });
    expect(readInboxOnRecord(dataDir)).toMatchObject({ on: false, by: "off" });
  });

  // T2: nothing the login-started Inbox starts inherits the markers, so a person's plannotator inbox there turns it on.
  test("the markers are read once and dropped from the Inbox's environment", () => {
    const env: Record<string, string | undefined> = { PLANNOTATOR_INBOX_LOGIN_ITEM: "1", XPC_SERVICE_NAME: "ai.plannotator.inbox", PATH: "/bin" };
    expect(takeLoginItemMarker(env, NOT_A_UNIT)).toBe(true);
    expect(env).toEqual({ PATH: "/bin" });
    expect(isOurLoginItem(env, NOT_A_UNIT)).toBe(false);
    const other: Record<string, string | undefined> = { XPC_SERVICE_NAME: "application.com.apple.Terminal.1" };
    expect(takeLoginItemMarker(other, NOT_A_UNIT)).toBe(false);
    expect(other).toEqual({ XPC_SERVICE_NAME: "application.com.apple.Terminal.1" });
  });

  test("when state.json cannot be written: the plain line, nothing starts", () => {
    mkdirSync(join(dataDir, "state.json"));
    expect(inboxRunMayStart(dataDir, ENV, RUN)).toEqual({ ok: false, line: INBOX_ON_NOT_SAVED });
  });

  test("assertInboxOn, in front of every start (ensureInboxRunning), throws the one line while off", () => {
    recordInboxOff(dataDir);
    expect(() => assertInboxOn(dataDir, ENV)).toThrow(new InboxOffError());
    expect(() => assertInboxOn(dataDir, ENV)).toThrow(INBOX_OFF_AGENT_LINE);
  });

  test("the off line never names what turns the Inbox on", () => {
    expect(INBOX_OFF_AGENT_LINE).not.toContain("plannotator inbox");
  });
});

describe("plannotator inbox status", () => {
  test("says on or off, why and since when", () => {
    expect(inboxOnStatusLines(dataDir)).toEqual(["  turned:   off (never turned on here)"]);
    recordInboxOff(dataDir, new Date("2026-11-18T09:00:00.000Z"));
    expect(inboxOnStatusLines(dataDir)).toEqual(["  turned:   off (turned off, 2026-11-18T09:00:00.000Z)"]);
  });

  // D1: a slow store is kept on, and status says so instead of claiming the window was used.
  test("a slow or unreadable store, an agent-only decision and a re-read lost record say what happened", () => {
    const at = "2026-11-18T09:00:00.000Z";
    writeInboxOnRecord(dataDir, { on: true, at, by: "update-slow" });
    expect(inboxOnStatusLines(dataDir)).toEqual([`  turned:   on (kept on when Plannotator updated: the Inbox's files took too long to read, ${at})`]);
    writeInboxOnRecord(dataDir, { on: true, at, by: "update-unreadable" });
    expect(inboxOnStatusLines(dataDir)).toEqual([`  turned:   on (kept on when Plannotator updated: some of the Inbox's files could not be read, ${at})`]);
    // A person who ran it with PLANNOTATOR_INBOX_CONNECT=0 and never touched the window leaves no trace: never "only agents".
    writeInboxOnRecord(dataDir, { on: false, at, by: "update-agent-only" });
    expect(inboxOnStatusLines(dataDir)).toEqual([`  turned:   off (off since Plannotator updated: nothing here showed the person had used the Inbox or run plannotator inbox, ${at})`]);
    writeInboxOnRecord(dataDir, { on: true, at, by: "record-lost" });
    expect(inboxOnStatusLines(dataDir)).toEqual([`  turned:   on (kept on: its record in state.json was lost and the Inbox had been used here, ${at})`]);
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
