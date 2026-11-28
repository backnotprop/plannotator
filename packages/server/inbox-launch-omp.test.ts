/**
 * Oh My Pi's launch host (inbox-launch-omp.ts: the Pi launcher with Oh My Pi's flavor) against the fake `omp`
 * (tests/helpers/fake-omp/), never the real one. What each test guards: a start lets Oh My Pi pick the session id and
 * takes it from `get_state`, names the session for its thread over RPC, and runs in the picked folder (home too); Stop
 * then a reply continues that session with `--resume <id>` on the same file; a session Oh My Pi never saved is said
 * plainly instead of started under another id; its extension dialog is answered Cancel under Oh My Pi's name; the row
 * is offered only with `omp` new enough and the extension in Oh My Pi's plugin record (or its settings), and the
 * not-ready line names the one command; the stopped line; the scratch purge in Oh My Pi's own sessions folder.
 * Its own ids: a new start that Auto Resume put in an earlier session asks for a new one (or refuses, nothing sent);
 * a resume answered as a newer copy that leads back is taken, one that does not is refused once and not started
 * again; an id that is not one is never taken; a session never saved gets no "your reply continues it"; the article.
 * A small bridge in the test's data dir stands in for the Inbox's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLaunchRecord, InboxMessage } from "@plannotator/core/inbox-types";
import { inboxLaunchNotReadyWords } from "@plannotator/core/inbox-launch-ready";
import { resolveInboxLaunch } from "@plannotator/shared/config";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeOmp } from "../../tests/helpers/fake-omp";
import type { FakePi } from "../../tests/helpers/fake-pi";
import { createAgentEnvironmentFor } from "./inbox-agents";
import type { LaunchHostContext, LaunchLive } from "./inbox-launch-host";
import type { LaunchEnv } from "./inbox-launch-env";
import { createOhMyPiLaunchHost, ompAgentDir, ompPluginInstalled, ompPluginsDirs, ompSessionDirOf, ompSessionsRoot, OMP_STOPPED_NOTE } from "./inbox-launch-omp";
import { piSessionContinues, piSessionProcesses } from "./inbox-launch-pi";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const undo of cleanup.splice(0).reverse()) await undo();
});

async function until<T>(what: string, check: () => T | null | undefined | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

/** The extension's bridge poll, counted per session (the fake polls as host `pi`). */
function testBridge(dataDir: string) {
  const seen = new Map<string, { polls: number; last: number; plugin: unknown }>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/api/inbox/bridge/poll") return Response.json({});
      const body = (await req.json()) as { session: string; plugin?: unknown };
      const entry = seen.get(body.session) ?? { polls: 0, last: 0, plugin: null };
      seen.set(body.session, entry);
      entry.polls += 1;
      entry.plugin = body.plugin ?? null;
      await Bun.sleep(100);
      entry.last = Date.now();
      return Response.json({ commands: [] });
    },
  });
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ port: server.port, token: "test" }));
  return {
    seen,
    runStateOf(session: string): LaunchLive | null {
      const entry = seen.get(session);
      return entry && Date.now() - entry.last < 600 ? { busy: false, busySince: null, polls: entry.polls } : null;
    },
    stop: () => server.stop(true),
  };
}

function setup(config: Parameters<typeof installFakeOmp>[0]["config"] = { noConnect: true }, options: { folderIsHome?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-omp-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const folder = options.folderIsHome ? home : join(root, "harbor");
  for (const dir of [home, bin, dataDir, folder]) mkdirSync(dir, { recursive: true });
  const fake: FakePi = installFakeOmp({ bin, state: join(root, "fake-omp"), home, config });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const bridge = testBridge(dataDir);
  const ctx: LaunchHostContext = {
    dataDir,
    homeDir: home,
    platform: "darwin",
    selfCommand: ["plannotator"],
    ownEnv: () => env,
    environment: async () => createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env }),
    shell: () => null,
    loginEnv: async (): Promise<LaunchEnv> => ({ ...env }),
    config: () => resolveInboxLaunch({}),
    launchDir: (id) => join(dataDir, "inbox", "launch", id),
    startLog: () => {},
    displayFolder: (path) => path,
    bridge,
    log: () => {},
  };
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "harbor", root: folder });
  const roots = new Map<string, InboxMessage>();
  const host = createOhMyPiLaunchHost(ctx);
  host.permissions({
    store,
    launchDir: ctx.launchDir,
    rootOf: (id) => roots.get(id) ?? null,
    roots: () => [...roots.values()],
    displayFolder: (path) => path,
    host: { stateOf: () => null, readAt: () => 0 },
    onChange: () => {},
  });
  cleanup.push(async () => {
    host.close?.();
    await until("every fake omp to end", () => fake.starts().every((call) => !fake.alive(call.pid)), 4_000).catch(() => fake.stopAll());
    bridge.stop();
    rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  const started = async () => {
    n += 1;
    const launch: InboxLaunchRecord = { id: `lch_01J0000000000000000000000${n}`, agent: "oh-my-pi", session_ref: null, folder, scratch: false, started_at: new Date().toISOString() };
    mkdirSync(ctx.launchDir(launch.id), { recursive: true });
    const message = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: { host: "oh-my-pi", session: `launch:${launch.id}` }, idempotency_key: `send-${n}`, thread_name: n === 1 ? "Tidy the readme" : `Tidy the readme ${n}`, launch }).message;
    roots.set(launch.id, message);
    const result = await host.start(launch, { name: "Tidy the readme", login: env });
    if (!result.ok) throw new Error(result.text);
    const settled: InboxLaunchRecord = { ...launch, session: result.session, session_ref: result.ref };
    roots.set(launch.id, { ...message, launch: settled });
    return { launch: settled, session: result.session, root: message };
  };
  const agentNotes = (message: InboxMessage) =>
    store
      .threadMessageIds(message.thread_id)
      .map((id) => store.message(id)!)
      .filter((m) => m.author.kind === "agent");
  const names = () => (existsSync(join(fake.state, "names.jsonl")) ? readFileSync(join(fake.state, "names.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { sessionId: string; name: string }) : []);
  const rpc = () => (existsSync(join(fake.state, "rpc.jsonl")) ? readFileSync(join(fake.state, "rpc.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type: string; from: string }) : []);
  /** The Inbox started again: a new host over the same data dir and launches. */
  const restarted = () => {
    const again = createOhMyPiLaunchHost(ctx);
    again.permissions({ store, launchDir: ctx.launchDir, rootOf: (id) => roots.get(id) ?? null, roots: () => [...roots.values()], displayFolder: (path) => path, host: { stateOf: () => null, readAt: () => 0 }, onChange: () => {} });
    cleanup.push(() => again.close?.());
    return again;
  };
  /** A session Oh My Pi saved (its first turn answered), then stopped. */
  const saved = async () => {
    const made = await started();
    await until("the session file", () => fake.sessionFiles().length >= 1 && fake.sessionFiles().some((file) => file.endsWith(`_${made.session}.jsonl`)));
    await host.stop(made.session);
    fake.configure({ turnOnStart: false });
    return made;
  };
  return { root, home, folder, fake, host, store, env, bridge, started, agentNotes, names, rpc, restarted, saved };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("Oh My Pi's own session ids, against the fake omp", () => {
  test("Auto Resume on: a new start never lands in the earlier conversation; the Inbox asks for a new session and takes that one", async () => {
    const { fake, host, started, saved, names, rpc } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
    const first = await saved();
    const [firstFile] = fake.sessionFiles();
    const before = readFileSync(firstFile!, "utf8");
    fake.configure({ autoResume: true });
    const second = await started();
    expect(second.session).toMatch(UUID);
    expect(second.session).not.toBe(first.session);
    // It opened the first session, so the Inbox asked for a new one, named that one, and left the first alone.
    expect(rpc()).toEqual([{ type: "new_session", from: first.session }]);
    expect(names().at(-1)).toEqual({ sessionId: second.session, name: "Tidy the readme" });
    expect(readFileSync(firstFile!, "utf8")).toBe(before);
    expect((await host.sessions())(second.session)).toMatchObject({ state: "running" });
  }, 15_000);

  test("Auto Resume on and the new session refused: nothing starts, nothing is sent, and the line says what to do", async () => {
    const { fake, host, saved, env } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
    const first = await saved();
    fake.configure({ autoResume: true, newSessionCancelled: true });
    const launch: InboxLaunchRecord = { id: "lch_01J00000000000000000000099", agent: "oh-my-pi", session_ref: null, folder: first.launch.folder, scratch: false, started_at: new Date().toISOString() };
    const result = await host.start(launch, { name: "Second", login: env });
    expect(result).toEqual({ ok: false, code: "failed", text: "Oh My Pi reopened an earlier session instead of starting a new one, so nothing was sent. Turn off Auto Resume in Oh My Pi's settings, then try again." });
    await until("that omp ended", () => fake.starts().every((call) => !fake.alive(call.pid)));
  }, 15_000);

  test("a resume that answers as a newer copy of the conversation (its header leads back): the thread takes that id", async () => {
    for (const kind of ["continuation", "fork"] as const) {
      const { fake, host, saved } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
      const { launch, session } = await saved();
      fake.configure({ resumeAs: kind });
      const resumed = await host.resume(launch);
      expect(resumed.failure).toBeNull();
      expect(fake.starts().at(-1)!.argv).toEqual(["--mode", "rpc", "--allow-home", "--resume", session]);
      expect(resumed.session).toMatch(UUID);
      expect(resumed.session).not.toBe(session);
      expect((await host.sessions())(resumed.session!)).toMatchObject({ state: "running" });
      // Stop reaches it under its new id.
      await host.stop(resumed.session!);
      expect(fake.starts().every((call) => !fake.alive(call.pid))).toBe(true);
    }
  }, 30_000);

  test("a resume that answers as a session that does not lead back: refused once, and a later reply starts nothing", async () => {
    const { fake, host, saved } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
    const { launch } = await saved();
    fake.configure({ resumeAs: "stranger" });
    const words = "Oh My Pi opened another session in place of this one, so it can't continue it here. Start a new Oh My Pi session.";
    expect((await host.resume(launch)).failure).toEqual({ code: "failed", text: words });
    expect(fake.starts()).toHaveLength(2);
    await until("that omp ended", () => fake.starts().every((call) => !fake.alive(call.pid)));
    expect((await host.resume(launch)).failure).toEqual({ code: "failed", text: words });
    expect(fake.starts()).toHaveLength(2);
  }, 15_000);

  test("after a resume answered as another session, the stopped line says so, here and after an Inbox restart: never that a reply continues it", async () => {
    const { fake, host, saved, restarted } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
    const { launch } = await saved();
    fake.configure({ resumeAs: "stranger" });
    const words = "Oh My Pi opened another session in place of this one, so it can't continue it here. Start a new Oh My Pi session.";
    expect((await host.resume(launch)).failure?.text).toBe(words);
    await until("that omp ended", () => fake.starts().every((call) => !fake.alive(call.pid)));
    expect(host.stoppedNote(launch)).toBe(words);
    expect(restarted().stoppedNote(launch)).toBe(words);
  }, 15_000);

  test("a resume that answers as the session another thread here has: refused, and that thread keeps its running session", async () => {
    const { fake, host, saved, started } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
    const first = await saved();
    const other = await started();
    fake.configure({ resumeAs: "continuation", resumeId: other.session });
    const resumed = await host.resume(first.launch);
    expect(resumed.failure?.text).toBe("Oh My Pi opened another session in place of this one, so it can't continue it here. Start a new Oh My Pi session.");
    expect(resumed.session).toBeUndefined();
    expect((await host.sessions())(other.session)).toMatchObject({ state: "running" });
  }, 15_000);

  test("an id that is not a session id is never taken", async () => {
    const { fake, host, started } = setup({ noConnect: true, stateId: "../../etc --resume x" });
    await expect(started()).rejects.toThrow("It answered something else.");
    await until("that omp ended", () => fake.starts().every((call) => !fake.alive(call.pid)));
  });

  test("a session Oh My Pi never saved: neither stopped line promises a reply continues it", async () => {
    const { fake, host, started, restarted, saved } = setup({ noConnect: true });
    const { launch, session } = await started();
    const pid = fake.starts()[0]!.pid;
    process.kill(pid, "SIGKILL"); // inbox-guard: own child (the test's fake omp, not an Inbox)
    await until("it ended", () => !fake.alive(pid));
    await Bun.sleep(100);
    const unsaved = "Oh My Pi had not saved this session yet, so there is nothing to continue. Start a new Oh My Pi session.";
    expect(host.stoppedNote(launch)).toBe(unsaved);
    expect(restarted().stoppedNote(launch)).toBe(unsaved);
    // One it saved still says a reply continues it.
    fake.configure({ turnOnStart: true, turnError: "401 expired" });
    const kept = await saved();
    expect(restarted().stoppedNote(kept.launch)).toBe(OMP_STOPPED_NOTE);
  }, 15_000);

  test("an Oh My Pi from an earlier Inbox still on the session: the line reads “An Oh My Pi process”", async () => {
    const { started, restarted } = setup({ noConnect: true });
    const { launch } = await started();
    const result = await restarted().resume(launch);
    expect(result.failure?.text).toMatch(/^An Oh My Pi process from before \(pid \d+\) still runs this session, so it did not start again\.$/);
  });
});

describe("Oh My Pi's session lineage", () => {
  test("a copy leads back through continuationOf or parentSession, copy after copy; a session of no lineage never does", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-omp-lineage-")));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const ids = { a: "0190a000-0000-7000-8000-00000000000a", b: "0190a000-0000-7000-8000-00000000000b", c: "0190a000-0000-7000-8000-00000000000c", d: "0190a000-0000-7000-8000-00000000000d" };
    const file = (id: string, header: Record<string, unknown>) => {
      const path = join(dir, `2026-11-25T00-00-00-000Z_${id}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ type: "session", id, cwd: "/srv/harbor", ...header })}\n`);
      return path;
    };
    file(ids.a, {});
    file(ids.b, { continuationOf: ids.a, parentSession: ids.a });
    const c = file(ids.c, { parentSession: ids.b });
    const d = file(ids.d, { parentSession: "/not/an/id.jsonl" });
    expect(piSessionContinues(c, ids.c, ids.a, [dir])).toBe(true);
    expect(piSessionContinues(c, ids.c, ids.b, [dir])).toBe(true);
    expect(piSessionContinues(d, ids.d, ids.a, [dir])).toBe(false);
    // The file must be the session get_state named.
    expect(piSessionContinues(c, ids.d, ids.a, [dir])).toBe(false);
  });

  test("a session id with pattern characters names only itself on a command line", () => {
    const listing = "  4100 1 omp --mode rpc --resume 0190a000X0000-7000-8000-00000000000a\n";
    expect(piSessionProcesses(listing, "0190a000.0000-7000-8000-00000000000a", [], [], "--resume")).toEqual([]);
  });
});

describe("Oh My Pi's launch host, against the fake omp", () => {
  test("start: Oh My Pi picks the session id, the Inbox reads it from get_state and names the session for its thread", async () => {
    const { fake, host, folder, started, names } = setup();
    const { session, launch } = await started();
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(launch.session_ref).toBe(session);
    const [call] = fake.starts();
    // No session id or name on argv (it takes neither); in the folder picked, home included.
    expect(call!.argv).toEqual(["--mode", "rpc", "--allow-home"]);
    expect(call!.cwd).toBe(folder);
    expect(call!.inboxTool).toBe("1");
    expect(names()).toEqual([{ sessionId: session, name: "Tidy the readme" }]);
    expect((await host.sessions())(session)).toEqual({ status: "idle", state: "running", waitingFor: null });
    // Starting in Rex and the model menus are Pi's only, for now.
    expect(host.rexCommand).toBeUndefined();
    expect(host.choices).toBeUndefined();
    expect(host.sessionHost).toBe("pi");
  });

  test("Stop before Oh My Pi ever answered: it saved no session file, so a reply says there is nothing to continue and starts nothing", async () => {
    const { fake, host, started } = setup({ noConnect: false });
    const { launch, session } = await started();
    await host.stop(session);
    expect(fake.exits()).toMatchObject([{ sessionId: session, why: "stdin", aborted: true }]);
    expect(fake.sessionFiles()).toEqual([]);
    const early = await host.resume(launch);
    expect(early.failure).toEqual({ code: "failed", text: "Oh My Pi had not saved this session yet, so there is nothing to continue. Start a new Oh My Pi session." });
    expect(fake.starts()).toHaveLength(1);
  });

  test("a session Oh My Pi saved: Stop, then a reply resumes that id and file", async () => {
    const { fake, host, started } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
    const { launch, session } = await started();
    // Its first turn ended (as an answer, it writes the session file).
    await until("the session file", () => fake.sessionFiles().length === 1);
    await host.stop(session);
    const resumed = await host.resume(launch);
    expect(resumed.failure).toBeNull();
    expect(fake.starts()).toHaveLength(2);
    expect(fake.starts()[1]!.argv).toEqual(["--mode", "rpc", "--allow-home", "--resume", session]);
    expect(fake.sessionFiles()).toHaveLength(1);
    expect((await host.sessions())(session)).toMatchObject({ state: "running" });
  }, 15_000);

  test("an extension dialog (an approval Oh My Pi asks before an action) is answered Cancel, and the thread says so as Oh My Pi", async () => {
    const { fake, started, agentNotes } = setup({ noConnect: true, dialogOnStart: true, dialog: { method: "select", title: "Allow bash: rm -rf build?", options: ["Approve", "Deny"] } });
    const { root, session } = await started();
    expect((await until("the dialog answered", () => fake.dialogs()[0])).response).toMatchObject({ cancelled: true });
    const note = await until("the note in the thread", () => agentNotes(root)[0]);
    expect(note.author).toMatchObject({ kind: "agent", host: "pi", session, name: "Oh My Pi" });
    expect(note.body).toBe("Oh My Pi asked something the Inbox can't show yet (“Allow bash: rm -rf build?”); answered Cancel.");
  });

  test("Oh My Pi's form (how its ask tool asks in RPC mode) is answered Cancel as well, and the thread says so: the session never waits on it", async () => {
    const { fake, started, agentNotes } = setup({ noConnect: true, turnOnStart: true, dialog: { method: "form", title: "Which branch should I use?" } });
    const { root, session } = await started();
    const asked = await until("the form answered", () => fake.dialogs()[0], 5_000);
    expect(asked.response).toMatchObject({ cancelled: true });
    const note = await until("the note in the thread", () => agentNotes(root)[0]);
    expect(note.author).toMatchObject({ kind: "agent", host: "pi", session, name: "Oh My Pi" });
    // A form has no title: the note without one.
    expect(note.body).toBe("Oh My Pi asked something the Inbox can't show yet; answered Cancel.");
  });

  test("the stopped line after an Inbox restart", () => {
    expect(OMP_STOPPED_NOTE).toBe("An Oh My Pi session runs only while the Inbox runs. Your reply continues it.");
  });

  test("offered only with omp new enough and the extension in Oh My Pi's plugin record; the line names the one command", async () => {
    const { fake, host, home } = setup();
    expect(await host.available()).toEqual({ ok: true, version: "19.2.1" });
    fake.setExtension(false);
    const off = await host.available();
    expect(off).toMatchObject({ ok: false, missing: false, code: "plugin_off" });
    // This computer's refusal reads "Oh My Pi can't be started here: <reason>. Nothing was sent."
    expect(off.ok ? "" : `${off.reason}.`).toContain("Run `omp plugin install @plannotator/pi-extension` on this computer, then try again.");
    expect(inboxLaunchNotReadyWords({ agent: "Oh My Pi", code: "plugin_off", machine: null }).fix).toBe("Run `omp plugin install @plannotator/pi-extension` on this computer, then try again.");
    expect(inboxLaunchNotReadyWords({ agent: "Oh My Pi", code: "plugin_off", machine: "fern-api" })).toEqual({
      line: "Oh My Pi isn't ready on fern-api: Plannotator's Pi extension isn't installed there",
      fix: "Run `omp plugin install @plannotator/pi-extension` on fern-api, then try again.",
      command: "omp plugin install @plannotator/pi-extension",
    });
    // Turned off in the lock (`omp plugin disable`): not offered.
    fake.setExtension(true);
    const lock = join(home, ".omp", "plugins", "omp-plugins.lock.json");
    writeFileSync(lock, JSON.stringify({ plugins: { "@plannotator/pi-extension": { version: "0.28.70", enabledFeatures: null, enabled: false } }, settings: {} }));
    expect(await host.available()).toMatchObject({ ok: false, code: "plugin_off" });
    // Listed in its agent dir's settings instead: offered.
    writeFileSync(join(home, ".omp", "agent", "settings.json"), JSON.stringify({ extensions: ["npm:@plannotator/pi-extension"] }));
    expect(await host.available()).toMatchObject({ ok: true });
    fake.configure({ version: "19.1.0" });
    expect(await host.available()).toMatchObject({ ok: false, reason: "Oh My Pi 19.1.0 is older than 19.2.1", code: "too_old" });
    fake.setInstalled(false);
    expect(await host.available()).toMatchObject({ ok: false, missing: true, code: "missing" });
  });

  test("with the extension missing, no omp runs at all, not even --version", async () => {
    const { fake, host } = setup();
    fake.setExtension(false);
    expect(await host.available()).toMatchObject({ ok: false });
    expect(fake.calls().filter((call) => call.argv.includes("--version"))).toEqual([]);
  });

  test("purge of a scratch folder: the session files in Oh My Pi's own folder for it whose header names it", async () => {
    const { fake, host, folder, home, started } = setup({ noConnect: true, turnOnStart: true, turnError: "401 expired" });
    const { session } = await started();
    await until("the session file", () => fake.sessionFiles().length === 1);
    await host.stop(session);
    // The process got no TMPDIR, so its temp root is /tmp and the folder is named from its absolute path.
    expect(fake.sessionFiles()[0]!.startsWith(ompSessionDirOf(join(home, ".omp", "agent"), folder, home, "/tmp"))).toBe(true);
    expect((await host.purge(folder)).skipped).toBeUndefined();
    expect(fake.sessionFiles()).toEqual([]);
  }, 15_000);
});

describe("Oh My Pi's plugin record, as its loader reads it", () => {
  /** A plugins folder holding `pi-subagents` by `omp plugin install`, and Plannotator's extension as `link` says. */
  function plugins(input: { lock?: boolean; enabled?: boolean; entry: "link" | "dangling" | "folder" | "none" }) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-omp-link-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const dir = join(root, "plugins");
    const checkout = join(root, "checkout", "pi-extension");
    mkdirSync(join(dir, "node_modules", "@plannotator"), { recursive: true });
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, "package.json"), JSON.stringify({ name: "@plannotator/pi-extension", version: "0.29.6", pi: {} }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "omp-plugins", private: true, dependencies: { "pi-subagents": "^1.0.0" } }));
    const entries: Record<string, unknown> = { "pi-subagents": { version: "1.0.0", enabledFeatures: null, enabled: true } };
    if (input.lock !== false) entries["@plannotator/pi-extension"] = { version: "0.29.6", enabledFeatures: null, enabled: input.enabled !== false };
    writeFileSync(join(dir, "omp-plugins.lock.json"), JSON.stringify({ plugins: entries, settings: {} }));
    const at = join(dir, "node_modules", "@plannotator", "pi-extension");
    if (input.entry === "link") symlinkSync(checkout, at, "dir");
    if (input.entry === "dangling") symlinkSync(join(root, "gone"), at, "dir");
    if (input.entry === "folder") cpSync(checkout, at, { recursive: true });
    return dir;
  }

  test("a checkout `omp plugin link` linked (a lock entry, no dependency) is installed; a link to nothing, a disabled one, a stray folder or a link the lock does not name is not", () => {
    expect(ompPluginInstalled(plugins({ entry: "link" }))).toBe(true);
    expect(ompPluginInstalled(plugins({ entry: "dangling" }))).toBe(false);
    expect(ompPluginInstalled(plugins({ entry: "link", enabled: false }))).toBe(false);
    // Oh My Pi skips a lock entry that is neither a dependency nor a link ("stale lockfile entry").
    expect(ompPluginInstalled(plugins({ entry: "folder" }))).toBe(false);
    expect(ompPluginInstalled(plugins({ entry: "link", lock: false }))).toBe(false);
    expect(ompPluginInstalled(plugins({ entry: "none" }))).toBe(false);
  });
});

describe("Oh My Pi's folders", () => {
  test("its plugin record under PI_CONFIG_DIR and a profile; XDG data only once that folder exists", () => {
    const env = (values: Record<string, string>) => (name: string) => values[name];
    expect(ompPluginsDirs(env({}), "/home/ada", "linux")).toEqual(["/home/ada/.omp/plugins"]);
    expect(ompPluginsDirs(env({ PI_CONFIG_DIR: ".omp-work", OMP_PROFILE: "quill" }), "/home/ada", "linux")).toEqual(["/home/ada/.omp-work/profiles/quill/plugins"]);
    expect(ompPluginsDirs(env({ XDG_DATA_HOME: "/nowhere-at-all" }), "/home/ada", "linux")).toEqual(["/home/ada/.omp/plugins"]);
  });

  test("its profile, agent dir and sessions root as Oh My Pi resolves them (XDG, `default`, an override a parent's profile set)", () => {
    const env = (values: Record<string, string>) => (name: string) => values[name];
    const xdg = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-omp-xdg-")));
    cleanup.push(() => rmSync(xdg, { recursive: true, force: true }));
    // `default` and an empty OMP_PROFILE are the default profile (an empty one wins over PI_PROFILE).
    expect(ompAgentDir(env({ OMP_PROFILE: "default" }), "/home/ada")).toBe("/home/ada/.omp/agent");
    expect(ompAgentDir(env({ OMP_PROFILE: "", PI_PROFILE: "quill" }), "/home/ada")).toBe("/home/ada/.omp/agent");
    expect(ompAgentDir(env({ PI_PROFILE: "quill" }), "/home/ada")).toBe("/home/ada/.omp/profiles/quill/agent");
    // A PI_CODING_AGENT_DIR that is PI_PROFILE's own agent dir is a parent's profile, not an override.
    expect(ompAgentDir(env({ OMP_PROFILE: "", PI_PROFILE: "quill", PI_CODING_AGENT_DIR: "/home/ada/.omp/profiles/quill/agent" }), "/home/ada")).toBe("/home/ada/.omp/agent");
    expect(ompAgentDir(env({ PI_CODING_AGENT_DIR: "/srv/agent" }), "/home/ada")).toBe("/srv/agent");
    // Sessions: under the agent dir, until $XDG_DATA_HOME/omp exists (no `agent/` there); never with an override.
    expect(ompSessionsRoot(env({ XDG_DATA_HOME: xdg }), "/home/ada", "linux")).toBe("/home/ada/.omp/agent/sessions");
    mkdirSync(join(xdg, "omp", "profiles", "quill"), { recursive: true });
    expect(ompSessionsRoot(env({ XDG_DATA_HOME: xdg }), "/home/ada", "linux")).toBe(join(xdg, "omp", "sessions"));
    expect(ompSessionsRoot(env({ XDG_DATA_HOME: xdg }), "/home/ada", "win32")).toBe("/home/ada/.omp/agent/sessions");
    expect(ompSessionsRoot(env({ XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: "/srv/agent" }), "/home/ada", "linux")).toBe("/srv/agent/sessions");
    expect(ompSessionsRoot(env({ XDG_DATA_HOME: xdg, OMP_PROFILE: "quill" }), "/home/ada", "darwin")).toBe(join(xdg, "omp", "profiles", "quill", "sessions"));
    expect(ompPluginsDirs(env({ XDG_DATA_HOME: xdg, OMP_PROFILE: "quill" }), "/home/ada", "darwin")[0]).toBe(join(xdg, "omp", "profiles", "quill", "plugins"));
  });

  test("its sessions folder names: under the temp root, under home, anywhere else", () => {
    const agent = "/home/ada/.omp/agent";
    expect(ompSessionDirOf(agent, "/home/ada/code/ledger", "/home/ada", "/tmp-root-that-is-not-there")).toBe(`${agent}/sessions/-code-ledger`);
    expect(ompSessionDirOf(agent, "/home/ada", "/home/ada", "/tmp-root-that-is-not-there")).toBe(`${agent}/sessions/-`);
    expect(ompSessionDirOf(agent, "/srv/quill-docs", "/home/ada", "/tmp-root-that-is-not-there")).toBe(`${agent}/sessions/--srv-quill-docs--`);
    expect(ompSessionDirOf(agent, "/tmp-root-that-is-not-there/x/y", "/home/ada", "/tmp-root-that-is-not-there")).toBe(`${agent}/sessions/-tmp-x-y`);
  });
});
