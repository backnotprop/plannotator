/**
 * Sealed means sealed (adr/implementation/inbox-mobile.md, section 4, "What
 * the relay can and cannot see"): one sentinel phrase is written into every
 * place an agent's or a person's words can be (a subject, a question, its
 * context and a choice, a failed turn's note, a permission prompt, a new
 * thread, a reply sent up from the phone, the door's answer to it), then
 * every relay-side record (the mailbox's SQLite files, as stored), every log
 * line (the relay's under `wrangler dev`, and the Inbox's relay log) and
 * every push Apple was sent (headers and bodies, the `live` one too) is
 * searched for it, for every message's id, the question's key and the agent's
 * session id. None is found. As a control,
 * the phone's key opens the same pushes and items and finds the phrase.
 *
 * The relay runs under `wrangler dev` with Apple played locally
 * (stand-in-apple.ts); the Inbox side is the real relay client
 * (packages/server/inbox-relay.ts) in this process over a store in a temp
 * folder: no Inbox server is started. Nothing reaches Apple.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptWithKey, deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { InboxDevices } from "../../../packages/shared/inbox/devices";
import { InboxStore } from "../../../packages/shared/inbox/store";
import type { InboxLine } from "@plannotator/core/inbox-types";
import { createInboxRelay, readRelayFile } from "../../../packages/server/inbox-relay";
import { standInApple } from "./stand-in-apple";
import { dumpMailbox, holds, startRelay, storageBytes, until, type Json, type Relay } from "./wrangler-relay";

const SENTINEL = "Quokka-Vellum-4417";
const PHONE = "dev_01K7SEALEDPHONE00000000000";
const AGENT = { kind: "agent" as const, host: "claude-code", session: "ses_sealed", name: null };

let relay: Relay;
let apple: Awaited<ReturnType<typeof standInApple>>;
let dataDir = "";
let client: ReturnType<typeof createInboxRelay> | null = null;

beforeAll(async () => {
  apple = await standInApple();
  relay = await startRelay("sealed", apple.vars);
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-relay-sealed-"));
}, 90_000);

afterAll(async () => {
  client?.stop();
  await relay?.stop();
  apple?.close();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

test("no sentinel, message id, question key or session id in any relay record, log line or push Apple was sent; the phone's key finds the sentinel", async () => {
  const store = InboxStore.open(dataDir);
  const devices = InboxDevices.open(dataDir);
  const secret = randomBytes(32).toString("base64url");
  const device = devices.add({ id: PHONE, name: "Phone", platform: "ios", token: "tok_sealed", secret, at: new Date().toISOString() });
  const inboxLog: string[] = [];
  client = createInboxRelay({
    dataDir,
    store,
    devices,
    // The event stream's `record` payload, as inbox.ts writes it: the record in full.
    payload: (line: InboxLine) => ({ seq: line.seq, kind: line.kind, id: line.id, [line.kind]: line.record }),
    // The door's answer echoes the words it was sent, as a reply's answer carries them back.
    apply: async (_deviceId, command) => Response.json({ ok: true, echo: command.body }),
    url: relay.url,
    log: (line) => inboxLog.push(line),
  });
  expect(await client.paired(device)).not.toBeNull();
  client.start();
  await until(() => client!.relayVersion(), (version) => version === "1.1", "hello from relay 1.1");
  const mailbox = readRelayFile(dataDir)!.mailbox_id;
  const keys = await deriveRelayKeys(secret, PHONE);
  const at = (method: string, path: string, body?: unknown) =>
    fetch(`${relay.url}/v1/mailboxes/${mailbox}${path}`, { method, headers: { Authorization: `Bearer ${keys.relaySecret}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  expect((await at("PUT", `/devices/${PHONE}/apns`, { token: "a".repeat(64), environment: "sandbox", topic: "ai.plannotator.app" })).status).toBe(204);
  expect((await at("PUT", `/devices/${PHONE}/liveactivity`, { token: "e".repeat(64) })).status).toBe(204);
  // The topic frame reaches the Inbox (the new app: it is sent the new thread and the failed turn too).
  await Bun.sleep(300);
  const notices: Json[] = [];
  const socket = new WebSocket(`${relay.url.replace(/^http/, "ws")}/v1/mailboxes/${mailbox}/devices/${PHONE}/socket`, { headers: { Authorization: `Bearer ${keys.relaySecret}` } } as unknown as string[]);
  socket.onmessage = (event) => notices.push(JSON.parse(String(event.data)));
  await new Promise((open) => (socket.onopen = open));

  const project = store.ensureProject({ name: `ledger-${SENTINEL}`, root: `/work/${SENTINEL}` });
  const asked = store.sendMessage({
    project_id: project.id,
    author: AGENT,
    subject: `Ship ${SENTINEL} today?`,
    body: [":::question", `Ship ${SENTINEL} today?`, "", `Stopped: ${SENTINEL} waits on this`, "", `- [ ] Yes, ship ${SENTINEL}`, "- [ ] No", ":::"].join("\n"),
  }).message;
  const failed = store.sendMessage({ project_id: project.id, author: AGENT, body: `The turn failed on ${SENTINEL}.`, reply_to: asked.id, turn_error: true }).message;
  const prompt = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "perm:ses_sealed" }, permission: true, reply_to: asked.id, body: [":::question", `Claude Code wants to run \`rm ${SENTINEL}\``, "", "- [ ] Allow once", "- [ ] Deny", ":::"].join("\n") }).message;
  const fresh = store.sendMessage({ project_id: project.id, author: AGENT, subject: `Migrated ${SENTINEL}`, body: `Done with ${SENTINEL}.` }).message;
  await until(() => apple.pushes.length, (n) => n >= 4, "four pushes at Apple");

  // The phone sends a reply up, its words the sentinel, with a not_after; the Inbox's answer echoes them back down.
  const command = { v: 1, id: "key-sealed-1", method: "POST", path: `/api/inbox/device/messages/${asked.id}/reply`, body: { idempotency_key: "key-sealed-1", words: `Yes: ${SENTINEL}` }, not_after: new Date(Date.now() + 60_000).toISOString() };
  expect((await at("POST", `/devices/${PHONE}/commands`, { id: command.id, ciphertext: await encryptWithKey(JSON.stringify(command), keys.upKey) })).status).toBe(202);
  const opened = async () => {
    const items = (((await (await at("GET", `/devices/${PHONE}/items?after=0`)).json()) as Json).items as Json[]) ?? [];
    return Promise.all(items.map(async (item) => JSON.parse(await decryptWithKey(item.ciphertext, keys.key)) as Json));
  };
  const plaintexts = await until(opened, (all) => all.some((p) => p.type === "result" && p.id === command.id), "the reply's result");
  expect(await client.live(PHONE, { working: 1, stopped_on_you: 1, ended: false })).toBe("sent");
  await until(() => notices.length, (n) => n >= plaintexts.length, "a notice per item");

  // Control: the phone's key opens what the relay held and what Apple got, and finds the sentinel there.
  expect(plaintexts.some((p) => JSON.stringify(p).includes(SENTINEL))).toBe(true);
  const result = plaintexts.find((p) => p.type === "result" && p.id === command.id)!;
  expect(Buffer.from(result.body_b64, "base64").toString()).toContain(SENTINEL);
  const sealedPushes = apple.pushes.filter((push) => push.headers["apns-push-type"] === "alert");
  const summaries = await Promise.all(sealedPushes.map(async (push) => JSON.parse(await decryptWithKey(JSON.parse(push.body).e, keys.key)) as Json));
  expect(summaries.map((s) => s.kind).sort()).toEqual(["new_thread", "permission", "question", "turn_error"]);
  expect(summaries.every((s) => JSON.stringify(s).includes(SENTINEL))).toBe(true);
  expect(notices.every((notice) => Object.keys(notice).join() === "n" && Number.isInteger(notice.n))).toBe(true);

  // Every relay-side record, log line and push payload: no words, no message id, no question key, no session id.
  // The Inbox's own relay log, on the computer, names message and device ids by design (ids and codes only), so only
  // the words and the session are looked for there.
  const words = [SENTINEL, SENTINEL.toLowerCase(), "Vellum"];
  const key = store.questionsOf(asked.id)[0]!.key;
  // The thread's id is its first message's.
  const ids = [...new Set([asked.thread_id, asked.id, failed.id, prompt.id, fresh.id, key, "ses_sealed"])];
  expect(ids.length).toBe(6);
  const places: [string, Buffer, string[]][] = [
    ["the mailbox's SQLite files", storageBytes(relay), [...words, ...ids]],
    ["the mailbox's rows", Buffer.from(JSON.stringify(dumpMailbox(relay, mailbox))), [...words, ...ids]],
    ["the relay's log", Buffer.from(relay.log()), [...words, ...ids]],
    ["what Apple was sent", Buffer.from(JSON.stringify(apple.pushes)), [...words, ...ids]],
    ["the items the relay answers", Buffer.from(await (await at("GET", `/devices/${PHONE}/items?after=0`)).text()), [...words, ...ids]],
    ["the Inbox's relay log", Buffer.from(inboxLog.join("\n")), [...words, "ses_sealed"]],
  ];
  for (const [place, bytes, texts] of places) {
    expect(bytes.length).toBeGreaterThan(0);
    for (const text of texts) {
      if (holds(bytes, text)) throw new Error(`${place} holds "${text}"`);
    }
  }
  socket.close();
}, 120_000);
