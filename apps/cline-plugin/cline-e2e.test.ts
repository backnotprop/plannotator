/**
 * End to end against a real Cline CLI: the built plugin in a scratch Cline
 * home, a fake OpenAI-compatible model on loopback (no key, no paid call), and
 * a scratch Inbox in this process. The Cline session shows up in the Inbox's
 * New message picker, and a New message to it starts a real turn there: the
 * fake model receives the wake text, and the Inbox records the delivery.
 *
 * Opt-in: Cline is never installed by the test suite. Point CLINE_E2E_BIN at a
 * Cline CLI binary (the npm package `cline`, installed into a scratch prefix)
 * to run it; otherwise it is skipped. macOS and Linux (it gives the TUI a pty
 * with `script`). Every Cline process gets the scratch HOME, its own hub port,
 * and stub `open` / `xdg-open` first on PATH, so nothing reaches the real
 * ~/.cline or opens a browser; the hub it starts is stopped at the end.
 *
 *   CLINE_E2E_BIN=/path/to/cline /tmp/overnight/bt.sh apps/cline-plugin/cline-e2e.test.ts
 */

import { afterAll, expect, test } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "../../packages/server/inbox";
import { NO_BROWSER } from "../../tests/helpers/no-browser";

const CLINE = process.env.CLINE_E2E_BIN?.trim();
const RUNS = !!CLINE && (process.platform === "darwin" || process.platform === "linux");

const cleanups: (() => void)[] = [];
afterAll(() => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      cleanup();
    } catch {
      // Best effort.
    }
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

async function until<T>(check: () => T | null | undefined | Promise<T | null | undefined>, ms: number): Promise<T | null> {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    const value = await check();
    if (value) return value;
    await Bun.sleep(100);
  }
  return null;
}

/** The last user message's text in a chat completions request. */
function lastUser(body: { messages?: { role?: string; content?: unknown }[] }): string {
  for (const message of [...(body.messages ?? [])].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) return message.content.map((part) => (part as { text?: string }).text ?? "").join(" ");
  }
  return "";
}

test.skipIf(!RUNS)(
  "a live Cline CLI session is listed in the New message picker, and a New message to it starts one real turn there",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-cline-e2e-")));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const home = join(root, "home");
    const project = join(root, "project");
    const dataDir = join(root, "plannotator");
    const stubs = join(root, "stubs");
    for (const dir of [home, project, dataDir, stubs]) mkdirSync(dir, { recursive: true });
    // Nothing a Cline notice or link could run opens a browser.
    for (const name of ["open", "xdg-open"]) {
      writeFileSync(join(stubs, name), "#!/bin/sh\nexit 0\n");
      chmodSync(join(stubs, name), 0o755);
    }

    // The fake model: every request recorded, a plain text answer streamed back.
    const requests: { at: number; user: string }[] = [];
    const model = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const body = (await request.json().catch(() => ({}))) as { messages?: { role?: string; content?: unknown }[] };
        requests.push({ at: Date.now(), user: lastUser(body) });
        const chunk = (delta: unknown, finish: string | null) =>
          `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        return new Response(`${chunk({ role: "assistant", content: "OK" }, null)}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
      },
    });
    cleanups.push(() => model.stop(true));

    const inbox: InboxServer = await startInboxServer({ dataDir });
    cleanups.push(() => inbox.stop());
    writeFileSync(join(dataDir, "config.json"), JSON.stringify({ inboxTool: { cline: true } }));

    // The plugin as Cline loads it: one built file in the scratch home's plugins folder.
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "index.ts")], target: "node" });
    expect(built.success).toBe(true);
    mkdirSync(join(home, ".cline", "plugins"), { recursive: true });
    writeFileSync(join(home, ".cline", "plugins", "plannotator.js"), await built.outputs[0]!.text());

    const env: Record<string, string> = {
      PATH: `${stubs}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      TERM: "xterm-256color",
      CLINE_TELEMETRY_DISABLED: "1",
      CLINE_HUB_PORT: String(await freePort()),
      PLANNOTATOR_DATA_DIR: dataDir,
      PLANNOTATOR_BROWSER: NO_BROWSER,
      PLANNOTATOR_UPDATE_CHECK: "0",
      PLANNOTATOR_INBOX_CONNECT: "0",
      NO_ANON_PING: "1",
    };
    const auth = spawnSync(CLINE!, ["auth", "-p", "openai-compatible", "-k", "fake", "-m", "fake-model", "-b", `http://127.0.0.1:${model.port}/v1`], { env, encoding: "utf8", timeout: 20_000 });
    expect(auth.status).toBe(0);
    cleanups.push(() => void spawnSync(CLINE!, ["hub", "stop"], { env, timeout: 10_000 }));

    // The interactive TUI on a pty (`script`), its first turn the prompt; it then stays open and idle.
    // Its stdin is a real pipe kept open by `sleep` (`script` refuses a socket, which is what a "pipe" stdio is here).
    const quoted = [CLINE!, "-i", "-c", project, "first turn"].map((word) => `'${word.replace(/'/g, `'\\''`)}'`).join(" ");
    const pty: ChildProcess = spawn(
      "/bin/sh",
      ["-c", process.platform === "darwin" ? `sleep 300 | /usr/bin/script -q /dev/null ${quoted}` : `sleep 300 | script -qfec ${`'${quoted.replace(/'/g, `'\\''`)}'`} /dev/null`],
      { env, cwd: project, detached: true, stdio: "ignore" },
    );
    cleanups.push(() => void process.kill(-pty.pid!, "SIGTERM"));

    const base = `http://127.0.0.1:${inbox.port}`;
    expect(await until(() => requests.find((r) => r.user === "first turn"), 30_000)).not.toBeNull();
    const listed = await until(async () => {
      const { projects } = (await (await fetch(`${base}/api/inbox/sessions`)).json()) as {
        projects: { project: { root: string }; sessions: { session: string; host: string; busy: boolean | null }[] }[];
      };
      return projects.flatMap((group) => group.sessions.map((s) => ({ ...s, root: group.project.root }))).find((s) => s.host === "cline");
    }, 15_000);
    expect(listed).toMatchObject({ host: "cline", root: project });

    const response = await fetch(`${base}/api/inbox/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: inbox.serverSession, to: { host: "cline", session: listed!.session }, body: "Idea: retry the webhook on a 409.", idempotency_key: "e2e-1" }),
    });
    expect(response.status).toBe(200);
    const sent = (await response.json()) as { thread_id: string; message: { id: string } };
    const turn = await until(() => requests.find((r) => r.user.includes(`(${sent.message.id})`)), 15_000);
    expect(turn?.user).toStartWith("Plannotator Inbox: Idea: retry the webhook on a 409");
    const delivery = await until(async () => {
      const { thread } = (await (await fetch(`${base}/api/inbox/threads/${sent.thread_id}`)).json()) as { thread: { messages: { delivery?: unknown }[] } };
      return thread.messages[0]?.delivery as { host: string; session: string } | undefined;
    }, 10_000);
    expect(delivery).toMatchObject({ host: "cline", session: listed!.session });
    await Bun.sleep(2_000);
    expect(requests.filter((r) => r.user.includes(`(${sent.message.id})`))).toHaveLength(1);
  },
  60_000,
);
