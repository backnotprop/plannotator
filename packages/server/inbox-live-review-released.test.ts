import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reviewConversations } from "@plannotator/core/review-threads";
import { INBOX_BRIDGE_POLL_PATH } from "@plannotator/shared/inbox/connection";
import { startInboxServer, type InboxServer } from "./inbox";

const REPO = resolve(import.meta.dir, "..", "..");
const RELEASES = ["v0.28.8", "v0.28.30"];
const SESSION = "ses-released";
const ANCHOR = { file: "src/billing.ts", side: "new", line_start: 4, line_end: 5, code: ["  if (amount < 0) throw new Error();", "  return charge(amount);"], head: "abc1234" };
const BLOCK = "(A review comment on `src/billing.ts` lines 4-5 (new side, at abc1234):\n```\n  if (amount < 0) throw new Error();\n  return charge(amount);\n```\nAnswer it with reply_to ";

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

async function world(prefix: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const server = await startInboxServer({ dataDir, binaryPath: null });
  servers.push(server);
  const send = async (host: string) => {
    const post = () => fetch(`http://127.0.0.1:${server.port}/api/inbox/review-threads/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, project_path: project, review: { key: "branch:fix/charge", title: "fix/charge" }, to: { host, session: SESSION }, comments: [{ anchor: ANCHOR, words: "Use RangeError." }], idempotency_key: "k1" }),
    });
    let response = await post();
    for (let t = 0; t < 100 && response.status === 409; t++) {
      await Bun.sleep(50);
      response = await post();
    }
    expect(response.status).toBe(200);
    return ((await response.json()) as { sent: string[] }).sent[0]!;
  };
  return { root, project, dataDir, server, send };
}

describe.skipIf(!released && !process.env.CI)("a review comment reaches a released plugin's shared connection", () => {
  for (const tag of RELEASES) {
    test(`${tag}: the wake carries the lines and its answer lands on them`, async () => {
      const w = await world("plannotator-live-review-released-");
      const old = await releasedConnection(tag, w.root);
      const tools = await old.discoverInboxTools(w.dataDir);
      const connection = new old.InboxAgentConnection({ dataDir: w.dataDir, host: "pi", agentName: "Pi", tools: tools! });
      expect(await connection.callTool({ action: "send_message", body: "Ready for review." }, { sessionId: SESSION, cwd: w.project, wakes: true } as never)).toMatchObject({ isError: false });
      const texts: string[] = [];
      const link = new old.InboxWake(connection, SESSION, { isBusy: async () => false, deliver: async (text: string) => void texts.push(text), notify: () => {} }, 5);
      link.start();
      stops.push(() => link.dispose());
      const id = await w.send("pi");
      for (let t = 0; t < 250 && !texts.some((text) => text.includes("Use RangeError.")); t++) await Bun.sleep(20);
      expect(texts.find((text) => text.includes("Use RangeError."))).toContain(`${BLOCK}${id}.)`);
      expect(await connection.callTool({ action: "send_message", body: "Done.", reply_to: id }, { sessionId: SESSION, cwd: w.project, wakes: true } as never)).toMatchObject({ isError: false });
      const [conversation] = reviewConversations(w.server.store.thread(w.server.store.message(id)!.thread_id)!.messages);
      expect(conversation!.messages.map((m) => m.body)).toEqual(["Use RangeError.", "Done."]);
    }, 60_000);
  }
});

describe.skipIf(!released && !process.env.CI)("a review comment reaches a released Claude Code mod", () => {
  for (const tag of RELEASES) {
    test(`${tag}: the turn it submits carries the lines`, async () => {
      const w = await world("plannotator-live-review-released-mod-");
      const { ClaudeSession } = await releasedMod(tag, w.root);
      const session = await ClaudeSession.start({ env: { PATH: process.env.PATH ?? "", PLANNOTATOR_RELAY_URL: "http://127.0.0.1:9", PLANNOTATOR_DATA_DIR: w.dataDir }, cwd: w.project, store: new Map(), sessionId: SESSION, dataDir: w.dataDir });
      stops.push(() => session.quit());
      expect(await session.callInbox({ action: "send_message", body: "Ready for review." }, w.project)).not.toHaveProperty("deny");
      for (let t = 0; t < 250 && !session.host.fetches.some((url) => url.includes(INBOX_BRIDGE_POLL_PATH)); t++) await Bun.sleep(20);
      const id = await w.send("claude-code");
      for (let t = 0; t < 500 && !session.host.submits.some((text) => text.includes("Use RangeError.")); t++) await Bun.sleep(20);
      expect(session.host.submits.find((text) => text.includes("Use RangeError."))).toContain(`${BLOCK}${id}.)`);
    }, 60_000);
  }
});
