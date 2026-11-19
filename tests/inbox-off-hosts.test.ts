/**
 * Every host's Inbox tool follows the person's record (packages/shared/inbox/inbox-on.ts): with the Inbox off on
 * this computer, OpenCode, DeepSeek Harness, Cline, OpenClaw and Hermes (`plannotator inbox connection`) offer no
 * tool and look nothing up, even where an Inbox ran before and its tools are remembered. The same world with the
 * record on gets the tool, so each case proves the record is what decides.
 *
 * No Inbox starts and nothing listens: the registry here is unreadable, so discovery reads only the remembered
 * tools (`inbox/connection-tools.json`). The data dir is a scratch folder and each env is the real rule.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_DEFAULT_TOOLS } from "../apps/hook/hooks/mod/inbox-default-tools";
import { findInboxConnection } from "../apps/opencode-plugin/inbox";
import { setupDshInbox } from "../apps/dsh-plugin/inbox";
import { setupClineInbox } from "../apps/cline-plugin/inbox";
import { OpenClawInbox } from "../apps/openclaw-plugin/inbox";
import { runInboxConnectionCommand } from "../apps/hook/server/inbox-connection-command";

const TOOLS = INBOX_DEFAULT_TOOLS.map((tool) => ({ ...tool }));
/** The host switches on, and nothing else: no sandbox marker, no test knob (the real rule). */
const ENV = { PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_TEST_INBOX_ON: "0" } as NodeJS.ProcessEnv;

let dataDir: string;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  dataDir = join(mkdtempSync(join(tmpdir(), "plannotator-inbox-off-hosts-")), "data");
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  // An Inbox ran here once (its registry file, unreadable, so nothing is called) and its tools are remembered.
  writeFileSync(join(dataDir, "inbox", "inbox.json"), "not a registry");
  writeFileSync(join(dataDir, "inbox", "connection-tools.json"), JSON.stringify({ tools: TOOLS }));
  for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_TEST_INBOX_ON", "PLANNOTATOR_TEST_SANDBOX"]) saved[key] = process.env[key];
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  process.env.PLANNOTATOR_INBOX_TOOL = "1";
  process.env.PLANNOTATOR_TEST_INBOX_ON = "0";
  delete process.env.PLANNOTATOR_TEST_SANDBOX;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const record = (on: boolean) => writeFileSync(join(dataDir, "state.json"), JSON.stringify({ inboxOn: { on, at: "2026-11-18T09:00:00.000Z", by: on ? "command" : "off" } }));

describe("with the Inbox off, no host offers the tool", () => {
  test("OpenCode 1 and 2: no connection; with it on, one", async () => {
    record(false);
    expect(await findInboxConnection()).toBeNull();
    record(true);
    expect(await findInboxConnection()).not.toBeNull();
  });

  test("DeepSeek Harness: nothing looked up; with it on, the tools are", async () => {
    let discovered = 0;
    const ctx = { get: (name: string) => (name === "agents" ? { get: () => undefined } : undefined), on: () => undefined } as never;
    const deps = { env: ENV, dataDir, discover: async () => (discovered++, null) };
    record(false);
    expect(await setupDshInbox(ctx, deps)).toBeNull();
    expect(discovered).toBe(0);
    record(true);
    await setupDshInbox(ctx, deps);
    expect(discovered).toBe(1);
  });

  test("Cline: nothing looked up; with it on, the tools are", async () => {
    let discovered = 0;
    const deps = { env: ENV, dataDir, discover: async () => (discovered++, null) };
    const ctx = { session: { sessionId: "ses-1" } };
    record(false);
    expect(await setupClineInbox({} as never, ctx, deps)).toBeNull();
    expect(discovered).toBe(0);
    record(true);
    await setupClineInbox({} as never, ctx, deps);
    expect(discovered).toBe(1);
  });

  test("OpenClaw: its switch reads off; with it on, on", () => {
    const inbox = new OpenClawInbox({ logger: {} } as never, { env: ENV, dataDir, discover: async () => TOOLS });
    const switchOn = () => (inbox as unknown as { switchOn(): boolean }).switchOn();
    record(false);
    expect(switchOn()).toBe(false);
    record(true);
    expect(switchOn()).toBe(true);
  });

  test("Hermes (plannotator inbox connection): ready says off; with it on, on", async () => {
    const ready = async () => {
      const out: string[] = [];
      const lines = (async function* () {})();
      await runInboxConnectionCommand(["--host", "hermes"], { dataDir, env: ENV, lines, write: (line) => void out.push(line), discover: async () => TOOLS, switchEveryMs: 60_000 });
      return JSON.parse(out[0]!) as { type: string; on: boolean };
    };
    record(false);
    expect(await ready()).toMatchObject({ type: "ready", on: false });
    record(true);
    expect(await ready()).toMatchObject({ type: "ready", on: true });
  });
});
