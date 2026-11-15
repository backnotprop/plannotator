import "../../tests/setup/sandbox-data-dir";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxAgentConnection, InboxWake } from "@plannotator/shared/inbox/agent-link";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { installFakeCodexLaunch } from "../../tests/helpers/fake-codex-launch";
import { FAKE, fakeLaunchHost } from "../../tests/helpers/fake-launch-host";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createInboxCodexWake } from "./inbox-codex-wake";
import { startInboxServer } from "./inbox";
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
    await Bun.sleep(20);
  }
}

function sandbox(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const folder = join(root, "project");
  const home = join(root, "home");
  for (const dir of [dataDir, folder, home]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxLaunch: { enabled: true } }));
  for (const [name, value] of [["PLANNOTATOR_DATA_DIR", dataDir], ["PLANNOTATOR_RELAY_URL", "http://127.0.0.1:9"]] as const) {
    const before = process.env[name];
    process.env[name] = value;
    cleanup.push(() => {
      if (before === undefined) delete process.env[name];
      else process.env[name] = before;
    });
  }
  return { root, dataDir, folder, home };
}

const codeOf = (run: () => unknown) => {
  try {
    run();
    return "ok";
  } catch (error) {
    return error instanceof InboxError ? error.code : String(error);
  }
};

describe("take back in a session launched from the Inbox", () => {
  test("through its plugin: the first message is refused; a later reply comes back while it waits and is refused once delivered", async () => {
    const { dataDir, folder } = sandbox("plannotator-take-back-launch-");
    const fake = fakeLaunchHost();
    const server = await startInboxServer({ dataDir, binaryPath: null, launchHosts: () => [fake.host] });
    cleanup.push(() => server.stop());
    const project = server.store.ensureProject({ name: "project", root: folder });
    const base = `http://127.0.0.1:${server.port}/api/inbox`;
    const post = (path: string, body: Record<string, unknown>) =>
      fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${server.port}` }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
    const takeBack = async (id: string) => {
      const answer = await post(`messages/${id}/take-back`, {});
      return { status: answer.status, ...((await answer.json()) as { code?: string; by?: string }) };
    };
    const sent = await post("messages", { to: { launch: { agent: FAKE, project_id: project.id } }, body: "Tidy the readme.", idempotency_key: "00000000-0000-4000-8000-000000000001" });
    expect(sent.status).toBe(200);
    const rootId = ((await sent.json()) as { message: { id: string } }).message.id;
    const session = await until("the launched session", () => server.store.message(rootId)?.launch?.session);
    expect(await takeBack(rootId)).toMatchObject({ status: 422, code: "cannot_take_back" });

    const reply = async (key: string, words: string) => ((await (await post(`messages/${rootId}/reply`, { idempotency_key: key, words })).json()) as { reply: { id: string } }).reply.id;
    const waiting = await reply("k1", "Use the ARM runner.");
    expect(await takeBack(waiting)).toMatchObject({ status: 200 });

    const delivered: string[] = [];
    const wake = new InboxWake(
      new InboxAgentConnection({ dataDir, host: FAKE, agentName: "Fake Agent", tools: [] }),
      session,
      {
        isBusy: async () => false,
        deliver: async (_text, command) => {
          delivered.push(command.id);
        },
        notify: () => {},
        projectPath: () => folder,
      },
      5,
    );
    wake.start();
    cleanup.push(() => wake.dispose());
    await until("the launch's first message delivered", () => delivered.includes(rootId));
    const later = await reply("k2", "Use the x86 runner.");
    await until("the later reply delivered", () => server.store.message(later)?.delivery);
    expect(await takeBack(later)).toMatchObject({ status: 409, code: "agent_has_it", by: "delivered", session });
    await Bun.sleep(300);
    expect(delivered).toEqual([rootId, later]);
  }, 30_000);

  test("Codex: the first message is refused; racing the wake, a later reply is never both taken back and a turn", async () => {
    const { root, dataDir, folder, home } = sandbox("plannotator-take-back-launch-codex-");
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), ['[mcp_servers.plannotator-inbox]', 'command = "plannotator"', 'args = ["inbox", "mcp"]', ""].join("\n"));
    const fake = installFakeCodexLaunch(join(root, "fake"), { turnMs: 40 });
    cleanup.push(() => {
      for (const start of fake.starts()) if (fake.alive(start.pid)) process.kill(start.pid, "SIGKILL"); // inbox-guard: own child (the fake codex)
    });
    const path = `${fake.bin}:/usr/bin:/bin`;
    const store = InboxStore.open(dataDir);
    const project = store.ensureProject({ name: "project", root: folder });
    const launch = createInboxLaunch({
      store,
      live: { runStateOf: () => null },
      dataDir,
      serverSession: "srv",
      homeDir: home,
      platform: process.platform,
      loginEnv: async () => ({ HOME: home, PATH: path, CODEX_HOME: codexHome }),
      ownEnv: () => ({ HOME: home, PATH: path }),
      installDirs: [],
      displayFolder: (p) => p,
      readBody: async (req) => (await req.json()) as Record<string, unknown>,
      json: (body, status = 200) => Response.json(body, { status }),
      onChange: () => {},
      log: () => {},
      selfCommand: ["plannotator"],
    });
    cleanup.push(() => launch.stop());
    const wake = createInboxCodexWake({
      store,
      environment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env: { HOME: home, PATH: path } }),
      commandOf: (item) => ({ type: item.reply_to ? "reply" : "message", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: item.subject ?? null, body: item.body, url: `http://127.0.0.1/#${item.thread_id}` }),
      deliver: (session, text) => launch.deliver("codex", session, text),
      launched: (session) => launch.launched("codex", session),
      extraClis: [],
      log: () => {},
    });
    cleanup.push(() => wake.stop());

    const target = launch.target({ launch: { agent: "codex", project_id: project.id } })!;
    const prepared = await launch.prepare(target, { name: "Tidy", body: "Tidy the readme.", resolveProject: async () => project });
    const first = store.startPersonThread({ project_id: project.id, body: "Tidy the readme.", to: prepared.to, idempotency_key: "send-1", thread_name: "Tidy", launch: prepared.launch }).message;
    launch.begin(first);
    await until("the root went in as a turn", () => store.message(first.id)?.delivery);
    expect(codeOf(() => store.takeBack(first.id))).toBe("cannot_take_back");

    const went = (words: string) => fake.turnTexts().some((text) => text.includes(words));
    let takenBack = 0;
    let both = 0;
    for (let i = 0; i < 20; i++) {
      const words = `Round ${i}: use the ARM runner.`;
      const id = store.sendReply(first.id, { words, idempotency_key: `k${i}` }).reply!.id;
      if (i % 2 === 1) await Bun.sleep(Math.random() * 6);
      const code = codeOf(() => store.takeBack(id));
      if (code === "ok") {
        takenBack++;
        await Bun.sleep(150);
        if (went(words)) both++;
      } else {
        expect(code).toBe("agent_has_it");
        await until(`round ${i} went in`, () => went(words));
      }
    }
    expect(both).toBe(0);
    expect(takenBack).toBeGreaterThan(0);
    expect(takenBack).toBeLessThan(20);
  }, 60_000);
});
