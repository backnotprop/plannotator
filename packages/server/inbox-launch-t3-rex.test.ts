/**
 * T3 Code and Start in Rex (Settings → Agents' "Start new agents in": Rex): T3 Code runs its threads in its own app,
 * so a T3 Code launch never starts in a Rex tab, and Settings never lists it as an agent Rex starts. The failure this
 * guards: with Rex chosen, a Send to T3 Code asking Rex for a tab (a second, empty agent next to the T3 thread), or
 * the launch marked as Rex's (no first turn put in, no T3 thread, the line saying it runs in Rex).
 *
 * The launch engine and the real T3 host against a fake T3 home (tests/helpers/fake-t3.ts), a stand-in for Rex's
 * `open`, in a scratch home and data folder. No Inbox server, no Rex and no T3 run.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { makeFakeT3Home } from "../../tests/helpers/fake-t3";
import { createInboxLaunch } from "./inbox-launch";
import type { InboxRexOpened } from "./inbox-rex";

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

test("with Rex chosen, T3 Code still starts its own thread through `t3 thread start`: Rex is never asked, the launch is not Rex's, and Settings doesn't list T3 Code as starting in Rex", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-t3-rex-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const shop = join(home, "code", "shop");
  for (const dir of [home, dataDir, join(shop, ".git")]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(shop, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true, startIn: "rex" } }));
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  const t3 = makeFakeT3Home(home, {}, { projects: [shop], db: false });
  const path = "/usr/bin:/bin";
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "shop", root: shop });
  const opens: unknown[] = [];
  const opened: InboxRexOpened = { opened: true, session: "session:x", window: "window:y", block: "block:z", line: "Rex · shop / T3 Code" };
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
    rex: {
      open: async (request) => (opens.push(request), opened),
      appAttachedNow: async () => true,
      paneGone: async () => false,
      closePane: async () => "closed",
    },
  });
  cleanup.push(() => launch.stop());

  const settings = await launch.route(new Request("http://127.0.0.1/api/inbox/launch/settings", { headers: { Host: "127.0.0.1" } }), "/api/inbox/launch/settings", "local");
  const shown = ((await settings!.json()) as { launch: { start_in: string; rex_agents: string[] } }).launch;
  expect(shown.start_in).toBe("rex");
  expect(shown.rex_agents).not.toContain("t3");

  const target = launch.target({ launch: { agent: "t3", project_id: project.id } })!;
  const prepared = await launch.prepare(target, { name: "Checkout copy", body: "Tighten the checkout copy.", resolveProject: async () => project });
  expect(prepared.launch.rex).toBeUndefined();
  const message = store.startPersonThread({ project_id: project.id, body: "Tighten the checkout copy.", to: prepared.to, idempotency_key: "send-1", thread_name: "Checkout copy", launch: prepared.launch }).message;
  launch.begin(message);
  const session = await until("the thread", () => store.message(message.id)!.launch!.session_ref);

  expect(opens).toEqual([]);
  expect(t3.starts().map((s) => s.id)).toEqual([session]);
  const after = store.message(message.id)!;
  expect(after.launch!.rex).toBeUndefined();
  expect(after.delivery).toMatchObject({ state: "delivered", host: "t3", session });
});
