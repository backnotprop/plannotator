/**
 * Routines on a real Inbox (temp data dir, the fake agent, a stand-in login item): the switch and what it
 * hides, the window's routes, and the agents' `routine` tool. What each test guards: off, agents get no tool
 * and a call writes nothing, the routes answer the plain off answer; on, the login item is added and removed with the
 * switch; an agent's routine arrives off and only the person turns it on the first time; a refused schedule
 * writes nothing; an agent's edit says old and new in its thread, and a folder move turns it off again.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { startInboxServer } from "./inbox";

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

async function world() {
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
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, launchHosts: () => [fake.host], scheduledLogin: login });
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
  return { server, base, folder, other, fake, login, rpc, tools, call, window, setOn, thread, lines, daily };
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
