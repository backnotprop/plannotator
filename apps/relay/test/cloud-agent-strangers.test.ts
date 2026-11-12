import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptWithKey, deriveRelayKeys, deriveRelaySignalToken, encryptWithKey } from "@plannotator/core/crypto";
import { decodeInboxAgentPairing, type InboxAgentPairing } from "../../../packages/shared/inbox/agent-pairing";
import { SimAgent } from "../../../scripts/inbox-sim";
import { createInboxWorld, destroyInboxWorld, registry, removeStubbedHtml, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";
import { dumpMailbox, sha256, sleep, startRelay, until, type Json, type Relay } from "./wrangler-relay";

const SECRET_WORDS = "Quokka ledger: the merger closes on the ninth.";

type Paired = {
  name: string;
  session: string;
  pairing: InboxAgentPairing & { relay: { url: string; mailbox_id: string } };
  keys: Awaited<ReturnType<typeof deriveRelayKeys>>;
  signal: string;
};

describe("one paired cloud agent against another, and a removed one, through the relay under wrangler dev", () => {
  let relay: Relay;
  let w: InboxWorld;
  let stubs: string[] = [];
  let env: Record<string, string> = {};
  let base = "";
  let serverSession = "";
  let hook: ReturnType<typeof Bun.serve>;
  let a: Paired;
  let b: Paired;
  let threadA = "";
  let local: SimAgent;
  let messageA = "";

  const win = async (path: string, body?: Json) => {
    const answer = await fetch(`${base}${path}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", Origin: base },
      ...(body ? { body: JSON.stringify({ serverSession, ...body }) } : {}),
    });
    return { status: answer.status, json: (await answer.json()) as Json };
  };

  const pairAgent = async (name: string): Promise<Paired> => {
    const paired = await win("/api/inbox/cloud-agents", { name, preset: "grok-bot", url: `http://127.0.0.1:${hook.port}/hook`, key: `key-${name.replace(/\s/g, "")}` });
    expect(paired.status).toBe(200);
    const pairing = decodeInboxAgentPairing(paired.json.pairing) as Paired["pairing"];
    expect(pairing.relay).toBeDefined();
    return { name, session: paired.json.agent.session, pairing, keys: await deriveRelayKeys(pairing.secret, pairing.device_id), signal: await deriveRelaySignalToken(pairing.secret, pairing.device_id) };
  };

  const atRelay = (owner: Paired, method: string, path: string, body?: unknown, bearer = owner.keys.relaySecret) =>
    fetch(`${owner.pairing.relay.url}/v1/mailboxes/${owner.pairing.relay.mailbox_id}/devices/${owner.pairing.device_id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const seal = async (owner: Paired, plaintext: Json) => encryptWithKey(JSON.stringify(plaintext), owner.keys.upKey);
  const sealed = async (owner: Paired, tool: string, args: Json, id = `cmd_${crypto.randomUUID()}`) => ({ id, ciphertext: await seal(owner, { v: 1, type: "agent_call", id, tool, arguments: args }) });

  const results = async (owner: Paired) => {
    const answer = (await (await atRelay(owner, "GET", "/items?after=0")).json()) as { items: { n: number; ciphertext: string }[] };
    return Promise.all(answer.items.map(async (item): Promise<Json> => ({ n: item.n, ...(JSON.parse(await decryptWithKey(item.ciphertext, owner.keys.key)) as Json) })));
  };

  const call = async (owner: Paired, tool: string, args: Json) => {
    const command = await sealed(owner, tool, args);
    expect((await atRelay(owner, "POST", "/commands", command)).status).toBe(202);
    const found = await until(() => results(owner), (items) => items.some((item) => item.id === command.id), `the result of ${tool}`);
    const item = found.find((entry) => entry.id === command.id)!;
    await atRelay(owner, "POST", "/ack", { item: item.n });
    return (JSON.parse(Buffer.from(item.body_b64, "base64").toString("utf8")) as Json).result as Json;
  };

  const text = (result: Json) => String(result.content?.[0]?.text ?? "");
  const rows = (owner: Paired, table: string): Json[] => ((dumpMailbox(relay, owner.pairing.relay.mailbox_id)[table] as Json[] | undefined) ?? []).filter((row) => (row.device_id ?? row.id) === owner.pairing.device_id);
  const drained = () => until(() => (dumpMailbox(relay, a.pairing.relay.mailbox_id).commands as Json[] | undefined)?.length ?? 0, (n) => n === 0, "the relay to let every command go");
  const inboxLog = () => readFileSync(join(w.dataDir, "inbox", "inbox.log"), "utf8");
  const refusals = (owner: Paired) => inboxLog().split(`agent command ${owner.pairing.device_id} refused`).length - 1;
  const threadBodies = async (id: string) => ((await win(`/api/inbox/threads/${id}`)).json.thread.messages as Json[]).map((m) => m.body as string);

  beforeAll(async () => {
    relay = await startRelay("cloud-agent-strangers", {});
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-relay-strangers-", "cloud-agent-strangers", "cloud-agent-strangers", { phones: false });
    env = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url };
    hook = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ ok: true }) });
    expect(realpathSync(w.root).startsWith(realpathSync(tmpdir()))).toBe(true);
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env, cwd: w.root });
    if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
    base = `http://127.0.0.1:${registry(w).port}`;
    serverSession = ((await (await fetch(`${base}/api/inbox/health`)).json()) as Json).serverSession;
    local = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Pi", host: "pi", cwd: w.project });
    await local.send({ project_path: w.project, subject: "Local plan", body: "A local note." });
    a = await pairAgent("Agent A");
    b = await pairAgent("Agent B");
    await until(() => rows(a, "devices").length + rows(b, "devices").length, (n) => n === 2, "both agents registered");
    await until(async () => ((await (await atRelay(a, "GET", "/items?after=0")).json()) as Json).inbox_online, (online) => online === true, "the Inbox on its socket", 30_000);
    const opened = await call(a, "send_message", { subject: "Quokka", body: SECRET_WORDS });
    threadA = opened.structuredContent.thread_id;
    messageA = opened.structuredContent.message_id ?? threadA;
    expect(threadA).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    hook?.stop(true);
    await local?.close().catch(() => {});
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
    await relay?.stop();
  });

  test("B's relay secret opens nothing of A's: not A's results, not a command posted as A", async () => {
    const pending = await sealed(a, "read_thread", { thread_id: threadA });
    expect((await atRelay(a, "POST", "/commands", pending)).status).toBe(202);
    await until(() => results(a), (items) => items.some((item) => item.id === pending.id), "a result held for A");
    expect((await atRelay(a, "GET", "/items?after=0", undefined, b.keys.relaySecret)).status).toBe(401);
    expect((await atRelay(a, "POST", "/ack", { through: 1_000 }, b.keys.relaySecret)).status).toBe(401);
    expect((await atRelay(a, "POST", "/commands", await sealed(b, "read_thread", {}), b.keys.relaySecret)).status).toBe(401);
    expect(rows(a, "items").length).toBeGreaterThan(0);
    for (const item of await results(a)) await atRelay(a, "POST", "/ack", { item: item.n });
  }, 60_000);

  test("A's sealed envelope filed under B's device is never applied: B's key does not open it", async () => {
    const before = refusals(b);
    const stolen = await sealed(a, "send_message", { reply_to: messageA, body: "Re-filed under B." });
    expect((await atRelay(b, "POST", "/commands", stolen)).status).toBe(202);
    await drained();
    await until(() => refusals(b), (n) => n === before + 1, "B's refusal in the Inbox log");
    expect((await results(b)).some((item) => item.id === stolen.id)).toBe(false);
    expect(await threadBodies(threadA)).not.toContain("Re-filed under B.");
  }, 60_000);

  test("B cannot read, find, answer in or resolve A's thread", async () => {
    expect(text(await call(b, "read_thread", { thread_id: threadA }))).toStartWith("thread_not_found:");
    expect(text(await call(b, "read_thread", { message_id: messageA }))).toStartWith("message_not_found:");
    const listed = await call(b, "read_thread", {});
    expect(JSON.stringify(listed)).not.toContain(threadA);
    expect(JSON.stringify(listed)).not.toContain("Quokka");
    await until(async () => JSON.stringify(await call(a, "search", { query: "quokka merger" })), (own) => own.includes("Quokka"), "A to find its own thread", 30_000);
    const found = await call(b, "search", { query: "quokka merger" });
    expect(JSON.stringify(found)).not.toContain("Quokka");
    expect(JSON.stringify(found)).not.toContain(threadA);
    expect(text(await call(b, "send_message", { reply_to: messageA, body: "B writes in A's thread." }))).toStartWith("message_not_found:");
    expect(text(await call(b, "resolve_message", { message_id: messageA, resolved: true }))).toStartWith("message_not_found:");
    expect(await threadBodies(threadA)).not.toContain("B writes in A's thread.");
    expect(text(await call(a, "read_thread", { thread_id: threadA }))).toContain("merger closes on the ninth");
  }, 90_000);

  test("an envelope of another version or type, under A's own key, is refused and writes nothing", async () => {
    const before = refusals(a);
    const shapes = [
      (id: string) => ({ v: 2, type: "agent_call", id, tool: "send_message", arguments: { reply_to: messageA, body: "Version two." } }),
      (id: string) => ({ v: 1, type: "agent_call_v2", id, tool: "send_message", arguments: { reply_to: messageA, body: "Unknown type." } }),
      (id: string) => ({ v: 1, id, tool: "send_message", arguments: { reply_to: messageA, body: "No type." } }),
    ];
    const ids: string[] = [];
    for (const shape of shapes) {
      const id = `cmd_${crypto.randomUUID()}`;
      ids.push(id);
      expect((await atRelay(a, "POST", "/commands", { id, ciphertext: await seal(a, shape(id)) })).status).toBe(202);
    }
    await drained();
    await until(() => refusals(a), (n) => n === before + shapes.length, "each refusal in the Inbox log");
    await sleep(300);
    expect((await results(a)).some((item) => ids.includes(item.id))).toBe(false);
    const bodies = await threadBodies(threadA);
    for (const words of ["Version two.", "Unknown type.", "No type."]) expect(bodies).not.toContain(words);
  }, 60_000);

  test("a resolve the agent already undid, posted again later, does not archive the thread again", async () => {
    const resolvedAt = async () => (await win(`/api/inbox/threads/${threadA}`)).json.thread.resolved_at ?? null;
    const archive = await sealed(a, "resolve_message", { message_id: messageA, resolved: true });
    expect((await atRelay(a, "POST", "/commands", archive)).status).toBe(202);
    const first = await until(() => results(a), (items) => items.some((item) => item.id === archive.id), "the archive's result");
    await atRelay(a, "POST", "/ack", { item: first.find((item) => item.id === archive.id)!.n });
    await drained();
    expect(await resolvedAt()).not.toBeNull();
    expect((await call(a, "resolve_message", { message_id: messageA, resolved: false })).isError).not.toBe(true);
    expect(await resolvedAt()).toBeNull();
    expect((await atRelay(a, "POST", "/commands", archive)).status).toBe(202);
    await drained();
    await sleep(1_000);
    expect(await resolvedAt()).toBeNull();
  }, 60_000);

  test("a removed agent's envelopes are refused on the Mac even when the relay still holds its device", async () => {
    expect((await win(`/api/inbox/cloud-agents/${a.session}/remove`, {})).json.removed).toBe(true);
    await until(() => rows(a, "devices").length, (n) => n === 0, "A removed at the relay");
    const kept = JSON.parse(readFileSync(join(w.dataDir, "inbox", "relay.json"), "utf8")) as Json;
    const stale = await fetch(`${kept.url}/v1/mailboxes/${kept.mailbox_id}/devices/${a.pairing.device_id}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${kept.secret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ secret_sha256: sha256(a.keys.relaySecret), cursor: 0, kind: "agent", signal_sha256: sha256(a.signal) }),
    });
    expect(stale.status).toBe(200);
    const before = refusals(a);
    const late = await sealed(a, "send_message", { reply_to: messageA, body: "Sent after removal." });
    expect((await atRelay(a, "POST", "/commands", late)).status).toBe(202);
    await drained();
    await until(() => refusals(a), (n) => n === before + 1, "the removed agent's refusal in the Inbox log");
    expect((await results(a)).some((item) => item.id === late.id)).toBe(false);
    expect(await threadBodies(threadA)).not.toContain("Sent after removal.");
  }, 60_000);
});
