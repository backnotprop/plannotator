/**
 * Pi through the real launch engine (inbox-launch.ts with its own hosts, no test host), against the fake `pi`
 * (tests/helpers/fake-pi/), never the real one. What each test guards: To offers "Pi" once `pi` and Plannotator's
 * Pi extension are there, and only then; a Send starts one `pi --mode rpc` in the chosen project's folder, with the
 * thread's name as one argument whatever it holds, and the thread addressed to that Pi session; the session's
 * extension polls the bridge as that session and takes the root; the spawn env keeps the login's own names but no
 * Plannotator name other than the two it sets, and no outer Pi session's markers. A small bridge stands in for the
 * Inbox's: no Inbox is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakePi } from "../../tests/helpers/fake-pi";
import { createInboxLaunch } from "./inbox-launch";
import { PI_STOPPED_NOTE } from "./inbox-launch-pi";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function until<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

/** The bridge the fake's extension calls: each session's polls, the root and the waiting replies handed once to the session they are for, their delivery. */
function stubBridge(dataDir: string, store: InboxStore) {
  const polls = new Map<string, { count: number; last: number }>();
  const busy = new Map<string, boolean>();
  const handed = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const pathname = new URL(req.url).pathname;
      // The extension's "delivered" event, recorded as the Inbox's bridge records it.
      if (pathname === "/api/inbox/bridge/event") {
        const event = (await req.json()) as { session: string; host: string; type: string; id?: string; busy?: boolean };
        if (event.type === "delivered" && event.id) store.recordDelivery(event.id, { host: event.host, session: event.session });
        if (event.type === "state") busy.set(event.session, event.busy === true);
        return Response.json({ ok: true });
      }
      if (pathname !== "/api/inbox/bridge/poll") return Response.json({});
      const { session, host } = (await req.json()) as { session: string; host: string };
      const entry = polls.get(session) ?? { count: 0, last: 0 };
      entry.count += 1;
      entry.last = Date.now();
      polls.set(session, entry);
      await Bun.sleep(100);
      const commands = store
        .threadIds()
        .map((id) => store.message(id))
        .filter((root): root is InboxMessage => !!root && root.to?.host === host && root.to.session === session)
        .concat(store.pendingReplies(session, { tags: true }))
        .filter((message) => !handed.has(message.id))
        .map((message) => (handed.add(message.id), { id: message.id, body: message.body }));
      return Response.json({ commands });
    },
  });
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ port: server.port, token: "test" }));
  return {
    polls,
    runStateOf: (session: string) => {
      const entry = polls.get(session);
      return entry && Date.now() - entry.last < 2_000 ? { busy: busy.get(session) === true, busySince: null, polls: entry.count } : null;
    },
    stop: () => server.stop(true),
  };
}

function setup(options: { folderName?: string } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-pi-engine-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const folder = join(root, options.folderName ?? "project");
  for (const dir of [home, bin, dataDir, folder]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  // The engine reads launch's switch from this data dir's config.json.
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const fake = installFakePi({ bin, state: join(root, "fake-pi"), home, config: {} });
  cleanup.push(() => void fake.stopAll());
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "project", root: folder });
  const bridge = stubBridge(dataDir, store);
  cleanup.push(() => bridge.stop());
  const path = `${bin}:/usr/bin:/bin`;
  /** How far the engine's clock is ahead of the wall clock (past the start's grace). */
  const clock = { ahead: 0 };
  /** A launch engine over this data dir: the Inbox, or the Inbox after a restart. */
  const makeLaunch = () => {
  const made = createInboxLaunch({
    store,
    live: { runStateOf: (session) => bridge.runStateOf(session) },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    // The login shell carries a name of its own, an outer Pi session's markers and Plannotator's own names.
    loginEnv: async () => ({ HOME: home, PATH: path, LOGIN_ONLY: "from-login", PI_SESSION_ID: "outer-session", PI_MODEL: "outer/model", PLANNOTATOR_PORT: "1", PLANNOTATOR_TEST_SANDBOX: "1" }),
    ownEnv: () => ({ HOME: home, PATH: path }),
    installDirs: [],
    displayFolder: (p) => p,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
    now: () => Date.now() + clock.ahead,
  });
  cleanup.push(() => made.stop());
  return made;
  };
  const launch = makeLaunch();
  return { store, project, folder, dataDir, fake, bridge, launch, clock, makeLaunch };
}

describe("Pi through the launch engine, against the fake pi", () => {
  test("To offers Pi once pi and Plannotator's Pi extension are there, and not before", async () => {
    const { fake, launch } = setup();
    expect((await launch.composeBlock())!.agents).toContainEqual({ agent: "pi", name: "Pi", scratch_trusted: true });

    const absent = setup();
    absent.fake.setInstalled(false);
    expect((await absent.launch.composeBlock())!.agents.map((a) => a.agent)).not.toContain("pi");

    const noExtension = setup();
    noExtension.fake.setExtension(false);
    expect((await noExtension.launch.composeBlock())!.agents.map((a) => a.agent)).not.toContain("pi");
    expect(fake.calls().some((call) => call.argv.includes("--version"))).toBe(true);
  });

  test("Send starts Pi in the project's folder, the thread's name one argument, the thread addressed to that session, which takes the root", async () => {
    const { store, project, folder, dataDir, fake, bridge, launch } = setup({ folderName: `pro'ject $(touch x) "y"` });
    // Pi keeps working on the root, so the line shows the session's own live state.
    fake.configure({ hold: true });
    const name = `--mode json; $(touch pwned) 'q' "dq"`;
    const target = launch.target({ launch: { agent: "pi", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name, body: "Tidy the readme.", resolveProject: async () => project });
    expect(prepared.launch.agent).toBe("pi");
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: name, launch: prepared.launch }).message;
    launch.begin(root);

    const session = await until("the session", () => store.message(root.id)!.launch!.session_ref);
    const [start] = fake.starts();
    expect(start!.argv).toEqual(["--mode", "rpc", "--session-id", session, "--name", name]);
    expect(start!.cwd).toBe(folder);
    expect(store.message(root.id)!.to).toEqual({ host: "pi", session });
    expect(start!.inboxTool).toBe("1");
    expect(start!.dataDir).toBe(dataDir);
    expect(start!.env).toContain("LOGIN_ONLY");
    expect(start!.env.filter((n) => n.startsWith("PLANNOTATOR_")).sort()).toEqual(["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_INBOX_TOOL"]);
    expect(start!.env).not.toContain("PI_SESSION_ID");
    expect(start!.env).not.toContain("PI_MODEL");

    // The session connects back: its extension polls as that session and takes the root as its first turn.
    await until("the root delivered", () => fake.delivered().includes(root.id));
    expect(bridge.polls.has(session)).toBe(true);
    await until("the root marked delivered to that session", () => store.message(root.id)!.delivery);
    expect(store.message(root.id)!.delivery).toMatchObject({ host: "pi", session });
    await until("the line follows that session: working", async () => (await launch.runOf(root.id))?.state === "working");
  });

  /** Send to a new Pi session whose extension does not connect: started, with its session id. */
  async function sendUnconnected(t: ReturnType<typeof setup>) {
    t.fake.configure({ noConnect: true });
    const target = t.launch.target({ launch: { agent: "pi", project_id: t.project.id } })!;
    const prepared = await t.launch.prepare(target, { name: "Tidy", body: "Tidy the readme.", resolveProject: async () => t.project });
    const root = t.store.startPersonThread({ project_id: t.project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy", launch: prepared.launch }).message;
    t.launch.begin(root);
    const session = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    return { root, session };
  }

  /** The reply starts Pi again on the same session, and the new one takes the root and the reply. */
  async function replyContinues(t: ReturnType<typeof setup>, launch: ReturnType<typeof setup>["launch"], root: InboxMessage, session: string) {
    t.fake.configure({ noConnect: false });
    const { reply } = t.store.sendReply(root.id, { words: "Please go on.", idempotency_key: "reply-1" });
    const again = await until("a second start", () => t.fake.starts()[1]);
    expect(again.argv.slice(0, 4)).toEqual(["--mode", "rpc", "--session-id", session]);
    await until("the root and the reply delivered", () => t.fake.delivered().includes(root.id) && t.fake.delivered().includes(reply.id));
    launch.sweep(true);
    expect(t.fake.starts()).toHaveLength(2);
  }

  test("a Pi that ends before it ever connected: the line says a reply continues it, and a reply does", async () => {
    const t = setup();
    const { root, session } = await sendUnconnected(t);
    const pid = t.fake.starts()[0]!.pid;
    process.kill(pid, "SIGKILL"); // inbox-guard: own child (the test's fake Pi, not an Inbox)
    await until("it ended", () => !t.fake.alive(pid));
    await until("the host saw it end", async () => (t.clock.ahead = 120_000, (await t.launch.runOf(root.id))?.state === "stopped"));
    expect((await t.launch.runOf(root.id))?.cause).toMatch(/^Pi ended on its own \(exit \d+\)\. Your reply continues it\.$/);
    await replyContinues(t, t.launch, root, session);
  }, 30_000);

  test("the Inbox restarted before Pi connected: the line says a reply continues it, and a reply does", async () => {
    const t = setup();
    const { root, session } = await sendUnconnected(t);
    // The Inbox stops (its Pi with it) and starts again.
    await t.launch.stop();
    await until("the first Pi ended", () => !t.fake.alive(t.fake.starts()[0]!.pid));
    const after = t.makeLaunch();
    t.clock.ahead = 120_000;
    expect(await after.runOf(root.id)).toMatchObject({ state: "stopped", cause: PI_STOPPED_NOTE });
    await replyContinues(t, after, root, session);
  }, 30_000);

  test("a Pi that runs but never connected: the line offers Try again, and a reply starts nothing beside it", async () => {
    const t = setup();
    const { root } = await sendUnconnected(t);
    t.clock.ahead = 120_000;
    expect(await t.launch.runOf(root.id)).toMatchObject({ state: "failed", cause: "Started, but not connected to the Inbox. Is Plannotator's extension on in that folder?" });
    t.store.sendReply(root.id, { words: "Hello?", idempotency_key: "reply-1" });
    await Bun.sleep(500);
    t.launch.sweep(true);
    await Bun.sleep(200);
    expect(t.fake.starts()).toHaveLength(1);
  }, 30_000);
});
