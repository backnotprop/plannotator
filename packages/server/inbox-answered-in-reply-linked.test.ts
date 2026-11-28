/**
 * A question answered in the person's reply, on two real Inboxes linked both ways. Starts two Inboxes: CI runs it.
 *
 * What this catches: a linked computer that does not list the `answered-in-reply` mark (its agents' marks would be
 * dropped there); an agent's answered_in_reply into another computer's thread not marking the question there; a
 * Reopen from this window not reaching the computer the thread lives on, or landing here instead.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { TailscaleRunner } from "@plannotator/shared/tailscale";
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

const ASK = [
  "The new build runner is up for harbor.",
  "",
  ":::question",
  "Which region should the new runner live in?",
  "",
  "- [ ] us-east-1",
  "- [ ] eu-west-1",
  ":::",
  "",
  ":::question",
  "Keep the old Jenkins job as a fallback for a week?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

describe("answered in the person's reply, on a linked computer's thread", () => {
  const dirs: string[] = [];
  const clients: Client[] = [];
  const envWas = { sandbox: process.env.PLANNOTATOR_TEST_SANDBOX, home: process.env.HOME };
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-answered-linked-")));
    dirs.push(root);
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
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
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
  let keys = 0;
  const press = async (port: number, path: string, body: Json = {}) => {
    const health = await get(port, "/api/inbox/health");
    return fetch(`${at(port)}${path}`, { method: "POST", headers: { Origin: at(port), "Content-Type": "application/json" }, body: JSON.stringify({ serverSession: health.serverSession, idempotency_key: `window-answered-${++keys}`, ...body }) });
  };
  const agent = async (server: InboxServer) => {
    const client = new Client({ name: "inbox-answered-linked-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${at(server.port)}/mcp`)));
    clients.push(client);
    return async (args: Json) => {
      const result = await client.callTool({ name: "send_message", arguments: { agent_session: "ses_studio", agent_host: "claude-code", ...args } });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      return { structured: result.structuredContent as Json, text: (result.content as { text: string }[]).map((c) => c.text).join("\n") };
    };
  };

  test("an agent here marks its question in the other computer's thread answered, and Reopen from this window lands there", async () => {
    const dataStudio = dataDir("studio");
    const dataLaptop = dataDir("laptop");
    const studio = await start(dataStudio);
    const laptop = await start(dataLaptop);
    try {
      const offered = (await (await fetch(`${at(laptop.port)}/api/inbox/machines/offer`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()) as Json;
      const linked = await fetch(`${at(studio.port)}/api/inbox/machines/link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ link: offered.link, address: at(laptop.port), back: at(studio.port) }) });
      expect(linked.status).toBe(201);
      const laptopId = (JSON.parse(readFileSync(join(dataStudio, "inbox", "machines.json"), "utf8")) as Json).links[0].id as string;
      await waitFor("Laptop lists the mark on Studio", async () => ((await get(studio.port, "/api/inbox/machines")).machines as Json[]).find((m) => m.id === laptopId)?.marks?.includes("answered-in-reply") === true, 15_000);

      const project = join(root, "harbor");
      mkdirSync(project, { recursive: true });
      const opened = laptop.store.sendMessage({ project_id: laptop.store.ensureProject({ name: "harbor", root: project }).id, author: { kind: "agent", host: "codex", session: "ses_laptop", name: null }, subject: "Move harbor deploys to the new build runner", body: "The runner is ready on this computer." }).message;

      const send = await agent(studio);
      const asked = (await send({ reply_to: opened.thread_id, body: ASK, idempotency_key: "ask-1" })).structured;
      const askedId = asked.message_id as string;
      const jenkins = (laptop.store.questionsOf(askedId) as Json[]).find((q) => (q.prompt as string).startsWith("Keep the old Jenkins"))!;
      const ref = `${askedId}/${jenkins.key}`;

      const far = `/api/inbox/m/${laptopId}`;
      const seen = (await get(studio.port, `${far}/threads/${opened.thread_id}`)).cursor as number;
      const replied = await press(studio.port, `${far}/messages/${askedId}/reply`, { words: "Yep, keep Jenkins for a week, that's fine.", questions: [], seen_through_seq: seen });
      const repliedBody = (await replied.json()) as Json;
      expect(replied.status, JSON.stringify(repliedBody)).toBe(200);
      const replyId = repliedBody.reply.id as string;

      const marked = await send({ reply_to: replyId, body: "Got it: Jenkins stays a week.", idempotency_key: "mark-1", answered_in_reply: [{ question: ref, quote: "keep Jenkins for a week" }] });
      expect(marked.structured.answered_in_reply).toEqual([ref]);
      expect(marked.text).not.toContain("older Plannotator");
      const onLaptop = () => (laptop.store.questionsOf(askedId) as Json[]).find((q) => q.key === jenkins.key)!;
      expect(onLaptop().state).toBe("answered_in_reply");
      expect(onLaptop().answered_in_reply).toMatchObject({ reply_id: replyId, quote: "keep Jenkins for a week" });

      const reopened = await press(studio.port, `${far}/messages/${askedId}/reopen`, { key: jenkins.key });
      expect(reopened.status, await reopened.clone().text()).toBe(200);
      expect(onLaptop().state).toBe("open");
      const note = laptop.store.message(laptop.store.threadMessageIds(opened.thread_id).at(-1)!)!;
      expect(note.reopened).toEqual([ref]);
      expect(studio.store.message(askedId) ?? null).toBeNull();
    } finally {
      studio.stop();
      laptop.stop();
    }
  }, 120_000);
});
