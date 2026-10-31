/**
 * OpenCode's launch host (inbox-launch-opencode.ts) and its permission terms
 * (inbox-launch-opencode-permission.ts). What each test guards:
 *  - To offers OpenCode only for 1.18+ below 2 with Plannotator's plugin in the person's config, and says why not;
 *  - a start runs one `opencode serve` per launch with this Inbox's data dir, the plugin's tool and launch id,
 *    and a password that lives only in server.json (0600): never argv, the start log, the server log, the Inbox
 *    log or the attach command (which reads it from the file, and does read it);
 *  - full permissions is an allow-all session ruleset; otherwise the person's own permissions decide;
 *  - Stop ends the server and the commands it left running; a reply starts a new server on the same session;
 *  - Delete's remove runs `opencode session delete`;
 *  - OpenCode's prompts read as the card's tools, with its own choices (no mode switch) and replies.
 * The real OpenCode is never run: the fake (tests/helpers/fake-opencode/) is the only `opencode` on PATH.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inboxPermissionAnswer, inboxPermissionQuestion } from "@plannotator/core/inbox-permission";
import type { InboxLaunchRecord } from "@plannotator/core/inbox-types";
import { installFakeOpenCode } from "../../tests/helpers/fake-opencode";
import { createAgentEnvironmentFor } from "./inbox-agents";
import type { LaunchHostContext } from "./inbox-launch-host";
import { createOpenCodeLaunchHost, openCodeAttachCommand, openCodeServerEnv, parseListening, parseOpenCodeVersion } from "./inbox-launch-opencode";
import { openCodePermissionEvent, openCodePermissionTerms, openCodeReply, readOpenCodePermission } from "./inbox-launch-opencode-permission";
import { openCode1LaunchWakes } from "../../apps/opencode-plugin/inbox";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
});

const LAUNCH_ID = "lch_01KAAAAAAAAAAAAAAAAAAAAAAA";

function world(options: { plugin?: boolean; version?: string; full?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pn-launch-opencode-")));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  for (const dir of [home, bin, dataDir, folder]) mkdirSync(dir, { recursive: true });
  if (options.plugin !== false) {
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ plugin: ["@plannotator/opencode@latest"] }));
  }
  const fake = installFakeOpenCode({ bin, state: join(root, "fake"), config: { ...(options.version ? { version: options.version } : {}), workMs: 50 } });
  const logs: string[] = [];
  const startLogs: string[] = [];
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const ctx: LaunchHostContext = {
    dataDir,
    homeDir: home,
    platform: process.platform,
    selfCommand: ["plannotator"],
    ownEnv: () => env,
    environment: async () => createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env }),
    shell: () => null,
    loginEnv: async () => ({ ...env, OPENCODE_SERVER_PASSWORD: "the-person-s-other-server", PLANNOTATOR_SESSION_TAG: "claude-code:x" }),
    config: () => ({ enabled: true, fullPermissions: options.full ?? null, model: null, scratchDir: null }) as never,
    launchDir: (id) => join(dataDir, "inbox", "launch", id),
    startLog: (_id, text) => startLogs.push(text),
    displayFolder: (path) => path,
    bridge: { runStateOf: () => null },
    log: (line) => logs.push(line),
  };
  const host = createOpenCodeLaunchHost(ctx);
  cleanup.push(() => {
    fake.stopAll();
    rmSync(root, { recursive: true, force: true });
  });
  const launch: InboxLaunchRecord = { id: LAUNCH_ID, agent: "opencode", session_ref: null, folder, scratch: false, started_at: new Date().toISOString(), ...(options.full ? { full_permissions: true } : {}) };
  return { root, home, dataDir, folder, fake, host, ctx, logs, startLogs, launch };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(what: string, check: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await Bun.sleep(25);
  }
}

describe("availability", () => {
  test("offered for 1.18+ with the plugin; refused, with the reason, without it, for OpenCode 2 and for an older one", async () => {
    expect(await world().host.available()).toEqual({ ok: true, version: "1.18.23" });
    expect(await world({ plugin: false }).host.available()).toMatchObject({ ok: false, missing: false, reason: "Plannotator's OpenCode plugin is not in your OpenCode config" });
    expect(await world({ version: "2.1.4" }).host.available()).toMatchObject({ ok: false, missing: false, reason: "OpenCode 2.1.4 is OpenCode 2, which the Inbox cannot start yet" });
    expect(await world({ version: "1.17.9" }).host.available()).toMatchObject({ ok: false, missing: false, reason: "OpenCode 1.17.9 is older than 1.18.0" });
    const gone = world();
    rmSync(join(gone.root, "bin", "opencode"));
    expect(await gone.host.available()).toMatchObject({ ok: false, missing: true });
  });
});

describe("a launch's server", () => {
  test("start: one server with this Inbox's data dir and the plugin's tool; the password only in server.json; Stop ends it and its children; a reply starts it again on the same session; remove deletes the session", async () => {
    const w = world();
    const started = await w.host.start(w.launch, { name: "Tidy the readme", login: await w.ctx.loginEnv() });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.session).toMatch(/^ses_/);
    expect(started.ref).toBe(started.session);
    const serve = w.fake.serves()[0]!;
    expect(serve.argv).toEqual(["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    expect(serve.cwd).toBe(w.folder);
    expect(serve.values).toMatchObject({ PLANNOTATOR_DATA_DIR: w.dataDir, PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_LAUNCH: LAUNCH_ID });
    // A password of its own (never the shell's other server's), and no Claude Code session tag.
    expect(serve.passwordSet).toBe(true);
    expect(serve.env).not.toContain("PLANNOTATOR_SESSION_TAG");
    const file = join(w.dataDir, "inbox", "launch", LAUNCH_ID, "server.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const server = JSON.parse(readFileSync(file, "utf8")) as { pid: number; url: string; password: string };
    expect(server.password).toMatch(/^[0-9a-f]{48}$/);
    expect(server.password).not.toBe("the-person-s-other-server");
    // The session: its title, no ruleset (the person's own permissions decide).
    expect(w.fake.sessions()).toEqual([{ id: started.session, directory: w.folder, title: "Tidy the readme", permission: null }]);

    // The password is nowhere else: argv, the start log, the server log, the Inbox log, the attach command.
    const launched = { ...w.launch, session_ref: started.session };
    const attach = w.host.attach(launched)!;
    const serverLog = readFileSync(join(w.dataDir, "inbox", "launch", LAUNCH_ID, "server.log"), "utf8");
    for (const text of [serve.argv.join(" "), ...w.startLogs, serverLog, ...w.logs, attach, w.host.terminal(launched, false)]) expect(text).not.toContain(server.password);
    // The attach command reads it from the file: run with `opencode attach` swapped for a print, it has it.
    const probe = attach.replace(/ opencode attach .*$/, ` /bin/sh -c 'printf %s "$OPENCODE_SERVER_PASSWORD"'`);
    expect(spawnSync("/bin/sh", ["-c", probe], { encoding: "utf8" }).stdout).toBe(server.password);
    expect(attach).toContain(`opencode attach ${server.url} --session ${started.session}`);

    const sessions = await w.host.sessions();
    expect(sessions!(started.session)).toEqual({ status: "idle", state: "running", waitingFor: null });

    // Stop: the turn is aborted, the server and the command it left running end.
    const child = w.fake.childOf(server.pid)!;
    expect(alive(server.pid) && child.alive).toBe(true);
    expect((await w.host.stop(started.session)).exitCode).toBe(0);
    expect(w.fake.aborts()).toEqual([started.session]);
    await until("the server and its child end", () => !alive(server.pid) && w.fake.processes().every((p) => !p.alive));
    expect(() => statSync(file)).toThrow();
    expect((await w.host.sessions())!(started.session)).toEqual({ status: null, state: "stopped", waitingFor: null });
    // Stopped: the attach command opens the session from OpenCode's own database.
    expect(w.host.attach(launched)).toBe(`cd ${w.folder} && opencode --session ${started.session}`);

    // A reply: a new server (a fresh login read), the same session.
    const resumed = await w.host.resume(launched);
    expect(resumed.failure).toBeNull();
    expect(w.fake.serves()).toHaveLength(2);
    const again = JSON.parse(readFileSync(file, "utf8")) as { pid: number; password: string };
    expect(again.pid).not.toBe(server.pid);
    expect(again.password).not.toBe(server.password);

    // Delete: stop, then the session goes from OpenCode's database.
    await w.host.stop(started.session);
    const removed = await w.host.remove(started.session);
    expect(removed.exitCode).toBe(0);
    expect(w.fake.calls().at(-1)!.argv).toEqual(["session", "delete", started.session, "--pure"]);
    expect(w.fake.sessions()).toEqual([]);
    await until("nothing of the fake runs", () => w.fake.processes().every((p) => !p.alive));
  }, 30_000);

  test("full permissions: the session gets an allow-all ruleset", async () => {
    const w = world({ full: true });
    expect(w.host.startOf("/x")).toEqual({ full: true, ownMode: false, bypass: false });
    const started = await w.host.start(w.launch, { name: "n", login: await w.ctx.loginEnv() });
    expect(started.ok).toBe(true);
    expect(w.fake.sessions()[0]!.permission).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
    if (started.ok) await w.host.stop(started.session);
  }, 30_000);

  test("a server that never comes up is a failed start, with the cause, and nothing left running", async () => {
    const w = world();
    w.fake.configure({ failServe: true });
    const started = await w.host.start(w.launch, { name: "n", login: await w.ctx.loginEnv() });
    expect(started).toMatchObject({ ok: false, code: "failed" });
    expect(w.fake.processes().every((p) => !p.alive)).toBe(true);
  }, 40_000);
});

describe("pure parts", () => {
  test("version and the listening line", () => {
    expect(parseOpenCodeVersion("1.18.23\n")).toBe("1.18.23");
    expect(parseListening("Warning: x\nopencode server listening on http://127.0.0.1:47961\n")).toBe("http://127.0.0.1:47961");
    expect(parseListening("opencode server listening on http://0.0.0.0:1\n")).toBeNull();
  });

  test("the server env: the launch filter, no other server's password, this launch's names", () => {
    const env = openCodeServerEnv({ PATH: "/bin", OPENCODE_SERVER_PASSWORD: "theirs", OPENCODE_SERVER_USERNAME: "u", PLANNOTATOR_DATA_DIR: "/real", PLANNOTATOR_SESSION_TAG: "t", ANTHROPIC_API_KEY: "k" }, { launchId: LAUNCH_ID, password: "p".repeat(48), dataDir: "/test" });
    expect(env).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: "k", OPENCODE_SERVER_PASSWORD: "p".repeat(48), PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_LAUNCH: LAUNCH_ID, PLANNOTATOR_DATA_DIR: "/test" });
    // The default data dir: no PLANNOTATOR_DATA_DIR at all (the plugin's own default is the same).
    expect(openCodeServerEnv({}, { launchId: LAUNCH_ID, password: "x", dataDir: null })).not.toHaveProperty("PLANNOTATOR_DATA_DIR");
  });

  test("the attach command quotes the folder, and with no server opens the session from the database", () => {
    expect(openCodeAttachCommand("/a b/it's", "ses_1", null)).toBe(`cd '/a b/it'\\''s' && opencode --session ses_1`);
  });

  test("the plugin says replies come back as turns only in a launch's server", () => {
    expect(openCode1LaunchWakes({ PLANNOTATOR_LAUNCH: LAUNCH_ID })).toBe(true);
    expect(openCode1LaunchWakes({})).toBe(false);
    expect(openCode1LaunchWakes({ PLANNOTATOR_LAUNCH: "yes" })).toBe(false);
  });
});

describe("OpenCode's permission prompts", () => {
  const terms = openCodePermissionTerms((p) => p);
  const asked = (value: Record<string, unknown>) => readOpenCodePermission({ id: "per_1", sessionID: "ses_1", ...value })!;

  test("a command: Allow once, Allow <its always rule> for this session, Deny; no mode switch, no Terminal hand-off", () => {
    const event = openCodePermissionEvent(asked({ permission: "bash", patterns: ["git status"], always: ["git status *"], metadata: { command: "git status" } }), "/p");
    expect(event).toMatchObject({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: "/p" });
    const q = inboxPermissionQuestion(event, { agent: "OpenCode", folder: "/p", ...terms });
    expect(q.prompt).toBe("OpenCode wants to run a command");
    expect(q.choices).toEqual(["Allow once", "Allow `git status` for this session", "Deny"]);
    // The pick by its label, as OpenCode's reply.
    const pick = (label: string, other: string | null = null) => inboxPermissionAnswer({ selected: [label], other, note: null, skipped: false } as never, event, terms);
    expect(openCodeReply(pick("Allow once").choice, null)).toEqual({ reply: "once" });
    const session = pick("Allow `git status` for this session");
    expect(openCodeReply(session.choice, session.reason)).toEqual({ reply: "always" });
    const deny = inboxPermissionAnswer({ selected: [], other: "not now", note: null, skipped: false } as never, event, terms);
    expect(openCodeReply(deny.choice, deny.reason)).toEqual({ reply: "reject", message: "The person denied this in the Plannotator Inbox. Do not retry it; go on with the next step without it. Their reason: not now" });
  });

  test("a file change shows OpenCode's own diff; `*` is every file edit", () => {
    const diff = "Index: /p/a.txt\n===\n--- /p/a.txt\n+++ /p/a.txt\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
    const event = openCodePermissionEvent(asked({ permission: "edit", patterns: ["a.txt"], always: ["*"], metadata: { filepath: "/p/a.txt", diff } }), "/p");
    const q = inboxPermissionQuestion(event, { agent: "OpenCode", folder: "/p", ...terms });
    expect(q.prompt).toBe("OpenCode wants to edit a file");
    expect(q.body).toContain("```diff\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n```");
    expect(q.body).not.toContain("Index:");
    expect(q.choices).toEqual(["Allow once", "Allow every file edit for this session", "Deny"]);
  });

  test("a permission the card has no words for keeps its own name and shows its input whole", () => {
    const event = openCodePermissionEvent(asked({ permission: "external_directory", patterns: ["/etc/*"], always: ["/etc/*"], metadata: { filepath: "/etc/hosts" } }), "/p");
    const q = inboxPermissionQuestion(event, { agent: "OpenCode", folder: "/p", ...terms });
    expect(q.prompt).toBe("OpenCode wants to use `external_directory`");
    expect(q.body).toContain('"/etc/hosts"');
    expect(readOpenCodePermission({ id: "nope", sessionID: "s", permission: "bash" })).toBeNull();
  });
});
