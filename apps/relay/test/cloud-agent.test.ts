import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptWithKey, deriveRelayKeys, deriveRelaySignalToken, encryptWithKey } from "@plannotator/core/crypto";
import { INBOX_CLOUD_SETUP_PAGE } from "@plannotator/core/inbox-cloud";
import { decodeInboxAgentPairing, type InboxAgentPairing } from "../../../packages/shared/inbox/agent-pairing";
import { SimAgent } from "../../../scripts/inbox-sim";
import { NO_BROWSER } from "../../../tests/helpers/no-browser";
import { createInboxWorld, destroyInboxWorld, personSends, registry, removeStubbedHtml, stopInbox, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";
import { SIGNAL_LIMIT } from "../src/signal";
import { dumpMailbox, holds, readMailbox, sha256, sleep, startRelay, storageBytes, until, type Json, type Relay } from "./wrangler-relay";

const KEY = "xai-WEBHOOKKEY0123456789";
const ASK = "Nightly run: the retry worker fails against the test clock. Should I fix it?";
const REPLY = "Yes, fix it, and tell me which tests you ran.";
const PRIVATE = "Private plan: the zebra launch.";

type Thread = { messages: { id: string; body: string; author: { kind: string; name?: string; session?: string; host?: string } }[] };

describe("a paired cloud agent reaches the Inbox through the relay, under wrangler dev", () => {
  let relay: Relay;
  let w: InboxWorld;
  let stubs: string[] = [];
  let local: SimAgent;
  let env: Record<string, string> = {};
  let base = "";
  let serverSession = "";
  let pairingString = "";
  let pairing: InboxAgentPairing & { relay: { url: string; mailbox_id: string } };
  let keys: Awaited<ReturnType<typeof deriveRelayKeys>>;
  let signalToken = "";
  let session = "";
  let agentThread = "";
  let agentMessage = "";
  let localThread: { thread_id: string; message_id: string };
  const wakes: Json[] = [];
  const routines: Promise<number>[] = [];
  const outputs: string[] = [];
  let routineRoot = "";
  let hook: ReturnType<typeof Bun.serve>;
  let pairAnswer: Json = {};

  const startTheInbox = () => {
    expect(realpathSync(w.root).startsWith(realpathSync(tmpdir()))).toBe(true);
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env, cwd: w.root });
    if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
    base = `http://127.0.0.1:${registry(w).port}`;
  };

  const win = async (path: string, body?: Json) => {
    const answer = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Origin: base },
      ...(body ? { body: JSON.stringify({ serverSession, ...body }) } : {}),
    });
    const text = await answer.text();
    outputs.push(text);
    return { status: answer.status, json: JSON.parse(text) as Json };
  };

  const thread = async (id: string) => (await win(`/api/inbox/threads/${id}`)).json.thread as Thread;

  const routineEnv = (extra: Record<string, string> = {}) => ({
    PATH: w.path,
    HOME: join(routineRoot, "home"),
    PLANNOTATOR_DATA_DIR: join(routineRoot, "home", ".plannotator"),
    PLANNOTATOR_BROWSER: NO_BROWSER,
    TMPDIR: tmpdir(),
    PLANNOTATOR_PAIRING: pairingString,
    ...extra,
  });

  const cli = (action: string, args?: Json, extra: Record<string, string> = {}) => {
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "call", action, ...(args ? [JSON.stringify(args)] : [])], { env: routineEnv(extra), cwd: routineRoot });
    const out = { code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() };
    outputs.push(out.stdout, out.stderr);
    return out;
  };

  const atRelay = (method: string, path: string, body?: unknown, bearer = keys.relaySecret) =>
    fetch(`${pairing.relay.url}/v1/mailboxes/${pairing.relay.mailbox_id}/devices/${pairing.device_id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const sealed = async (tool: string, args: Json, id = `cmd_${crypto.randomUUID()}`) => ({
    id,
    ciphertext: await encryptWithKey(JSON.stringify({ v: 1, type: "agent_call", id, tool, arguments: args }), keys.upKey),
  });

  const post = async (command: { id: string; ciphertext: string }) => {
    const answer = await atRelay("POST", "/commands", command);
    return { status: answer.status, json: (await answer.json()) as Json };
  };

  const results = async () => {
    const answer = (await (await atRelay("GET", "/items?after=0")).json()) as { items: { n: number; ciphertext: string }[] };
    return Promise.all(answer.items.map(async (item): Promise<Json> => ({ n: item.n, ...(JSON.parse(await decryptWithKey(item.ciphertext, keys.key)) as Json) })));
  };

  const resultOf = async (id: string) => {
    const found = await until(results, (items) => items.some((item) => item.id === id), `the result of ${id}`);
    const item = found.find((entry) => entry.id === id)!;
    await atRelay("POST", "/ack", { item: item.n });
    return JSON.parse(Buffer.from(item.body_b64, "base64").toString("utf8")) as Json;
  };

  const rows = (table: string): Json[] => ((dumpMailbox(relay, pairing.relay.mailbox_id)[table] as Json[] | undefined) ?? []).filter((row) => (row.device_id ?? row.id) === pairing.device_id);
  const signal = (token = signalToken) => fetch(`${pairing.relay.url}/v1/mailboxes/${pairing.relay.mailbox_id}/signals/${token}`);
  const inboxLog = () => readFileSync(join(w.dataDir, "inbox", "inbox.log"), "utf8");
  const agentMessages = async (id: string) => (await thread(id)).messages.filter((m) => m.author.kind === "agent" && m.author.session === session);

  beforeAll(async () => {
    relay = await startRelay("cloud-agent", {});
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-relay-agent-", "cloud-agent", "cloud-agent", { phones: false });
    env = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url };
    routineRoot = join(w.root, "routine");
    mkdirSync(join(routineRoot, "home"), { recursive: true });
    hook = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (req) => {
        const payload = (await req.json()) as Json;
        wakes.push({ authorization: req.headers.get("authorization"), payload });
        const file = join(routineRoot, `wake-${wakes.length}.json`);
        writeFileSync(file, JSON.stringify(payload));
        const child = Bun.spawn([process.execPath, join(import.meta.dir, "stand-in-routine.ts"), file, join(routineRoot, "transcript.jsonl")], { env: routineEnv(), cwd: routineRoot, stdout: "ignore", stderr: "ignore" });
        routines.push(child.exited);
        return Response.json({ ok: true });
      },
    });
    startTheInbox();
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
    local = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Pi", host: "pi", cwd: w.project });
    localThread = (await local.send({ project_path: w.project, subject: "Launch plan", body: PRIVATE })) as { thread_id: string; message_id: string };
    const paired = await win("/api/inbox/cloud-agents", { name: "Nightly fixer", preset: "grok-bot", url: `http://127.0.0.1:${hook.port}/hook`, key: KEY });
    expect(paired.status).toBe(200);
    pairAnswer = paired.json;
    pairingString = paired.json.pairing;
    session = paired.json.agent.session;
    pairing = decodeInboxAgentPairing(pairingString) as typeof pairing;
    keys = await deriveRelayKeys(pairing.secret, pairing.device_id);
    signalToken = await deriveRelaySignalToken(pairing.secret, pairing.device_id);
    outputs.length = 0;
  }, 120_000);

  afterAll(async () => {
    hook?.stop(true);
    await local?.close().catch(() => {});
    await Promise.all(routines).catch(() => {});
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
    await relay?.stop();
  });

  test("pairing carries the relay; the device is registered as an agent with no down path, and a v1 string still names the same device", async () => {
    expect(pairingString.startsWith("plannotator-pairing-2.")).toBe(true);
    const kept = JSON.parse(readFileSync(join(w.dataDir, "inbox", "relay.json"), "utf8")) as Json;
    expect(pairing.relay).toEqual({ url: relay.url, mailbox_id: kept.mailbox_id });
    const device = await until(() => rows("devices")[0], (row) => row !== undefined, "the agent registered");
    expect(device).toMatchObject({ id: pairing.device_id, secret_sha256: sha256(keys.relaySecret), carriage: 0, agent: 1, signal_sha256: sha256(signalToken), apns_token: null, fcm_token: null });
    expect((await atRelay("PUT", "/carriage", { on: true, cursor: 0 })).status).toBe(403);
    expect((await atRelay("PUT", "/apns", { token: "a".repeat(64), environment: "sandbox" })).status).toBe(403);
    const push = await fetch(`${relay.url}/v1/mailboxes/${kept.mailbox_id}/push`, {
      method: "POST",
      headers: { Authorization: `Bearer ${kept.secret}` },
      body: JSON.stringify({ device_id: pairing.device_id, collapse_id: "x", ciphertext: "AAAA" }),
    });
    expect(push.status).toBe(403);
  });

  const linkOf = async (agentSession: string) => ((await win("/api/inbox/cloud-agents")).json.agents as Json[]).find((agent) => agent.session === agentSession)?.link as Json;
  const pairingsIn = (text: string) => text.match(/plannotator-pairing-\d\.[A-Za-z0-9_-]+/g) ?? [];

  test("Settings' message carries the v2 pairing string exactly once and never the webhook key; the agent shows waiting until its first whoami through the relay, then connected", async () => {
    expect(pairAnswer.setup.kind).toBe("message");
    const message = pairAnswer.setup.message as string;
    expect(message).toContain(INBOX_CLOUD_SETUP_PAGE);
    expect(pairingsIn(message)).toEqual([pairingString]);
    expect(decodeInboxAgentPairing(pairingsIn(message)[0])?.relay).toEqual(pairing.relay);
    expect(JSON.stringify(pairAnswer)).not.toContain(KEY);
    expect(pairAnswer.agent.wake).toBe(true);

    expect(await linkOf(session)).toEqual({ state: "waiting", last_seen_at: null });
    expect(cli("whoami").code).toBe(0);
    const link = await linkOf(session);
    expect(link.state).toBe("connected");
    expect(Date.parse(link.last_seen_at)).toBeGreaterThan(Date.parse(pairAnswer.agent.created_at) - 1);
  }, 30_000);

  test("end to end: the person replies in the agent's thread, the webhook wakes a stand-in routine holding only the pairing string, and its answer lands in the thread under the agent's name", async () => {
    const whoami = cli("whoami");
    expect(whoami.code).toBe(0);
    const self = JSON.parse(whoami.stdout) as Json;
    expect(self).toMatchObject({ name: "Nightly fixer", signal_url: `${relay.url}/v1/mailboxes/${pairing.relay.mailbox_id}/signals/${signalToken}` });

    const opened = cli("send_message", { subject: "Retry worker", body: ASK });
    expect(opened.code).toBe(0);
    const first = JSON.parse(opened.stdout) as Json;
    agentThread = first.thread_id;
    agentMessage = first.message_id ?? first.thread_id;
    expect(wakes.length).toBe(0);

    await personSends(w, agentMessage, REPLY);
    await until(() => wakes.length, (n) => n === 1, "the webhook wake");
    expect(wakes[0]!.authorization).toBe(`Bearer ${KEY}`);
    expect(wakes[0]!.payload.thread.id).toBe(agentThread);
    expect(await routines[0]).toBe(0);

    const answers = await until(() => agentMessages(agentThread), (list) => list.length === 2, "the routine's answer", 30_000);
    expect(answers[1]!.body).toBe("I read your reply in the thread. Fixed: the retry worker now waits for the test clock. All 14 retry tests pass.");
    expect(answers[1]!.author).toMatchObject({ kind: "agent", name: "Nightly fixer", session, host: "cloud-grok" });
    const transcript = readFileSync(join(routineRoot, "transcript.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Json);
    expect(transcript.map((step) => [step.action, step.code])).toEqual([
      ["whoami", 0],
      ["read_thread", 0],
      ["send_message", 0],
    ]);
    expect(rows("commands")).toEqual([]);
    expect(rows("items")).toEqual([]);

    const bytes = storageBytes(relay);
    for (const plain of [ASK, REPLY, "Retry worker", "retry worker now waits", agentThread, agentMessage, PRIVATE, session, "Nightly fixer"]) {
      expect(holds(bytes, plain)).toBe(false);
      expect(relay.log()).not.toContain(plain);
    }
  }, 90_000);

  test("the down path is off: activity in other threads queues nothing for the agent at the relay, and moves its signal not at all", async () => {
    const before = ((await (await signal()).json()) as Json).signal;
    const sent = await local.send({ project_path: w.project, subject: "Second plan", body: "Another private note." });
    await personSends(w, localThread.message_id, "Ship the zebra launch Friday.");
    await personSends(w, sent.message_id ?? sent.thread_id, "Not yet.");
    await sleep(1500);
    expect(rows("items")).toEqual([]);
    expect(holds(storageBytes(relay), "zebra")).toBe(false);
    expect(await (await signal()).json()).toEqual({ signal: before });

    const kept = JSON.parse(readFileSync(join(w.dataDir, "inbox", "relay.json"), "utf8")) as Json;
    const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/mailboxes/${kept.mailbox_id}/socket`, { headers: { Authorization: `Bearer ${kept.secret}` } } as unknown as string[]);
    await new Promise((open) => (socket.onopen = open));
    socket.send(JSON.stringify({ type: "item", device_id: pairing.device_id, cursor: 7, ciphertext: "AAAArecord" }));
    socket.send(JSON.stringify({ type: "applied", device_id: "dev_none", id: "flush" }));
    await sleep(500);
    socket.close();
    expect(rows("items")).toEqual([]);
    await until(async () => ((await (await atRelay("GET", "/items?after=0")).json()) as Json).inbox_online, (online) => online === true, "the Inbox back on its socket", 30_000);
  }, 30_000);

  test("the signal: one opaque value, which changes when the person writes in the agent's thread; a wrong address is 404 and polling past the limit is 429", async () => {
    const answer = await signal();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const before = (await answer.json()) as Json;
    expect(Object.keys(before)).toEqual(["signal"]);
    expect(before.signal).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await personSends(w, agentMessage, "Also check the refund path.");
    const after = await until(async () => ((await (await signal()).json()) as Json).signal, (value) => value !== before.signal, "the signal to change");
    expect(after).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect((await signal("A".repeat(43))).status).toBe(404);
    expect((await fetch(`${pairing.relay.url}/v1/mailboxes/${pairing.relay.mailbox_id}/signals/${pairing.device_id}`)).status).toBe(404);
    let last = 200;
    for (let i = 0; i < SIGNAL_LIMIT + 1 && last === 200; i++) last = (await signal()).status;
    expect(last).toBe(429);
  }, 30_000);

  test("security through the relay: out-of-scope threads and non-agent routes are refused, a tampered or re-filed envelope is never applied, a replay posts once", async () => {
    const drained = () => until(() => rows("commands").length, (n) => n === 0, "the relay to let the commands go");
    const bodies = async () => (await agentMessages(agentThread)).map((m) => m.body);

    const scoped = await sealed("read_thread", { thread_id: localThread.thread_id });
    expect((await post(scoped)).status).toBe(202);
    expect((await resultOf(scoped.id)).result.content[0].text).toStartWith("thread_not_found:");

    const snooze = await sealed("snooze_thread", { thread_id: agentThread });
    await post(snooze);
    expect((await resultOf(snooze.id)).result.content[0].text).toStartWith("tool_not_allowed:");

    const windowId = `cmd_${crypto.randomUUID()}`;
    const windowRoute = {
      id: windowId,
      ciphertext: await encryptWithKey(JSON.stringify({ v: 1, id: windowId, method: "POST", path: `/api/inbox/device/messages/${agentMessage}/reply`, body: { words: "Approved, as the person.", idempotency_key: "w1" } }), keys.upKey),
    };
    expect((await post(windowRoute)).status).toBe(202);

    const tamperedCommand = await sealed("send_message", { reply_to: agentMessage, body: "Tampered?" });
    const at = 30;
    const flipped = tamperedCommand.ciphertext[at] === "A" ? "B" : "A";
    expect((await post({ id: tamperedCommand.id, ciphertext: `${tamperedCommand.ciphertext.slice(0, at)}${flipped}${tamperedCommand.ciphertext.slice(at + 1)}` })).status).toBe(202);

    const refiled = await sealed("send_message", { reply_to: agentMessage, body: "Re-filed?" });
    expect((await post({ id: `cmd_${crypto.randomUUID()}`, ciphertext: refiled.ciphertext })).status).toBe(202);

    await drained();
    await sleep(500);
    const ids = new Set((await results()).map((item) => item.id));
    expect(ids.has(windowId)).toBe(false);
    expect(ids.has(tamperedCommand.id)).toBe(false);
    expect((await thread(agentThread)).messages.some((m) => m.body.includes("Approved, as the person."))).toBe(false);
    expect(await bodies()).not.toContain("Tampered?");
    expect(await bodies()).not.toContain("Re-filed?");
    expect(inboxLog()).toContain(`agent command ${pairing.device_id} refused`);

    const once = await sealed("send_message", { reply_to: agentMessage, body: "Posted once." });
    await post(once);
    const first = await resultOf(once.id);
    await drained();
    expect((await post(once)).json.queued).toBe(true);
    const again = await resultOf(once.id);
    expect(again.result.structuredContent.message_id).toBe(first.result.structuredContent.message_id);
    expect((await bodies()).filter((body) => body === "Posted once.")).toHaveLength(1);
  }, 60_000);

  test("asleep: a read says so and leaves nothing at the relay; a send_message waits there sealed and is posted once when the computer is back", async () => {
    await stopInbox(w);
    await until(async () => ((await (await atRelay("GET", "/items?after=0")).json()) as Json).inbox_online, (online) => online === false, "the relay to see the Inbox gone");
    const read = cli("read_thread", { thread_id: agentThread });
    expect(read.code).toBe(1);
    expect(read.stderr).toBe("computer_asleep: Your computer is asleep or offline; nothing was sent. Try again later.\n");
    expect(rows("commands")).toEqual([]);

    const queued = cli("send_message", { reply_to: agentMessage, body: "Sent while you slept." });
    expect(queued.code).toBe(0);
    expect(JSON.parse(queued.stdout)).toMatchObject({ queued: true });
    expect(rows("commands")).toHaveLength(1);
    expect(holds(storageBytes(relay), "Sent while you slept.")).toBe(false);

    startTheInbox();
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
    await until(async () => (await agentMessages(agentThread)).filter((m) => m.body === "Sent while you slept.").length, (n) => n === 1, "the held message posted", 30_000);
    await until(() => rows("commands").length, (n) => n === 0, "the held command let go");
    await sleep(1000);
    expect((await agentMessages(agentThread)).filter((m) => m.body === "Sent while you slept.")).toHaveLength(1);
  }, 90_000);

  test("Remove: the device leaves the relay with all it held, its signal stops answering, and the next call is refused", async () => {
    const pending = await sealed("read_thread", { thread_id: agentThread });
    await post(pending);
    await until(results, (items) => items.some((item) => item.id === pending.id), "a result held for the agent");
    expect(rows("items").length).toBeGreaterThan(0);

    expect((await win(`/api/inbox/cloud-agents/${session}/remove`, {})).json.removed).toBe(true);
    await until(() => rows("devices").length, (n) => n === 0, "the device removed at the relay");
    expect(rows("items")).toEqual([]);
    expect(rows("commands")).toEqual([]);
    expect((await signal()).status).toBe(404);
    const after = cli("read_thread", { thread_id: agentThread });
    expect(after.code).toBe(1);
    expect(after.stderr).toStartWith("pairing_removed: ");
    expect((await atRelay("POST", "/commands", await sealed("read_thread", {}))).status).toBe(404);
  }, 30_000);

  test("secrets never reach the relay's storage or log, the Inbox's log, or any answer but the one pair answer; the signal address shows only in the platform's own request log", async () => {
    const answers = outputs.join("\n");
    const everywhere = [storageBytes(relay).toString("latin1"), relay.log(), inboxLog()];
    for (const secret of [pairingString, pairing.token, pairing.secret, keys.relaySecret, keys.upKey, keys.key, keys.collapseKey, KEY]) {
      for (const place of [...everywhere, answers]) expect(place.includes(secret)).toBe(false);
    }
    const relayOwnLines = relay.log().split("\n").filter((line) => !line.startsWith("[wrangler:info] GET /v1/mailboxes/"));
    for (const place of [storageBytes(relay).toString("latin1"), relayOwnLines.join("\n"), inboxLog()]) expect(place.includes(signalToken)).toBe(false);
  });

  test("a polling agent pairs with no webhook, connects and sees the signal move with no wake; a new pairing revokes the old string at once", async () => {
    const before = wakes.length;
    const paired = await win("/api/inbox/cloud-agents", { name: "Poller", preset: "other" });
    expect(paired.status).toBe(200);
    expect(paired.json.agent.wake).toBe(false);
    const first = pairingsIn(paired.json.setup.message as string);
    expect(first).toHaveLength(1);
    const firstPairing = decodeInboxAgentPairing(first[0])!;
    expect(firstPairing.relay).toEqual(pairing.relay);
    const poller = paired.json.agent.session as string;

    expect(cli("whoami", undefined, { PLANNOTATOR_PAIRING: first[0]! }).code).toBe(0);
    expect((await linkOf(poller)).state).toBe("connected");
    const pollToken = await deriveRelaySignalToken(firstPairing.secret, firstPairing.device_id);
    const pollSignal = () => fetch(`${firstPairing.relay!.url}/v1/mailboxes/${firstPairing.relay!.mailbox_id}/signals/${pollToken}`).then((r) => r.json() as Promise<Json>);
    const quiet = (await pollSignal()).signal;
    const sent = await win("/api/inbox/messages", { to: { session: poller }, body: "Poll me: anything new on the export?", idempotency_key: "poll-1" });
    expect(sent.status).toBe(200);
    await until(async () => (await pollSignal()).signal, (value) => value !== quiet, "the poller's signal to move");
    const listed = cli("read_thread", {}, { PLANNOTATOR_PAIRING: first[0]! });
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(sent.json.thread_id);
    await sleep(500);
    expect(wakes.length).toBe(before);
    expect((await win(`/api/inbox/cloud-agents/${poller}/test`, {})).json.test.started).toBe(false);

    const renewed = await win(`/api/inbox/cloud-agents/${poller}/pairing`, {});
    expect(renewed.status).toBe(200);
    const second = pairingsIn(renewed.json.setup.message as string);
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect(renewed.json.agent.link.state).toBe("waiting");
    const old = cli("whoami", undefined, { PLANNOTATOR_PAIRING: first[0]! });
    expect(old.code).toBe(1);
    expect(old.stderr).toStartWith("pairing_removed: ");
    expect(cli("whoami", undefined, { PLANNOTATOR_PAIRING: second[0]! }).code).toBe(0);
    expect((await linkOf(poller)).state).toBe("connected");
    expect(cli("read_thread", { thread_id: sent.json.thread_id }, { PLANNOTATOR_PAIRING: second[0]! }).code).toBe(0);

    const claude = await win("/api/inbox/cloud-agents", { name: "Routine", preset: "claude-routine" });
    expect(claude.json.setup.kind).toBe("claude-routine");
    expect(pairingsIn(claude.json.setup.variable)).toHaveLength(1);
    expect(claude.json.setup.variable).toStartWith("PLANNOTATOR_PAIRING=plannotator-pairing-2.");
    expect((claude.json.setup.domains as string).split("\n")).toContain(new URL(relay.url).hostname);
    expect(pairingsIn(claude.json.setup.instructions)).toEqual([]);
  }, 60_000);
});
