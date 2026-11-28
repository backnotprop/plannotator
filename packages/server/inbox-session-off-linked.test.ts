import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
import { INBOX_BRIDGE_EVENT_PATH, INBOX_BRIDGE_POLL_PATH, INBOX_OFF_POLL_FIELD, INBOX_WAKES_META_KEY } from "@plannotator/shared/inbox/connection";
import { waitFor } from "../../tests/helpers/inbox-world";
import { startInboxServer, type InboxServer } from "./inbox";

type Json = Record<string, any>;

function scriptedTailscale(): TailscaleRunner {
  const serve = new Map<number, string>();
  return (args) => {
    const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
    if (args[1] === "status") {
      if (serve.size === 0) return ok("{}");
      const TCP = Object.fromEntries([...serve.keys()].map((p) => [String(p), { HTTPS: true }]));
      const Web = Object.fromEntries([...serve].map(([p, proxy]) => [`studio.tail0000.ts.net:${p}`, { Handlers: { "/": { Proxy: proxy } } }]));
      return ok(JSON.stringify({ TCP, Web }));
    }
    const httpsPort = Number(/--https=(\d+)/.exec(args.join(" "))![1]);
    if (args.includes("off")) {
      serve.delete(httpsPort);
      return ok();
    }
    serve.set(httpsPort, args.at(-1)!);
    return ok(`Available within your tailnet:\n\nhttps://studio.tail0000.ts.net:${httpsPort}/\n|-- proxy ${args.at(-1)}\n`);
  };
}

describe("a session turned off on a linked computer", () => {
  const clients: Client[] = [];
  const envWas = { sandbox: process.env.PLANNOTATOR_TEST_SANDBOX, home: process.env.HOME };
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-session-off-linked-")));
    process.env.PLANNOTATOR_TEST_SANDBOX = root;
    process.env.HOME = join(root, "home");
    mkdirSync(process.env.HOME, { recursive: true });
  });
  afterAll(async () => {
    for (const client of clients.splice(0)) await client.close().catch(() => {});
    for (const [name, was] of [["PLANNOTATOR_TEST_SANDBOX", envWas.sandbox], ["HOME", envWas.home]] as const) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
    rmSync(root, { recursive: true, force: true });
  });
  const dataDir = (name: string) => {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), "{}");
    return dir;
  };
  const start = (dir: string) => startInboxServer({ dataDir: dir, binaryPath: null, phones: false, tailscale: scriptedTailscale() });
  const at = (port: number) => `http://127.0.0.1:${port}`;
  const get = async (port: number, path: string) => (await (await fetch(`${at(port)}${path}`)).json()) as Json;
  const press = async (port: number, path: string, body: Json) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { Origin: at(port), "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `window-off-${Math.random()}`, ...body }) });
  };
  const bridge = (server: InboxServer, path: string, body: unknown) =>
    fetch(`${at(server.port)}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` }, body: JSON.stringify(body) });

  test("the other computer's window reads it as Inbox off on the row, the thread and the Agents card, and as sending once it is back on", async () => {
    const dataStudio = dataDir("studio");
    const dataLaptop = dataDir("laptop");
    const studio = await start(dataStudio);
    const laptop = await start(dataLaptop);
    try {
      const offered = (await (await fetch(`${at(laptop.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(studio.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(laptop.port), back: at(studio.port) }) });
      expect(linked.status).toBe(201);
      const laptopId = (JSON.parse(readFileSync(join(dataStudio, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;

      const project = join(root, "fern-api");
      mkdirSync(project, { recursive: true });
      const client = new Client({ name: "inbox-session-off-linked-test", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${at(laptop.port)}/mcp`)));
      clients.push(client);
      const sent = (
        await client.callTool({
          name: "send_message",
          arguments: { body: "The fern-api migration is ready. Run it tonight?", project_path: project, agent_session: "ses_laptop", agent_host: "pi" },
          _meta: { [INBOX_WAKES_META_KEY]: true },
        })
      ).structuredContent as { message_id: string; thread_id: string };
      const poll = (off: boolean) => bridge(laptop, INBOX_BRIDGE_POLL_PATH, { session: "ses_laptop", host: "pi", project_path: project, waitMs: 0, busy: false, [INBOX_OFF_POLL_FIELD]: off });
      await poll(true);

      const far = `/api/inbox/m/${laptopId}`;
      await waitFor("Laptop's thread on Studio", async () => (await get(studio.port, `${far}/threads/${sent.thread_id}`)).thread !== undefined, 15_000);
      const seen = (await get(studio.port, `${far}/threads/${sent.thread_id}`)).cursor as number;
      const replied = await press(studio.port, `${far}/messages/${sent.message_id}/reply`, { words: "Yes, once Charlie Dunn is online.", seen_through_seq: seen });
      expect(replied.status).toBe(200);

      const row = async () =>
        ((await get(studio.port, "/api/inbox/threads?archived=exclude&machines=1")).sections as Json[]).flatMap((s) => s.threads as Json[]).find((r) => r.thread_id === sent.thread_id);
      const agent = async () =>
        ((await get(studio.port, "/api/inbox/threads?archived=exclude&machines=1")).agents as Json[]).flatMap((g) => g.agents as Json[]).find((a) => a.session === "ses_laptop");
      const connection = async () => (await get(studio.port, `${far}/threads/${sent.thread_id}/sessions?asker=ses_laptop`)).asker?.connection as Json | undefined;

      await waitFor("Inbox off on Studio's row", async () => (await row())?.delivery?.reason === "inbox_off", 20_000);
      expect((await row())!.delivery.state).toBe("queued");
      await waitFor("Inbox off on Studio's Agents card", async () => (await agent())?.inbox_off === true, 20_000);
      expect((await connection())?.inbox_off).toBe(true);
      expect(laptop.store.threadMessageIds(sent.thread_id).map((id) => laptop.store.message(id)!).filter((m) => m.author.kind === "person")).toHaveLength(1);

      await bridge(laptop, INBOX_BRIDGE_EVENT_PATH, { session: "ses_laptop", host: "pi", type: "state", busy: false, [INBOX_OFF_POLL_FIELD]: false });
      await poll(false);
      await waitFor("sending on Studio's row", async () => (await row())?.delivery?.state === "sending", 20_000);
      await waitFor("Agents card back on", async () => (await agent())?.inbox_off === undefined, 20_000);
      expect((await connection())?.inbox_off).toBeUndefined();
    } finally {
      studio.stop();
      laptop.stop();
    }
  }, 120_000);
});
