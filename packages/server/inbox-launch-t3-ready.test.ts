/**
 * T3 Code started from the Inbox in a folder T3 doesn't know yet, or while T3 Code isn't running (issue #3590): the
 * Inbox clears both by itself and starts the thread, with no step for the person. The failures this guards: a Send
 * to T3 Code that fails in every folder T3 doesn't already know ("No T3 Code project matches '.'", seen on a real T3
 * 0.1.9 on 2026-11-18), or whenever T3 Code is closed, while T3's own CLI can add the folder and its app can be
 * opened; and, when that can't be done, words that hide why.
 *
 * The launch engine and the real T3 host against a fake T3 home (tests/helpers/fake-t3.ts: `project add`, `thread
 * start`, a server that is down until the stand-in for opening the app brings it up). No Inbox server, no app opened,
 * no T3 run.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { makeFakeT3Home, type FakeT3Home } from "../../tests/helpers/fake-t3";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createInboxLaunch } from "./inbox-launch";
import type { LaunchHostContext } from "./inbox-launch-host";
import { createT3LaunchHost, T3_LAUNCH_NOT_OPEN } from "./inbox-launch-t3";
import { openT3App, t3ProjectAdded, t3RemedyOf } from "./inbox-launch-t3-ready";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const undo of cleanup.splice(0).reverse()) undo();
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

/** A T3 home whose project list holds `shop` only when `known`; `opens`: what the stand-in for opening T3 Code's app does. */
function setup(options: { known: boolean; down?: boolean; opens?: "up" | "nothing" | "fails"; openWaitMs?: number }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-t3-ready-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const shop = join(home, "code", "shop");
  for (const dir of [home, dataDir, join(shop, ".git")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shop, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const t3: FakeT3Home = makeFakeT3Home(home, {}, { projects: options.known ? [shop] : [], db: false });
  if (options.down) t3.setState("down");
  const opened: string[] = [];
  const openApp = async () => {
    opened.push("open");
    if (options.opens === "fails") return false;
    if (options.opens === "up") t3.setState("up");
    return true;
  };
  const path = "/usr/bin:/bin";
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "shop", root: shop });
  const startLog: string[] = [];
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: process.platform,
    loginEnv: async () => ({ HOME: home, PATH: path, PLANNOTATOR_TEST_SANDBOX: "1" }),
    ownEnv: () => ({ HOME: home, PATH: path }),
    installDirs: [],
    displayFolder: (p) => p,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    log: () => {},
    selfCommand: ["plannotator"],
    firstTurn: (message) => message.body,
    hosts: (ctx: LaunchHostContext) => [
      createT3LaunchHost({ ...ctx, startLog: (id, text) => (startLog.push(text), ctx.startLog(id, text)) }, { openApp, openWaitMs: options.openWaitMs ?? 5_000 }),
    ],
  });
  cleanup.push(() => launch.stop());
  const send = async () => {
    const target = launch.target({ launch: { agent: "t3", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Checkout copy", body: "Tighten the checkout copy.", resolveProject: async () => project });
    const message = store.startPersonThread({ project_id: project.id, body: "Tighten the checkout copy.", to: prepared.to, idempotency_key: `send-${Math.random()}`, thread_name: "Checkout copy", launch: prepared.launch }).message;
    launch.begin(message);
    await until("the start ended", () => !!store.message(message.id)!.launch!.session_ref || !!store.message(message.id)!.launch!.error);
    return store.message(message.id)!;
  };
  const verbs = () => t3.calls().map((args) => `${args[0]} ${args[1]}`).filter((verb) => verb !== "thread list");
  return { t3, shop, send, opened, verbs, startLog };
}

test("a folder T3 doesn't know: the Inbox adds it as a T3 project with T3's own `project add`, then starts the thread there, with no step for the person", async () => {
  const t = setup({ known: false });
  const root = await t.send();
  expect(root.launch!.error ?? null).toBeNull();
  expect(root.launch!.session_ref).toBe(t.t3.starts()[0]!.id);
  expect(root.delivery).toMatchObject({ state: "delivered", host: "t3" });
  expect(t.t3.added()).toEqual([t.shop]);
  expect(t.verbs()).toEqual(["thread start", "project add", "thread start"]);
  expect(t.t3.calls()).toContainEqual(["project", "add", t.shop]);
  expect(t.t3.starts()).toHaveLength(1);
  expect(t.opened).toEqual([]);
  // start.log says what was run and what T3 said, for each step.
  expect(t.startLog.some((line) => line.startsWith(`t3 project add ${t.shop}\nexit 0\nAdded project`))).toBe(true);
});

test("T3 Code not running: the Inbox opens its app, waits for its server, then starts the thread", async () => {
  const t = setup({ known: true, down: true, opens: "up" });
  const root = await t.send();
  expect(root.launch!.error ?? null).toBeNull();
  expect(root.launch!.session_ref).toBe(t.t3.starts()[0]!.id);
  expect(t.opened).toEqual(["open"]);
  expect(t.verbs()).toEqual(["thread start", "thread start"]);
  expect(t.startLog).toContain("T3 Code wasn't running: opened it, waiting for it");
});

test("both: T3 Code closed and a folder it doesn't know: opened, then the folder added, then one thread", async () => {
  const t = setup({ known: false, down: true, opens: "up" });
  const root = await t.send();
  expect(root.launch!.session_ref).toBe(t.t3.starts()[0]!.id);
  expect(t.opened).toEqual(["open"]);
  expect(t.verbs()).toEqual(["thread start", "thread start", "project add", "thread start"]);
  expect(t.t3.starts()).toHaveLength(1);
});

test("what the Inbox can't clear keeps today's words: an app that won't open, a server that never comes up, a folder T3 won't add; each tried once", async () => {
  const cant = setup({ known: true, down: true, opens: "fails" });
  expect((await cant.send()).launch!.error).toMatchObject({ code: "failed", text: T3_LAUNCH_NOT_OPEN });
  expect(cant.opened).toEqual(["open"]);
  expect(cant.verbs()).toEqual(["thread start"]);
  expect(cant.startLog).toContain("T3 Code isn't running, and the Inbox couldn't open it");

  const never = setup({ known: true, down: true, opens: "nothing", openWaitMs: 300 });
  expect((await never.send()).launch!.error).toMatchObject({ code: "failed", text: T3_LAUNCH_NOT_OPEN });
  expect(never.opened).toEqual(["open"]);
  expect(never.verbs()).toEqual(["thread start"]);

  const refused = setup({ known: false });
  refused.t3.refuseProjectAdd();
  expect((await refused.send()).launch!.error).toMatchObject({ code: "failed", text: "shop isn't a project in T3 Code yet. Add its folder in T3 Code, then try again." });
  expect(refused.verbs()).toEqual(["thread start", "project add"]);
  expect(refused.t3.starts()).toEqual([]);
});

test("T3's words: which refusal the Inbox can clear, and what counts as added", () => {
  expect(t3RemedyOf("No running T3 Code server uses /Users/someone/.t3. Start T3 Code, then retry.")).toBe("open");
  expect(t3RemedyOf("Could not reach the T3 Code server at http://127.0.0.1:9. connect ECONNREFUSED")).toBe("open");
  expect(t3RemedyOf("No T3 Code project matches '.'. Pass a project id or a path inside a project.")).toBe("add");
  expect(t3RemedyOf("Model 'retired' is not available for provider instance 'codex'.")).toBeNull();
  expect(t3ProjectAdded({ exitCode: 0, stdout: "Added project p (shop) at /x/shop.", stderr: "" })).toBe(true);
  expect(t3ProjectAdded({ exitCode: 1, stdout: "", stderr: "An active project already exists for '/x/shop'." })).toBe(true);
  expect(t3ProjectAdded({ exitCode: 1, stdout: "", stderr: "Something went wrong." })).toBe(false);
  expect(t3ProjectAdded({ exitCode: null, timedOut: true, stdout: "", stderr: "" })).toBe(false);
});

test("a test run never opens the person's T3 Code app, whatever the platform", async () => {
  const runs: string[][] = [];
  const e = { ...createAgentEnvironmentFor({ platform: "darwin", homeDir: "/nowhere", env: { PATH: "/usr/bin:/bin", PLANNOTATOR_TEST_SANDBOX: "1" } }), run: async (argv: readonly string[]) => (runs.push([...argv]), { exitCode: 0, stdout: "", stderr: "", timedOut: false }) };
  expect(await openT3App(e as never)).toBe(false);
  expect(runs).toEqual([]);
});
