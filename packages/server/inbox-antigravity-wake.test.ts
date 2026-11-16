/**
 * The Antigravity wake (inbox-antigravity-wake.ts) against a fake agent API
 * (tests/helpers/fake-agy.ts: each product's `bin/agentapi`, the App's hub
 * file, a CLI hand-over), with a store in a temp folder. No Inbox server, and
 * the real agy and App are never run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  antigravityConversationOfCall,
  antigravityLoopbackAddress,
  antigravityProductOfPath,
  type InboxAuthor,
  type InboxMessage,
} from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxStore } from "@plannotator/shared/inbox/store";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { createInboxAntigravityWake, type InboxAntigravityWake } from "./inbox-antigravity-wake";
import { INBOX_REPLY_ANTIGRAVITY_HANDOVER_TEXT, INBOX_REPLY_ARRIVES_TEXT, INBOX_REPLY_LOOK_TEXT, INBOX_REPLY_READ_LATER_TEXT, antigravityHandsOver, replyNextStepText } from "./inbox-mcp";
import { createFakeAgy, type FakeAgy } from "../../tests/helpers/fake-agy";

const CONVERSATION = "6640fa39-c263-49df-b314-312ed85b242f";
const CLI_CONVERSATION = "2cb0b3d5-163d-4a94-a19b-5b564a906739";
const APP_TOKEN = "app-token-0123456789abcdef";
/** A pid no process has (above the largest pid macOS and Linux hand out). */
const GONE_PID = 2 ** 22 + 12345;
const CLI_TOKEN = "cli-token-0123456789abcdef";

const fakes: FakeAgy[] = [];
const wakes: InboxAntigravityWake[] = [];
afterEach(() => {
  for (const wake of wakes.splice(0)) wake.stop();
  for (const fake of fakes.splice(0)) fake.remove();
});

const meta = (conversation: string, product: "antigravity" | "antigravity-cli" | "antigravity-ide", root = conversation) => ({
  "antigravity.google/artifacts_dir": `/home/x/.gemini/${product}/brain/${conversation}`,
  "antigravity.google/conversation_id": conversation,
  "antigravity.google/root_conversation_id": root,
  progressToken: "t:1",
});

const commandOf = (item: InboxMessage): InboxReplyCommand => ({ type: "reply", id: item.id, thread_id: item.thread_id, reply_to: item.reply_to ?? null, subject: null, body: item.body, url: "http://127.0.0.1/#thread" });

function world(conversation = CONVERSATION) {
  const fake = createFakeAgy();
  fakes.push(fake);
  const store = InboxStore.open(join(fake.root, "data", "inbox"));
  const project = store.ensureProject({ name: "ledger", root: "/work/ledger" });
  const author: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "antigravity", session: conversation, name: "Antigravity" };
  const asked = store.sendMessage({ project_id: project.id, author, body: "Ship the worker today?", wakes: true }).message;
  const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { PATH: "/usr/bin:/bin", HOME: fake.home } });
  const logs: string[] = [];
  const start = (over: { sendTimeoutMs?: number; waitCheckMs?: number; now?: () => number } = {}) => {
    const wake = createInboxAntigravityWake({ store, environment, commandOf, log: (line) => logs.push(line), appClients: [], waitCheckMs: 50, ...over });
    wakes.push(wake);
    return wake;
  };
  let n = 0;
  const reply = (words: string) => store.sendReply(asked.id, { words, idempotency_key: `k${++n}` }).reply!;
  const linksDir = join(store.dir, "antigravity", "links");
  // `pid`: the agy it came from (this test process: running); null writes none.
  const link = (address: string, token: string, pid: number | null = process.pid, id = conversation) => {
    mkdirSync(linksDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(linksDir, `${id}.json`), JSON.stringify({ conversation: id, address, token, at: new Date().toISOString(), ...(pid === null ? {} : { pid }) }), { mode: 0o600 });
  };
  const lookups = () => fake.calls().filter((call) => call.args[0] === "get-conversation-metadata").length;
  return { fake, store, start, reply, link, linksDir, lookups, logs, asked };
}

const waitFor = async (check: () => boolean, ms = 3000) => {
  const until = Date.now() + ms;
  while (!check() && Date.now() < until) await Bun.sleep(20);
  return check();
};

describe("an App conversation, through the App's hub file", () => {
  test("a reply goes in once, with the hub's token in the environment only, and is delivered", async () => {
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION] });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start();
    expect(await wake.wakes("antigravity", CONVERSATION, meta(CONVERSATION, "antigravity"))).toBe(true);
    const reply = w.reply("Yes, ship it.");
    await wake.sweep();
    expect(w.fake.sends()).toHaveLength(1);
    const [send] = w.fake.sends();
    expect(send!.tokenOk).toBe(true);
    expect(send!.address).toBe("localhost:57930");
    expect(send!.args.slice(0, 2)).toEqual(["send-message", CONVERSATION]);
    expect(send!.args[2]).toContain(`(${reply.id})`);
    expect(send!.args.join(" ")).not.toContain(APP_TOKEN);
    expect(w.store.message(reply.id)!.delivery).toMatchObject({ host: "antigravity", session: CONVERSATION });
    expect(w.fake.transcript("app", CONVERSATION)).toContain("Yes, ship it.");

    // Never twice: another sweep, and a restart.
    await wake.sweep();
    wake.stop();
    await w.start().sweep();
    expect(w.fake.sends()).toHaveLength(1);
  });

  test("two replies in a row: two sends, each once", async () => {
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION] });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start();
    const first = w.reply("First.");
    await wake.sweep();
    const second = w.reply("Second.");
    await wake.sweep();
    await wake.sweep();
    expect(w.fake.sends().map((call) => call.args[2]!.includes(`(${first.id})`) ? 1 : call.args[2]!.includes(`(${second.id})`) ? 2 : 0)).toEqual([1, 2]);
  });

  test("a hub file whose pid is gone is not used, and the App closed keeps the reply until it is back", async () => {
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION] });
    w.fake.hub("app", 57930, APP_TOKEN, 2 ** 22 + 12345);
    const wake = w.start();
    expect(await wake.wakes("antigravity", CONVERSATION, meta(CONVERSATION, "antigravity"))).toBe(false);
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(w.fake.calls()).toHaveLength(0);
    expect(w.store.message(reply.id)!.delivery).toBeFalsy();
    // The App comes back (a new launch, a new port and token): the wait check sees its file and sends.
    w.fake.server("localhost:58000", { up: true, token: "new-token-0123456789", product: "app", conversations: [CONVERSATION] });
    w.fake.hub("app", 58000, "new-token-0123456789");
    expect(await waitFor(() => !!w.store.message(reply.id)!.delivery)).toBe(true);
    expect(w.fake.sends()).toHaveLength(1);
  });

  test("a conversation no server has is never sent to (send-message would answer 0 for it)", async () => {
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: ["00000000-0000-4000-8000-000000000000"] });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start();
    expect(await wake.wakes("antigravity", CONVERSATION, meta(CONVERSATION, "antigravity"))).toBe(false);
    w.reply("Yes.");
    await wake.sweep();
    expect(w.fake.sends()).toHaveLength(0);
  });

  test("a token the server no longer takes sends nothing and is tried again with the new hub file", async () => {
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: "rotated-token-000000", product: "app", conversations: [CONVERSATION] });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start();
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(w.fake.sends()).toHaveLength(0);
    expect(w.store.message(reply.id)!.delivery).toBeFalsy();
    w.fake.hub("app", 57930, "rotated-token-000000");
    expect(await waitFor(() => !!w.store.message(reply.id)!.delivery)).toBe(true);
    expect(w.fake.sends()).toHaveLength(1);
  });
});

describe("a send whose outcome is not known", () => {
  test("it timed out after the message landed: read back from the transcript, delivered, never sent again", async () => {
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION], hang: "after" });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start({ sendTimeoutMs: 1500 });
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(w.fake.sends()).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toMatchObject({ host: "antigravity" });
    expect(wake.uncertain(CONVERSATION, reply.id)).toBe(false);
  });

  test("it timed out with nothing in the transcript: saved, never sent again, across a restart", async () => {
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION], hang: "before" });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start({ sendTimeoutMs: 1500 });
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(wake.uncertain(CONVERSATION, reply.id)).toBe(true);
    expect(wake.uncertainItems(CONVERSATION)).toEqual([reply.id]);
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION] });
    await wake.sweep();
    wake.stop();
    const again = w.start();
    await again.sweep();
    expect(w.fake.sends()).toHaveLength(1);
    expect(again.uncertain(CONVERSATION, reply.id)).toBe(true);
    expect(w.store.message(reply.id)!.delivery).toBeFalsy();
  });
});

describe("a CLI conversation, through its hand-over", () => {
  test("no hand-over: not woken and nothing sent; the hand-over lets the waiting reply go in once", async () => {
    const w = world(CLI_CONVERSATION);
    w.fake.server("localhost:56548", { up: true, token: CLI_TOKEN, product: "cli", conversations: [CLI_CONVERSATION] });
    const wake = w.start();
    expect(await wake.wakes("antigravity", CLI_CONVERSATION, meta(CLI_CONVERSATION, "antigravity-cli"))).toBe(false);
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(w.fake.calls()).toHaveLength(0);
    w.link("localhost:56548", CLI_TOKEN);
    expect(await waitFor(() => !!w.store.message(reply.id)!.delivery)).toBe(true);
    expect(w.fake.sends()).toHaveLength(1);
    expect(w.fake.sends()[0]!.tokenOk).toBe(true);
    expect(await wake.wakes("antigravity", CLI_CONVERSATION, meta(CLI_CONVERSATION, "antigravity-cli"))).toBe(true);
  });

  test("its agy exited: ended, the stale hand-over removed, and alive again with a new one", async () => {
    const w = world(CLI_CONVERSATION);
    w.fake.server("localhost:56548", { up: false, token: CLI_TOKEN, product: "cli", conversations: [CLI_CONVERSATION] });
    w.link("localhost:56548", CLI_TOKEN);
    const wake = w.start();
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(wake.status(CLI_CONVERSATION)).toBe("dead");
    expect(existsSync(join(w.store.dir, "antigravity", "links", `${CLI_CONVERSATION}.json`))).toBe(false);
    expect(w.fake.sends()).toHaveLength(0);
    // Resumed in a new agy, which hands over again.
    w.fake.server("localhost:61000", { up: true, token: "next-cli-token-00000", product: "cli", conversations: [CLI_CONVERSATION] });
    w.link("localhost:61000", "next-cli-token-00000");
    wake.noteToolCall(CLI_CONVERSATION, meta(CLI_CONVERSATION, "antigravity-cli"));
    expect(await waitFor(() => !!w.store.message(reply.id)!.delivery)).toBe(true);
    expect(wake.status(CLI_CONVERSATION)).toBe("alive");
    expect(w.fake.sends()).toHaveLength(1);
  });

  test("a subagent's call never wakes (its conversation is not its root's)", async () => {
    const w = world(CLI_CONVERSATION);
    w.fake.server("localhost:56548", { up: true, token: CLI_TOKEN, product: "cli", conversations: [CLI_CONVERSATION] });
    w.link("localhost:56548", CLI_TOKEN);
    const wake = w.start();
    expect(await wake.wakes("antigravity", CLI_CONVERSATION, meta(CLI_CONVERSATION, "antigravity-cli", CONVERSATION))).toBe(false);
  });
});

describe("stale hand-overs", () => {
  test("a hand-over whose agy pid is gone is removed on the wake's pass, the conversation is ended and its reply waits", async () => {
    const w = world(CLI_CONVERSATION);
    w.fake.server("localhost:56548", { up: true, token: CLI_TOKEN, product: "cli", conversations: [CLI_CONVERSATION] });
    w.link("localhost:56548", CLI_TOKEN, GONE_PID);
    const other = "11111111-2222-4333-8444-555555555555";
    w.link("localhost:50001", "other-token-0123456789", GONE_PID, other);
    const running = "66666666-7777-4888-9999-aaaaaaaaaaaa";
    w.link("localhost:50002", "running-token-0123456", process.pid, running);
    const wake = w.start();
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(existsSync(join(w.linksDir, `${CLI_CONVERSATION}.json`))).toBe(false);
    expect(existsSync(join(w.linksDir, `${other}.json`))).toBe(false);
    expect(existsSync(join(w.linksDir, `${running}.json`))).toBe(true);
    expect(w.fake.calls()).toHaveLength(0);
    expect(wake.status(CLI_CONVERSATION)).toBe("dead");
    expect(w.logs.filter((line) => line.includes("is no longer running"))).toHaveLength(1);
    expect(w.store.message(reply.id)!.delivery).toBeFalsy();
  });

  test("a hand-over with no pid is removed when nothing answers on its port, and kept while something does", async () => {
    const listening = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => listening.once("listening", resolve));
    const open = (listening.address() as { port: number }).port;
    const closed = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => closed.once("listening", resolve));
    const shut = (closed.address() as { port: number }).port;
    await new Promise((resolve) => closed.close(resolve));
    try {
      const w = world(CLI_CONVERSATION);
      w.link(`127.0.0.1:${shut}`, CLI_TOKEN, null);
      const kept = "66666666-7777-4888-9999-aaaaaaaaaaaa";
      w.link(`127.0.0.1:${open}`, "kept-token-0123456789", null, kept);
      await w.start().sweep();
      expect(existsSync(join(w.linksDir, `${CLI_CONVERSATION}.json`))).toBe(false);
      expect(existsSync(join(w.linksDir, `${kept}.json`))).toBe(true);
    } finally {
      listening.close();
    }
  });
});

describe("how often it asks", () => {
  test("a conversation the App no longer has is asked for again only after a doubling wait, at once when a hub file changes; its reply never drops", async () => {
    let clock = 1_000_000;
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: ["00000000-0000-4000-8000-000000000000"] });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start({ now: () => clock, waitCheckMs: 60_000 });
    const reply = w.reply("Yes.");
    await wake.sweep();
    expect(w.lookups()).toBe(1);
    for (let i = 0; i < 5; i++) await wake.sweep();
    expect(w.lookups()).toBe(1);
    clock += 15_001;
    await wake.sweep();
    expect(w.lookups()).toBe(2);
    clock += 15_001; // The wait is 30 s now.
    await wake.sweep();
    expect(w.lookups()).toBe(2);
    clock += 15_000;
    await wake.sweep();
    expect(w.lookups()).toBe(3);
    // The App is launched again: its new hub file is asked at once, and the reply goes in.
    w.fake.server("localhost:58000", { up: true, token: "new-token-0123456789", product: "app", conversations: [CONVERSATION] });
    w.fake.hub("app", 58000, "new-token-0123456789");
    await wake.sweep();
    expect(w.store.message(reply.id)!.delivery).toMatchObject({ host: "antigravity", session: CONVERSATION });
    expect(w.fake.sends()).toHaveLength(1);
  });

  test("a conversation's calls in a run ask once; a later call asks again", async () => {
    let clock = 1_000_000;
    const w = world();
    w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION] });
    w.fake.hub("app", 57930, APP_TOKEN);
    const wake = w.start({ now: () => clock });
    for (let i = 0; i < 4; i++) expect(await wake.wakes("antigravity", CONVERSATION, meta(CONVERSATION, "antigravity"))).toBe(true);
    expect(w.lookups()).toBe(1);
    clock += 15_001;
    expect(await wake.wakes("antigravity", CONVERSATION, meta(CONVERSATION, "antigravity"))).toBe(true);
    expect(w.lookups()).toBe(2);
  });
});

test("the token is never in a log line, a store file, a claim or an argument", async () => {
  const w = world();
  w.fake.server("localhost:57930", { up: true, token: "rotated-token-000000", product: "app", conversations: [CONVERSATION], hang: "before" });
  w.fake.hub("app", 57930, APP_TOKEN);
  const wake = w.start({ sendTimeoutMs: 1500 });
  w.reply("One.");
  await wake.sweep();
  w.fake.server("localhost:57930", { up: true, token: APP_TOKEN, product: "app", conversations: [CONVERSATION], hang: "before" });
  w.reply("Two.");
  await wake.sweep();
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(w.store.dir);
  for (const file of files) expect(readFileSync(file, "utf8")).not.toContain(APP_TOKEN);
  for (const line of w.logs) expect(line).not.toContain(APP_TOKEN);
  for (const call of w.fake.calls()) expect(call.args.join(" ")).not.toContain(APP_TOKEN);
});

describe("what the agent is told", () => {
  test("woken: the reply arrives and it looks if it has not; a CLI conversation with no hand-over is told the one command", () => {
    expect(replyNextStepText(true, "antigravity")).toBe(`${INBOX_REPLY_ARRIVES_TEXT} ${INBOX_REPLY_LOOK_TEXT}`);
    const cli = { mcpReq: { _meta: meta(CLI_CONVERSATION, "antigravity-cli") } };
    const app = { mcpReq: { _meta: meta(CONVERSATION, "antigravity") } };
    expect(antigravityHandsOver(cli, false, { agent_host: "antigravity", agent_session: CLI_CONVERSATION })).toBe(true);
    expect(replyNextStepText(false, "antigravity", false, true)).toBe(INBOX_REPLY_ANTIGRAVITY_HANDOVER_TEXT);
    // Woken already, an App conversation, or another conversation's call: the usual words.
    expect(antigravityHandsOver(cli, true, { agent_host: "antigravity", agent_session: CLI_CONVERSATION })).toBe(false);
    expect(antigravityHandsOver(app, false, { agent_host: "antigravity", agent_session: CONVERSATION })).toBe(false);
    expect(antigravityHandsOver(cli, false, { agent_host: "antigravity", agent_session: CONVERSATION })).toBe(false);
    expect(replyNextStepText(false, "antigravity")).toBe(INBOX_REPLY_READ_LATER_TEXT);
  });

  test("the hand-over goes only to a caller filed as Antigravity, even when its call carries an agy conversation's _meta", () => {
    const cli = { mcpReq: { _meta: meta(CLI_CONVERSATION, "antigravity-cli") } };
    for (const host of ["claude-code", "codex", "pi", "opencode", "t3", "qwen", "cursor", "gemini", undefined]) {
      expect(antigravityHandsOver(cli, false, { agent_host: host, agent_session: CLI_CONVERSATION })).toBe(false);
      expect(antigravityHandsOver({ mcpReq: {} }, false, { agent_host: host, agent_session: CLI_CONVERSATION })).toBe(false);
      expect(replyNextStepText(false, host, false, false)).toBe(INBOX_REPLY_READ_LATER_TEXT);
    }
    // Filed as Antigravity but with no _meta naming that conversation (a forged host): not told either.
    expect(antigravityHandsOver({ mcpReq: {} }, false, { agent_host: "antigravity", agent_session: CLI_CONVERSATION })).toBe(false);
  });
});

describe("how a call names its conversation", () => {
  test("the conversation and its product from _meta; a subagent's call is none", () => {
    expect(antigravityConversationOfCall(meta(CLI_CONVERSATION, "antigravity-cli"))).toEqual({ conversation: CLI_CONVERSATION, product: "cli" });
    expect(antigravityConversationOfCall(meta(CONVERSATION, "antigravity"))).toEqual({ conversation: CONVERSATION, product: "app" });
    expect(antigravityConversationOfCall(meta(CONVERSATION, "antigravity-ide"))).toEqual({ conversation: CONVERSATION, product: "ide" });
    expect(antigravityConversationOfCall(meta(CONVERSATION, "antigravity", CLI_CONVERSATION))).toBeNull();
    expect(antigravityConversationOfCall({ "antigravity.google/conversation_id": "not-a-uuid" })).toBeNull();
    expect(antigravityConversationOfCall({ threadId: CONVERSATION })).toBeNull();
    expect(antigravityProductOfPath("/home/x/.gemini/elsewhere/brain/x")).toBeNull();
  });
  test("only this computer's loopback is taken as a server address", () => {
    expect(antigravityLoopbackAddress("localhost:56548")).toBe("localhost:56548");
    expect(antigravityLoopbackAddress("http://127.0.0.1:57930")).toBe("127.0.0.1:57930");
    expect(antigravityLoopbackAddress("example.com:56548")).toBeNull();
    expect(antigravityLoopbackAddress("localhost:0")).toBeNull();
    expect(antigravityLoopbackAddress("localhost:56548/../x")).toBeNull();
  });
});
