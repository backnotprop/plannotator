/**
 * Oh My Pi through the real launch engine (inbox-launch.ts with its own hosts, no test host), against the fake `omp`
 * and the fake `pi` (tests/helpers/fake-omp, fake-pi), never the real ones. What each test guards: To offers
 * "Oh My Pi" as its own row beside "Pi" once `omp` and Plannotator's extension in its plugin record are there, and not
 * before; a Send starts `omp --mode rpc` in the project's folder and addresses the thread to the session id Oh My Pi
 * picked, as host `pi` (its extension polls the Inbox as Pi does), which takes the root; Pi's own row still starts Pi.
 * A small bridge stands in for the Inbox's: no Inbox is started.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeOmp } from "../../tests/helpers/fake-omp";
import { installFakePi } from "../../tests/helpers/fake-pi";
import { stubBridge } from "../../tests/helpers/stub-bridge";
import { createInboxLaunch } from "./inbox-launch";

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

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-launch-omp-engine-")));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const bin = join(root, "bin");
  const dataDir = join(root, "data");
  const folder = join(root, "harbor");
  for (const dir of [home, bin, dataDir, folder]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  // The engine reads launch's switch from this data dir's config.json.
  const before = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  cleanup.push(() => {
    if (before === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
    else process.env.PLANNOTATOR_DATA_DIR = before;
  });
  // Pi and Oh My Pi both on this computer, each with Plannotator's extension.
  const pi = installFakePi({ bin, state: join(root, "fake-pi"), home, config: {} });
  const fake = installFakeOmp({ bin, state: join(root, "fake-omp"), home, config: {} });
  cleanup.push(() => void pi.stopAll());
  cleanup.push(() => void fake.stopAll());
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "harbor", root: folder });
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
  return { store, project, folder, dataDir, pi, fake, bridge, launch, clock, makeLaunch };
}

describe("Oh My Pi through the launch engine, against the fake omp", () => {
  test("To offers Oh My Pi as its own row beside Pi once omp and the extension's plugin record are there, and not before", async () => {
    const { launch } = setup();
    const agents = (await launch.composeBlock())!.agents;
    expect(agents).toContainEqual({ agent: "pi", name: "Pi", scratch_trusted: true });
    expect(agents).toContainEqual({ agent: "oh-my-pi", name: "Oh My Pi", scratch_trusted: true });

    const absent = setup();
    absent.fake.setInstalled(false);
    expect((await absent.launch.composeBlock())!.agents.map((a) => a.agent)).toEqual(expect.not.arrayContaining(["oh-my-pi"]));

    const noPlugin = setup();
    noPlugin.fake.setExtension(false);
    const left = (await noPlugin.launch.composeBlock())!.agents.map((a) => a.agent);
    expect(left).toContain("pi");
    expect(left).not.toContain("oh-my-pi");
  });

  test("Send starts omp in the project's folder; the thread goes to the session Oh My Pi picked, as host pi, which takes the root", async () => {
    const { store, project, folder, pi, fake, bridge, launch } = setup();
    fake.configure({ hold: true });
    const target = launch.target({ launch: { agent: "oh-my-pi", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy the readme", body: "Tidy the readme.", resolveProject: async () => project });
    expect(prepared.launch.agent).toBe("oh-my-pi");
    const root = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy the readme", launch: prepared.launch }).message;
    launch.begin(root);

    const session = await until("the session", () => store.message(root.id)!.launch!.session_ref);
    const [start] = fake.starts();
    expect(start!.argv).toEqual(["--mode", "rpc", "--allow-home"]);
    expect(start!.cwd).toBe(folder);
    expect(store.message(root.id)!.to).toEqual({ host: "pi", session });
    expect(pi.starts()).toEqual([]);
    await until("the root delivered", () => fake.delivered().includes(root.id));
    expect(bridge.polls.has(session)).toBe(true);
    await until("the root marked delivered to that session", () => store.message(root.id)!.delivery);
    expect(store.message(root.id)!.delivery).toMatchObject({ host: "pi", session });
  });
});
