/**
 * Mistral Vibe through the real launch engine (inbox-launch.ts with its own hosts) and the real Vibe wake
 * (inbox-vibe-wake.ts), against the fake `vibe-acp` (tests/helpers/fake-vibe-launch.ts), never the real one. What each
 * test guards: To offers Vibe only with a new enough `vibe-acp` there; a Send starts one `vibe-acp` in the project's
 * folder with the person's env, makes a session there with the Inbox MCP server named for the Inbox's own session id,
 * and puts the root in as its first turn; a reply during a turn waits for it and is not recorded delivered until it
 * goes in (never a second prompt at once, never lost to a Stop); Stop cancels the turn and ends the process, and the
 * next reply loads the session again with the same identity; the model pick rides the process env, never a config write; no API key is a clear line; a failed turn
 * is a note; an approval is the permission card. No Inbox server is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_PERMISSION_ALLOW_ONCE } from "@plannotator/core/inbox-permission";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeVibeLaunch, type FakeVibeLaunchState } from "../../tests/helpers/fake-vibe-launch";
import { createInboxLaunch } from "./inbox-launch";
import { VIBE_SIGNED_OUT, vibeInboxMcpServer, vibeSpawnEnv, vibeStopNote } from "./inbox-launch-vibe";
import { vibeDecision } from "./inbox-launch-vibe-permission";
import { createInboxVibeWake } from "./inbox-vibe-wake";

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

function setup(options: { state?: FakeVibeLaunchState; withVibe?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-vibe-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  const vibeHome = join(home, ".vibe");
  for (const dir of [home, dataDir, folder, vibeHome]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const fake = installFakeVibeLaunch(join(root, "fake"), options.state ?? {});
  const bin = options.withVibe === false ? join(root, "empty-bin") : fake.bin;
  mkdirSync(bin, { recursive: true });
  const path = `${bin}:/usr/bin:/bin`;
  cleanup.push(() => {
    for (const start of fake.starts()) if (fake.alive(start.pid)) process.kill(start.pid, "SIGKILL"); // inbox-guard: own child (the fake vibe-acp)
  });
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "project", root: folder });
  const launch = createInboxLaunch({
    store,
    // Vibe has no bridge poll: its host's own process is what is live.
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    // The login shell: the person's VIBE_HOME, a name of its own, an outer Vibe shell's markers, Plannotator's own names.
    loginEnv: async () => ({ HOME: home, PATH: path, VIBE_HOME: vibeHome, LOGIN_ONLY: "from-login", VIBE_SESSION: "1", VIBE_CLI: "rust", PLANNOTATOR_PORT: "1", PLANNOTATOR_TEST_SANDBOX: "1" }),
    ownEnv: () => ({ HOME: home, PATH: path }),
    installDirs: [],
    displayFolder: (p) => p,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["/opt/plannotator"],
  });
  cleanup.push(() => launch.stop());
  const launched = () =>
    new Set(
      store
        .launchedRoots()
        .filter((m) => m.launch?.agent === "mistral-vibe" && !m.launch.deleted_at && m.to?.host === "mistral-vibe")
        .map((m) => m.to!.session),
    );
  const wake = createInboxVibeWake({
    store,
    commandOf: (item) => ({ type: item.reply_to ? "reply" : "message", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: item.subject ?? null, body: item.body, url: `http://127.0.0.1/#${item.thread_id}` }),
    deliver: (session, text) => launch.deliver("mistral-vibe", session, text),
    launched,
    log: () => {},
  });
  cleanup.push(() => wake.stop());
  const sendWith = async (body: string, choice: { model?: string } = {}) => {
    const target = launch.target({ launch: { agent: "mistral-vibe", project_id: project.id, ...choice } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body, resolveProject: async () => project });
    const message = store.startPersonThread({ project_id: project.id, body, to: prepared.to, idempotency_key: `send-${body}`, thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(message);
    return message;
  };
  const stopRoute = (launchId: string) =>
    launch.route(new Request(`http://127.0.0.1/api/inbox/launch/${launchId}/stop`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ server_session: "srv" }) }), `/api/inbox/launch/${launchId}/stop`, "local");
  /** The session processes, in the project's folder (the model list's throwaway `vibe-acp` runs in home). */
  const starts = () => fake.starts().filter((start) => start.cwd === folder);
  const rpc = (method: string) => {
    const pids = new Set(starts().map((start) => start.pid));
    return fake.rpc(method).filter((call) => pids.has(call.pid));
  };
  return { store, project, folder, dataDir, vibeHome, fake, starts, rpc, launch, wake, send: (body: string) => sendWith(body), sendWith, stopRoute };
}

describe("Mistral Vibe through the launch engine, against the fake vibe-acp", () => {
  test("To offers Vibe only once a new enough vibe-acp is there", async () => {
    const ready = setup();
    expect((await ready.launch.composeBlock())!.agents.map((a) => a.agent)).toContain("mistral-vibe");

    const missing = setup({ withVibe: false });
    const block = (await missing.launch.composeBlock())!;
    expect(block.agents.map((a) => a.agent)).not.toContain("mistral-vibe");
    expect(block.not_ready).toContainEqual({ agent: "mistral-vibe", name: "Vibe", code: "missing" });

    const old = setup({ state: { version: "vibe-acp 3.0.0" } });
    expect((await old.launch.composeBlock())!.not_ready).toContainEqual({ agent: "mistral-vibe", name: "Vibe", code: "too_old" });
  });

  test("Send starts vibe-acp in the folder with the person's env, makes a session with the Inbox MCP server named for it, and the root is its first turn", async () => {
    const t = setup();
    const root = await t.send("Tidy the readme.");
    const ref = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    const to = t.store.message(root.id)!.to!;
    expect(to.host).toBe("mistral-vibe");
    // The Inbox's own id for the session, not Vibe's: the MCP server names it.
    expect(to.session).not.toBe(ref);
    expect(t.store.message(root.id)!.launch!.session).toBe(to.session);

    const [start] = t.starts();
    expect(start!.cwd).toBe(t.folder);
    expect(start!.env).toMatchObject({ VIBE_HOME: t.vibeHome, LOGIN_ONLY: "from-login" });
    for (const name of ["VIBE_SESSION", "VIBE_CLI", "PLANNOTATOR_PORT", "VIBE_ACTIVE_MODEL"]) expect(start!.env[name]).toBeUndefined();

    const [made] = t.rpc("session/new");
    expect(made!.params.cwd).toBe(t.folder);
    expect(made!.params.mcpServers).toEqual([
      { name: "plannotator-inbox", command: "/opt/plannotator", args: ["inbox", "mcp"], env: [{ name: "PLANNOTATOR_VIBE_SESSION", value: to.session }, { name: "PLANNOTATOR_DATA_DIR", value: t.dataDir }] },
    ]);
    // Nothing that would write the person's config.toml.
    expect(t.rpc("session/set_config_option")).toHaveLength(0);

    await until("the root went in as a turn", () => t.fake.promptTexts().some((text) => text.includes("Tidy the readme.")));
    await until("the root marked delivered to that session", () => t.store.message(root.id)!.delivery);
    expect(t.store.message(root.id)!.delivery).toMatchObject({ host: "mistral-vibe", session: to.session });
    expect(t.rpc("session/prompt")[0]!.params.sessionId).toBe(ref);
  });

  test("a reply during a turn waits for it, undelivered; Stop cancels the turn and keeps the reply; the next reply loads the session with the same identity and both go in", async () => {
    const t = setup();
    const root = await t.send("First SLOW job.");
    const ref = await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    const session = t.store.message(root.id)!.to!.session;
    await until("working", async () => (await t.launch.runOf(root.id))?.state === "working");

    const one = t.store.sendReply(root.id, { words: "Also check the tests.", idempotency_key: "reply-1" }).reply!;
    await Bun.sleep(500);
    // It waits for the running turn: never a second prompt at once (the fake refuses one), and not delivered yet.
    expect(t.rpc("session/prompt").some((call) => JSON.stringify(call.params.prompt).includes("Also check the tests."))).toBe(false);
    expect(t.store.message(one.id)!.delivery ?? null).toBeNull();
    expect(t.starts()).toHaveLength(1);

    const stopped = await t.stopRoute(t.store.message(root.id)!.launch!.id);
    expect(stopped!.status).toBe(200);
    expect(t.rpc("session/cancel")[0]!.params).toEqual({ sessionId: ref });
    expect(t.rpc("session/close")[0]!.params).toEqual({ sessionId: ref });
    const pid = t.starts()[0]!.pid;
    await until("the process ended", () => !t.fake.alive(pid));
    expect(await t.launch.runOf(root.id)).toMatchObject({ state: "stopped" });
    // The reply that waited is kept for the next start, never recorded delivered.
    expect(t.rpc("session/prompt").some((call) => JSON.stringify(call.params.prompt).includes("Also check the tests."))).toBe(false);
    expect(t.store.message(one.id)!.delivery ?? null).toBeNull();

    t.store.sendReply(root.id, { words: "Please go on.", idempotency_key: "reply-2" });
    const again = await until("a second process", () => t.starts()[1]);
    const loaded = await until("it loaded the session", () => t.rpc("session/load").find((call) => call.pid === again.pid));
    expect(loaded.params.sessionId).toBe(ref);
    expect(loaded.params.mcpServers[0].env[0]).toEqual({ name: "PLANNOTATOR_VIBE_SESSION", value: session });
    await until("the new reply went in on it", () => t.rpc("session/prompt").some((call) => call.pid === again.pid && JSON.stringify(call.params.prompt).includes("Please go on.")));
    const onSecond = t.rpc("session/prompt").filter((call) => call.pid === again.pid).map((call) => JSON.stringify(call.params.prompt));
    expect(onSecond.findIndex((text) => text.includes("Also check the tests."))).toBe(0);
    await until("the kept reply marked delivered", () => t.store.message(one.id)!.delivery);
    expect(t.rpc("session/new")).toHaveLength(1);
  }, 30_000);

  test("model: Vibe's own list, no effort column; a pick goes on the process env at start and again on load", async () => {
    const t = setup({ state: { models: ["mistral-medium-latest", "devstral-2"] } });
    const choices = await until("the lists", async () => (await t.launch.composeBlock())!.agents.find((a) => a.agent === "mistral-vibe")?.choices);
    expect(choices).toMatchObject({ models: ["mistral-medium-latest", "devstral-2"], efforts: [] });

    const root = await t.sendWith("A SLOW job.", { model: "devstral-2" });
    await until("the session", () => t.store.message(root.id)!.launch!.session_ref);
    expect(t.store.message(root.id)!.launch).toMatchObject({ model: "devstral-2" });
    const pick = (start: { env: Record<string, string> }) => start.env.VIBE_ACTIVE_MODEL;
    expect(pick(t.starts().at(-1)!)).toBe("devstral-2");

    await until("working", async () => (await t.launch.runOf(root.id))?.state === "working");
    await t.stopRoute(t.store.message(root.id)!.launch!.id);
    const count = t.starts().length;
    t.store.sendReply(root.id, { words: "Go on.", idempotency_key: "reply-1" });
    const again = await until("loaded again", () => t.starts()[count]);
    expect(pick(again)).toBe("devstral-2");
  }, 30_000);

  test("no API key: the start fails with how to sign in, and the message is kept", async () => {
    const t = setup({ state: { signedOut: true } });
    const root = await t.send("Hello");
    await until("the start failed", () => t.store.message(root.id)!.launch!.error);
    expect(t.store.message(root.id)!.launch!.error).toMatchObject({ code: "failed", text: VIBE_SIGNED_OUT });
    expect(await t.launch.runOf(root.id)).toMatchObject({ state: "failed", cause: VIBE_SIGNED_OUT });
    await until("its process ended", () => t.starts().every((start) => !t.fake.alive(start.pid)));
  });

  test("a turn that fails is one note in the thread, with Vibe's own words", async () => {
    const t = setup({ state: { failTurn: "Rate limit exceeded for mistral-medium-latest." } });
    const root = await t.send("Do it.");
    const note = await until("the note", () =>
      t.store
        .threadMessageIds(root.id)
        .map((id) => t.store.message(id)!)
        .find((m) => m.author.kind === "agent" && m.body.startsWith("Vibe's turn ended with an error:")),
    );
    expect(note.body).toBe("Vibe's turn ended with an error: Rate limit exceeded for mistral-medium-latest.");
    expect(note.author).toMatchObject({ host: "mistral-vibe", name: "Vibe" });
    expect(note.turn_error).toBe(true);
  });

  test("an approval is the permission card; Allow once answers allow_once", async () => {
    const t = setup();
    const root = await t.send("Please APPROVE this.");
    const question = await until("the card", () => {
      const ids = t.store.threadMessageIds(root.id);
      const id = ids.find((m) => t.store.message(m)!.author.kind === "agent" && t.store.questionsOf(m).length > 0);
      return id ? { id, q: t.store.questionsOf(id)[0]! } : null;
    });
    // The card's action labels, pinned on purpose: they name what Vibe is asked to allow.
    expect(question.q.prompt).toBe("Vibe wants to run a command");
    expect(question.q.choices.map((c) => c.label)).toEqual(["Allow once", "Allow `touch` for this session", "Deny"]);
    expect(t.store.message(question.id)!.body).toContain("touch approved.txt");
    const picked = { v: 1 as const, key: question.q.key, kind: "single" as const, prompt: question.q.prompt, selected: [INBOX_PERMISSION_ALLOW_ONCE] };
    const saved = t.store.savePicks(question.id, [{ key: question.q.key, revision: question.q.revision, answer: picked }], { unsentOnly: true, confirmFull: false });
    t.store.sendReply(question.id, { idempotency_key: "answer-1", questions: [{ key: question.q.key, revision: saved[0]!.revision }] });
    await until("Vibe got allow_once", () => {
      t.launch.sweep(true);
      return t.fake.calls().some((call) => call.event === "answer" && call.method === "session/request_permission" && JSON.stringify(call.result) === JSON.stringify({ outcome: { outcome: "selected", optionId: "allow_once" } }));
    });
  });

  test("the session choice answers Vibe's own session option, never the one that writes its config", async () => {
    const t = setup();
    const root = await t.send("Please APPROVE this.");
    const question = await until("the card", () => {
      const id = t.store.threadMessageIds(root.id).find((m) => t.store.message(m)!.author.kind === "agent" && t.store.questionsOf(m).length > 0);
      return id ? { id, q: t.store.questionsOf(id)[0]! } : null;
    });
    const session = question.q.choices.map((c) => c.label).find((label) => label.endsWith("for this session"))!;
    const picked = { v: 1 as const, key: question.q.key, kind: "single" as const, prompt: question.q.prompt, selected: [session] };
    const saved = t.store.savePicks(question.id, [{ key: question.q.key, revision: question.q.revision, answer: picked }], { unsentOnly: true, confirmFull: false });
    t.store.sendReply(question.id, { idempotency_key: "answer-1", questions: [{ key: question.q.key, revision: saved[0]!.revision }] });
    const answer = await until("Vibe got an answer", () => {
      t.launch.sweep(true);
      return t.fake.calls().find((call) => call.event === "answer" && call.method === "session/request_permission");
    });
    expect((answer as { result: unknown }).result).toEqual({ outcome: { outcome: "selected", optionId: "allow_always" } });
  });

  test("Stop while an approval is open answers it cancelled, so the turn ends and the process goes", async () => {
    const t = setup();
    const root = await t.send("Please APPROVE this.");
    await until("the card", () => t.store.threadMessageIds(root.id).some((m) => t.store.message(m)!.author.kind === "agent" && t.store.questionsOf(m).length > 0));
    await t.stopRoute(t.store.message(root.id)!.launch!.id);
    expect(t.fake.calls().some((call) => call.event === "answer" && call.method === "session/request_permission" && JSON.stringify(call.result) === JSON.stringify({ outcome: { outcome: "cancelled" } }))).toBe(true);
    const pid = t.starts()[0]!.pid;
    await until("the process ended", () => !t.fake.alive(pid));
  }, 20_000);
});

describe("Mistral Vibe host pieces", () => {
  test("the spawn env keeps the person's names, drops Plannotator's and an outer Vibe shell's, and adds the model pick", () => {
    expect(vibeSpawnEnv({ PATH: "/bin", VIBE_HOME: "/h/.vibe", VIBE_SESSION: "1", VIBE_CLI: "rust", PLANNOTATOR_PORT: "1", MISTRAL_API_KEY: "k" }, "devstral-2")).toEqual({
      PATH: "/bin",
      VIBE_HOME: "/h/.vibe",
      MISTRAL_API_KEY: "k",
      VIBE_ACTIVE_MODEL: "devstral-2",
    });
    expect(vibeSpawnEnv({ PATH: "/bin" }, undefined)).toEqual({ PATH: "/bin" });
  });

  test("the MCP server runs this Plannotator's `inbox mcp`, always with the data dir (Vibe passes it no XDG_DATA_HOME)", () => {
    expect(vibeInboxMcpServer(["bun", "run", "/src/index.ts"], "s-1", "/home/me/.plannotator")).toEqual({
      name: "plannotator-inbox",
      command: "bun",
      args: ["run", "/src/index.ts", "inbox", "mcp"],
      env: [
        { name: "PLANNOTATOR_VIBE_SESSION", value: "s-1" },
        { name: "PLANNOTATOR_DATA_DIR", value: "/home/me/.plannotator" },
      ],
    });
  });

  test("Allow for this session picks only an id Vibe documents as session-only; with none, Allow once", () => {
    const once = { optionId: "allow_once", kind: "allow_once" };
    const session = { optionId: "allow_always", kind: "allow_always" };
    const permanent = { optionId: "allow_always_permanent", kind: "allow_always" };
    const unknown = { optionId: "allow_always_global", kind: "allow_always" };
    const deny = { optionId: "reject_once", kind: "reject_once" };
    expect(vibeDecision("session", [once, permanent, session, deny])).toEqual({ outcome: { outcome: "selected", optionId: "allow_always" } });
    expect(vibeDecision("session", [once, permanent, unknown, deny])).toEqual({ outcome: { outcome: "selected", optionId: "allow_once" } });
    expect(vibeDecision("deny", [once, session, deny])).toEqual({ outcome: { outcome: "selected", optionId: "reject_once" } });
    expect(vibeDecision("deny", [once])).toEqual({ outcome: { outcome: "cancelled" } });
  });

  test("a refusal or a limit is said; a normal end or a cancel says nothing", () => {
    expect(vibeStopNote("end_turn")).toBeNull();
    expect(vibeStopNote("cancelled")).toBeNull();
    expect(vibeStopNote("max_tokens")).toContain("token limit");
  });
});
