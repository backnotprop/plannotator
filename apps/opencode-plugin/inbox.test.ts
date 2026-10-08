/**
 * OpenCode 1 gets the Inbox tool only (no wake): the plugin's OpenCode 1
 * entry (`index.ts`) against a REAL Inbox under a temp data dir (the compiled
 * binary when PLANNOTATOR_INBOX_TEST_BINARY names one). The tool is built
 * with OpenCode 1's own `tool()` and zod (`tool.schema`), and the JSON Schema
 * the model would see is what that zod produces. A live OpenCode 1 run is not
 * part of this proof; OpenCode 2 is proved on the real host in inbox-v2.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import { INBOX_TOOL_WAKE_NOTE } from "@plannotator/shared/inbox/connection";
import PlannotatorPlugin from "./index";
import { createInboxWorld, destroyInboxWorld, QUESTION, startInbox, stubBuiltHtml, thread, type InboxWorld } from "../../tests/helpers/inbox-world";

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const saved = { ...process.env };

beforeAll(() => {
  stubs = stubBuiltHtml();
});
afterAll(() => {
  for (const file of stubs) rmSync(file, { force: true });
});
afterEach(() => {
  for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_BIN"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const w of worlds.splice(0)) destroyInboxWorld(w);
});

async function loadPlugin(w: InboxWorld): Promise<Record<string, any>> {
  process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
  process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");
  return (await PlannotatorPlugin({ client: {}, directory: w.project } as never, { workflow: "manual" } as never)) as Record<string, any>;
}

// The world's `plannotator` wrapper is a /bin/sh script.
describe.skipIf(process.platform === "win32")("OpenCode 1 ↔ Plannotator Inbox (the plugin's OpenCode 1 entry, a real Inbox)", () => {
  test("no tool without a registry or with the switch off; with both, the tool (no wake) lands a thread", async () => {
    const w = createInboxWorld("plannotator-inbox-oc1-", "03-opencode1-tool-only", "opencode1");
    worlds.push(w);
    mkdirSync(w.dataDir, { recursive: true });
    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));

    expect((await loadPlugin(w)).tool?.plannotator_inbox).toBeUndefined();
    w.proof("switch on, no inbox/inbox.json: no plannotator_inbox");

    startInbox(w);
    writeFileSync(path.join(w.dataDir, "config.json"), "{}");
    expect((await loadPlugin(w)).tool?.plannotator_inbox).toBeUndefined();
    w.proof("Inbox running, switch at its OpenCode default (off): no plannotator_inbox");

    process.env.PLANNOTATOR_INBOX_TOOL = "1";
    const inbox = (await loadPlugin(w)).tool?.plannotator_inbox;
    expect(inbox).toBeDefined();
    expect(inbox.description).not.toContain(INBOX_TOOL_WAKE_NOTE);
    const schema = tool.schema.toJSONSchema(tool.schema.object(inbox.args)) as { properties: Record<string, { enum?: string[] }>; required: string[] };
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action?.enum).toContain("send_message");
    expect(Object.keys(schema.properties)).not.toContain("agent_session");
    w.proof(`PLANNOTATOR_INBOX_TOOL=1: plannotator_inbox with actions ${JSON.stringify(schema.properties.action?.enum)}; the description carries no wake line\n\n${inbox.description}`);

    const answer = await inbox.execute({ action: "send_message", body: QUESTION }, { sessionID: "ses_opencode1", directory: w.project });
    const sent = JSON.parse(answer.slice(answer.indexOf("{"))) as { thread_id: string };
    const t = await thread(w, sent.thread_id);
    expect(t.project.root).toBe(w.project);
    expect(t.messages[0]?.author).toMatchObject({ kind: "agent", host: "opencode", name: "OpenCode", session: "ses_opencode1" });
    w.proof(`> plannotator_inbox send_message (OpenCode 1)\n${answer}\n\nthread author ${JSON.stringify(t.messages[0]?.author)}`);
  }, 60_000);
});
