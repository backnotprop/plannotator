/**
 * Open in Terminal, when Rex is where the person works (inbox-rex.ts): the launched session's attach command opens
 * in a new Rex tab, and otherwise everything is as before. The failures these guard: Rex asked from a window on
 * another computer (the tailnet, a linked machine's window); a Rex that said no leaving the person with nothing
 * when Terminal would have opened; Rex used while its app is not attached here.
 *
 * A real launch engine over a temp data dir with the engine's fake host (tests/helpers/fake-launch-host.ts) and a
 * stand-in for inbox-rex.ts (its own tests cover the calls Rex gets). The sandbox PATH is empty: no osascript.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";

const restore: (() => void)[] = [];
afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
});

function setEnv(name: string, value: string) {
  const before = process.env[name];
  process.env[name] = value;
  restore.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

async function setup(rexState: { here: boolean; opens: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-rex-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "my-app");
  for (const dir of [dataDir, home, folder]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "my-app", root: folder });
  const fake = fakeLaunchHost();
  const asked = { here: 0, opens: [] as { project: string; tab: string; command: string }[] };
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    loginEnv: async () => ({ HOME: home, PATH: "" }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => [fake.host],
    rex: {
      opensHere: async () => (asked.here++, rexState.here),
      open: async (request) => (asked.opens.push(request), rexState.opens ? { session: "session:x", window: "window:y" } : null),
    },
  });
  restore.push(() => launch.stop());
  const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
  const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
  const message = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send", thread_name: "Tidy", launch: prepared.launch }).message;
  launch.begin(message);
  for (let i = 0; i < 200 && store.message(message.id)!.launch!.session_ref !== "f1"; i++) await Bun.sleep(5);
  const id = prepared.launch.id;
  const open = (via = "local", door: { platform: string; window: boolean } | null = null) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/open`, { method: "POST", headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" }, body: JSON.stringify({ serverSession: "srv" }) }),
      `/api/inbox/launch/${id}/open`,
      via,
      door,
    );
  return { fake, asked, open };
}

describe("Open in Terminal, with Rex", () => {
  test("Rex's app attached here: the attach command opens in a Rex tab named for the agent, in the project's session", async () => {
    const { fake, asked, open } = await setup({ here: true, opens: true });
    const answer = (await (await open())!.json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ ok: true, opened: "rex" });
    expect(asked.opens).toEqual([{ project: "my-app", tab: fake.host.name, command: answer.command as string }]);
    expect(answer.command).toBeTruthy();
  });

  test("Rex said no: as before (here, no osascript: the same open_unavailable as without Rex)", async () => {
    const { asked, open } = await setup({ here: true, opens: false });
    await expect(open()).rejects.toMatchObject({ code: "open_unavailable" });
    expect(asked.opens).toHaveLength(1);
  });

  test("Rex's app not attached here: Rex gets no tab", async () => {
    const { asked, open } = await setup({ here: false, opens: true });
    await expect(open()).rejects.toMatchObject({ code: "open_unavailable" });
    expect(asked.opens).toEqual([]);
  });

  test("from another computer (the tailnet, or a linked machine's window): Rex is never asked", async () => {
    const { asked, open } = await setup({ here: true, opens: true });
    const tailnet = await open("tailnet").then(
      (r) => r?.status,
      (e: { code?: string }) => e.code,
    );
    expect(tailnet).not.toBe(200);
    await expect(open("local", { platform: "darwin", window: true })).rejects.toMatchObject({ code: "open_unavailable" });
    expect(asked.here).toBe(0);
    expect(asked.opens).toEqual([]);
  });
});
