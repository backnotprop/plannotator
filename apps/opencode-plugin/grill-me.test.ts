/**
 * The grill-me note on OpenCode (grill-me.ts). The failures this guards: a
 * grill-me skill run (typed on OpenCode 1, or loaded by the model's `skill`
 * tool on both runtimes) without the note; the note on another skill
 * (`grilled-cheese`), on a subagent's call, twice in one turn, or where the
 * Inbox reminder is off; and OpenCode 1 telling the model a reply comes back
 * by itself (it does not there).
 *
 * The plugin-level tests load the real plugin entries against a temp data dir
 * whose Inbox is only remembered (`inbox/connection-tools.json`): the tool is
 * registered without any Inbox running or contacted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GRILL_ME_NOTE_TEXT, GRILL_ME_NOTE_TEXT_NO_WAKE } from "@plannotator/shared/inbox/grill-me";
import PlannotatorPlugin from "./index";
import serverPlugin from "./server";
import { createOpenCode1GrillMe, registerGrillMeOpenCode2, withGrillMeNote } from "./grill-me";

const savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
const savedInboxTool = process.env.PLANNOTATOR_INBOX_TOOL;
const dirs: string[] = [];

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  if (savedInboxTool === undefined) delete process.env.PLANNOTATOR_INBOX_TOOL;
  else process.env.PLANNOTATOR_INBOX_TOOL = savedInboxTool;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data dir with a remembered Inbox (no registry to reach) and this config.json. */
function rememberedInbox(config: Record<string, unknown>): void {
  const dir = mkdtempSync(path.join(tmpdir(), "plannotator-grill-me-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "inbox"), { recursive: true });
  writeFileSync(path.join(dir, "inbox", "inbox.json"), "{}");
  writeFileSync(
    path.join(dir, "inbox", "connection-tools.json"),
    JSON.stringify({ tools: [{ name: "send_message", description: "Send a message.", inputSchema: { type: "object", properties: {} } }] }),
  );
  writeFileSync(path.join(dir, "config.json"), JSON.stringify(config));
  delete process.env.PLANNOTATOR_INBOX_TOOL;
  process.env.PLANNOTATOR_DATA_DIR = dir;
}

const skillOutput = '<skill_content name="grill-me">\n# Skill: grill-me\n</skill_content>';

describe("OpenCode 1", () => {
  const hooks = (subagentSessions: string[] = []) =>
    createOpenCode1GrillMe({ isSubagentSession: async (id) => subagentSessions.includes(id) });

  test("a typed grill-me command gets the no-wake note as a synthetic part of its message", () => {
    const grillMe = hooks();
    const output = { parts: [{ type: "text", text: "Interview me." }] as unknown[] };
    grillMe.command({ command: "grill-me", sessionID: "s1" }, output);
    expect(output.parts).toEqual([
      { type: "text", text: "Interview me." },
      { type: "text", text: GRILL_ME_NOTE_TEXT_NO_WAKE, synthetic: true },
    ]);
  });

  test("the model's skill tool loading a grill-me skill gets the note after the skill", async () => {
    const grillMe = hooks();
    const output = { title: "Loaded skill: grilling", output: skillOutput, metadata: {} };
    await grillMe.toolAfter({ tool: "skill", sessionID: "s1", args: { name: "grilling" } }, output);
    expect(output.output).toBe(`${skillOutput}\n\n${GRILL_ME_NOTE_TEXT_NO_WAKE}`);
  });

  test("another skill or tool, a subtask command and a subagent's session get nothing", async () => {
    const grillMe = hooks(["child"]);
    const parts: unknown[] = [];
    grillMe.command({ command: "grilled-cheese", sessionID: "s1" }, { parts });
    const subtask = [{ type: "subtask", agent: "explore", prompt: "x" }];
    grillMe.command({ command: "grill-me", sessionID: "s1" }, { parts: subtask });
    expect(parts).toEqual([]);
    expect(subtask).toHaveLength(1);
    for (const [tool, args, sessionID] of [
      ["skill", { name: "grilled-cheese" }, "s1"],
      ["read", { name: "grill-me" }, "s1"],
      ["skill", { name: "grill-me" }, "child"],
    ] as const) {
      const output = { output: skillOutput };
      await grillMe.toolAfter({ tool, sessionID, args }, output);
      expect(output.output).toBe(skillOutput);
    }
  });

  test("once per turn: a typed /grill-me that loads grilling adds one note; the next user message starts over", async () => {
    const grillMe = hooks();
    grillMe.command({ command: "grill-me", sessionID: "s1" }, { parts: [] });
    grillMe.userMessage({ sessionID: "s1" }); // the command's own message
    const same = { output: skillOutput };
    await grillMe.toolAfter({ tool: "skill", sessionID: "s1", args: { name: "grilling" } }, same);
    expect(same.output).toBe(skillOutput);

    grillMe.userMessage({ sessionID: "s1" });
    const next = { output: skillOutput };
    await grillMe.toolAfter({ tool: "skill", sessionID: "s1", args: { name: "grilling" } }, next);
    expect(next.output).toContain(GRILL_ME_NOTE_TEXT_NO_WAKE);
    // A typed command in a later turn still gets it, though the session had one.
    const parts: unknown[] = [];
    grillMe.command({ command: "grill-me", sessionID: "s1" }, { parts });
    expect(parts).toHaveLength(1);
  });

  test("the plugin wires it with the Inbox tool and the reminder on, and not with the reminder off", async () => {
    const load = async () =>
      (await PlannotatorPlugin(
        { client: { session: { get: async () => ({ data: { id: "s1" } }) } }, directory: tmpdir() } as never,
        { workflow: "manual" } as never,
      )) as Record<string, any>;

    rememberedInbox({ inboxTool: { opencode: true } });
    const on = await load();
    expect(on.tool?.plannotator_inbox).toBeDefined();
    const parts: unknown[] = [];
    await on["command.execute.before"]({ command: "grill-me", sessionID: "s1", arguments: "" }, { parts });
    expect(parts).toEqual([{ type: "text", text: GRILL_ME_NOTE_TEXT_NO_WAKE, synthetic: true }]);
    await on["chat.message"]({ sessionID: "s1" }, { message: {}, parts });
    await on["chat.message"]({ sessionID: "s1" }, { message: {}, parts: [] });
    const output = { title: "", output: skillOutput, metadata: {} };
    await on["tool.execute.after"]({ tool: "skill", sessionID: "s1", callID: "c1", args: { name: "grill-me" } }, output);
    expect(output.output).toBe(`${skillOutput}\n\n${GRILL_ME_NOTE_TEXT_NO_WAKE}`);

    rememberedInbox({ inboxTool: { opencode: true }, inboxReminder: false });
    const off = await load();
    expect(off.tool?.plannotator_inbox).toBeDefined();
    const offParts: unknown[] = [];
    await off["command.execute.before"]({ command: "grill-me", sessionID: "s1", arguments: "" }, { parts: offParts });
    expect(offParts).toEqual([]);
    expect(off["tool.execute.after"]).toBeUndefined();
  });
});

describe("OpenCode 2", () => {
  function host(options: { promptHook?: boolean } = {}) {
    const after: Array<(event: any) => Promise<void> | void> = [];
    const prompt: Array<(event: any) => Promise<void> | void> = [];
    const toolDomain = {
      hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
        if (name === "execute.after") after.push(callback);
        return { dispose: async () => {} };
      },
    };
    const sessionDomain = options.promptHook === false
      ? {}
      : {
          hook: async (name: string, callback: (event: any) => Promise<void> | void) => {
            if (name === "prompt") prompt.push(callback);
            return { dispose: async () => {} };
          },
        };
    return {
      toolDomain,
      sessionDomain,
      after,
      prompt: async (sessionID: string) => {
        for (const callback of prompt) await callback({ sessionID, messageID: "m", prompt: { text: "go" }, delivery: "queue" });
      },
      /** A finished tool call through every execute.after hook; returns the result the host would keep. */
      call: async (tool: string, input: unknown, extra: Record<string, unknown> = {}) => {
        const event: Record<string, any> = { tool, sessionID: "s1", agent: "build", messageID: "m", id: "c", input, status: "completed", result: { content: skillOutput }, ...extra };
        for (const callback of after) await callback(event);
        return event.result;
      },
    };
  }
  const notSubagent = async () => false;

  test("the skill tool loading a grill-me skill gets the note after its content", async () => {
    const h = host();
    expect(await registerGrillMeOpenCode2(h.toolDomain, h.sessionDomain, { isSubagent: notSubagent, wakes: true })).toBe(true);
    expect(await h.call("skill", { name: "x:grill-me" })).toEqual({ content: `${skillOutput}\n\n${GRILL_ME_NOTE_TEXT}` });
    await h.prompt("s1");
    const parts = await h.call("skill", { name: "grill_me" }, { result: { content: [{ type: "text", text: "skill" }] } });
    expect(parts).toEqual({ content: [{ type: "text", text: "skill" }, { type: "text", text: GRILL_ME_NOTE_TEXT }] });
  });

  test("another skill, a failed call and a subagent's call get nothing", async () => {
    const h = host();
    await registerGrillMeOpenCode2(h.toolDomain, h.sessionDomain, { isSubagent: async ({ agent }) => agent === "explore", wakes: true });
    expect(await h.call("skill", { name: "grilled-cheese" })).toEqual({ content: skillOutput });
    expect(await h.call("read", { name: "grill-me" })).toEqual({ content: skillOutput });
    expect(await h.call("skill", { name: "grill-me" }, { agent: "explore" })).toEqual({ content: skillOutput });
    const failed = await h.call("skill", { name: "grill-me" }, { status: "error", result: undefined });
    expect(failed).toBeUndefined();
  });

  test("once per turn; the next prompt starts over; without the prompt hook every load gets it", async () => {
    const h = host();
    await registerGrillMeOpenCode2(h.toolDomain, h.sessionDomain, { isSubagent: notSubagent, wakes: false });
    expect(await h.call("skill", { name: "grill-me" })).toEqual({ content: `${skillOutput}\n\n${GRILL_ME_NOTE_TEXT_NO_WAKE}` });
    expect(await h.call("skill", { name: "grilling" })).toEqual({ content: skillOutput });
    await h.prompt("s1");
    expect((await h.call("skill", { name: "grilling" })).content).toContain(GRILL_ME_NOTE_TEXT_NO_WAKE);

    const bare = host({ promptHook: false });
    await registerGrillMeOpenCode2(bare.toolDomain, bare.sessionDomain, { isSubagent: notSubagent, wakes: true });
    expect((await bare.call("skill", { name: "grill-me" })).content).toContain(GRILL_ME_NOTE_TEXT);
    expect((await bare.call("skill", { name: "grilling" })).content).toContain(GRILL_ME_NOTE_TEXT);
  });

  test("a host without a tool hook gets nothing; a result shape it does not know is left alone", async () => {
    expect(await registerGrillMeOpenCode2({}, undefined, { isSubagent: notSubagent, wakes: true })).toBe(false);
    expect(withGrillMeNote({ output: { structured: true } }, "note")).toBeNull();
    expect(withGrillMeNote({ output: "text" }, "note")).toEqual({ output: "text", content: "text\n\nnote" });
  });

  test("the plugin wires it with the Inbox tool and the reminder on, and not with the reminder off", async () => {
    const setup = async () => {
      const h = host();
      const context = {
        options: { workflow: "manual" },
        agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary" }, { id: "explore", name: "explore", mode: "subagent" }] }) },
        // A root session: no parentID.
        session: { get: async () => ({ id: "s1" }), hook: h.sessionDomain.hook },
        tool: { transform: async () => ({ dispose: async () => {} }), hook: h.toolDomain.hook },
      };
      await serverPlugin.setup(context as never);
      return h;
    };

    rememberedInbox({ inboxTool: { opencode: true } });
    const on = await setup();
    // No session.prompt on this host: no wake, so the read-it-later wording.
    expect(await on.call("skill", { name: "grill-me" })).toEqual({ content: `${skillOutput}\n\n${GRILL_ME_NOTE_TEXT_NO_WAKE}` });
    await on.prompt("s1");
    expect(await on.call("skill", { name: "grill-me" }, { agent: "explore" })).toEqual({ content: skillOutput });

    rememberedInbox({ inboxTool: { opencode: true }, inboxReminder: false });
    const off = await setup();
    expect(off.after).toHaveLength(0);
    expect(await off.call("skill", { name: "grill-me" })).toEqual({ content: skillOutput });
  });
});
