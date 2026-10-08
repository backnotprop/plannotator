/**
 * The relay, proved in action (mobile plan step R1; adr/implementation/inbox-mobile.md,
 * section 4). Nothing is mocked but Apple:
 *
 *  - the relay runs under `wrangler dev` (local workerd, its Durable Object
 *    on SQLite, persisted under apps/relay/.wrangler/proof-*), on free ports;
 *  - the Inbox is `plannotator inbox --background` (the compiled binary when
 *    PLANNOTATOR_INBOX_TEST_BINARY names one, as the relay workflow runs it;
 *    the CLI from source otherwise) under a temp HOME and data dir, pointed
 *    at the relay by PLANNOTATOR_RELAY_URL; agents write through
 *    `plannotator inbox mcp` and the MCP SDK's stdio client;
 *  - Apple is a local HTTP/2 server (cleartext, prior knowledge) that checks
 *    the provider token's ES256 signature against a key made for this run and
 *    answers 200, or 410 for a token that starts with 4100; the relay reaches
 *    it through the same HTTP/2 client it uses for Apple (APNS_ORIGIN);
 *  - the phone is this script: it redeems the QR secret at the device door,
 *    derives its relay secret and key from the pairing secret, and calls the
 *    relay with them, as the app will.
 *
 * Then a second relay with no APNs key (pushes answer `no_apns_key`), and a
 * third that reaches Apple's real sandbox over TLS with a throwaway key: the
 * transport works when Apple answers 403 InvalidProviderToken. The real
 * sandbox send to the test iPhone waits on the owner's APNs key and the device.
 *
 * Runs from this folder (`bun test`, its own bunfig): the root bunfig skips
 * apps/relay because it needs wrangler. Never deploys anything.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import http2 from "node:http2";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHmac } from "node:crypto";
import { decryptWithKey, deriveRelayKeys } from "@plannotator/core/crypto";
import { SimAgent } from "../../../scripts/inbox-sim";
import { createInboxWorld, destroyInboxWorld, registry, stopInbox, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";
import { GUIDE_BRIEF_EXAMPLE } from "../../../packages/server/inbox-guides";

type Json = Record<string, any>;

const relayDir = resolve(import.meta.dir, "..");
const wrangler = join(relayDir, "node_modules", ".bin", "wrangler");
const TOKEN_OK = "a".repeat(64);
const TOKEN_GONE = `4100${"0".repeat(60)}`;
const SUBJECT = "Run the retry tests against the Stripe test clock?";

const sha256 = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex");
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean, what: string, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (ok(value)) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(value)}`);
    await sleep(100);
  }
}

function freePort(): number {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

// ── Apple, played locally ──

interface Pushed {
  headers: Record<string, string>;
  body: string;
  jwtValid: boolean;
}

async function throwawayKey() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return { pkcs8, publicKey: pair.publicKey };
}

async function verifyJwt(authorization: string | undefined, publicKey: CryptoKey): Promise<boolean> {
  const jwt = /^bearer (.+)$/.exec(authorization ?? "")?.[1];
  if (!jwt) return false;
  const [header, claims, signature] = jwt.split(".");
  const parsed = JSON.parse(Buffer.from(header!, "base64url").toString());
  const payload = JSON.parse(Buffer.from(claims!, "base64url").toString());
  if (parsed.alg !== "ES256" || parsed.kid !== "KEY0000000" || payload.iss !== "TEAM000000") return false;
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${claims}`));
}

function fakeApns(publicKey: CryptoKey): Promise<{ port: number; pushes: Pushed[]; close: () => void }> {
  const pushes: Pushed[] = [];
  const server = http2.createServer();
  server.on("stream", (stream, headers) => {
    let body = "";
    stream.on("data", (chunk) => (body += chunk));
    stream.on("end", async () => {
      const flat = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, String(v)]));
      const jwtValid = await verifyJwt(flat.authorization, publicKey);
      pushes.push({ headers: flat, body, jwtValid });
      if (!jwtValid) {
        stream.respond({ ":status": 403 });
        stream.end(JSON.stringify({ reason: "InvalidProviderToken" }));
      } else if (flat[":path"]!.startsWith("/3/device/4100")) {
        stream.respond({ ":status": 410 });
        stream.end(JSON.stringify({ reason: "Unregistered", timestamp: Date.now() }));
      } else {
        stream.respond({ ":status": 200, "apns-id": crypto.randomUUID() });
        stream.end();
      }
    });
  });
  return new Promise((ready) => server.listen(0, "127.0.0.1", () => ready({ port: (server.address() as { port: number }).port, pushes, close: () => server.close() })));
}

// ── The relay under wrangler dev ──

interface Relay {
  url: string;
  persist: string;
  log: () => string;
  stop: () => void;
}

async function startRelay(name: string, vars: Record<string, string>): Promise<Relay> {
  const port = freePort();
  const persist = join(relayDir, ".wrangler", `proof-${name}`);
  rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  // The throwaway key lives in this env file for the run only (.wrangler/ is not committed), never on a command line.
  const envFile = join(persist, "relay.env");
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => `${k}=${v}\n`).join(""), { mode: 0o600 });
  let output = "";
  const child = Bun.spawn(
    [wrangler, "dev", "--local", "--ip", "127.0.0.1", "--port", String(port), "--inspector-port", String(freePort()), "--persist-to", persist, "--env-file", envFile, "--show-interactive-dev-session=false"],
    { cwd: relayDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" } },
  );
  for (const stream of [child.stdout, child.stderr]) {
    void (async () => {
      for await (const chunk of stream) output += new TextDecoder().decode(chunk);
    })();
  }
  const url = `http://127.0.0.1:${port}`;
  await until(
    () => fetch(`${url}/v1/nothing`).then((r) => r.status).catch(() => 0),
    (status) => status === 404,
    `wrangler dev for ${name}\n${output}`,
    60_000,
  );
  return {
    url,
    persist,
    log: () => output,
    stop: () => {
      child.kill();
      rmSync(envFile, { force: true });
      // The relay's own log, kept beside its storage for whoever reads the run (the workflow uploads it).
      writeFileSync(join(persist, "wrangler.log"), output);
    },
  };
}

/** The relay's Durable Object storage: the SQLite file of each mailbox. */
function mailboxFiles(relay: Relay): string[] {
  const dir = join(relay.persist, "v3", "do", "plannotator-relay-Mailbox");
  return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite").map((f) => join(dir, f)) : [];
}

function readMailbox(relay: Relay, mailboxId: string): { mailbox: Json | null; devices: Json[] } {
  for (const file of mailboxFiles(relay)) {
    const db = new Database(file, { readonly: true });
    try {
      const name = db.query("SELECT name FROM __miniflare_do_name").get() as { name: string } | null;
      if (name?.name !== mailboxId) continue;
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
      if (!tables.includes("mailbox")) return { mailbox: null, devices: [] };
      return { mailbox: db.query("SELECT * FROM mailbox").get() as Json, devices: db.query("SELECT * FROM devices ORDER BY id").all() as Json[] };
    } finally {
      db.close();
    }
  }
  return { mailbox: null, devices: [] };
}

/** Every byte the relay's storage holds, to search for what it must never hold. */
function storageBytes(relay: Relay): Buffer {
  const dir = join(relay.persist, "v3", "do", "plannotator-relay-Mailbox");
  return Buffer.concat(readdirSync(dir).map((f) => readFileSync(join(dir, f))));
}

function holds(bytes: Buffer, text: string): boolean {
  return bytes.includes(Buffer.from(text, "utf8")) || bytes.includes(Buffer.from(text, "utf16le"));
}

// ── The proof ──

describe("the relay with an Inbox, under wrangler dev", () => {
  let apple: Awaited<ReturnType<typeof fakeApns>>;
  let relay: Relay;
  let w: InboxWorld;
  let stubs: string[] = [];
  let agent: SimAgent;
  let base = "";
  let env: Record<string, string> = {};
  let phone: { id: string; token: string; secret: string; key: string; relaySecret: string };
  let mailbox: { url: string; mailbox_id: string; secret: string };

  const win = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  /** The phone at the relay, with its relay secret (or another bearer). */
  const atRelay = (method: string, path: string, body?: unknown, bearer = phone.relaySecret) =>
    fetch(`${mailbox.url}/v1/mailboxes/${mailbox.mailbox_id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const startTheInbox = () => {
    // A harness proves its data dir before it spawns (row 5109): a temp path, never ~/.plannotator.
    expect(realpathSync(w.root).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(env.PLANNOTATOR_DATA_DIR).toBe(w.dataDir);
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env, cwd: w.root });
    if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
    base = `http://127.0.0.1:${registry(w).port}`;
  };

  const inboxLog = () => readFileSync(join(w.dataDir, "inbox", "inbox.log"), "utf8");

  /** The window makes an offer; the phone redeems its QR secret at the device door. */
  const pair = async (name: string) => {
    const health = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
    const offer = (await (await win("/api/inbox/pairing", { serverSession: health.serverSession })).json()) as Json;
    const secret = /[?&]secret=([A-Za-z0-9_-]+)/.exec(offer.link)![1]!;
    const answer = await fetch(`${base}/api/inbox/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, name, platform: "ios" }),
    });
    expect(answer.status).toBe(201);
    const body = (await answer.json()) as Json;
    const derived = await deriveRelayKeys(body.secret, body.device.id);
    return { body, phone: { id: body.device.id as string, token: body.token as string, secret: body.secret as string, ...derived } };
  };

  /** The collapse id the Inbox sends: the thread id under the phone's key, never the thread id itself. */
  const collapseOf = (threadId: string) => createHmac("sha256", Buffer.from(phone.key, "base64url")).update(threadId).digest("hex");

  const device = async (id: string) => ((await (await win("/api/inbox/devices")).json()) as Json).devices.find((d: Json) => d.id === id);

  beforeAll(async () => {
    const key = await throwawayKey();
    apple = await fakeApns(key.publicKey);
    relay = await startRelay("inbox", { APNS_KEY: key.pkcs8, APNS_KEY_ID: "KEY0000000", APNS_TEAM_ID: "TEAM000000", APNS_ORIGIN: `http://127.0.0.1:${apple.port}` });
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-relay-", "relay", "relay");
    env = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url };
    startTheInbox();
    agent = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Claude Code", host: "claude-code", cwd: w.project });
  }, 120_000);

  afterAll(async () => {
    await agent?.close().catch(() => {});
    if (w) destroyInboxWorld(w);
    for (const path of stubs) rmSync(path, { force: true });
    relay?.stop();
    apple?.close();
  });

  test("7.26, 7.27: the first pairing makes the mailbox, keeps it in relay.json (0600) and registers the phone by its relay secret's hash", async () => {
    const paired = await pair("iPhone");
    phone = paired.phone;
    const file = join(w.dataDir, "inbox", "relay.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(kept).sort()).toEqual(["mailbox_id", "secret", "url", "v"]);
    mailbox = kept;
    expect(paired.body.relay).toEqual({ url: relay.url, mailbox_id: kept.mailbox_id });
    expect(kept.mailbox_id).toMatch(/^mbx_[A-Za-z0-9_-]{22}$/);

    const stored = readMailbox(relay, kept.mailbox_id);
    expect(stored.mailbox).toEqual({ secret_sha256: sha256(kept.secret) });
    expect(stored.devices).toEqual([
      { id: phone.id, secret_sha256: sha256(phone.relaySecret), carriage: 1, cursor: expect.any(Number), apns_token: null, apns_environment: null },
    ]);
    expect((await device(phone.id)).carriage).toBe(true);
  });

  test("7.27 again: a replayed registration changes nothing; a wrong mailbox bearer is 401; an unknown mailbox is 404", async () => {
    expect((await atRelay("PUT", `/devices/${phone.id}/apns`, { token: TOKEN_OK, environment: "sandbox" })).status).toBe(204);
    const before = readMailbox(relay, mailbox.mailbox_id).devices;
    const again = await atRelay("PUT", `/devices/${phone.id}`, { secret_sha256: sha256(phone.relaySecret), cursor: 0 }, mailbox.secret);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ device_id: phone.id });
    expect(readMailbox(relay, mailbox.mailbox_id).devices).toEqual(before);
    expect(before[0]!.apns_token).toBe(TOKEN_OK);

    const wrong = await atRelay("PUT", `/devices/${phone.id}`, { secret_sha256: sha256(phone.relaySecret), cursor: 0 }, phone.relaySecret);
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: "unauthorized", code: "unauthorized" });
    const unknown = await fetch(`${relay.url}/v1/mailboxes/mbx_AAAAAAAAAAAAAAAAAAAAAA/devices/${phone.id}/apns`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${phone.relaySecret}` },
      body: JSON.stringify({ token: TOKEN_OK, environment: "sandbox" }),
    });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as Json).code).toBe("mailbox_not_found");
    // R2's routes are not built yet: a path the relay does not serve.
    expect(((await (await atRelay("GET", `/devices/${phone.id}/items?after=0`)).json()) as Json).code).toBe("not_found");
  });

  test("creation is the Worker's alone: a client's /create neither replaces a mailbox's hash nor makes one under an id it picks", async () => {
    const attacker = "attacker-bearer";
    const before = readMailbox(relay, mailbox.mailbox_id).mailbox;
    for (const id of [mailbox.mailbox_id, "mbx_QQQQQQQQQQQQQQQQQQQQQQ"]) {
      const probe = await fetch(`${relay.url}/v1/mailboxes/${id}/create`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(attacker) }) });
      expect(probe.status).toBe(404);
    }
    expect(readMailbox(relay, mailbox.mailbox_id).mailbox).toEqual(before!);
    expect(readMailbox(relay, "mbx_QQQQQQQQQQQQQQQQQQQQQQ").mailbox).toBeNull();
    const push = await atRelay("POST", "/push", { device_id: phone.id, collapse_id: "msg_00000000000000000000000000", ciphertext: "AAAAexample" }, attacker);
    expect(push.status).toBe(401);
    expect((await atRelay("PUT", "/devices/dev_EVIL", { secret_sha256: sha256(attacker), cursor: 0 }, attacker)).status).toBe(401);
  });

  test("7.35: the phone's relay switch reaches the Inbox over its socket and flips carriage in the device record", async () => {
    expect((await atRelay("PUT", `/devices/${phone.id}/carriage`, { on: false })).status).toBe(204);
    await until(() => device(phone.id), (d) => d.carriage === false, "carriage off");
    expect(readMailbox(relay, mailbox.mailbox_id).devices[0]!.carriage).toBe(0);
    expect((await atRelay("PUT", `/devices/${phone.id}/carriage`, { on: true, cursor: 7 })).status).toBe(204);
    await until(() => device(phone.id), (d) => d.carriage === true, "carriage on");
    expect(readMailbox(relay, mailbox.mailbox_id).devices[0]).toMatchObject({ carriage: 1, cursor: 7 });
    // The phone's own bearer only: the Inbox's is refused on the phone's routes.
    expect((await atRelay("PUT", `/devices/${phone.id}/carriage`, { on: false }, mailbox.secret)).status).toBe(401);
  });

  test("7.30: an agent's question fires one push, sealed under the phone's key; Apple gets ciphertext and a generic alert only", async () => {
    const sent = await agent.send({
      project_path: w.project,
      body: ["The retry worker is ready.", "", ":::question", SUBJECT, "They take about four minutes against the test key.", "- Yes", "- No", "Recommended: Yes", ":::"].join("\n"),
    });
    await until(() => apple.pushes.length, (n) => n === 1, "one push");
    await sleep(1000);
    expect(apple.pushes.length).toBe(1);
    const push = apple.pushes[0]!;
    expect(push.jwtValid).toBe(true);
    expect(push.headers).toMatchObject({
      ":method": "POST",
      ":path": `/3/device/${TOKEN_OK}`,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-topic": "ai.plannotator.app",
      "apns-collapse-id": collapseOf(sent.thread_id),
    });
    const body = JSON.parse(push.body);
    expect(body.aps).toEqual({ alert: { title: "Plannotator", body: "New in your Inbox" }, "mutable-content": 1, sound: "default" });
    expect(Object.keys(body).sort()).toEqual(["aps", "e"]);
    expect(push.body).not.toContain("retry");
    const summary = JSON.parse(await decryptWithKey(body.e, phone.key));
    expect(summary).toEqual({
      v: 1,
      thread_id: sent.thread_id,
      message_id: sent.message_id ?? sent.thread_id,
      subject: SUBJECT,
      project: "refund-service",
      agent: "Claude Code",
      question: {
        key: expect.stringMatching(/^q-/),
        revision: 0,
        prompt: SUBJECT,
        context: "They take about four minutes against the test key.",
        choices: [
          { label: "Yes", recommended: true },
          { label: "No", recommended: false },
        ],
      },
    });
  });

  test("one message is one push however many questions it carries; news is none; a guided review is one", async () => {
    apple.pushes.length = 0;
    const two = await agent.send({
      project_path: w.project,
      thread: "two questions",
      body: [":::question", "Ship it behind a flag?", "- Yes", "- No", ":::", "", ":::question", "Which region first?", "- us-east", "- eu-west", ":::"].join("\n"),
    });
    await until(() => apple.pushes.length, (n) => n === 1, "one push for two questions");
    expect(JSON.parse(await decryptWithKey(JSON.parse(apple.pushes[0]!.body).e, phone.key)).question).toBeNull();
    expect(apple.pushes[0]!.headers["apns-collapse-id"]).toBe(collapseOf(two.thread_id));

    await agent.send({ project_path: w.project, thread: "news", body: "The migration finished. Nothing to answer." });
    const guided = await agent.submitGuide({ ...GUIDE_BRIEF_EXAMPLE, project_path: w.project, thread: "token-refresh", idempotency_key: "guide-relay-1" });
    await until(() => apple.pushes.length, (n) => n === 2, "one push for the guided review");
    await sleep(1000);
    expect(apple.pushes.length).toBe(2);
    expect(JSON.parse(await decryptWithKey(JSON.parse(apple.pushes[1]!.body).e, phone.key)).thread_id).toBe(guided.thread_id);
  });

  test("Apple's 4096 bytes: a question whose context would pass them goes without its context", async () => {
    apple.pushes.length = 0;
    const context = "The four-minute run hits the test clock twice. ".repeat(120);
    await agent.send({ project_path: w.project, thread: "long", body: [":::question", "Run the long suite?", context, "- Yes", "- No", ":::"].join("\n") });
    await until(() => apple.pushes.length, (n) => n === 1, "one push");
    expect(Buffer.byteLength(apple.pushes[0]!.body)).toBeLessThanOrEqual(4096);
    const summary = JSON.parse(await decryptWithKey(JSON.parse(apple.pushes[0]!.body).e, phone.key));
    expect(summary.question).toMatchObject({ prompt: "Run the long suite?", context: null, choices: [{ label: "Yes" }, { label: "No" }] });
  });

  test("with the phone's relay switch off, no push goes to it", async () => {
    apple.pushes.length = 0;
    expect((await atRelay("PUT", `/devices/${phone.id}/carriage`, { on: false })).status).toBe(204);
    await until(() => device(phone.id), (d) => d.carriage === false, "carriage off");
    await agent.send({ project_path: w.project, thread: "while off", body: [":::question", "Deploy now?", "- Yes", "- No", ":::"].join("\n") });
    await sleep(1500);
    expect(apple.pushes.length).toBe(0);
    expect((await atRelay("PUT", `/devices/${phone.id}/carriage`, { on: true, cursor: 0 })).status).toBe(204);
    await until(() => device(phone.id), (d) => d.carriage === true, "carriage on");
  });

  test("the relay's storage holds no key, secret, subject or body", () => {
    const bytes = storageBytes(relay);
    for (const value of [phone.secret, phone.key, phone.relaySecret, phone.token, mailbox.secret, SUBJECT, "Run the long suite?", "four minutes"]) {
      expect(holds(bytes, value)).toBe(false);
    }
    // What it does hold, as the contract lists it.
    expect(holds(bytes, sha256(phone.relaySecret))).toBe(true);
  });

  test("a 410 from Apple deletes the token: the next push answers no_apns_token", async () => {
    expect((await atRelay("PUT", `/devices/${phone.id}/apns`, { token: TOKEN_GONE, environment: "production" })).status).toBe(204);
    apple.pushes.length = 0;
    await agent.send({ project_path: w.project, thread: "gone", body: [":::question", "Roll back?", "- Yes", "- No", ":::"].join("\n") });
    await until(() => apple.pushes.length, (n) => n === 1, "the push Apple refuses");
    await until(() => readMailbox(relay, mailbox.mailbox_id).devices[0]!.apns_token, (t) => t === null, "the token deleted");
    await until(inboxLog, (log) => log.includes(`${phone.id} 200 apns_gone`), "the Inbox's log line");
    await agent.send({ project_path: w.project, thread: "gone again", body: [":::question", "Roll back now?", "- Yes", "- No", ":::"].join("\n") });
    await until(inboxLog, (log) => log.includes(`${phone.id} 200 no_apns_token`), "no_apns_token");
    expect(apple.pushes.length).toBe(1);
  });

  test("hello: a restarted Inbox registers a phone the relay does not list and takes each phone's switch from the relay", async () => {
    const second = (await pair("iPad")).phone;
    await until(() => readMailbox(relay, mailbox.mailbox_id).devices.map((d) => d.id), (ids) => ids.includes(second.id), "the second phone registered");
    stopInbox(w);
    // While the Inbox is stopped: the relay loses the second phone, and the first turns its switch off.
    expect((await atRelay("DELETE", `/devices/${second.id}`, undefined, mailbox.secret)).status).toBe(204);
    expect((await atRelay("PUT", `/devices/${phone.id}/carriage`, { on: false })).status).toBe(204);
    startTheInbox();
    await until(() => readMailbox(relay, mailbox.mailbox_id).devices.find((d) => d.id === second.id), (d) => d?.secret_sha256 === sha256(second.relaySecret), "registered again on hello");
    await until(() => device(phone.id), (d) => d.carriage === false, "the switch taken from hello");
  });

  test("7.37, 7.28: a removed phone is gone from the relay with everything it held", async () => {
    const health = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
    expect((await win(`/api/inbox/devices/${phone.id}/revoke`, { serverSession: health.serverSession })).status).toBe(200);
    await until(() => readMailbox(relay, mailbox.mailbox_id).devices.map((d) => d.id), (ids) => !ids.includes(phone.id), "the phone removed");
    const after = await atRelay("PUT", `/devices/${phone.id}/apns`, { token: TOKEN_OK, environment: "sandbox" });
    expect(after.status).toBe(404);
    expect(((await after.json()) as Json).code).toBe("device_not_found");
    expect(existsSync(join(w.dataDir, "inbox", "device-secrets", phone.id))).toBe(false);
  });
});

describe("a relay without the APNs key", () => {
  let relay: Relay;

  beforeAll(async () => {
    relay = await startRelay("no-key", {});
  }, 90_000);
  afterAll(() => relay?.stop());

  test("every push answers no_apns_key, logged once; mailbox creation is braked by the reused rule", async () => {
    const secret = "mailbox-secret-for-the-no-key-proof";
    const made = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(secret) }) });
    expect(made.status).toBe(201);
    const { mailbox_id } = (await made.json()) as Json;
    const at = (method: string, path: string, body: unknown, bearer: string) =>
      fetch(`${relay.url}/v1/mailboxes/${mailbox_id}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const dev = "dev_00000000000000000000000000";
    expect((await at("PUT", `/devices/${dev}`, { secret_sha256: sha256("phone"), cursor: 0 }, secret)).status).toBe(200);
    expect((await at("PUT", `/devices/${dev}/apns`, { token: TOKEN_OK, environment: "sandbox" }, "phone")).status).toBe(204);
    for (let i = 0; i < 2; i++) {
      const push = await at("POST", "/push", { device_id: dev, collapse_id: "msg_00000000000000000000000000", ciphertext: "AAAAexample" }, secret);
      expect(push.status).toBe(200);
      expect(await push.json()).toEqual({ sent: false, reason: "no_apns_key" });
    }
    await until(relay.log, (log) => log.includes("no APNs key"), "the log line");
    expect(relay.log().split("no APNs key").length - 1).toBe(1);

    // The creation brake guides.show uses (20 per minute per IP); wrangler dev sets CF-Connecting-IP.
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      const r = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(`m${i}`) }) });
      statuses.push(r.status);
      if (r.status === 429) {
        expect(r.headers.get("retry-after")).toBe("60");
        expect(await r.json()).toEqual({ error: "too many requests", code: "too_many_requests" });
      }
    }
    expect(statuses).toContain(429);
  });
});

describe("a hostile server in Apple's place", () => {
  let relay: Relay;
  let server: ReturnType<typeof Bun.listen>;
  let mode: "oversized" | "flood" | "graceful-goaway" = "oversized";
  const frame = (type: number, flags: number, stream: number, payload: Uint8Array) => {
    const out = new Uint8Array(9 + payload.length);
    out.set([(payload.length >> 16) & 255, (payload.length >> 8) & 255, payload.length & 255, type, flags, 0, 0, 0, stream], 0);
    out.set(payload, 9);
    return out;
  };

  beforeAll(async () => {
    // A raw TCP peer that answers each connection by `mode`, never by the protocol's rules.
    server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          if ((socket.data as { answered?: boolean } | undefined)?.answered) return;
          socket.data = { answered: true };
          socket.write(frame(4, 0, 0, new Uint8Array()));
          if (mode === "oversized") {
            // A DATA frame that says 16 MiB, then a trickle.
            socket.write(new Uint8Array([0xff, 0xff, 0xff, 0x0, 0x0, 0, 0, 0, 1, 1, 2, 3]));
          } else if (mode === "flood") {
            socket.write(frame(1, 0x4, 1, new Uint8Array([0x8c]))); // :status 400, END_HEADERS
            for (let i = 0; i < 64; i++) socket.write(frame(0, 0, 1, new Uint8Array(1000).fill(0x61)));
          } else {
            socket.write(frame(7, 0, 0, new Uint8Array([0, 0, 0, 1, 0, 0, 0, 0]))); // GOAWAY, last stream 1, NO_ERROR
            socket.write(frame(1, 0x5, 1, new Uint8Array([0x88]))); // :status 200, END_HEADERS | END_STREAM
          }
        },
      },
      data: undefined as unknown,
    } as Parameters<typeof Bun.listen>[0]);
    const key = await throwawayKey();
    relay = await startRelay("hostile", { APNS_KEY: key.pkcs8, APNS_KEY_ID: "KEY0000000", APNS_TEAM_ID: "TEAM000000", APNS_ORIGIN: `http://127.0.0.1:${server.port}` });
  }, 90_000);
  afterAll(() => {
    relay?.stop();
    server?.stop(true);
  });

  test("a frame over 16 KiB and a flood of body fail at once, never buffered to the timeout; a graceful GOAWAY that covers the push still answers", async () => {
    const secret = "mailbox-secret-for-the-hostile-proof";
    const { mailbox_id } = (await (await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(secret) }) })).json()) as Json;
    const at = (method: string, path: string, body: unknown, bearer: string) =>
      fetch(`${relay.url}/v1/mailboxes/${mailbox_id}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const dev = "dev_00000000000000000000000000";
    await at("PUT", `/devices/${dev}`, { secret_sha256: sha256("phone"), cursor: 0 }, secret);
    expect((await at("PUT", `/devices/${dev}/apns`, { token: TOKEN_OK, environment: "sandbox" }, "phone")).status).toBe(204);
    const push = async () => {
      const started = Date.now();
      const answer = await at("POST", "/push", { device_id: dev, collapse_id: "c".repeat(64), ciphertext: "AAAAexample" }, secret);
      return { status: answer.status, body: (await answer.json()) as Json, ms: Date.now() - started };
    };
    mode = "oversized";
    const oversized = await push();
    expect(oversized).toMatchObject({ status: 502, body: { code: "apns_failed" } });
    expect(oversized.body.error).toContain("over 16384");
    expect(oversized.ms).toBeLessThan(3000);
    mode = "flood";
    const flood = await push();
    expect(flood).toMatchObject({ status: 502, body: { code: "apns_failed" } });
    expect(flood.body.error).toContain("too large");
    expect(flood.ms).toBeLessThan(3000);
    mode = "graceful-goaway";
    expect(await push()).toMatchObject({ status: 202, body: { sent: true } });
    // Apple's own ceiling on the collapse id, at the relay.
    expect((await at("POST", "/push", { device_id: dev, collapse_id: "c".repeat(65), ciphertext: "AAAAexample" }, secret)).status).toBe(400);
  }, 30_000);
});

// Apple's real hosts: run where RELAY_PROOF_APPLE=1 (the relay workflow sets it), so a local run works offline.
describe.skipIf(process.env.RELAY_PROOF_APPLE !== "1")("the transport to Apple's real push hosts, sandbox and production", () => {
  let relay: Relay;

  beforeAll(async () => {
    const key = await throwawayKey();
    relay = await startRelay("apple", { APNS_KEY: key.pkcs8, APNS_KEY_ID: "KEY0000000", APNS_TEAM_ID: "TEAM000000" });
  }, 90_000);
  afterAll(() => relay?.stop());

  test("an HTTP/2 push over connect() and TLS gets Apple's own answer: 403 InvalidProviderToken for a throwaway key", async () => {
    const secret = "mailbox-secret-for-the-apple-proof";
    const { mailbox_id } = (await (await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(secret) }) })).json()) as Json;
    const at = (method: string, path: string, body: unknown, bearer: string) =>
      fetch(`${relay.url}/v1/mailboxes/${mailbox_id}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const dev = "dev_00000000000000000000000000";
    await at("PUT", `/devices/${dev}`, { secret_sha256: sha256("phone"), cursor: 0 }, secret);
    for (const environment of ["sandbox", "production"]) {
      expect((await at("PUT", `/devices/${dev}/apns`, { token: TOKEN_OK, environment }, "phone")).status).toBe(204);
      const push = await at("POST", "/push", { device_id: dev, collapse_id: "msg_00000000000000000000000000", ciphertext: "AAAAexample" }, secret);
      expect(push.status).toBe(502);
      expect(await push.json()).toEqual({ error: "APNs answered 403 InvalidProviderToken.", code: "apns_failed", apns_status: 403, apns_reason: "InvalidProviderToken" });
    }
  }, 30_000);
});
