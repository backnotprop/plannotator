import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const REPO = resolve(import.meta.dir, "..", "..");
const RELEASES = ["v0.28.8", "v0.28.30"];
const SESSION = "ses-released";

const roots: string[] = [];
const servers: InboxServer[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fromRelease = (tag: string, path: string) => {
  const shown = Bun.spawnSync(["git", "-C", REPO, "show", `${tag}:${path}`]);
  return shown.exitCode === 0 ? shown.stdout.toString() : null;
};
const released = RELEASES.every((tag) => fromRelease(tag, "packages/shared/inbox/agent-link.ts") !== null);

async function releasedConnection(tag: string, root: string) {
  const dir = join(root, "released", tag);
  mkdirSync(dir, { recursive: true });
  for (const name of ["agent-link.ts", "connection.ts"]) writeFileSync(join(dir, name), fromRelease(tag, `packages/shared/inbox/${name}`)!);
  return (await import(join(dir, "agent-link.ts"))) as typeof import("@plannotator/shared/inbox/agent-link");
}

async function releasedMod(tag: string, root: string) {
  const dir = join(root, "released-mod", tag);
  const listed = Bun.spawnSync(["git", "-C", REPO, "ls-tree", "-r", "--name-only", tag, "apps/hook/hooks/mod/"]).stdout.toString().split("\n");
  for (const path of listed.filter((p) => p.endsWith(".ts") && !p.endsWith(".test.ts"))) {
    const file = join(dir, path.slice("apps/hook/hooks/mod/".length));
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, fromRelease(tag, path)!);
  }
  return (await import(join(dir, "testing", "claude-session.ts"))) as typeof import("../../apps/hook/hooks/mod/testing/claude-session");
}

describe.skipIf(!released)("take back against a released plugin's shared connection", () => {
  for (const tag of RELEASES) {
    test(`${tag}: racing its claim, a reply is never both taken back and delivered`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-take-back-released-")));
      roots.push(root);
      const project = join(root, "api");
      mkdirSync(project, { recursive: true });
      const dataDir = join(root, "data");
      const server = await startInboxServer({ dataDir, binaryPath: null });
      servers.push(server);
      const old = await releasedConnection(tag, root);
      const tools = await old.discoverInboxTools(dataDir);
      expect(tools?.length).toBeGreaterThan(0);
      const connection = new old.InboxAgentConnection({ dataDir, host: "pi", agentName: "Pi", tools: tools! });
      const asked = await connection.callTool({ action: "send_message", body: "Which runner?" }, { sessionId: SESSION, cwd: project, wakes: true } as never);
      expect(asked).toMatchObject({ isError: false });
      const thread = server.store.listRows()[0]!.thread_id;
      const delivered: string[] = [];
      const link = new old.InboxWake(
        connection,
        SESSION,
        {
          isBusy: async () => {
            await Bun.sleep(30);
            return false;
          },
          deliver: async (_text, command) => {
            delivered.push(command.id);
            await Bun.sleep(40);
          },
          notify: () => {},
        },
        5,
      );
      link.start();
      stops.push(() => link.dispose());
      const post = (path: string, body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${server.port}/api/inbox/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
      const first = await (await post(`messages/${thread}/reply`, { idempotency_key: "warm", words: "Warm up." })).json();
      for (let t = 0; t < 250 && !delivered.includes(first.reply.id); t++) await Bun.sleep(20);
      expect(delivered).toEqual([first.reply.id]);
      let takenBack = 0;
      let both = 0;
      for (let i = 0; i < 25; i++) {
        const id = ((await (await post(`messages/${thread}/reply`, { idempotency_key: `k${i}`, words: `Round ${i}: ARM.` })).json()) as { reply: { id: string } }).reply.id;
        await Bun.sleep(Math.random() * 160);
        const taken = await post(`messages/${id}/take-back`, {});
        if (taken.status === 200) takenBack++;
        else for (let t = 0; t < 75 && !server.store.message(id)?.delivery; t++) await Bun.sleep(20);
        await Bun.sleep(taken.status === 200 ? 200 : 0);
        if (taken.status === 200 && delivered.includes(id)) both++;
      }
      expect(both).toBe(0);
      expect(takenBack).toBeGreaterThan(0);
      expect(takenBack).toBeLessThan(25);
    }, 120_000);
  }
});

describe.skipIf(!released)("take back against a released Claude Code mod", () => {
  for (const tag of RELEASES) {
    test(`${tag}: a press right after its last ask is refused, and the words go in once`, async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-take-back-released-mod-")));
      roots.push(root);
      const project = join(root, "api");
      mkdirSync(project, { recursive: true });
      const dataDir = join(root, "data");
      const server = await startInboxServer({ dataDir, binaryPath: null });
      servers.push(server);
      const { ClaudeSession } = await releasedMod(tag, root);
      const session = await ClaudeSession.start({ env: { PATH: process.env.PATH ?? "", PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_DATA_DIR: dataDir }, cwd: project, store: new Map(), sessionId: SESSION, dataDir });
      stops.push(() => session.quit());
      expect(await session.callInbox({ action: "send_message", body: "Which runner?" }, project)).not.toHaveProperty("deny");
      const thread = server.store.listRows()[0]!.thread_id;
      for (let t = 0; t < 250 && !session.host.fetches.some((url) => url.includes(INBOX_BRIDGE_POLL_PATH)); t++) await Bun.sleep(20);
      const post = (path: string, body: Record<string, unknown>) =>
        fetch(`http://127.0.0.1:${server.port}/api/inbox/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: server.serverSession, ...body }) });
      let armed: string | null = null;
      let status = 0;
      const fetch0 = session.host.fetch;
      session.host.fetch = async (url, init) => {
        const response = await fetch0(url, init);
        if (armed && url.endsWith(INBOX_BRIDGE_POLL_PATH) && typeof init.body === "string" && JSON.parse(init.body).waitMs === 0) {
          const id = armed;
          armed = null;
          status = (await post(`messages/${id}/take-back`, {})).status;
        }
        return response;
      };
      const words = "Pressed right after the last ask: use the ARM runner.";
      armed = ((await (await post(`messages/${thread}/reply`, { idempotency_key: "k1", words })).json()) as { reply: { id: string } }).reply.id;
      for (let t = 0; t < 500 && status === 0; t++) await Bun.sleep(20);
      await Bun.sleep(1_500);
      expect(status).toBe(409);
      expect(session.host.submits.filter((text) => text.includes(words))).toHaveLength(1);
    }, 60_000);
  }
});
