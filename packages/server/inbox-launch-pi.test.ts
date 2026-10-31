/**
 * Pi's launch host (inbox-launch-pi.ts) against the fake `pi` (tests/helpers/fake-pi/), never the real one: the
 * process it owns per session, Stop and resume on the same session file, the extension dialog it answers Cancel
 * and says so in the thread, Open in Terminal handing the session over without a second writer, restarts that a
 * Stop, Delete or Open in Terminal cancels, the Inbox's stop ending every process, a start that fails, when the
 * row is offered, and the scratch purge. A small bridge in the test's own data dir stands in for the Inbox's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxLaunchRecord, InboxMessage } from "@plannotator/core/inbox-types";
import { resolveInboxLaunch } from "@plannotator/shared/config";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakePi, type FakePi } from "../../tests/helpers/fake-pi";
import { createAgentEnvironmentFor } from "./inbox-agents";
import type { LaunchHostContext, LaunchLive } from "./inbox-launch-host";
import type { LaunchEnv } from "./inbox-launch-env";
import { createPiLaunchHost, piDialogNote, piDialogTitle, piExtensionListed, piHandoffCommand, piSpawnEnv, PI_HANDED_BACK_NOTE, PI_HANDOFF_NOTE, PI_STOPPED_NOTE } from "./inbox-launch-pi";

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

/** The bridge polls of the test's data dir (the fake's extension finds it through inbox.json): live while it polls. */
function testBridge(dataDir: string) {
  const seen = new Map<string, { polls: number; last: number; holding: number }>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (new URL(req.url).pathname !== "/api/inbox/bridge/poll") return Response.json({});
      const { session } = (await req.json()) as { session: string };
      const entry = seen.get(session) ?? { polls: 0, last: 0, holding: 0 };
      seen.set(session, entry);
      entry.polls += 1;
      entry.holding += 1;
      await Bun.sleep(150);
      entry.holding -= 1;
      entry.last = Date.now();
      return Response.json({ commands: [] });
    },
  });
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  writeFileSync(join(dataDir, "inbox", "inbox.json"), JSON.stringify({ port: server.port, token: "test" }));
  return {
    runStateOf(session: string): LaunchLive | null {
      const entry = seen.get(session);
      return entry && (entry.holding > 0 || Date.now() - entry.last < 600) ? { busy: false, busySince: null, polls: entry.polls } : null;
    },
    stop: () => server.stop(true),
  };
}

function setup(
  config: Parameters<typeof installFakePi>[0]["config"] = { noConnect: true },
  options: { handoffMs?: number; terminalOpenMs?: number; dataDirName?: string; folderName?: string; ps?: string } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-pi-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, options.dataDirName ?? "data");
  const folder = join(root, options.folderName ?? "project");
  for (const dir of [home, bin, dataDir, folder]) mkdirSync(dir, { recursive: true });
  const fake: FakePi = installFakePi({ bin, state: join(root, "fake-pi"), home, config });
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const bridge = testBridge(dataDir);
  const logs: string[] = [];
  /** A login-shell read the test holds open (`holdLogin`), as a slow one would be. */
  let held: Promise<void> | null = null;
  const holdLogin = () => {
    let release!: () => void;
    held = new Promise<void>((done) => (release = done));
    return () => {
      held = null;
      release();
    };
  };
  const ctx: LaunchHostContext = {
    dataDir,
    homeDir: home,
    platform: "darwin",
    selfCommand: ["plannotator"],
    ownEnv: () => env,
    environment: async () => createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env }),
    shell: () => null,
    loginEnv: async (): Promise<LaunchEnv> => {
      if (held) await held;
      return { ...env };
    },
    config: () => resolveInboxLaunch({}),
    launchDir: (id) => join(dataDir, "inbox", "launch", id),
    startLog: (_id, text) => logs.push(text),
    displayFolder: (path) => path,
    bridge,
    log: () => {},
  };
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "project", root: folder });
  const roots = new Map<string, InboxMessage>();
  const hosts: ReturnType<typeof createPiLaunchHost>[] = [];
  /** A host on this context: another one is the Inbox started again. */
  const makeHost = () => {
    const made = createPiLaunchHost(ctx, options);
    const permissions = made.permissions({
      store,
      launchDir: ctx.launchDir,
      rootOf: (id) => roots.get(id) ?? null,
      roots: () => [...roots.values()],
      displayFolder: (path) => path,
      host: { stateOf: () => null, readAt: () => 0 },
      onChange: () => {},
    });
    hosts.push(made);
    return { host: made, sweep: () => permissions.sweep() };
  };
  const { host, sweep } = makeHost();
  const terminals: ReturnType<typeof Bun.spawn>[] = [];
  /** What Open in Terminal would run, run here as the person's shell runs a typed line (with the fake on PATH). */
  const runTerminal = (command: string, personShell = "/bin/sh") => {
    const shell = Bun.spawn([personShell, "-c", command], { env, stdout: "ignore", stderr: "ignore" });
    terminals.push(shell);
    return shell;
  };
  cleanup.push(async () => {
    for (const made of hosts) made.close();
    for (const terminal of fake.terminals()) if (fake.alive(terminal.pid)) process.kill(terminal.pid, "SIGTERM"); // inbox-guard: own child (the fake pi this test's Terminal command ran)
    for (const shell of terminals) shell.kill("SIGTERM");
    await until("every fake pi to end", () => [...fake.starts(), ...fake.terminals()].every((call) => !fake.alive(call.pid)), 4_000).catch(() => fake.stopAll());
    bridge.stop();
    rmSync(root, { recursive: true, force: true });
  });
  let n = 0;
  /** A started launch: its record, now with the session. */
  const started = async (login: Record<string, string> = env) => {
    n += 1;
    const launch: InboxLaunchRecord = { id: `lch_01J0000000000000000000000${n}`, agent: "pi", session_ref: null, folder, scratch: false, started_at: new Date().toISOString() };
    mkdirSync(ctx.launchDir(launch.id), { recursive: true });
    const message = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: { host: "pi", session: `launch:${launch.id}` }, idempotency_key: `send-${n}`, thread_name: `Tidy the readme ${n}`, launch }).message;
    roots.set(launch.id, message);
    const result = await host.start(launch, { name: "Tidy the readme", login });
    if (!result.ok) throw new Error(result.text);
    const settled: InboxLaunchRecord = { ...launch, session_ref: result.ref };
    roots.set(launch.id, { ...message, launch: settled });
    return { launch: settled, session: result.session, root: message, pid: fake.starts().at(-1)!.pid };
  };
  const agentNotes = (message: InboxMessage) =>
    store
      .threadMessageIds(message.thread_id)
      .map((id) => store.message(id)!)
      .filter((m) => m.author.kind === "agent");
  return { root, home, bin, dataDir, folder, fake, host, sweep, makeHost, store, logs, env, bridge, holdLogin, runTerminal, started, agentNotes, launchDir: ctx.launchDir };
}

describe("Pi's launch host, against the fake pi", () => {
  test("start: one RPC process on an exact session id in the folder, the Inbox tool on, this Inbox's data dir, nothing else on argv", async () => {
    const { fake, host, folder, dataDir, env, started } = setup();
    const { session, launch } = await started({ ...env, PLANNOTATOR_SESSION_TAG: "the Inbox's own", PLANNOTATOR_DATA_DIR: "/somewhere/else", ANTHROPIC_API_KEY: "from-the-login-shell", PI_SESSION_ID: "the-session-the-inbox-runs-in" });
    expect(launch.session_ref).toBe(session);
    const [call] = fake.starts();
    expect(call!.argv).toEqual(["--mode", "rpc", "--session-id", session, "--name", "Tidy the readme"]);
    expect(call!.cwd).toBe(folder);
    // The launched session reaches this Inbox (not the person's default one), with the Inbox tool on for it alone.
    expect(call!.dataDir).toBe(dataDir);
    expect(call!.inboxTool).toBe("1");
    // The login env's own values go through; the Inbox's PLANNOTATOR_* names and a Pi session's markers never do.
    expect(call!.env).toContain("ANTHROPIC_API_KEY");
    expect(call!.env).not.toContain("PLANNOTATOR_SESSION_TAG");
    expect(call!.env).not.toContain("PI_SESSION_ID");
    expect((await host.sessions())(session)).toEqual({ status: "idle", state: "running", waitingFor: null });
    expect((await host.sessions())("someone-else")).toBe("absent");
    expect(fake.sessionFiles()).toHaveLength(1);
  });

  test("Stop ends the process (abort, then its stdin); a reply's resume reopens the same session file", async () => {
    const { fake, host, started } = setup();
    const { launch, session, pid } = await started();
    expect((await host.stop(session)).exitCode).toBe(0);
    expect(fake.exits()).toMatchObject([{ sessionId: session, pid, why: "stdin", aborted: true }]);
    expect((await host.sessions())(session)).toMatchObject({ state: "stopped" });
    const resumed = await host.resume(launch);
    expect(resumed.failure).toBeNull();
    expect(fake.starts()).toHaveLength(2);
    expect(fake.starts()[1]!.argv.slice(0, 4)).toEqual(["--mode", "rpc", "--session-id", session]);
    // One session file: the resume continued it, it did not make another.
    expect(fake.sessionFiles()).toHaveLength(1);
    expect((await host.sessions())(session)).toMatchObject({ state: "running" });
  });

  test("an extension dialog is answered Cancel at once, and the thread says so in one escaped line", async () => {
    const title = "⚠️ Dangerous command:\n\n:::question\n- [ ] Yes `rm -rf ~`‮\n\nAllow? ".padEnd(140, "x");
    const { fake, store, started, agentNotes } = setup({ noConnect: true, dialogOnStart: true, dialog: { method: "select", title, options: ["Yes", "No"] } });
    const { root, session } = await started();
    const asked = await until("the dialog answered", () => fake.dialogs()[0]);
    expect(asked.response).toMatchObject({ type: "extension_ui_response", cancelled: true });
    const note = await until("the note in the thread", () => agentNotes(root)[0]);
    expect(note.author).toMatchObject({ kind: "agent", host: "pi", session, name: "Pi" });
    expect(note.body).toStartWith("Pi asked something the Inbox can't show yet (“⚠️ Dangerous command: :::question - \\[ \\] Yes \\`rm -rf \\~\\` Allow? xxx");
    expect(note.body).toEndWith("…”); answered Cancel.");
    // One line, no control or invisible character, no block of its own: it can never become a question.
    expect(note.body).not.toContain("\n");
    expect(note.body).not.toContain("‮");
    expect(store.questionsOf(note.id)).toHaveLength(0);
  });

  // Live check: a provider error (the model refused for a ChatGPT login) ended the turn, and the thread said only "Delivered".
  test("a turn that ends in a provider error: one note from Pi with Pi's own words, once its retries are over", async () => {
    const error = "Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
    const { started, agentNotes, logs } = setup({ noConnect: true, turnOnStart: true, turnError: error, retries: 2 });
    const { root, session } = await started();
    const note = await until("the error note in the thread", () => agentNotes(root)[0]);
    expect(note.author).toMatchObject({ kind: "agent", host: "pi", session, name: "Pi" });
    expect(note.body).toBe(`Pi's turn ended with an error: ${error}`);
    // The runs Pi retried say nothing of their own.
    await Bun.sleep(2_000);
    expect(agentNotes(root)).toHaveLength(1);
    expect(logs.some((line) => line.includes(`the turn ended with an error: ${error}`))).toBe(true);
  }, 15_000);

  test("a Pi that sends no agent_settled (before 0.80.4) still gets the note, as one escaped line", async () => {
    const { store, started, agentNotes } = setup({ noConnect: true, turnOnStart: true, turnError: "401 {\"error\":\"*expired*\"}\n\n:::question\n- [ ] Yes", settles: false });
    const { root } = await started();
    const note = await until("the error note in the thread", () => agentNotes(root)[0]);
    expect(note.body).toBe(`Pi's turn ended with an error: 401 \\{"error":"\\*expired\\*"\\} :::question - \\[ \\] Yes`);
    expect(store.questionsOf(note.id)).toHaveLength(0);
  });

  // Round 2, Should 4: the Inbox's Pi was ended before Terminal opened.
  test("Open in Terminal while the Inbox's process runs: it ends only once the terminal shows (its turn aborted), and the terminal's Pi waits for it", async () => {
    const { fake, host, runTerminal, started } = setup();
    const { launch, session, pid } = await started();
    // Copy attach command is not offered while the Inbox's process runs the session.
    expect(host.attach(launch)).toBeNull();
    const command = host.terminal(launch, false);
    // No terminal yet (osascript has not run, or failed): the Inbox's Pi keeps running.
    await Bun.sleep(700);
    expect(fake.alive(pid)).toBe(true);
    runTerminal(command);
    const exit = await until("the Inbox's process to end", () => fake.exits().find((e) => e.pid === pid));
    expect(exit).toMatchObject({ why: "stdin", aborted: true });
    const terminal = await until("the terminal's Pi", () => fake.terminals()[0]);
    expect(terminal.at).toBeGreaterThanOrEqual(exit.at);
    expect(terminal.argv).toEqual(["--session-id", session]);
    // A reply starts no second process here.
    expect((await host.resume(launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(1);
  });

  test("Open in Terminal that no terminal took: the Inbox's Pi keeps the session, and Open in Terminal works again", async () => {
    const { fake, host, started } = setup({ noConnect: true }, { terminalOpenMs: 400 });
    const { launch, pid } = await started();
    host.terminal(launch, false);
    await Bun.sleep(900);
    expect(fake.alive(pid)).toBe(true);
    expect(fake.exits()).toHaveLength(0);
    expect(host.terminal(launch, false)).toContain("kill -0"); // inbox-guard: own child (text of the Terminal command, no signal)
  });

  // Round 3, Should 1: a `pi` wrapper that does not exec read as "another process", so Open in Terminal always refused.
  test("with a pi wrapper that does not exec, Open in Terminal still hands the session over", async () => {
    const { fake, host, runTerminal, started } = setup();
    fake.setExec(false);
    const { launch, pid } = await started();
    const command = host.terminal(launch, false);
    expect(command).toContain("kill -0"); // inbox-guard: own child (text of the Terminal command, no signal)
    runTerminal(command);
    expect(await until("the Inbox's process to end", () => fake.exits().find((e) => e.pid === pid))).toMatchObject({ aborted: true });
    await until("the terminal's Pi", () => fake.terminals()[0]);
  });

  // Round 3, Should 2: with its folder gone, the hand-off command ran Pi at once, in the shell's own folder.
  test("the hand-off command with its folder gone runs no Pi", async () => {
    const { fake, root, runTerminal } = setup();
    const shell = runTerminal(piHandoffCommand(join(root, "gone"), randomUUID(), process.pid));
    await Promise.race([shell.exited, Bun.sleep(3_000)]);
    expect(shell.exitCode).toBe(1);
    expect(fake.terminals()).toHaveLength(0);
  });

  // Round 3, Must: Copy attach was offered again while the Pi the person started from it ran the session.
  test("Copy attach is not offered while the Pi started from it runs the session", async () => {
    const { fake, host, bridge, runTerminal, started } = setup({});
    const { launch, session } = await started();
    await until("the Inbox's Pi on the bridge", () => bridge.runStateOf(session));
    await host.stop(session);
    // Its own last polls still read live for a while: offered at once.
    const atStop = bridge.runStateOf(session);
    expect(atStop).not.toBeNull();
    const command = host.attach(launch);
    expect(command).not.toBeNull();
    runTerminal(command!);
    await until("its Pi on the bridge", () => fake.terminals()[0] && (bridge.runStateOf(session)?.polls ?? 0) > atStop!.polls);
    expect(host.attach(launch)).toBeNull();
  });

  // Round 3, Should 4: with no ps, "" read as "no process", and a restart started a second writer.
  test("when ps does not run, a reply's restart starts nothing and says why", async () => {
    const { fake, host, logs, started } = setup({ noConnect: true }, { ps: "/nonexistent/plannotator-test/ps" });
    const { launch, session } = await started();
    await host.stop(session);
    const refused = await host.resume(launch);
    expect(refused.failure).toMatchObject({ code: "failed", text: expect.stringContaining("could not list processes") });
    expect(logs.some((line) => line.includes("did not run"))).toBe(true);
    expect(fake.starts()).toHaveLength(1);
  });

  // Round 2, Must 1: a second Open in Terminal (or Copy attach) before the bridge saw the first terminal's Pi.
  test("a second Open in Terminal, or Copy attach, during a hand-off gives no second Pi on the session", async () => {
    const { fake, host, runTerminal, started } = setup();
    const running = await started();
    const first = host.terminal(running.launch, false);
    const second = host.terminal(running.launch, false);
    expect(host.attach(running.launch)).toBeNull();
    runTerminal(first);
    runTerminal(second);
    await until("the first terminal's Pi", () => fake.terminals().length === 1);
    await Bun.sleep(800);
    expect(fake.terminals().filter((call) => fake.alive(call.pid))).toHaveLength(1);
    expect(second).toStartWith("echo ");

    // The same on a stopped session.
    const stopped = await started();
    await host.stop(stopped.session);
    const one = host.terminal(stopped.launch, false);
    expect(host.attach(stopped.launch)).toBeNull();
    runTerminal(one);
    runTerminal(host.terminal(stopped.launch, false));
    await until("its terminal's Pi", () => fake.terminals().some((call) => call.argv[1] === stopped.session));
    await Bun.sleep(800);
    expect(fake.terminals().filter((call) => call.argv[1] === stopped.session && fake.alive(call.pid))).toHaveLength(1);
  });

  // Round 2, Must 2: an Inbox started again forgot the hand-off, and a reply started an RPC Pi beside the terminal's.
  test("after an Inbox restart, a Pi open in a terminal on the session keeps every restart off, until it quit", async () => {
    const { fake, host, makeHost, dataDir, runTerminal, started } = setup();
    const { launch, session } = await started();
    await host.stop(session);
    // The terminal's Pi cannot reach the new Inbox yet (it retries on its own backoff).
    rmSync(join(dataDir, "inbox", "inbox.json"));
    runTerminal(host.terminal(launch, false));
    const terminal = await until("the terminal's Pi", () => fake.terminals()[0]);
    const restarted = makeHost().host;
    // The reply waits for that Pi: held, not restarted; no attach command, no second terminal.
    expect(restarted.live(session)).toMatchObject({ busy: null });
    expect((await restarted.resume(launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(1);
    expect(restarted.attach(launch)).toBeNull();
    expect(restarted.terminal(launch, false)).toStartWith("echo ");
    process.kill(terminal.pid, "SIGTERM"); // inbox-guard: own child (the fake pi this test's Terminal command ran)
    await until("it to quit", () => !fake.alive(terminal.pid));
    await Bun.sleep(1_700);
    expect(restarted.live(session)).toBeNull();
    expect((await restarted.resume(launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(2);
  });

  // Round 2, Should 3: a reply during a hand-off read as a restart ("Starting Pi again…", then "did not connect").
  test("during a hand-off the session reads as held, so a reply waits for the terminal's Pi; once it is over, it reads as stopped", async () => {
    const { host, started } = setup({ noConnect: true }, { handoffMs: 300 });
    const { launch, session } = await started();
    await host.stop(session);
    expect(host.live(session)).toBeNull();
    host.terminal(launch, false);
    expect(host.live(session)).toMatchObject({ busy: null });
    await Bun.sleep(400);
    expect(host.live(session)).toBeNull();
  });

  // Round 2, Should 1 and 5: the Terminal command in another shell's syntax, an odd data dir and folder.
  test("the Terminal command runs the same from sh and from csh, with spaces, quotes and shell marks in the data dir and the folder", async () => {
    const odd = { dataDirName: `data dir 'q' "dq" $HOME \`x\` ; &`, folderName: `pro'ject $(x) "y"` };
    const { fake, host, dataDir, folder, runTerminal, started } = setup({ noConnect: true }, odd);
    for (const personShell of ["/bin/sh", "/bin/csh"]) {
      if (!existsSync(personShell)) continue;
      const { launch, session } = await started();
      runTerminal(host.terminal(launch, false), personShell);
      const terminal = await until(`the terminal's Pi from ${personShell}`, () => fake.terminals().find((call) => call.argv[1] === session));
      expect(terminal).toMatchObject({ argv: ["--session-id", session], cwd: folder, dataDir, inboxTool: "1" });
    }
  });

  // Must 1: the Terminal's Pi polled nothing (no Inbox tool), and a timer alone ended the hand-off.
  test("the Terminal's Pi takes the session through this Inbox's bridge; nothing starts here until it quit, however long it runs", async () => {
    const { fake, host, dataDir, bridge, runTerminal, started } = setup({ noConnect: true }, { handoffMs: 300 });
    const { launch, session, pid } = await started();
    runTerminal(host.terminal(launch, false));
    // It runs only once the Inbox's process is gone, and it polls this Inbox: the Inbox tool on, this data dir.
    await until("the Terminal's Pi on the bridge", () => bridge.runStateOf(session));
    const [terminal] = fake.terminals();
    expect(terminal).toMatchObject({ inboxTool: "1", dataDir, argv: ["--session-id", session] });
    expect(fake.exits().find((e) => e.pid === pid)!.at).toBeLessThanOrEqual(terminal!.at);
    // Long past the hand-off's minute (here 300 ms): while the Terminal's Pi runs, a reply starts nothing here,
    // and nothing offers a second Pi on the session.
    await Bun.sleep(700);
    expect((await host.resume(launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(1);
    expect(host.attach(launch)).toBeNull();
    // It quit there: the next reply continues the session here.
    process.kill(terminal!.pid, "SIGTERM"); // inbox-guard: own child (the fake pi this test's Terminal command ran)
    await until("the bridge to lose it", () => !bridge.runStateOf(session));
    expect((await host.resume(launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(2);
  });

  // Must 2: Open in Terminal on a session that is not running opened no hand-off, and a restart reading the login shell went on.
  test("Open in Terminal on a stopped session, or during a reply's restart, hands it over: nothing starts here", async () => {
    const { fake, host, holdLogin, started, dataDir, folder } = setup();
    const a = await started();
    await host.stop(a.session);
    host.terminal(a.launch, false);
    expect((await host.resume(a.launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(1);

    const b = await started();
    await host.stop(b.session);
    const release = holdLogin();
    const restart = host.resume(b.launch);
    // A restart under way: no Copy attach; Open in Terminal gives the Terminal the session, and the restart stops.
    expect(host.attach(b.launch)).toBeNull();
    const command = host.terminal(b.launch, false);
    expect(command).toContain(b.session);
    expect(command).not.toStartWith("echo ");
    expect(command).not.toContain("kill -0"); // inbox-guard: own child (text of the Terminal command, no signal)
    release();
    expect(await restart).toMatchObject({ failure: null, text: expect.stringContaining("nothing started") });
    expect(fake.starts()).toHaveLength(2);
  });

  // Must 3: a Stop or Delete (Delete stops first) during a reply's restart still started Pi.
  test("Stop or Delete during a reply's restart: before its spawn nothing starts; as it comes up it ends", async () => {
    const { fake, host, holdLogin, started } = setup({ noConnect: true });
    const a = await started();
    await host.stop(a.session);
    const release = holdLogin();
    const restart = host.resume(a.launch);
    const stopping = host.stop(a.session);
    release();
    expect((await restart).failure).toBeNull();
    expect((await stopping).exitCode).toBe(0);
    expect(fake.starts()).toHaveLength(1);

    fake.configure({ readyDelayMs: 1_500 });
    const comingUp = host.resume(a.launch);
    const second = await until("the restart's process", () => fake.starts()[1]);
    await host.stop(a.session);
    expect((await comingUp).failure).toBeNull();
    await until("it to end", () => fake.exits().find((e) => e.pid === second.pid));
    expect((await host.sessions())(a.session)).toMatchObject({ state: "stopped" });
  });

  test("Try again on a Pi that runs but never connected: that process ends, a new one starts", async () => {
    const { fake, host, started } = setup({ noConnect: true });
    const { launch, pid } = await started();
    expect((await host.resume(launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(2);
    expect(fake.exits()).toMatchObject([{ pid, why: "stdin", aborted: true }]);
  });

  test("the stopped line's cause is this launch's: ended on its own, open in Terminal, back from it, or the Inbox restarted", async () => {
    const { fake, host, makeHost, sweep, started } = setup({ noConnect: true }, { handoffMs: 300 });
    const crashed = await started();
    process.kill(crashed.pid, "SIGKILL"); // inbox-guard: own child (the fake pi this test started)
    await until("the host to see it end", () => host.stoppedNote(crashed.launch)?.includes("ended on its own"));

    const handed = await started();
    await host.stop(handed.session);
    host.terminal(handed.launch, false);
    expect(host.stoppedNote(handed.launch)).toBe(PI_HANDOFF_NOTE);
    await Bun.sleep(400);
    sweep();
    expect(host.stoppedNote(handed.launch)).toBe(PI_HANDED_BACK_NOTE);

    // The Inbox started again: it never ran these sessions.
    expect(makeHost().host.stoppedNote(crashed.launch)).toBe(PI_STOPPED_NOTE);
  });

  test("the Inbox stops (close): every process gets abort, then the end of its stdin", async () => {
    const { fake, host, started } = setup();
    await started();
    await started();
    host.close();
    await until("both processes to end", () => fake.exits().length === 2);
    expect(fake.exits().every((exit) => exit.why === "stdin" && exit.aborted === true)).toBe(true);
  });

  test("a Pi from before that still runs the session (pi.pid): no second one starts; once it is gone, one does", async () => {
    const { fake, host, makeHost, started } = setup();
    const { launch, session } = await started();
    const restarted = makeHost().host;
    const refused = await restarted.resume(launch);
    expect(refused.failure).toMatchObject({ code: "failed", text: expect.stringContaining(`(pid ${fake.starts()[0]!.pid})`) });
    expect(fake.starts()).toHaveLength(1);
    await host.stop(session);
    expect((await restarted.resume(launch)).failure).toBeNull();
    expect(fake.starts()).toHaveLength(2);
  });

  test("a session file that is gone: Pi starts the session again, and the thread says it starts with no memory", async () => {
    const { fake, host, started, agentNotes } = setup();
    const { launch, session, root } = await started();
    await host.stop(session);
    const [file] = fake.sessionFiles();
    rmSync(file!);
    expect((await host.resume(launch)).failure).toBeNull();
    const note = await until("the note", () => agentNotes(root).find((m) => m.body.startsWith("Pi's session file for this thread is gone")));
    expect(note.body).toContain(file!);
    expect(note.author).toMatchObject({ host: "pi", session });
    // A file that is there: no note.
    await host.stop(session);
    await host.resume(launch);
    expect(agentNotes(root)).toHaveLength(1);
  });

  test("a start that fails: the cause from Pi's stderr, and nothing left running", async () => {
    const { fake, host, store, folder } = setup({ startFail: "Error: No API key found for anthropic" });
    const project = store.ensureProject({ name: "project", root: folder });
    const launch: InboxLaunchRecord = { id: "lch_01J00000000000000000000009", agent: "pi", session_ref: null, folder, scratch: false, started_at: new Date().toISOString() };
    store.startPersonThread({ project_id: project.id, body: "Hi.", to: { host: "pi", session: `launch:${launch.id}` }, idempotency_key: "send-fail", launch });
    const result = await host.start(launch, { name: "Hi", login: { HOME: "", PATH: fake.shell.replace(/\/login-shell$/, "") + ":/usr/bin:/bin" } });
    expect(result).toMatchObject({ ok: false, code: "failed", text: "Pi did not start: Error: No API key found for anthropic" });
    expect(fake.starts().every((call) => !fake.alive(call.pid))).toBe(true);
  });

  test("offered only with pi new enough and Plannotator's Pi extension in Pi's settings", async () => {
    const { fake, host } = setup();
    expect(await host.available()).toEqual({ ok: true, version: "0.85.1" });
    fake.setExtension(false);
    expect(await host.available()).toMatchObject({ ok: false, missing: false, reason: expect.stringContaining("Pi extension") });
    fake.setExtension(true);
    fake.configure({ version: "0.70.0" });
    expect(await host.available()).toMatchObject({ ok: false, missing: false, reason: "Pi 0.70.0 is older than 0.79.1" });
    fake.setInstalled(false);
    expect(await host.available()).toMatchObject({ ok: false, missing: true });
  });

  test("purge of a scratch folder: only the session files whose header names that folder", async () => {
    const { home, host, folder, started, fake } = setup();
    const { session } = await started();
    await host.stop(session);
    const dir = join(home, ".pi", "agent", "sessions", `--${folder.slice(1).replace(/\//g, "-")}--`);
    // Another folder whose name encodes the same way (Pi maps "/" and "-" alike): never removed.
    writeFileSync(join(dir, "other.jsonl"), `${JSON.stringify({ type: "session", id: "x", cwd: `${folder}-elsewhere` })}\n`);
    expect((await host.purge(folder)).skipped).toBeUndefined();
    expect(fake.sessionFiles()).toEqual([join(dir, "other.jsonl")]);
    expect(existsSync(dir)).toBe(true);
    expect(readFileSync(join(dir, "other.jsonl"), "utf8")).toContain("elsewhere");
  });
});

describe("Pi's pure pieces", () => {
  test("the extension check reads Pi's packages and extensions, in either form, and only Plannotator's Pi extension", () => {
    expect(piExtensionListed(JSON.stringify({ packages: ["npm:pi-subagents", "npm:@plannotator/pi-extension"] }))).toBe(true);
    expect(piExtensionListed(JSON.stringify({ packages: [{ source: "../plannotator/apps/pi-extension" }] }))).toBe(true);
    expect(piExtensionListed(JSON.stringify({ extensions: ["/opt/plannotator/apps/pi-extension/index.ts"] }))).toBe(true);
    expect(piExtensionListed(JSON.stringify({ packages: ["npm:pi-subagents", "npm:plannotator-themes"] }))).toBe(false);
    expect(piExtensionListed("{not json")).toBe(false);
    expect(piExtensionListed(null)).toBe(false);
  });

  test("the spawn env drops every PLANNOTATOR_* name and a Pi session's markers; the data dir only when not the default", () => {
    const pi = { PI_SESSION_ID: "s", PI_SESSION_FILE: "/f", PI_PROVIDER: "p", PI_MODEL: "m", PI_REASONING_LEVEL: "high" };
    expect(piSpawnEnv({ PATH: "/bin", PLANNOTATOR_SESSION_TAG: "t", PLANNOTATOR_DATA_DIR: "/x", ...pi, PI_CODING_AGENT_DIR: "/a" }, null)).toEqual({ PATH: "/bin", PI_CODING_AGENT_DIR: "/a", PLANNOTATOR_INBOX_TOOL: "1" });
    expect(piSpawnEnv({ PATH: "/bin" }, "/tmp/data")).toEqual({ PATH: "/bin", PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_DATA_DIR: "/tmp/data" });
  });

  test("a dialog's title keeps an emoji whole and drops bidi controls; one with no title still says what happened", () => {
    expect(piDialogTitle("👩‍💻 Deploy‮ now?")).toBe("👩‍💻 Deploy now?");
    expect(piDialogNote(undefined)).toBe("Pi asked something the Inbox can't show yet; answered Cancel.");
  });
});
