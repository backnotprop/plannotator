/**
 * T3 Code as a launch host (issue #3590): New message → To → T3 Code and a project starts a new T3 thread there, in
 * a new git worktree, with the message as its first turn, and the person's replies go in through the T3 wake.
 *
 * The launch engine and the real T3 host against a fake T3 home (tests/helpers/fake-t3.ts: a `t3` launcher that
 * answers `thread start` and `thread send` as T3's cli/thread.ts does), in a scratch home and data folder. No Inbox
 * server and no T3 run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_LAUNCHED_LINE, type InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { makeFakeT3Home } from "../../tests/helpers/fake-t3";
import { stubBridge } from "../../tests/helpers/stub-bridge";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { codexQueueMessage } from "./inbox-codex-wake";
import { createInboxLaunch } from "./inbox-launch";
import { createT3LaunchHost, gitRepoOf, T3_LAUNCH_NOT_OPEN, t3BaseOf, t3StartCause, t3StartedThreadOf, t3StartFailure } from "./inbox-launch-t3";
import type { LaunchHostContext } from "./inbox-launch-host";
import { createT3Local } from "./inbox-t3-local";
import { createInboxT3Wake } from "./inbox-t3-wake";

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

/** The bridge command the wake words a message from, as inbox.ts's `replyCommand` gives it (the launched lines included). */
const commandOf = (item: InboxMessage): InboxReplyCommand => ({
  type: "reply",
  id: item.id,
  thread_id: item.thread_id,
  reply_to: item.reply_to ?? null,
  subject: null,
  body: item.body,
  url: "http://127.0.0.1/#thread",
  ...(item.launch ? { launched: { agent: item.launch.agent, project: true } } : {}),
});

/** A git repository as git leaves it on disk: `.git/HEAD` naming the branch it has checked out. No git is run. */
function repo(folder: string, head = "ref: refs/heads/main") {
  mkdirSync(join(folder, ".git"), { recursive: true });
  writeFileSync(join(folder, ".git", "HEAD"), `${head}\n`);
}

function setup(options: { t3?: boolean; known?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-t3-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const shop = join(home, "code", "shop");
  const notes = join(home, "notes");
  for (const dir of [home, dataDir, shop, notes]) mkdirSync(dir, { recursive: true });
  repo(shop, "ref: refs/heads/release/2.4");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const t3 = options.t3 === false ? null : makeFakeT3Home(home, {}, { projects: options.known === false ? [] : [shop] });
  const path = "/usr/bin:/bin";
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "shop", root: shop });
  const plain = store.ensureProject({ name: "notes", root: notes });
  const bridge = stubBridge(dataDir, store);
  cleanup.push(() => bridge.stop());
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: (session) => bridge.runStateOf(session) },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    loginEnv: async () => ({ HOME: home, PATH: path, PLANNOTATOR_TEST_SANDBOX: "1" }),
    ownEnv: () => ({ HOME: home, PATH: path }),
    installDirs: [],
    displayFolder: (p) => p.replace(home, "~"),
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
    firstTurn: (message) => codexQueueMessage(commandOf(message)),
  });
  cleanup.push(() => launch.stop());
  const send = async (body: string, at = project) => {
    const target = launch.target({ launch: { agent: "t3", project_id: at.id } })!;
    const prepared = await launch.prepare(target, { name: "Checkout copy", body, resolveProject: async () => at });
    const message = store.startPersonThread({ project_id: at.id, body, to: prepared.to, idempotency_key: `send-${body}`, thread_name: "Checkout copy", launch: prepared.launch }).message;
    launch.begin(message);
    return message;
  };
  const environment = createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: path, PLANNOTATOR_TEST_SANDBOX: "1" } });
  /** The T3 wake that exists already, reaching T3 through `t3 thread send`. */
  const wake = () => {
    const local = createT3Local({ environment, sendTimeoutMs: 5_000, probeMs: 25 });
    const made = createInboxT3Wake({ store, dataDir, commandOf, local, log: () => {} });
    cleanup.push(() => {
      made.stop();
      local.stop();
    });
    return made;
  };
  return { home, shop, notes, store, project, plain, t3, launch, send, wake };
}

describe("T3 Code through the launch engine, against a fake t3", () => {
  test("To offers T3 Code in the projects that are git repositories, always in a new worktree; with no t3, it is not on this computer", async () => {
    const t = setup();
    const block = (await t.launch.composeBlock())!;
    const entry = block.agents.find((a) => a.agent === "t3");
    expect(entry).toMatchObject({ name: "T3 Code", starts_in: [t.project.id], worktree: true });
    // The other agents start anywhere, as before.
    expect(block.agents.filter((a) => a.agent !== "t3").every((a) => a.starts_in === undefined && a.worktree === undefined)).toBe(true);

    const none = setup({ t3: false });
    const missing = (await none.launch.composeBlock())!;
    expect(missing.agents.map((a) => a.agent)).not.toContain("t3");
    expect(missing.not_ready).toContainEqual({ agent: "t3", name: "T3 Code", code: "missing" });
  });

  test("Send runs `t3 thread start` in the project with the checked-out branch as the worktree's base, the wake text on stdin, and moves the root to the new thread, delivered", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    const [start] = t.t3!.starts();
    expect(start!.id).toBe(session);
    expect(start!.cwd).toBe(t.shop);
    expect(start!.base).toBe("release/2.4");
    expect(start!.title).toBe("Checkout copy");
    expect(t.t3!.calls()[0]).toEqual(["thread", "start", ".", "-", "--worktree", "release/2.4", "--title", "Checkout copy", "--json"]);
    // The words the T3 wake would send the thread: the message, and the line that says the Inbox started it.
    const after = t.store.message(root.id)!;
    expect(start!.text).toBe(codexQueueMessage(commandOf(after)));
    expect(start!.text).toContain("Tighten the checkout copy.");
    expect(start!.text).toContain(INBOX_LAUNCHED_LINE);
    expect(after.to).toEqual({ host: "t3", session });
    expect(after.delivery).toMatchObject({ state: "delivered", host: "t3", session });
    // The message is never in the command line T3's process list shows.
    expect(t.t3!.calls().flat().join(" ")).not.toContain("Tighten");
  });

  test("the T3 wake never sends the first message again, and a reply goes into the new thread once", async () => {
    const t = setup();
    const root = await t.send("Tighten the checkout copy.");
    const session = await until("the thread", () => t.store.message(root.id)!.launch!.session_ref);
    const wake = t.wake();
    await wake.sweep();
    await wake.sweep();
    expect(t.t3!.sends()).toEqual([]);

    const reply = t.store.sendReply(root.id, { words: "Keep the button label.", idempotency_key: "r1" }).reply!;
    await until("the reply went in", async () => {
      await wake.sweep();
      return t.store.message(reply.id)!.delivery;
    });
    expect(t.t3!.sends()).toEqual([["thread", "send", session, "-", "--json"]]);
    expect(t.t3!.turns().filter(([at]) => at === session).map(([, text]) => text.includes("Keep the button label."))).toEqual([false, true]);
  });

  test("a project that is not a git repository, a scratch folder and another folder are refused before anything is made", async () => {
    const t = setup();
    await expect(t.send("Sort the notes.", t.plain)).rejects.toThrow("~/notes isn't a git repository. T3 Code starts its work in a new worktree of one. Nothing was sent.");
    const scratch = t.launch.target({ launch: { agent: "t3", scratch: true } })!;
    await expect(t.launch.prepare(scratch, { name: "Try", body: "x", resolveProject: async () => t.project })).rejects.toThrow("T3 Code starts only in a project's git repository, in a new worktree. Nothing was sent.");
    mkdirSync(join(t.home, "drafts"));
    const other = t.launch.target({ launch: { agent: "t3", folder: "~/drafts" } })!;
    await expect(t.launch.prepare(other, { name: "Try", body: "x", resolveProject: async () => t.project })).rejects.toThrow("isn't a git repository. T3 Code starts its work in a new worktree of one. Nothing was sent.");
    expect(t.t3!.calls()).toEqual([]);
  });

  test("when T3 refuses, the run line says why in plain words: T3 Code not open (no server, or one not answering), a folder T3 doesn't know; never a path", async () => {
    for (const state of ["down", "stale"] as const) {
      const down = setup();
      down.t3!.setState(state);
      const one = await down.send("Tighten the checkout copy.");
      const error = await until("the start failed", () => down.store.message(one.id)!.launch!.error);
      expect(error).toMatchObject({ code: "failed", text: T3_LAUNCH_NOT_OPEN });
      expect(error.text).not.toContain("/");
      expect(down.store.message(one.id)!.delivery).toBeUndefined();
    }

    const unknown = setup({ known: false });
    const two = await unknown.send("Tighten the checkout copy.");
    const said = await until("the start failed", () => unknown.store.message(two.id)!.launch!.error);
    expect(said.text).toBe("shop isn't a project in T3 Code yet. Add its folder in T3 Code, then try again.");
  });
});

describe("T3 launch pieces", () => {
  test("a test run never offers a t3 outside its temp folder (a t3 on the person's PATH), only one in its scratch home", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-path-")));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const hostWith = (which: string | null) =>
      createT3LaunchHost({
        platform: "darwin",
        environment: async () => ({ ...createAgentEnvironmentFor({ platform: "darwin", homeDir: home, env: { PLANNOTATOR_TEST_SANDBOX: "1" } }), which: () => which }),
      } as unknown as LaunchHostContext);
    expect(await hostWith("/opt/homebrew/bin/t3").available()).toMatchObject({ ok: false, code: "missing" });
    expect(await hostWith(join(home, "bin", "t3")).available()).toMatchObject({ ok: true });
    makeFakeT3Home(home, {});
    expect(await hostWith(null).available()).toMatchObject({ ok: true });
  });

  test("the base is the branch the folder has checked out, HEAD when detached, and a linked worktree's own HEAD; none outside a repository", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-t3-base-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const main = join(root, "app");
    repo(main, "ref: refs/heads/feature/login");
    mkdirSync(join(main, "src", "deep"), { recursive: true });
    expect(t3BaseOf(join(main, "src", "deep"))).toBe("feature/login");
    expect(gitRepoOf(join(main, "src"))!.top).toBe(main);

    const detached = join(root, "detached");
    repo(detached, "3f2a9c0d1e4b5a6c7d8e9f0a1b2c3d4e5f6a7b8c");
    expect(t3BaseOf(detached)).toBe("HEAD");

    // A linked worktree: `.git` is a file naming its git dir, which has its own HEAD.
    const linked = join(root, "linked");
    const gitDir = join(main, ".git", "worktrees", "linked");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(linked);
    writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/fix/totals\n");
    writeFileSync(join(linked, ".git"), `gitdir: ${gitDir}\n`);
    expect(t3BaseOf(linked)).toBe("fix/totals");

    const plain = join(root, "plain");
    mkdirSync(plain);
    // The temp folder itself is in no repository either.
    expect(gitRepoOf(plain)).toBeNull();
    expect(t3BaseOf(plain)).toBeNull();
  });

  test("the thread is read from --json's last line", () => {
    const thread = "thread:project:5b1d2c3e-0f1a-4b2c-8d3e-4f5a6b7c8d9e:7c6d5e4f-3a2b-4c1d-9e0f-1a2b3c4d5e6f";
    expect(t3StartedThreadOf(`warming up\n${JSON.stringify({ threadId: thread, projectId: "p", runId: "r" })}\n`)).toBe(thread);
    expect(t3StartedThreadOf(JSON.stringify({ projectId: "p" }))).toBeNull();
    expect(t3StartedThreadOf("not json")).toBeNull();
  });

  test("a failed start's cause: the host's own sentence for each case it recognises, never T3's path or server words", () => {
    const failed = (stderr: string) => t3StartFailure({ exitCode: 1, stdout: "", stderr }, "shop");
    // T3 Code not open: no server for its home, or a runtime file whose server does not answer.
    expect(failed("No running T3 Code server uses /Users/me/.t3. Start T3 Code, then retry.")).toBe("T3 Code isn't open on this computer. Open it, then try again.");
    expect(failed("Could not reach the T3 Code server at http://127.0.0.1:3773. connect ECONNREFUSED")).toBe("T3 Code isn't open on this computer. Open it, then try again.");
    // The folder is in no project T3 knows.
    expect(failed("No T3 Code project matches '.'. Pass a project id or a path inside a project.")).toBe("shop isn't a project in T3 Code yet. Add its folder in T3 Code, then try again.");
    // No answer in time; an answer with no thread in it.
    expect(t3StartFailure({ timedOut: true, exitCode: null, stdout: "", stderr: "" }, "shop")).toBe("T3 Code didn't answer within 30 seconds. It may have started the thread, so look in T3 Code before you try again.");
    expect(t3StartFailure({ exitCode: 0, stdout: "{}", stderr: "" }, "shop")).toBe("T3 Code started a thread but didn't say which. Look in T3 Code before you try again.");
  });

  test("a failure it does not recognise: T3's last line, one line, 300 characters at most, each absolute path cut to its last name", () => {
    expect(t3StartCause('noise\nBase ref "nope" does not resolve to a commit in project "shop" (/Users/me/code/shop).\n', "shop")).toBe('Base ref "nope" does not resolve to a commit in project "shop" (shop).');
    expect(t3StartCause("Worktree folder /Users/me/.t3/worktrees/shop/t3-1a2b3c4d is in use.", "shop")).toBe("Worktree folder t3-1a2b3c4d is in use.");
    expect(t3StartCause("Cannot write ~/.t3/userdata/state.json, C:\\Users\\me\\.t3\\x.db or '/var/tmp/t3' now", "shop")).toBe("Cannot write state.json, x.db or 't3' now.");
    // A URL is not a path.
    expect(t3StartCause("Fetch https://example.com/a/b failed", "shop")).toBe("Fetch https://example.com/a/b failed.");
    expect(t3StartCause("", "shop")).toBe("T3 Code did not say why.");
    expect(t3StartCause(`${"x".repeat(400)}`, "shop").length).toBeLessThanOrEqual(301);
  });
});
