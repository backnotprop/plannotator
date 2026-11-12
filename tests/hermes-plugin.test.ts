import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InboxThread } from "../packages/core/inbox-types";
import { startInboxServer, type InboxServer } from "../packages/server/inbox";
import { removeStubbedHtml, stubHookDistHtml } from "./helpers/hook-dist-stub";
import { NO_BROWSER } from "./helpers/no-browser";

const python = process.platform === "win32" ? null : Bun.which("python3");
const here = resolve(import.meta.dir, "hermes");
const cli = resolve(import.meta.dir, "../apps/hook/server/index.ts");
const roots: string[] = [];
const servers: InboxServer[] = [];
const saved = process.env.PLANNOTATOR_DATA_DIR;
const stubs = stubHookDistHtml();

afterAll(() => removeStubbedHtml(stubs));

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-hermes-")));
  roots.push(root);
  return root;
}

test.skipIf(!python)("the plugin's Python tests pass against the Hermes stub", () => {
  const home = scratch();
  const run = Bun.spawnSync([python!, "-m", "unittest", "-q", "test_plugin"], {
    cwd: here,
    env: { PATH: process.env.PATH ?? "", HOME: home, PYTHONDONTWRITEBYTECODE: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(run.stderr.toString()).toContain("OK");
  expect(run.exitCode).toBe(0);
}, 60_000);

test.skipIf(!python)("end to end: the plugin over the real plannotator signs as the Hermes session, and the reply wakes it once after its turn", async () => {
  const root = scratch();
  const dataDir = join(root, "data");
  const project = join(root, "ledger");
  mkdirSync(project, { recursive: true });
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  const server = await startInboxServer({ dataDir });
  servers.push(server);
  const bin = join(root, "plannotator");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" run "${cli}" "$@"\n`);
  chmodSync(bin, 0o755);
  const child = Bun.spawn([python!, "e2e.py", project], {
    cwd: here,
    env: { PATH: process.env.PATH ?? "", HOME: join(root, "home"), PLANNOTATOR_DATA_DIR: dataDir, PLANNOTATOR_INBOX_TOOL: "1", PLANNOTATOR_BIN: bin, PLANNOTATOR_BROWSER: NO_BROWSER, PYTHONDONTWRITEBYTECODE: "1" },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const reader = child.stdout.getReader();
  let buffered = "";
  const next = async (): Promise<Record<string, unknown>> => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`the Hermes stub ended: ${await new Response(child.stderr).text()}`);
      buffered += new TextDecoder().decode(value);
    }
    const line = buffered.slice(0, buffered.indexOf("\n"));
    buffered = buffered.slice(buffered.indexOf("\n") + 1);
    return JSON.parse(line);
  };
  try {
    expect((await next()).tools).toEqual(["plannotator_inbox"]);
    const sent = String((await next()).sent);
    const messageId = /"message_id":"([^"]+)"/.exec(sent)![1]!;
    const threadId = /"thread_id":"([^"]+)"/.exec(sent)![1]!;
    const base = `http://127.0.0.1:${server.port}`;
    const thread = async () => ((await (await fetch(`${base}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
    expect((await thread()).messages[0]!.author).toMatchObject({ kind: "agent", host: "hermes", session: "ses_e2e", name: "Hermes Agent" });
    const replied = await fetch(`${base}/api/inbox/messages/${messageId}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "e2e", words: "Yes, ship it." }),
    });
    const replyId = ((await replied.json()) as { reply: { id: string } }).reply.id;
    await Bun.sleep(2_500);
    expect((await thread()).messages.find((m) => m.id === replyId)?.delivery ?? null).toBeNull();
    child.stdin.write("turn over\n");
    child.stdin.flush();
    const injected = (await next()).injected as [string, string][];
    expect(injected).toHaveLength(1);
    expect(injected[0]![0]).toBe("ses_e2e");
    expect(injected[0]![1]).toStartWith("Plannotator Inbox: ");
    expect(injected[0]![1]).toContain("Yes, ship it.");
    for (let waited = 0; waited < 5_000 && !(await thread()).messages.find((m) => m.id === replyId)?.delivery; waited += 100) await Bun.sleep(100);
    expect((await thread()).messages.find((m) => m.id === replyId)?.delivery).toMatchObject({ host: "hermes", session: "ses_e2e" });
  } finally {
    child.stdin.write("done\n");
    child.stdin.end();
    await child.exited;
  }
}, 90_000);
