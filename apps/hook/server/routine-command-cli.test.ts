/**
 * `plannotator routine …` as real processes against a real sandboxed Inbox (temp HOME and data dir, the fake launch
 * agent, a stand-in login item, agent CLI stubs on PATH). The Inbox runs in this test's process; every call is the
 * CLI, finding it through the data dir's `inbox.json`. No routine here is ever run: the only `run` and `on` are ones
 * the server refuses, the only ones on (asked for with /create-routine) run once in 2099, and the fake agent records
 * that it never started.
 *
 * What can regress: a routine made from the shell arriving on (unless the person asked this session for it with
 * /create-routine in the thread --thread names: then on, and its line and --json say so; a shell calling as another
 * session gets it off, told why), or the shell turning on or running one the person
 * never turned on; a refused schedule, agent or folder writing anything; the shell's lines or --json not saying
 * what the server holds; an update changing fields it was not given; delete doing more (or less) than the
 * window's; and the command writing while the person has routines off.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startInboxServer, type InboxServer } from "@plannotator/server/inbox";
import { CREATE_ROUTINE_SKILL } from "@plannotator/core/create-routine-skill";
import { INBOX_BUILTIN_SKILL_ROOT } from "@plannotator/core/inbox-review";
import { INBOX_REPLY_SKILL_AUDIENCE } from "@plannotator/core/skill-reference-block";
import type { SkillCatalogEntry } from "@plannotator/ui/utils/skillReferences";
import { builtinSkillContent, composeInboxSkillsBlock } from "../../../packages/inbox/skills";
import { stubbedAgentClis } from "../../../tests/helpers/agent-cli-guard";
import { FAKE, fakeLaunchHost } from "../../../tests/helpers/fake-launch-host";
import { removeStubbedHtml, stubHookDistHtml } from "../../../tests/helpers/hook-dist-stub";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";

const entry = resolve(import.meta.dir, "index.ts");
const SESSION = "claude-code:ses_maya";

let stubs: string[] = [];
const servers: InboxServer[] = [];
const restore: (() => void)[] = [];
beforeAll(() => {
  // The CLI imports the built HTML; these tests never read the pages.
  stubs = stubHookDistHtml();
});
afterAll(() => {
  removeStubbedHtml(stubs);
});
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const undo of restore.splice(0).reverse()) undo();
});
// After the cleanup hooks: a stub's failure stops the hooks registered behind it.
const agents = stubbedAgentClis();

function setEnv(name: string, value: string | undefined) {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

/** A sandbox with an Inbox running, routines on (or off), and the fake agent as the only one that can start. */
async function world(options: { scheduled?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-routine-cli-")));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  // Under PLANNOTATOR_TEST_SANDBOX the in-process Inbox's launcher reads `<data dir>/agents-home` as home (inbox.ts): the
  // folder checks accept a project under it and refuse one outside it (on Linux the temp folder is /tmp, a system folder).
  const home = join(dataDir, "agents-home");
  const project = join(home, "code", "acme-api");
  for (const dir of [dataDir, project]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({}));
  setEnv("HOME", home);
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", dataDir);
  setEnv("PLANNOTATOR_INBOX_TAILSCALE", undefined);
  setEnv("PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9");
  const fake = fakeLaunchHost();
  const login = { calls: [] as string[], path: null, add: async () => (login.calls.push("add"), "added" as const), remove: async () => void login.calls.push("remove") };
  const server = await startInboxServer({ dataDir, binaryPath: null, phones: false, scheduled: options.scheduled ?? true, launchHosts: () => [fake.host], scheduledLogin: login });
  servers.push(server);
  const env: Record<string, string> = {
    ...agents.env,
    HOME: home,
    TMPDIR: tmpdir(),
    PLANNOTATOR_SESSION_TAG: SESSION,
    PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9",
    PLANNOTATOR_DATA_DIR: dataDir,
    PLANNOTATOR_BROWSER: NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_UPDATE_CHECK: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const cli = async (args: string[], opts: { stdin?: string; cwd?: string; env?: Record<string, string> } = {}) => {
    const proc = Bun.spawn([process.execPath, "run", entry, "routine", ...args], {
      cwd: opts.cwd ?? project,
      env: { ...env, ...opts.env },
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, stdout, stderr };
  };
  /** Makes the usual routine from the shell and gives its id. */
  const make = async (extra: string[] = []) => {
    const made = await cli(["create", "--name", "Dependency check", "--cron", "0 9 * * 1-5", "--tz", "America/New_York", "--agent", FAKE, "--prompt", "Check for outdated dependencies.", "--json", ...extra]);
    expect(made).toMatchObject({ code: 0, stderr: "" });
    return JSON.parse(made.stdout).scheduled.id as string;
  };
  return { server, home, project, fake, login, cli, make };
}
type World = Awaited<ReturnType<typeof world>>;

const nothingStarted = (w: World) => expect(w.fake.calls).toEqual([]);

describe("what an agent can do from the shell is what the routine tool lets it", () => {
  test("a routine made from the shell arrives off; on and run are refused until the person turns it on, and nothing starts", async () => {
    const w = await world();
    const made = await w.cli(["create", "--name", "Dependency check", "--cron", "0 9 * * 1-5", "--tz", "America/New_York", "--agent", FAKE, "--prompt", "-"], { stdin: "Check for outdated dependencies.\nReply with what to update.\n" });
    expect(made).toMatchObject({ code: 0, stderr: "" });
    // Plain lines, for the agent to tell the person: the id, the name, off, and that the person turns it on.
    expect(made.stdout).toMatch(/^Made sch_\S+ "Dependency check": off, /);
    expect(made.stdout).toContain("It is off until the person turns it on in Routines in the Inbox.");
    const [record] = w.server.store.scheduledThreads();
    expect(record).toMatchObject({
      name: "Dependency check",
      prompt: "Check for outdated dependencies.\nReply with what to update.",
      schedule: { cron: "0 9 * * 1-5", tz: "America/New_York" },
      enabled: false,
      approved_at: null,
      folder: { path: w.project },
      agent: FAKE,
      made_by: { host: "claude-code", session: "ses_maya" },
    });

    for (const op of ["on", "run"]) {
      const refused = await w.cli([op, record!.id]);
      expect(refused).toMatchObject({ code: 1, stdout: "" });
      expect(refused.stderr).toStartWith("routine_not_approved: ");
    }
    expect(w.server.store.scheduledThread(record!.id)).toMatchObject({ enabled: false, approved_at: null });
    nothingStarted(w);
  });

  test("asked for with /create-routine in the window, the one made with --thread there is on: its line and --json say on and the next run", async () => {
    const w = await world();
    const base = `http://127.0.0.1:${w.server.port}`;
    const projectId = w.server.store.ensureProject({ name: "acme-api", root: w.project }).id;
    const thread = w.server.store.sendMessage({ project_id: projectId, author: { kind: "agent", host: "claude-code", session: "ses_maya", name: "Claude Code" }, body: "What should run?" }).message.thread_id;
    const builtin: SkillCatalogEntry = { name: CREATE_ROUTINE_SKILL.name, root: INBOX_BUILTIN_SKILL_ROOT, humanOnly: true, description: CREATE_ROUTINE_SKILL.description };
    const feedback = composeInboxSkillsBlock([builtin], new Map([[builtin.name, builtinSkillContent(builtin)!]]), INBOX_REPLY_SKILL_AUDIENCE);
    const send = async (key: string) => {
      const sent = await fetch(`${base}/api/inbox/messages/${thread}/reply`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: JSON.stringify({ serverSession: w.server.serverSession, idempotency_key: key, words: "/create-routine every weekday at 9", questions: [], feedback }),
      });
      expect(sent.status).toBe(200);
    };
    await send("k-cli-1");
    // In 2099: nothing comes due while the test runs.
    const at = ["--at", "2099-01-05T09:00", "--tz", "America/New_York", "--agent", FAKE, "--prompt", "Check for outdated dependencies."];
    const made = await w.cli(["create", "--name", "Dependency check", "--thread", thread, ...at]);
    expect(made).toMatchObject({ code: 0, stderr: "" });
    expect(made.stdout).toMatch(/^Made sch_\S+ "Dependency check": on, .+, next 2099-01-05T14:00:00\.000Z\. It is on: the person asked for it with \/create-routine in thread msg_\w+\./);
    expect(made.stdout).not.toContain("not yet turned on");
    // Another Send, another one. Another agent session's shell (its own PLANNOTATOR_SESSION_TAG) does not take it (the
    // reply went to ses_maya): off, and its line says why.
    await send("k-cli-2");
    const theirs = await w.cli(["create", "--name", "Not theirs", "--thread", thread, ...at], { env: { PLANNOTATOR_SESSION_TAG: "claude-code:ses_other" } });
    expect(theirs).toMatchObject({ code: 0, stderr: "" });
    expect(theirs.stdout).toMatch(/^Made sch_\S+ "Not theirs": off, /);
    expect(theirs.stdout).toContain(`The /create-routine request from the person in thread ${thread} was for another agent session, not yours`);
    // A shell that names no session at all is told that, not that the request was another's, and the grant stays.
    const bare = await w.cli(["create", "--name", "From a bare shell", "--thread", thread, ...at], { env: { PLANNOTATOR_SESSION_TAG: "" } });
    expect(bare).toMatchObject({ code: 0, stderr: "" });
    expect(bare.stdout).toMatch(/^Made sch_\S+ "From a bare shell": off, /);
    expect(bare.stdout).toContain(`This call names no agent session, so it could not be matched to the person's /create-routine request in thread ${thread}`);
    expect(bare.stdout).not.toContain("another agent session");
    // The one it went to: --json carries on, approved and the next run.
    const json = await w.cli(["create", "--name", "Weekly digest", "--thread", thread, "--json", ...at]);
    expect(json).toMatchObject({ code: 0, stderr: "" });
    const row = JSON.parse(json.stdout);
    expect(row).toMatchObject({ asked_with_create_routine: true, scheduled: { enabled: true, state: "on", next_run: "2099-01-05T14:00:00.000Z" } });
    expect(row.scheduled.approved_at).toEqual(expect.any(String));
    // Used up: the next one there arrives off, and --json says so with the same fields.
    const again = await w.cli(["create", "--name", "Second", "--thread", thread, "--json", ...at]);
    expect(again).toMatchObject({ code: 0, stderr: "" });
    expect(JSON.parse(again.stdout)).toMatchObject({ asked_with_create_routine: false, scheduled: { enabled: false, approved_at: null, next_run: null } });
    const first = w.server.store.scheduledThreads().find((record) => record.name === "Dependency check")!;
    expect(first).toMatchObject({ enabled: true, made_by: { session: "ses_maya", thread_id: thread } });
    nothingStarted(w);
  });

  test("the server's rules hold from the shell, and a refusal writes nothing", async () => {
    const w = await world();
    const base = ["create", "--name", "Too often", "--prompt", "p", "--agent", FAKE];
    const cases: [string[], string][] = [
      [[...base, "--cron", "*/5 * * * *"], "schedule_too_frequent: "],
      [[...base, "--cron", "not a cron"], "schedule_invalid: "],
      [[...base, "--at", "2020-01-01T09:00"], "schedule_invalid: "],
      // T3 Code is not an agent a routine can start: the server says which are.
      [["create", "--name", "T3", "--prompt", "p", "--agent", "t3"], "validation_error: agent"],
      [[...base, "--folder", "~"], "validation_error: "],
      [[...base, "--file", "notes.md", "--folder", join(w.home, "code", "nope")], "folder_missing: "],
      [["create", "--name", "No prompt", "--agent", FAKE], "validation_error: prompt"],
    ];
    for (const [args, code] of cases) {
      const refused = await w.cli(args);
      expect({ args, code: refused.code, stdout: refused.stdout, starts: refused.stderr.startsWith(code) }).toEqual({ args, code: 1, stdout: "", starts: true });
    }
    expect(w.server.store.scheduledThreads()).toEqual([]);
    nothingStarted(w);
  });

  test("bad usage exits 2 and reaches no Inbox write", async () => {
    const w = await world();
    const refused = await w.cli(["create", "--name", "x", "--cron", "0 9 * * *", "--at", "2026-11-20T17:00"]);
    expect(refused).toMatchObject({ code: 2, stdout: "" });
    expect(refused.stderr).toStartWith("usage: ");
    expect(w.server.store.scheduledThreads()).toEqual([]);
  });
});

describe("list, get, update and delete", () => {
  test("list and get say what the server holds, as lines and as --json", async () => {
    const w = await world();
    const id = await w.make();
    const listed = await w.cli(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toStartWith(`${id} "Dependency check": off, `);
    expect(listed.stdout).toContain("not yet turned on by the person");
    expect(JSON.parse((await w.cli(["list", "--json"])).stdout).scheduled.map((row: { id: string }) => row.id)).toEqual([id]);
    const got = JSON.parse((await w.cli(["get", id, "--json"])).stdout);
    expect(got).toMatchObject({ scheduled: { id, prompt: "Check for outdated dependencies.", enabled: false }, runs: [] });
    const missing = await w.cli(["get", "sch_nope"]);
    expect(missing).toMatchObject({ code: 1, stdout: "" });
    expect(missing.stderr).toStartWith("routine_not_found: ");
  });

  test("update changes only what it is given, from options or from one JSON object", async () => {
    const w = await world();
    const id = await w.make();
    expect((await w.cli(["update", id, "--cron", "0 7 * * 1-5", "--tz", "America/New_York"])).code).toBe(0);
    expect(w.server.store.scheduledThread(id)).toMatchObject({ schedule: { cron: "0 7 * * 1-5", tz: "America/New_York" }, prompt: "Check for outdated dependencies.", name: "Dependency check", enabled: false });
    expect((await w.cli(["update", JSON.stringify({ id, name: "Morning deps" })])).code).toBe(0);
    expect(w.server.store.scheduledThread(id)).toMatchObject({ name: "Morning deps", schedule: { cron: "0 7 * * 1-5" } });
    // A file and a folder by a path relative to the shell's folder reach the server whole.
    mkdirSync(join(w.project, "packages", "web"), { recursive: true });
    writeFileSync(join(w.project, "deps.md"), "notes");
    expect((await w.cli(["update", id, "--folder", "packages/web", "--file", "deps.md"])).code).toBe(0);
    expect(w.server.store.scheduledThread(id)).toMatchObject({ folder: { path: join(w.project, "packages", "web") }, attachments: [join(w.project, "deps.md")] });
    expect((await w.cli(["update", id, "--no-schedule", "--no-files"])).code).toBe(0);
    expect(w.server.store.scheduledThread(id)).toMatchObject({ schedule: null, attachments: [] });
    nothingStarted(w);
  });

  test("delete is the window's delete: the routine goes, and its thread and the change lines stay", async () => {
    const w = await world();
    const id = await w.make();
    const deleted = await w.cli(["delete", id]);
    expect(deleted).toMatchObject({ code: 0, stderr: "" });
    expect(deleted.stdout).toContain(`Deleted ${id}.`);
    expect(w.server.store.scheduledThread(id)).toBeNull();
    expect(w.server.store.deletedScheduledThread(id)).not.toBeNull();
    expect((await w.cli(["list"])).stdout).toBe("No routines.\n");
    nothingStarted(w);
  });
});

test("routines off: the command writes nothing and says so, exit 1; its help still answers", async () => {
  const w = await world({ scheduled: false });
  const refused = await w.cli(["create", "--name", "Dependency check", "--cron", "0 9 * * 1-5", "--agent", FAKE, "--prompt", "p"]);
  expect(refused).toMatchObject({ code: 1, stdout: "" });
  expect(refused.stderr).toStartWith("routines_off: ");
  expect(w.server.store.scheduledThreads()).toEqual([]);
  const help = await w.cli(["create", "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("--cron");
});
