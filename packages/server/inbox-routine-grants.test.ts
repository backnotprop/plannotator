/**
 * `/create-routine` grants (inbox-routine-grants.ts) and the `routine` tool's create taking one, on a real store and
 * routines engine over a temp data dir (no server, no clock started; every schedule is in 2099 and the agent is the
 * test's fake, so nothing can run). What regresses:
 *  - a message that is not the person's Send of the BUILT-IN /create-routine minting a grant: an agent's message with
 *    the same block, a skill of the person's own by that name, another built-in, a block that is not the message's
 *    end, a routine run's divider (its prompt is an agent's to edit);
 *  - a grant used twice, by another thread, by a session the Send did not go to (another agent in the thread, a
 *    shell that names none), after its hour; lost when the create is refused before anything is saved, or given back
 *    after the routine was saved;
 *  - a granted create arriving off, or its result not saying on and its next run; an ungranted one arriving on, or
 *    its result not saying why it is off.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { INBOX_REPLY_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { builtinSkillContent, composeInboxSkillsBlock, withSkillsBlock } from "../inbox/skills";
import { createInboxLaunch } from "./inbox-launch";
import { registerInboxScheduledTool } from "./inbox-mcp-scheduled";
import { createInboxScheduled, type InboxScheduled } from "./inbox-scheduled";
import { createRoutineGrants, mintsRoutineGrant, ROUTINE_GRANT_MS, sendRecipients } from "./inbox-routine-grants";

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

type SkillCatalogEntry = Parameters<typeof composeInboxSkillsBlock>[0][number];
type SkillExportContent = NonNullable<ReturnType<typeof builtinSkillContent>>;

const BUILTIN: SkillCatalogEntry ={ name: CREATE_ROUTINE_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true, description: CREATE_ROUTINE_SKILL.description };
const WORDS = "/create-routine every weekday at 9 check for outdated dependencies";

/** The block the window composes at the Send, from its own text for a built-in. */
function blockOf(entry: SkillCatalogEntry, content?: SkillExportContent): string {
  const contents = new Map<string, SkillExportContent>();
  const text = content ?? builtinSkillContent(entry);
  if (text) contents.set(entry.name, text);
  return composeInboxSkillsBlock([entry], contents, INBOX_REPLY_SKILL_AUDIENCE);
}

const PERSON_SEND = withSkillsBlock(WORDS, blockOf(BUILTIN));

describe("what mints a grant", () => {
  test("the person's Send of the built-in does; the same block from an agent, or as a run's prompt, does not", () => {
    expect(mintsRoutineGrant({ author: { kind: "person" }, body: PERSON_SEND })).toBe(true);
    expect(mintsRoutineGrant({ author: { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" }, body: PERSON_SEND })).toBe(false);
    expect(mintsRoutineGrant({ author: { kind: "person" }, body: PERSON_SEND, scheduled_run: { scheduled_id: "sch_x", name: "x", due_at: "2099-01-01T00:00:00.000Z", by: "schedule" } as InboxMessage["scheduled_run"] })).toBe(false);
  });

  test("a skill of the person's own named create-routine, another built-in, or a block before more words do not", () => {
    const own: SkillCatalogEntry = { name: "create-routine", root: "claude", humanOnly: true, description: "Mine." };
    const ownBlock = blockOf(own, { content: "# Mine\n\nDo it my way.", truncated: false, dir: "/x", path: "/x/SKILL.md" });
    expect(ownBlock).toContain("--- BEGIN SKILL INSTRUCTIONS: create-routine ---");
    expect(mintsRoutineGrant({ author: { kind: "person" }, body: withSkillsBlock(WORDS, ownBlock) })).toBe(false);

    const shape: SkillCatalogEntry = { name: "shape", root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true, description: "Shape." };
    expect(mintsRoutineGrant({ author: { kind: "person" }, body: withSkillsBlock("/shape a board", blockOf(shape)) })).toBe(false);

    expect(mintsRoutineGrant({ author: { kind: "person" }, body: `${PERSON_SEND}\n\nAnd one more thing.` })).toBe(false);
    expect(mintsRoutineGrant({ author: { kind: "person" }, body: WORDS })).toBe(false);
  });
});

describe("a grant", () => {
  const send = (id: string, thread: string, at: number): InboxMessage =>
    ({ id, thread_id: thread, project_id: "prj_x", reply_to: thread, author: { kind: "person" }, subject: null, body: PERSON_SEND, created_at: new Date(at).toISOString(), resolved_at: null }) as InboxMessage;
  /** Who each Send went to, as the store would say. */
  const to: Record<string, string[]> = { msg_send: ["ses_maya"], msg_a: ["ses_maya"], msg_two: ["ses_maya", "ses_tagged"], msg_nobody: [] };
  const grantsAt = (clock: { now: number }) => createRoutineGrants((id) => to[id] ?? [], () => clock.now);

  test("is taken once, only in its own thread by a session it went to, and the same Send never mints a second", () => {
    const clock = { now: Date.parse("2026-11-17T12:00:00.000Z") };
    const grants = grantsAt(clock);
    grants.noteSend(send("msg_send", "msg_thread", clock.now));
    grants.noteSend(send("msg_send", "msg_thread", clock.now));
    expect(grants.take("msg_other", "ses_maya")).toEqual({ grant: null, for_another: false });
    expect(grants.take(null, "ses_maya")).toEqual({ grant: null, for_another: false });
    // Another agent in the thread, and a caller that names no session: none, and the thread holds one for another.
    expect(grants.take("msg_thread", "ses_other")).toEqual({ grant: null, for_another: true });
    expect(grants.take("msg_thread", "")).toEqual({ grant: null, for_another: true });
    expect(grants.take("msg_thread", "ses_maya").grant).toMatchObject({ thread_id: "msg_thread", message_id: "msg_send" });
    expect(grants.take("msg_thread", "ses_maya")).toEqual({ grant: null, for_another: false });
    // Written again (delivered, seen): still none.
    grants.noteSend(send("msg_send", "msg_thread", clock.now));
    expect(grants.take("msg_thread", "ses_maya").grant).toBeNull();
  });

  test("a session the Send tags takes it too; a Send that went to no session is taken by nobody", () => {
    const clock = { now: Date.parse("2026-11-17T12:00:00.000Z") };
    const grants = grantsAt(clock);
    grants.noteSend(send("msg_two", "msg_thread", clock.now));
    expect(grants.take("msg_thread", "ses_tagged").grant).toMatchObject({ message_id: "msg_two" });
    grants.noteSend(send("msg_nobody", "msg_lone", clock.now));
    for (const session of ["ses_maya", "ses_other", ""]) expect(grants.take("msg_lone", session).grant).toBeNull();
  });

  test("lasts an hour from the Send", () => {
    const clock = { now: Date.parse("2026-11-17T12:00:00.000Z") };
    const grants = grantsAt(clock);
    grants.noteSend(send("msg_a", "msg_thread", clock.now));
    clock.now += ROUTINE_GRANT_MS - 1;
    expect(grants.open()).toHaveLength(1);
    clock.now += 1;
    expect(grants.take("msg_thread", "ses_maya")).toEqual({ grant: null, for_another: false });
    expect(ROUTINE_GRANT_MS).toBe(60 * 60_000);
  });

  test("given back after a refused create, while its hour lasts", () => {
    const clock = { now: Date.parse("2026-11-17T12:00:00.000Z") };
    const grants = grantsAt(clock);
    grants.noteSend(send("msg_a", "msg_thread", clock.now));
    const taken = grants.take("msg_thread", "ses_maya").grant!;
    grants.restore(taken);
    grants.restore(taken);
    expect(grants.open()).toHaveLength(1);
    expect(grants.take("msg_thread", "ses_maya").grant).toBe(taken);
    clock.now += ROUTINE_GRANT_MS;
    grants.restore(taken);
    expect(grants.open()).toHaveLength(0);
  });
});

type Tool = (input: Record<string, unknown>) => Promise<{ content: { text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean }>;

function world() {
  const root = mkdtempSync(join(tmpdir(), "plannotator-routine-grants-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "project");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
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
  const grants = createRoutineGrants(sendRecipients(store), () => clock.now);
  const tools: Record<string, Tool> = {};
  const server = { registerTool: (name: string, _config: unknown, handler: Tool) => void (tools[name] = handler) } as unknown as McpServer;
  registerInboxScheduledTool(server, { scheduledOn: () => true, scheduled: () => scheduled, routineGrants: () => grants });
  const AGENT = { kind: "agent" as const, host: FAKE, session: "ses_maya", name: "Fake Agent" };
  /** A thread the agent asked in, and the person's reply there: with the built-in, it is noted as the Send routes do. */
  const thread = (words: string, feedback?: string) => {
    const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "What should I set up?" }).message;
    const { reply } = store.sendReply(asked.id, { idempotency_key: `k_${asked.id}`, words, questions: [], ...(feedback ? { feedback } : {}) });
    grants.noteSend(reply);
    return asked.thread_id;
  };
  const create = (over: Record<string, unknown> = {}) =>
    tools.routine!({ op: "create", name: "Dependency check", prompt: "Check for outdated dependencies.", schedule: { at: "2099-01-05T09:00", tz: "America/New_York" }, folder: { scratch: true }, agent: FAKE, agent_host: FAKE, agent_session: "ses_maya", agent_name: "Fake Agent", ...over });
  return { store, project, grants, thread, create, clock, tool: (input: Record<string, unknown>) => tools.routine!({ agent_host: FAKE, agent_session: "ses_maya", ...input }) };
}

describe("routine create with the person's /create-routine", () => {
  test("in the thread the person asked in: made on and approved, and the result says on and its next run", async () => {
    const w = world();
    const threadId = w.thread(WORDS, blockOf(BUILTIN));
    const made = await w.create({ thread_id: threadId });
    expect(made.isError).toBeUndefined();
    const text = made.content[0]!.text;
    expect(text).toMatch(/^Made sch_\w+ "Dependency check": on, .+, next 2099-01-05T14:00:00\.000Z\. /);
    expect(text).not.toContain("not yet turned on");
    expect(text).toContain(` It is on: the person asked for it with /create-routine in thread ${threadId}.`);
    expect(made.structuredContent).toMatchObject({ asked_with_create_routine: true, scheduled: { enabled: true, next_run: "2099-01-05T14:00:00.000Z" } });
    const [record] = w.store.scheduledThreads();
    expect(record).toMatchObject({ enabled: true, approved_at: "2026-11-17T14:00:00.000Z" });
    // The person's line in their thread says so.
    const line = w.store.message(w.store.threadMessageIds(threadId).at(-1)!)!;
    expect(line.body).toBe(`Made the routine [Dependency check](#routine=${record!.id}). It is on, as you asked with /create-routine.`);
    // One Send, one routine: the next create there arrives off and says why.
    const again = await w.create({ name: "Second", thread_id: threadId });
    expect(again.content[0]!.text).toContain(`: off, `);
    expect(again.content[0]!.text).toContain(`No /create-routine request from the person in thread ${threadId} that this Inbox still holds (one lasts an hour and makes one routine, and an Inbox restart forgets it), so it is off until the person turns it on in Routines in the Inbox.`);
    expect(again.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false, approved_at: null } });
  });

  test("without --thread, in another thread, or after the hour: off as before, saying why", async () => {
    const w = world();
    const asked = w.thread(WORDS, blockOf(BUILTIN));
    const other = w.thread("Thanks.");

    const none = await w.create();
    expect(none.content[0]!.text).toContain(", not yet turned on by the person");
    expect(none.content[0]!.text).toContain(" It is off until the person turns it on in Routines in the Inbox. A create starts on only with thread_id (--thread from a shell) naming the thread where the person asked for it with /create-routine.");

    const elsewhere = await w.create({ thread_id: other });
    expect(elsewhere.content[0]!.text).toContain(`No /create-routine request from the person in thread ${other} that this Inbox still holds`);

    w.clock.now += ROUTINE_GRANT_MS;
    const late = await w.create({ thread_id: asked });
    expect(late.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false, approved_at: null } });
    expect(w.store.scheduledThreads().every((record) => !record.enabled && record.approved_at === null)).toBe(true);
    // And an agent still cannot turn one on.
    const on = await w.tool({ op: "on", id: w.store.scheduledThreads()[0]!.id });
    expect(on.content[0]!.text).toStartWith("routine_not_approved: ");
  });

  test("a create the server refuses gives the grant back: the next good one is on", async () => {
    const w = world();
    const threadId = w.thread(WORDS, blockOf(BUILTIN));
    const refused = await w.create({ thread_id: threadId, schedule: { cron: "* * * * *" } });
    expect(refused.isError).toBe(true);
    expect(w.store.scheduledThreads()).toHaveLength(0);
    const made = await w.create({ thread_id: threadId });
    expect(made.structuredContent).toMatchObject({ asked_with_create_routine: true, scheduled: { enabled: true } });
  });

  test("another agent session in the thread does not take it: off, saying it was for another agent; the one asked then takes it", async () => {
    const w = world();
    const threadId = w.thread(WORDS, blockOf(BUILTIN));
    const theirs = await w.create({ thread_id: threadId, agent_session: "ses_other", name: "Not mine" });
    expect(theirs.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false, approved_at: null } });
    expect(theirs.content[0]!.text).toContain(` The /create-routine request from the person in thread ${threadId} was for another agent session, not yours, so it is off until the person turns it on in Routines in the Inbox.`);
    expect(theirs.content[0]!.text).not.toContain("names no agent session");
    const mine = await w.create({ thread_id: threadId });
    expect(mine.structuredContent).toMatchObject({ asked_with_create_routine: true, scheduled: { enabled: true } });
  });

  test("a call that names no session (a shell with none) is told so, never that it was for another; its Inbox tool, naming the session, then makes it on", async () => {
    const w = world();
    const threadId = w.thread(WORDS, blockOf(BUILTIN));
    const shell = await w.create({ thread_id: threadId, agent_session: "", name: "From a bare shell" });
    expect(shell.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false, approved_at: null } });
    const text = shell.content[0]!.text;
    expect(text).toContain(` This call names no agent session, so it could not be matched to the person's /create-routine request in thread ${threadId}, and it is off until the person turns it on in Routines in the Inbox. To have it on, delete it and make it again with your Inbox tool's routine action, or from the shell with --session and your session id.`);
    expect(text).not.toContain("another agent session");
    // The tool call, with the session the connection fills (agent_session ses_…), takes the grant the bare shell left.
    const tool = await w.create({ thread_id: threadId });
    expect(tool.content[0]!.text).toContain(` It is on: the person asked for it with /create-routine in thread ${threadId}.`);
    expect(tool.structuredContent).toMatchObject({ asked_with_create_routine: true, scheduled: { enabled: true } });
  });

  test("an agent's message carrying the same block grants nothing", async () => {
    const w = world();
    const agentMessage = w.store.sendMessage({ project_id: w.project.id, author: { kind: "agent", host: FAKE, session: "ses_other", name: "Other" }, body: PERSON_SEND }).message;
    w.grants.noteSend(agentMessage);
    expect(w.grants.open()).toHaveLength(0);
    const made = await w.create({ thread_id: agentMessage.thread_id });
    expect(made.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false } });
  });
});

describe("the grant after a create that fails", () => {
  /** The tool over a stand-in routines engine whose create fails before or after its fields pass (`checked`). */
  function failing(after: boolean) {
    const clock = { now: Date.parse("2026-11-17T12:00:00.000Z") };
    const grants = createRoutineGrants(() => ["ses_maya"], () => clock.now);
    grants.noteSend({ id: "msg_send", thread_id: "msg_thread", project_id: "prj_x", reply_to: "msg_thread", author: { kind: "person" }, subject: null, body: PERSON_SEND, created_at: new Date(clock.now).toISOString(), resolved_at: null } as InboxMessage);
    const scheduled = {
      create: async (_input: unknown, _by: unknown, _key: unknown, _asked: unknown, checked?: () => void) => {
        if (after) {
          checked?.();
          throw new InboxError("internal_error", "the line for the person could not be written");
        }
        throw new InboxError("validation_error", "name: required.", { field: "name" });
      },
    } as unknown as InboxScheduled;
    const tools: Record<string, Tool> = {};
    const server = { registerTool: (name: string, _config: unknown, handler: Tool) => void (tools[name] = handler) } as unknown as McpServer;
    registerInboxScheduledTool(server, { scheduledOn: () => true, scheduled: () => scheduled, routineGrants: () => grants });
    const create = () => tools.routine!({ op: "create", name: "x", prompt: "p", folder: { scratch: true }, agent_host: FAKE, agent_session: "ses_maya", thread_id: "msg_thread" });
    return { grants, create };
  }

  test("refused before anything is saved: given back", async () => {
    const w = failing(false);
    expect((await w.create()).isError).toBe(true);
    expect(w.grants.open()).toHaveLength(1);
  });

  test("failed after its fields passed (the routine may be saved): it stays used", async () => {
    const w = failing(true);
    expect((await w.create()).isError).toBe(true);
    expect(w.grants.open()).toHaveLength(0);
  });
});
