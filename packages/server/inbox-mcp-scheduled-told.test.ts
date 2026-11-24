/**
 * The `routine` tool's result says what changed and where the person's line went, on a real store and routines
 * engine over a temp data dir (no server, no clock started; the schedule is in 2099 and the agent is the test's fake,
 * so nothing can run). A scratch routine made from a shell that names no thread, while New message is off, has no
 * thread and no project to post its change line in. What regresses:
 *  - an update that changed the name, schedule or prompt saying "Nothing changed" because no line was posted;
 *  - a change with no line posted saying nothing about it (the agent then thinks the person saw it);
 *  - an update or on/off that changed nothing claiming a change or a missing line;
 *  - a change with a thread not saying which thread the person sees it in.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import { NO_CHANGE_LINE, registerInboxScheduledTool } from "./inbox-mcp-scheduled";
import { createInboxScheduled } from "./inbox-scheduled";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

type Tool = (input: Record<string, unknown>) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, any>; isError?: boolean }>;

function world() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-routine-told-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  // New message is off: a scratch routine has no project to make its own thread in.
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: false } }));
  const clock = { now: Date.parse("2026-11-17T14:00:00.000Z") };
  const store = InboxStore.open(dataDir, { now: () => new Date(clock.now) });
  const project = store.ensureProject({ name: "project", root: folder });
  const fake = fakeLaunchHost();
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => ({ HOME: home, PATH: "" }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => [fake.host],
    now: () => clock.now,
  });
  restore.push(() => launch.stop());
  const scheduled = createInboxScheduled({
    store,
    launch,
    on: () => true,
    launchOn: () => launch.settingsState().enabled,
    resolveProject: async () => store.project(project.id)!,
    recordAttachments: async () => [],
    displayFolder: (path) => path,
    now: () => clock.now,
  });
  restore.push(() => scheduled.stop());
  const tools: Record<string, Tool> = {};
  const server = { registerTool: (name: string, _config: unknown, handler: Tool) => void (tools[name] = handler) } as unknown as McpServer;
  registerInboxScheduledTool(server, { scheduledOn: () => true, scheduled: () => scheduled });
  const tool = (input: Record<string, unknown>) => tools.routine!({ agent_host: FAKE, agent_session: "ses_maya", agent_name: "Fake Agent", ...input });
  const thread = () => store.sendMessage({ project_id: project.id, author: { kind: "agent", host: FAKE, session: "ses_maya", name: "Fake Agent" }, body: "Working on it." }).message.thread_id;
  return { store, scheduled, tool, thread };
}

describe("routine results with no thread to post the person's line in", () => {
  test("an update that changed fields says Changed and that no line was posted; one that changed nothing says Nothing changed", async () => {
    const w = world();
    const made = await w.tool({ op: "create", name: "CLI weekly notes", prompt: "Write the notes.", schedule: { cron: "0 16 * * 5", tz: "America/New_York" }, folder: { scratch: true }, agent: FAKE });
    expect(made.isError).toBeUndefined();
    expect(made.content[0]!.text).toEndWith(NO_CHANGE_LINE);
    const id = made.structuredContent!.scheduled.id as string;
    expect(w.scheduled.get(id).scheduled.thread_id).toBeNull();

    const renamed = await w.tool({ op: "update", id, name: "CLI Friday notes", schedule: { cron: "30 15 * * 5", tz: "America/New_York" } });
    expect(renamed.content[0]!.text).toStartWith(`Changed ${id} "CLI Friday notes": `);
    expect(renamed.content[0]!.text).toEndWith(NO_CHANGE_LINE);

    const prompt = await w.tool({ op: "update", id, prompt: "Write the Friday notes." });
    expect(prompt.content[0]!.text).toStartWith(`Changed ${id} `);
    expect(prompt.content[0]!.text).toEndWith(NO_CHANGE_LINE);

    const same = await w.tool({ op: "update", id, name: "CLI Friday notes" });
    expect(same.content[0]!.text).toStartWith(`Nothing changed in ${id} `);
    expect(same.content[0]!.text).not.toContain(NO_CHANGE_LINE);

    // Already off: nothing changed, so no word about a line.
    const off = await w.tool({ op: "off", id });
    expect(off.content[0]!.text).not.toContain(NO_CHANGE_LINE);

    const deleted = await w.tool({ op: "delete", id });
    expect(deleted.content[0]!.text).toEndWith(NO_CHANGE_LINE);
  });

  test("with thread_id the line goes there and the result names that thread", async () => {
    const w = world();
    const threadId = w.thread();
    const made = await w.tool({ op: "create", name: "Weekly notes", prompt: "Write the notes.", schedule: null, folder: { scratch: true }, agent: FAKE, thread_id: threadId });
    const id = made.structuredContent!.scheduled.id as string;
    const changed = await w.tool({ op: "update", id, name: "Friday notes", thread_id: threadId });
    expect(changed.content[0]!.text).toStartWith(`Changed ${id} "Friday notes": `);
    expect(changed.content[0]!.text).toEndWith(` The person sees it in thread ${threadId}.`);
    expect(changed.content[0]!.text).not.toContain(NO_CHANGE_LINE);
  });
});
