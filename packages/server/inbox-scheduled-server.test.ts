/**
 * Routines on a real Inbox (temp data dir, the fake agent, a stand-in login item): the switch and what it
 * hides, the window's routes, and the agents' `routine` tool. What each test guards: off, agents get no tool
 * and a call writes nothing, the routes answer the plain off answer; on, the login item is added and removed with the
 * switch; an agent's routine arrives off and only the person turns it on the first time; a refused schedule
 * writes nothing; an agent's edit says old and new in its thread, and a folder move turns it off again; the person's
 * own /create-routine Send turns on the one routine the agent it went to then makes in that thread: from the window
 * (reply, New message, a new thread), a paired phone, or a linked machine with the window's mark. A bare call to any
 * of those routes (no Origin, or the window's Origin without this run's serverSession), a stale tab, a linked machine
 * without the mark and an agent's own message with the same block mint nothing; another agent session in the thread
 * cannot take the person's approval.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { INBOX_REPLY_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { builtinSkillContent, composeInboxSkillsBlock, withSkillsBlock } from "../inbox/skills";
import { startInboxServer } from "./inbox";
import { parseLinkOffer } from "./inbox-links";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string | undefined) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: Record<string, any> };

async function world(options: { phones?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-scheduled-server-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  // The sandboxed Inbox's launcher reads this as home.
  const home = join(dataDir, "agents-home");
  const folder = join(home, "acme-api");
  const other = join(home, "acme-web");
  for (const dir of [dataDir, folder, other]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", dataDir);
  setEnv("HOME", home);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  setEnv("PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9");
  const fake = fakeLaunchHost();
  const login = { calls: [] as string[], path: null, add: async () => (login.calls.push("add"), "added" as const), remove: async () => void login.calls.push("remove") };
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: options.phones ?? false, launchHosts: () => [fake.host], scheduledLogin: login });
  restore.push(() => server.stop());
  const base = `http://127.0.0.1:${server.port}`;
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data:"));
    return JSON.parse(data ? data.slice(5) : text) as { result: any };
  };
  const tools = async () => ((await rpc("tools/list", {})).result.tools as { name: string }[]).map((tool) => tool.name);
  const agent = { agent_session: "ses_maya", agent_host: "claude-code", agent_name: "Claude Code", project_path: folder };
  const call = async (args: Record<string, unknown>) => (await rpc("tools/call", { name: "routine", arguments: { ...agent, ...args } })).result as ToolResult;
  const window = (path: string, body: Record<string, unknown> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
  const setOn = async (on: boolean) => (await window("/api/inbox/settings", { scheduled_threads: { on } })).json() as Promise<Record<string, any>>;
  const sent = (await rpc("tools/call", { name: "send_message", arguments: { ...agent, body: "Working on the triage.", subject: "Triage" } })).result as ToolResult;
  const thread = sent.structuredContent!.thread_id as string;
  const lines = () =>
    server.store
      .threadMessageIds(thread)
      .map((m) => server.store.message(m)!)
      .filter((m) => m.scheduled_change);
  const daily = { cron: "0 9 * * 1-5", tz: "America/New_York" };
  return { server, base, dataDir, folder, other, fake, login, rpc, tools, call, window, setOn, thread, lines, daily };
}

describe("the switch", () => {
  test("off, the default: no tool, a call writes nothing, every route answers the off answer", async () => {
    const w = await world();
    expect(await w.tools()).not.toContain("routine");
    const refused = await w.call({ op: "create", name: "Morning triage", prompt: "Triage.", schedule: w.daily, agent: FAKE });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toBe("routines_off: Routines are off on this computer, so nothing was written. The person turns them on in Settings, Capabilities.");
    const list = await fetch(`${w.base}/api/inbox/scheduled`);
    expect(list.status).toBe(404);
    expect(((await list.json()) as { code: string }).code).toBe("routines_off");
    expect((await w.window("/api/inbox/scheduled", { name: "x", prompt: "y", schedule: null, folder: { scratch: true }, agent: FAKE })).status).toBe(404);
    expect(w.server.store.scheduledThreads()).toEqual([]);
    expect(w.login.calls).toEqual([]);
    expect((await (await fetch(`${w.base}/api/inbox/settings`)).json()).scheduled_threads).toEqual({ on: false });
  });

  test("on adds the login item and the tool; off removes both", async () => {
    const w = await world();
    expect((await w.setOn(true)).scheduled_threads).toEqual({ on: true, login: "added" });
    expect(await w.tools()).toContain("routine");
    expect(w.login.calls).toEqual(["add"]);
    expect((await w.setOn(false)).scheduled_threads).toEqual({ on: false });
    expect(w.login.calls).toEqual(["add", "remove"]);
    expect(await w.tools()).not.toContain("routine");
  });
});

describe("agents", () => {
  test("an agent's routine arrives off; the person turns it on the first time", async () => {
    const w = await world();
    await w.setOn(true);
    const made = await w.call({ op: "create", name: "Morning triage", prompt: "Triage the new issues.", schedule: w.daily, agent: FAKE, thread_id: w.thread });
    expect(made.isError).toBeUndefined();
    const id = made.structuredContent!.scheduled.id as string;
    expect(w.server.store.scheduledThread(id)).toMatchObject({ enabled: false, approved_at: null, made_by: { session: "ses_maya", thread_id: w.thread } });
    expect(w.lines().map((m) => m.body)).toEqual([
      `Made the routine [Morning triage](#routine=${id}). It is off until you turn it on.`,
    ]);
    expect(w.lines()[0]!.author).toMatchObject({ kind: "agent", session: "ses_maya" });

    for (const op of ["on", "run"]) {
      const refused = await w.call({ op, id, thread_id: w.thread });
      expect(refused.content[0]!.text).toStartWith("routine_not_approved: The person turns Morning triage on the first time, in the Inbox.");
    }
    expect(w.server.store.scheduledThread(id)!.enabled).toBe(false);
    expect(w.lines()).toHaveLength(1);
    expect(w.fake.calls).toEqual([]);

    // Not from an agent's curl: the routes write only for the window.
    expect((await fetch(`${w.base}/api/inbox/scheduled/${id}/on`, { method: "POST", body: JSON.stringify({}) })).status).toBe(403);
    expect((await w.window(`/api/inbox/scheduled/${id}/on`)).status).toBe(200);
    expect(w.server.store.scheduledThread(id)!.approved_at).not.toBeNull();
    expect((await w.call({ op: "off", id, thread_id: w.thread })).content[0]!.text).toContain(": off,");
    expect((await w.call({ op: "on", id, thread_id: w.thread })).isError).toBeUndefined();
    expect(w.lines().map((m) => m.body).slice(1)).toEqual([
      `Turned the routine [Morning triage](#routine=${id}) off.`,
      `Turned the routine [Morning triage](#routine=${id}) on.`,
    ]);
  });

  test("closer than 15 minutes is refused and nothing is written", async () => {
    const w = await world();
    await w.setOn(true);
    const refused = await w.call({ op: "create", name: "Pinger", prompt: "Ping.", schedule: { cron: "*/5 * * * *", tz: "America/New_York" }, agent: FAKE, thread_id: w.thread });
    expect(refused.content[0]!.text).toBe("schedule_too_frequent: Scheduled times are at least 15 minutes apart. This one runs every 5 minutes.");
    expect(w.server.store.scheduledThreads()).toEqual([]);
    expect(w.lines()).toEqual([]);
    const preview = (await (await w.window("/api/inbox/scheduled/preview", { schedule: { cron: "*/5 * * * *", tz: "America/New_York" } })).json()) as Record<string, any>;
    expect(preview.refused).toMatchObject({ code: "schedule_too_frequent", every_minutes: 5 });
  });

  test("an agent with no folder and no project_path is told the fields it has; with no schedule it runs only when run", async () => {
    const w = await world();
    await w.setOn(true);
    const refused = await w.call({ op: "create", name: "Release notes", prompt: "Draft them.", schedule: null, agent: FAKE, project_path: undefined });
    expect(refused.content[0]!.text).toBe("validation_error: folder: { path } or { scratch: true }, or pass project_path.");
    const made = await w.call({ op: "create", name: "Release notes", prompt: "Draft them.", schedule: null, agent: FAKE });
    expect(made.content[0]!.text).toMatch(/^Made sch_\w+ "Release notes": off, runs only when run, fake-agent in ~\/acme-api, not yet turned on by the person, thread msg_\w+\. It is off/);
  });

  test("an agent's edit says old and new; a folder move turns it off and the person turns it on again", async () => {
    const w = await world();
    await w.setOn(true);
    const id = (await w.call({ op: "create", name: "Morning triage", prompt: "Triage the new issues.", schedule: w.daily, agent: FAKE, thread_id: w.thread })).structuredContent!.scheduled.id as string;
    await w.window(`/api/inbox/scheduled/${id}/on`);
    await w.call({ op: "update", id, prompt: "Triage the new issues.\nLabel each one.", schedule: { cron: "0 10 * * 1-5", tz: "America/New_York" }, thread_id: w.thread });
    const changed = w.lines().at(-1)!;
    expect(changed.body).toBe(
      [
        `Changed the routine [Morning triage](#routine=${id}).`,
        "It now runs every weekday at 10:00 AM (was every weekday at 9:00 AM).",
        "The prompt:\n\n```diff\n- Triage the new issues.\n+ Triage the new issues.\n+ Label each one.\n```",
      ].join("\n\n"),
    );
    expect(changed.scheduled_change).toEqual({ scheduled_id: id, name: "Morning triage", op: "update", fields: ["prompt", "schedule"] });
    expect(w.server.store.scheduledThread(id)!.enabled).toBe(true);

    await w.call({ op: "update", id, folder: { path: w.other }, thread_id: w.thread });
    const moved = w.lines().at(-1)!;
    expect(moved.body).toEndWith("It now works in ~/acme-web (was ~/acme-api).\n\nIt is off until you turn it on again.");
    expect(moved.scheduled_change).toMatchObject({ fields: ["folder"], turned_off: true });
    expect(w.server.store.scheduledThread(id)).toMatchObject({ enabled: false, approved_at: null });
    expect((await w.call({ op: "on", id })).content[0]!.text).toStartWith("routine_not_approved:");
  });
});

describe("the window's editor", () => {
  test("a create sent twice with one idempotency_key (a retry, a keepalive, a reloaded page's kept draft) makes one routine", async () => {
    const w = await world();
    await w.setOn(true);
    const fields = { name: "Feedback digest", prompt: "Read the feedback threads.", schedule: w.daily, folder: { scratch: true }, agent: FAKE, idempotency_key: "k-editor-1" };
    const [first, second] = await Promise.all([w.window("/api/inbox/scheduled", fields), w.window("/api/inbox/scheduled", fields)]);
    const third = await w.window("/api/inbox/scheduled", fields);
    const ids = await Promise.all([first, second, third].map(async (r) => ((await r.json()) as { scheduled: { id: string } }).scheduled.id));
    expect([first.status, second.status, third.status]).toEqual([201, 201, 201]);
    expect(new Set(ids).size).toBe(1);
    expect(w.server.store.scheduledThreads()).toHaveLength(1);
    // The key is kept on the record (so a restart still knows it) and never sent out.
    expect(w.server.store.scheduledThreads()[0]!.create_key).toBe("k-editor-1");
    expect(JSON.stringify(await (await fetch(`${w.base}/api/inbox/scheduled`)).json())).not.toContain("k-editor-1");
    // Another key is another routine.
    expect((await w.window("/api/inbox/scheduled", { ...fields, idempotency_key: "k-editor-2" })).status).toBe(201);
    expect(w.server.store.scheduledThreads()).toHaveLength(2);
  });
});

describe("/create-routine: the person's own Send turns on the routine it asks for", () => {
  const entry: Parameters<typeof composeInboxSkillsBlock>[0][number] = { name: CREATE_ROUTINE_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true, description: CREATE_ROUTINE_SKILL.description };
  const words = "/create-routine every weekday at 9 check for outdated dependencies";
  const block = composeInboxSkillsBlock([entry], new Map([[entry.name, builtinSkillContent(entry)!]]), INBOX_REPLY_SKILL_AUDIENCE);
  // In 2099: on or not, nothing comes due while the test runs.
  const far = { at: "2099-01-05T09:00", tz: "America/New_York" };
  const create = (w: Awaited<ReturnType<typeof world>>, name: string, thread_id?: string) =>
    w.call({ op: "create", name, prompt: "Check for outdated dependencies.", schedule: far, agent: FAKE, ...(thread_id ? { thread_id } : {}) });

  test("an agent's bare call to the reply route, or its own message with the same block, grants nothing", async () => {
    const w = await world();
    await w.setOn(true);
    // Written as the person's reply (the route is open to a local call), but not the person's own Send.
    const bare = await fetch(`${w.base}/api/inbox/messages/${w.thread}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotency_key: "k-bare", words, questions: [], feedback: block }) });
    expect(bare.status).toBe(200);
    const off = await create(w, "From a bare call", w.thread);
    expect(off.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false, approved_at: null } });
    expect(off.content[0]!.text).toContain(`No /create-routine request from the person in thread ${w.thread} that this Inbox still holds`);

    const own = (await w.rpc("tools/call", { name: "send_message", arguments: { agent_session: "ses_maya", agent_host: "claude-code", agent_name: "Claude Code", project_path: w.folder, body: `${words}\n\n${block}`, subject: "Routine" } })).result as ToolResult;
    const ownThread = own.structuredContent!.thread_id as string;
    const stillOff = await create(w, "From an agent's message", ownThread);
    expect(stillOff.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false } });
    expect(w.server.store.scheduledThreads().every((r) => !r.enabled && r.approved_at === null)).toBe(true);
    expect(w.fake.calls).toEqual([]);
  });

  test("the window's reply with /create-routine: the agent's create in that thread is on, once; Routines lists it on", async () => {
    const w = await world();
    await w.setOn(true);
    const sent = await w.window(`/api/inbox/messages/${w.thread}/reply`, { idempotency_key: "k-person", words, questions: [], feedback: block });
    expect(sent.status).toBe(200);
    // A replay of the same Send mints nothing more.
    expect((await w.window(`/api/inbox/messages/${w.thread}/reply`, { idempotency_key: "k-person", words, questions: [], feedback: block })).status).toBe(200);

    // Another agent session that names this thread does not take the person's approval: the reply went to ses_maya.
    const theirs = await w.call({ op: "create", name: "Not theirs", prompt: "p", schedule: far, agent: FAKE, thread_id: w.thread, agent_session: "ses_other" });
    expect(theirs.structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false, approved_at: null } });
    expect(theirs.content[0]!.text).toContain(`The /create-routine request from the person in thread ${w.thread} was for another agent session, not yours`);
    await w.call({ op: "delete", id: theirs.structuredContent!.scheduled.id, agent_session: "ses_other" });

    const made = await create(w, "Dependency check", w.thread);
    expect(made.isError).toBeUndefined();
    expect(made.content[0]!.text).toMatch(/^Made sch_\w+ "Dependency check": on, .+, next 2099-01-05T14:00:00\.000Z\. It is on: the person asked for it with \/create-routine in thread msg_\w+\. The person sees it in thread msg_\w+\.$/);
    const id = made.structuredContent!.scheduled.id as string;
    expect(w.server.store.scheduledThread(id)).toMatchObject({ enabled: true, made_by: { session: "ses_maya", thread_id: w.thread } });
    expect(w.server.store.scheduledThread(id)!.approved_at).not.toBeNull();
    // The other session's line first (off), then this one's (on).
    expect(w.lines().map((m) => m.body)).toEqual([
      `Made the routine [Not theirs](#routine=${theirs.structuredContent!.scheduled.id}). It is off until you turn it on.`,
      `Made the routine [Dependency check](#routine=${id}). It is on, as you asked with /create-routine.`,
    ]);
    // Routines, as the window reads it: on.
    const listed = (await (await fetch(`${w.base}/api/inbox/scheduled`)).json()) as { scheduled: { id: string; enabled: boolean; state: string; next_run: string | null }[] };
    expect(listed.scheduled.find((row) => row.id === id)).toMatchObject({ enabled: true, next_run: "2099-01-05T14:00:00.000Z" });

    // One Send, one routine; and without --thread, off as before.
    expect((await create(w, "Second", w.thread)).structuredContent).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false } });
    expect((await create(w, "Third")).content[0]!.text).toContain("It is off until the person turns it on in Routines in the Inbox.");
    // Turned on, an agent may change it as before; it never started anything here.
    expect((await w.call({ op: "off", id, thread_id: w.thread })).isError).toBeUndefined();
    expect((await w.call({ op: "on", id, thread_id: w.thread })).isError).toBeUndefined();
    expect(w.fake.calls).toEqual([]);
    await w.call({ op: "delete", id });
  });
});

describe("/create-routine: who mints, on every Send route and door", () => {
  const entry: Parameters<typeof composeInboxSkillsBlock>[0][number] = { name: CREATE_ROUTINE_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true, description: CREATE_ROUTINE_SKILL.description };
  const words = "/create-routine every weekday at 9 check for outdated dependencies";
  const block = composeInboxSkillsBlock([entry], new Map([[entry.name, builtinSkillContent(entry)!]]), INBOX_REPLY_SKILL_AUDIENCE);
  const far = { at: "2099-01-05T09:00", tz: "America/New_York" };
  type W = Awaited<ReturnType<typeof world>>;
  let n = 0;
  const key = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  /** The agent the person writes to (ses_maya) makes a routine in `thread`: was it on? Deleted again, so none is left on. */
  const madeOn = async (w: W, thread: string): Promise<boolean> => {
    const made = await w.call({ op: "create", name: `Routine ${key()}`, prompt: "Check for outdated dependencies.", schedule: far, agent: FAKE, thread_id: thread });
    expect(made.isError).toBeUndefined();
    await w.call({ op: "delete", id: made.structuredContent!.scheduled.id });
    return made.structuredContent!.asked_with_create_routine === true && made.structuredContent!.scheduled.enabled === true;
  };
  const post = (w: W, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetch(`${w.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  /** ses_maya live in the project, as its connection's poll makes it (New message and a new thread need a live session). */
  const live = async (w: W) => {
    const { token } = JSON.parse(readFileSync(join(w.dataDir, "inbox", "inbox.json"), "utf8")) as { token: string };
    const polled = await post(w, "/api/inbox/bridge/poll", { session: "ses_maya", host: "claude-code", project_path: w.folder, started_at: new Date().toISOString(), busy: false, waitMs: 0 }, { Authorization: `Bearer ${token}` });
    expect(polled.status).toBe(200);
  };
  const reply = (extra: Record<string, unknown>) => ({ idempotency_key: key(), words, questions: [], feedback: block, ...extra });
  const newMessage = (extra: Record<string, unknown>) => ({ session: "ses_maya", body: withSkillsBlock(words, block), idempotency_key: key(), ...extra });
  const newThread = (extra: Record<string, unknown>) => ({ to: { host: "claude-code", session: "ses_maya" }, body: withSkillsBlock(words, block), idempotency_key: key(), ...extra });
  const threadOf = async (response: Response) => ((await response.json()) as { thread_id: string }).thread_id;

  test("the window's Origin without this run's serverSession, or with another run's, mints nothing on any Send route", async () => {
    const w = await world();
    await w.setOn(true);
    await live(w);
    const origin = { Origin: w.base };
    for (const serverSession of [undefined, "older-run"]) {
      const extra = serverSession ? { serverSession } : {};
      // Whatever each route answers (written as the person's, or refused), no grant comes of it.
      await post(w, `/api/inbox/messages/${w.thread}/reply`, reply(extra), origin);
      await post(w, `/api/inbox/threads/${w.thread}/message`, newMessage(extra), origin);
      expect([serverSession, await madeOn(w, w.thread)]).toEqual([serverSession, false]);
      const started = await post(w, "/api/inbox/messages", newThread(extra), origin);
      if (started.status === 200) expect([serverSession, await madeOn(w, await threadOf(started))]).toEqual([serverSession, false]);
    }
    expect(w.fake.calls).toEqual([]);
  });

  test("New message and a new thread mint from the window, never from a bare call", async () => {
    const w = await world();
    await w.setOn(true);
    await live(w);
    const origin = { Origin: w.base };
    const session = { serverSession: w.server.serverSession };
    // New message, bare (with this run's serverSession, no Origin): nothing minted. From the window: the agent it went to makes it on.
    await post(w, `/api/inbox/threads/${w.thread}/message`, newMessage(session));
    expect(await madeOn(w, w.thread)).toBe(false);
    expect((await post(w, `/api/inbox/threads/${w.thread}/message`, newMessage(session), origin)).status).toBe(200);
    expect(await madeOn(w, w.thread)).toBe(true);
    // A new thread, bare (if the route takes it at all): nothing minted. From the window: on.
    const bare = await post(w, "/api/inbox/messages", newThread(session));
    if (bare.status === 200) expect(await madeOn(w, await threadOf(bare))).toBe(false);
    const started = await post(w, "/api/inbox/messages", newThread(session), origin);
    expect(started.status).toBe(200);
    expect(await madeOn(w, await threadOf(started))).toBe(true);
    expect(w.fake.calls).toEqual([]);
  });

  test("a paired phone mints; a linked machine mints with the window's mark and not without", async () => {
    const w = await world({ phones: true });
    await w.setOn(true);
    // The person's phone, paired through the real routes: its reply through the device door is the person's.
    const made = (await (await post(w, "/api/inbox/pairing", {})).json()) as { offer: { code: string } };
    const phone = ((await (await post(w, "/api/inbox/device/pair", { code: made.offer.code, name: "iPhone", platform: "ios" })).json()) as { token: string }).token;
    expect((await post(w, `/api/inbox/device/messages/${w.thread}/reply`, reply({}), { Authorization: `Bearer ${phone}` })).status).toBe(200);
    expect(await madeOn(w, w.thread)).toBe(true);

    // A linked machine: its forward of a press in its window carries the mark; an agent's bare call through it does not.
    const offered = (await (await post(w, "/api/inbox/machines/offer", {})).json()) as { link: string };
    const secret = parseLinkOffer(offered.link)!.secret;
    const machine = ((await (await post(w, "/api/inbox/device/pair", { name: "MacBook", platform: "machine", secret })).json()) as { token: string }).token;
    const bearer = { Authorization: `Bearer ${machine}` };
    expect((await post(w, `/api/inbox/device/messages/${w.thread}/reply`, reply({}), bearer)).status).toBe(200);
    expect(await madeOn(w, w.thread)).toBe(false);
    expect((await post(w, `/api/inbox/device/messages/${w.thread}/reply`, reply({}), { ...bearer, "X-Plannotator-Window": "1" })).status).toBe(200);
    expect(await madeOn(w, w.thread)).toBe(true);
    expect(w.fake.calls).toEqual([]);
  });
});
