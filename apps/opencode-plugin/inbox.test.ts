/**
 * OpenCode 1 gets the Inbox tool only (no wake): the plugin's OpenCode 1
 * entry (`index.ts`) against a REAL Inbox under a temp data dir (the compiled
 * binary when PLANNOTATOR_INBOX_TEST_BINARY names one). The tool is built
 * with OpenCode 1's own `tool()` and zod (`tool.schema`), and the JSON Schema
 * the model would see is what that zod produces. A live OpenCode 1 run is not
 * part of this proof; OpenCode 2 is proved on the real host in inbox-v2.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tool } from "@opencode-ai/plugin";
import { INBOX_REMINDER_TEXT_NO_WAKE, INBOX_TOOL_WAKE_NOTE } from "@plannotator/shared/inbox/connection";
import PlannotatorPlugin from "./index";
import { createInboxWorld, destroyInboxWorld, QUESTION, startInbox, removeStubbedHtml, stubBuiltHtml, thread, type InboxWorld } from "../../tests/helpers/inbox-world";

let stubs: string[] = [];
const worlds: InboxWorld[] = [];
const saved = { ...process.env };

beforeAll(() => {
  stubs = stubBuiltHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(async () => {
  for (const key of ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL", "PLANNOTATOR_BIN"]) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const w of worlds.splice(0)) await destroyInboxWorld(w);
});

async function loadPlugin(w: InboxWorld, client: Record<string, unknown> = {}): Promise<Record<string, any>> {
  process.env.PLANNOTATOR_DATA_DIR = w.dataDir;
  process.env.PLANNOTATOR_BIN = path.join(w.bin, "plannotator");
  return (await PlannotatorPlugin({ client, directory: w.project } as never, { workflow: "manual" } as never)) as Record<string, any>;
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

  test("the reminder: one fixed line (no-wake wording) at the end of the one system part OpenCode 1.18 sends, on every request of an agent with the tool; none for a subagent or an agent with the tool off; a failed lookup never flips it; inboxReminder off sends none", async () => {
    const w = createInboxWorld("plannotator-inbox-oc1-", "04-opencode1-reminder", "opencode1");
    worlds.push(w);
    startInbox(w);
    mkdirSync(w.dataDir, { recursive: true });
    // OpenCode 1's client as the transform reads it: the session's last user message names its agent.
    const agents = [
      { name: "build", mode: "primary" },
      { name: "explore", mode: "subagent" },
      { name: "docs", mode: "primary", tools: { "plannotator*": false } },
    ];
    const lookup = { fail: false };
    const client = (agent: string) => ({
      session: {
        messages: async () => {
          if (lookup.fail) throw new Error("lookup failed");
          return { data: [{ info: { role: "user", agent } }] };
        },
      },
      app: { agents: async () => ({ data: agents }) },
    });
    // OpenCode 1.18 sends the system prompt as ONE part (#1114).
    const HOST = "You are OpenCode.\n\nProject instructions.";
    const system = async (plugin: Record<string, any>, sessionID = "ses_1", parts: string[] = [HOST]) => {
      const output = { system: [...parts] };
      await plugin["experimental.chat.system.transform"]?.({ sessionID }, output);
      return output.system;
    };

    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: false } }));
    expect((await system(await loadPlugin(w, client("build")))).join("\n")).not.toContain(INBOX_REMINDER_TEXT_NO_WAKE);

    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true } }));
    const on = await loadPlugin(w, client("build"));
    const first = await system(on);
    // Still one part; the host's text before the line is byte for byte.
    expect(first).toEqual([`${HOST}\n\n${INBOX_REMINDER_TEXT_NO_WAKE}`]);
    expect(await system(on)).toEqual(first);
    // Several parts (an older OpenCode 1): the count stays, the line ends the last one.
    expect(await system(on, "ses_1", ["A", "B"])).toEqual(["A", `B\n\n${INBOX_REMINDER_TEXT_NO_WAKE}`]);
    w.proof(`OpenCode 1 with the tool: the system parts every request\n\n${JSON.stringify(first, null, 2)}`);

    // A lookup that fails keeps the session's last answer, so the prompt never flips.
    lookup.fail = true;
    expect(await system(on)).toEqual(first);
    // A session with no answer yet gets no line while the lookup fails.
    expect(await system(on, "ses_2")).toEqual([HOST]);
    lookup.fail = false;
    expect(await system(on, "ses_2")).toEqual(first);
    w.proof("a failed agent lookup: the session's last answer (none yet: no line)");

    expect(await system(await loadPlugin(w, client("explore")))).toEqual([HOST]);
    expect(await system(await loadPlugin(w, client("docs")))).toEqual([HOST]);
    w.proof("a subagent, and an agent whose tools switch plannotator* off: no line");

    writeFileSync(path.join(w.dataDir, "config.json"), JSON.stringify({ inboxTool: { opencode: true }, inboxReminder: { opencode: false } }));
    const quiet = await loadPlugin(w, client("build"));
    expect(quiet.tool?.plannotator_inbox).toBeDefined();
    expect((await system(quiet)).join("\n")).not.toContain(INBOX_REMINDER_TEXT_NO_WAKE);
  }, 60_000);
});
