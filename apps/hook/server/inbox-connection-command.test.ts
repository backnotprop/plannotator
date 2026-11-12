import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxThread } from "../../../packages/core/inbox-types";
import { startInboxServer, type InboxServer } from "../../../packages/server/inbox";
import { runInboxConnectionCommand } from "./inbox-connection-command";

const saved = { data: process.env.PLANNOTATOR_DATA_DIR, tool: process.env.PLANNOTATOR_INBOX_TOOL };
const roots: string[] = [];
const servers: InboxServer[] = [];

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-connection-")));
  roots.push(root);
  process.env.PLANNOTATOR_DATA_DIR = join(root, "data");
  delete process.env.PLANNOTATOR_INBOX_TOOL;
});

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (saved.data === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved.data;
  if (saved.tool === undefined) delete process.env.PLANNOTATOR_INBOX_TOOL;
  else process.env.PLANNOTATOR_INBOX_TOOL = saved.tool;
});

class Pipe {
  readonly out: Record<string, unknown>[] = [];
  private readonly queue: string[] = [];
  private wakeReader: (() => void) | null = null;
  private closed = false;

  send(request: Record<string, unknown>): void {
    this.queue.push(JSON.stringify(request));
    this.wakeReader?.();
  }

  close(): void {
    this.closed = true;
    this.wakeReader?.();
  }

  async *lines(): AsyncIterable<string> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wakeReader = resolve));
      this.wakeReader = null;
    }
  }

  write = (line: string) => {
    for (const part of line.split("\n").filter(Boolean)) this.out.push(JSON.parse(part));
  };

  async next(type: string, ms = 8_000): Promise<Record<string, unknown>> {
    const seen = new Set<Record<string, unknown>>();
    for (let waited = 0; waited < ms; waited += 20) {
      const found = this.out.find((event) => event.type === type && !seen.has(event));
      if (found) {
        this.out.splice(this.out.indexOf(found), 1);
        return found;
      }
      await Bun.sleep(20);
    }
    throw new Error(`no ${type} event; saw ${JSON.stringify(this.out)}`);
  }
}

async function world() {
  const root = roots[roots.length - 1]!;
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  const dataDir = process.env.PLANNOTATOR_DATA_DIR!;
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  return { project, dataDir, server };
}

function run(dataDir: string, pipe: Pipe, argv: string[] = ["--host", "hermes", "--plugin-version", "0.1.0"], env: NodeJS.ProcessEnv = { PLANNOTATOR_INBOX_TOOL: "1" }) {
  return runInboxConnectionCommand(argv, { dataDir, env, lines: pipe.lines(), write: pipe.write, tickMs: 40 });
}

async function thread(server: InboxServer, id: string): Promise<InboxThread> {
  return ((await (await fetch(`http://127.0.0.1:${server.port}/api/inbox/threads/${id}`)).json()) as { thread: InboxThread }).thread;
}

async function reply(server: InboxServer, messageId: string, words: string): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: `k-${words}`, words }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { reply: { id: string } }).reply.id;
}

test("a Hermes session's message is signed as that session, and the person's reply comes back once as a deliver event", async () => {
  const w = await world();
  const pipe = new Pipe();
  const done = run(w.dataDir, pipe);
  const ready = await pipe.next("ready");
  expect((ready.tool as { name: string }).name).toBe("plannotator_inbox");
  expect((ready.tool as { parameters: { type: string } }).parameters.type).toBe("object");

  pipe.send({ type: "open", session: "ses_owner1", cwd: w.project });
  pipe.send({ type: "state", session: "ses_owner1", busy: true });
  pipe.send({ type: "call", id: 1, session: "ses_owner1", cwd: w.project, wakes: true, input: { action: "send_message", body: "Draft is ready. Ship it?" } });
  const result = await pipe.next("result");
  expect(result.is_error).toBe(false);
  const messageId = /"message_id":"([^"]+)"/.exec(String(result.text))![1]!;
  const threadId = /"thread_id":"([^"]+)"/.exec(String(result.text))![1]!;
  const sent = (await thread(w.server, threadId)).messages[0]!;
  expect(sent.author).toMatchObject({ kind: "agent", host: "hermes", session: "ses_owner1", name: "Hermes Agent" });
  expect(sent.wakes).toBe(true);

  const replyId = await reply(w.server, messageId, "Yes, ship it.");
  await Bun.sleep(400);
  expect(pipe.out.filter((event) => event.type === "deliver")).toEqual([]);
  pipe.send({ type: "state", session: "ses_owner1", busy: false });
  const deliver = await pipe.next("deliver");
  expect(deliver).toMatchObject({ session: "ses_owner1", id: replyId });
  expect(String(deliver.text)).toStartWith("Plannotator Inbox: ");
  expect(String(deliver.text)).toContain("Yes, ship it.");
  pipe.send({ type: "delivered", session: "ses_owner1", id: replyId });
  for (let waited = 0; waited < 4_000 && !(await thread(w.server, threadId)).messages.find((m) => m.id === replyId)?.delivery; waited += 50) await Bun.sleep(50);
  expect((await thread(w.server, threadId)).messages.find((m) => m.id === replyId)?.delivery).toMatchObject({ host: "hermes", session: "ses_owner1" });
  await Bun.sleep(400);
  expect(pipe.out.filter((event) => event.type === "deliver")).toEqual([]);
  pipe.close();
  expect(await done).toBe(0);
});

test("with the switch off there is no tool, and nothing polls", async () => {
  const w = await world();
  const pipe = new Pipe();
  const done = run(w.dataDir, pipe, ["--host", "hermes"], { PLANNOTATOR_INBOX_TOOL: "0" });
  const ready = await pipe.next("ready");
  expect(ready.tool).toBeNull();
  expect(String(ready.why)).toContain("Settings → Agents");
  pipe.close();
  expect(await done).toBe(0);
});

test("--no-wake: the tool does not promise a wake and a session is never opened", async () => {
  const w = await world();
  const pipe = new Pipe();
  const done = run(w.dataDir, pipe, ["--host", "hermes", "--no-wake"]);
  const ready = await pipe.next("ready");
  expect(String((ready.tool as { description: string }).description)).not.toContain("A reply arrives in this session by itself");
  pipe.send({ type: "open", session: "ses_x", cwd: w.project });
  await Bun.sleep(300);
  const live = (await (await fetch(`http://127.0.0.1:${w.server.port}/api/inbox/sessions`)).json()) as { projects: { sessions: { session: string }[] }[] };
  expect(live.projects.flatMap((group) => group.sessions).some((s) => s.session === "ses_x")).toBe(false);
  pipe.close();
  expect(await done).toBe(0);
});
