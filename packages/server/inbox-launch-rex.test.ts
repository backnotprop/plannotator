/**
 * Open in Rex (inbox-rex.ts) from the launch route: the window's button says where it opens, and the server does
 * that or fails, never the other. The failures these guard: Rex asked from a window on another computer (the
 * tailnet, a linked machine's window); a Rex failure leaving a handed-over session with nothing running (the host's
 * `terminalFailed`); a Rex tab and a Terminal window both opening the command; a double click opening two tabs; the
 * command run without the person's login PATH.
 *
 * A real launch engine over a temp data dir with the engine's fake host (tests/helpers/fake-launch-host.ts) and a
 * stand-in for inbox-rex.ts (its own tests cover the calls Rex gets). The sandbox PATH has no osascript.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createInboxLaunch } from "./inbox-launch";
import type { InboxRexOpened } from "./inbox-rex";

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

type OpenRequest = { project: string; projectKey: string; tab: string; command: string; pathPrepend?: readonly string[] };

async function setup(answer: (request: OpenRequest) => Promise<InboxRexOpened>) {
  const root = mkdtempSync(join(tmpdir(), "plannotator-launch-rex-"));
  restore.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const home = join(root, "home");
  const folder = join(root, "my-app");
  const loginBin = join(root, "login-bin");
  for (const dir of [dataDir, home, folder, loginBin]) mkdirSync(dir, { recursive: true });
  setEnv("PLANNOTATOR_DATA_DIR", dataDir);
  setEnv("PLANNOTATOR_TEST_SANDBOX", "1");
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  const store = InboxStore.open(dataDir);
  const project = store.ensureProject({ name: "my-app", root: folder });
  const fake = fakeLaunchHost();
  const failed: string[] = [];
  const opens: OpenRequest[] = [];
  const launch = createInboxLaunch({
    store,
    live: { runStateOf: () => null },
    dataDir,
    serverSession: "srv",
    homeDir: home,
    platform: "darwin",
    // The person's login shell puts its own folder on PATH: the Rex tab gets it in front.
    loginEnv: async () => ({ HOME: home, PATH: loginBin }),
    ownEnv: () => ({ HOME: home, PATH: "" }),
    installDirs: [],
    displayFolder: (path) => path,
    readBody: async (req) => (await req.json()) as Record<string, unknown>,
    json: (body, status = 200) => Response.json(body, { status }),
    onChange: () => {},
    selfCommand: ["plannotator"],
    hosts: () => [{ ...fake.host, terminalFailed: (_launch, command) => void failed.push(command) }],
    rex: { open: async (request) => (opens.push(request), answer(request)) },
  });
  restore.push(() => launch.stop());
  const target = launch.target({ launch: { agent: FAKE, project_id: project.id } })!;
  const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy.", resolveProject: async () => project });
  const message = store.startPersonThread({ project_id: project.id, body: "Tidy.", to: prepared.to, idempotency_key: "send", thread_name: "Tidy", launch: prepared.launch }).message;
  launch.begin(message);
  for (let i = 0; i < 200 && store.message(message.id)!.launch!.session_ref !== "f1"; i++) await Bun.sleep(5);
  const id = prepared.launch.id;
  const open = (inRex: boolean, via = "local", door: { platform: string; window: boolean } | null = null) =>
    launch.route(
      new Request(`http://127.0.0.1/api/inbox/launch/${id}/open`, {
        method: "POST",
        headers: { Origin: "http://127.0.0.1", Host: "127.0.0.1" },
        body: JSON.stringify({ serverSession: "srv", ...(inRex ? { in: "rex" } : {}) }),
      }),
      `/api/inbox/launch/${id}/open`,
      via,
      door,
    );
  return { fake, opens, failed, open, loginBin, projectId: project.id };
}

const opened: InboxRexOpened = { opened: true, session: "session:x", window: "window:y", line: "Rex · my-app / Fake Agent" };

describe("Open in Rex", () => {
  test("the button said Rex: the attach command opens in a Rex tab named for the agent, through the login PATH", async () => {
    const { fake, opens, open, loginBin, projectId } = await setup(async () => opened);
    const answer = (await (await open(true))!.json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ ok: true, opened: "rex", line: "Rex · my-app / Fake Agent" });
    expect(opens).toEqual([{ project: "my-app", projectKey: projectId, tab: fake.host.name, command: answer.command as string, pathPrepend: [loginBin] }]);
  });

  test("the button said Terminal: Rex is never asked, whatever is attached", async () => {
    const { opens, open } = await setup(async () => opened);
    await expect(open(false)).rejects.toMatchObject({ code: "open_unavailable" });
    expect(opens).toEqual([]);
  });

  test("Rex failed: the host hears so (nothing left without a process), and Terminal does not open instead", async () => {
    const { fake, opens, failed, open } = await setup(async () => ({ opened: false, sent: true }));
    await expect(open(true)).rejects.toMatchObject({ code: "open_unavailable", message: "Rex didn't open it. Copy the command instead." });
    expect(opens).toHaveLength(1);
    expect(failed).toEqual([`fake attach f1`]);
    expect(fake.calls.filter((c) => c.startsWith("terminal "))).toHaveLength(1);
  });

  test("two presses while the first is opening: one tab", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { opens, open } = await setup(async () => (await gate, opened));
    const first = open(true);
    const second = open(true);
    await Bun.sleep(20);
    release();
    const answers = await Promise.all([first, second]);
    for (const answer of answers) expect(((await answer!.json()) as { opened?: string }).opened).toBe("rex");
    expect(opens).toHaveLength(1);
  });

  test("from another computer (the tailnet, or a linked machine's window): Rex is never asked", async () => {
    const { opens, open } = await setup(async () => opened);
    const tailnet = await open(true, "tailnet").then(
      (r) => r?.status,
      (e: { code?: string }) => e.code,
    );
    expect(tailnet).not.toBe(200);
    await expect(open(true, "local", { platform: "darwin", window: true })).rejects.toMatchObject({ code: "open_unavailable" });
    expect(opens).toEqual([]);
  });
});
