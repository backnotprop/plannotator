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
 * Then the carriage (R2) on its own relay and Inbox: the phone reads and
 * answers through the relay alone (no Wi-Fi, no tailnet), with the Inbox
 * stopped and started between a question and its answer.
 *
 * Then a second relay with no APNs key and no FCM service account (pushes
 * answer `no_apns_key`, `no_fcm_key`, or `no_push_token` with neither token),
 * where the token routes, `hello`'s flags and a mailbox made
 * under R2's schema are checked; then FCM (R3,
 * section 10) on its own relay and Inbox, an Android phone paired, with
 * Google's two hosts played locally (oauth2.googleapis.com checks the RS256
 * JWT against a throwaway RSA key made for this run; fcm.googleapis.com
 * checks the access token it minted); and a relay that reaches Apple's real
 * sandbox over TLS with a throwaway key: the transport works when Apple
 * answers 403 InvalidProviderToken. The real
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
import { decryptWithKey, deriveRelayKeys, encryptWithKey } from "@plannotator/core/crypto";
import { SimAgent } from "../../../scripts/inbox-sim";
import { createInboxWorld, destroyInboxWorld, registry, stopInbox, removeStubbedHtml, stubBuiltHtml, worldEnv, type InboxWorld } from "../../../tests/helpers/inbox-world";
import { GUIDE_BRIEF_EXAMPLE } from "../../../packages/server/inbox-guides";
import { apnsBody } from "../../../packages/server/inbox-relay";
import { fcmMessage } from "../src/fcm";

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

// ── Google, played locally ──

const FCM_PROJECT = "plannotator-relay-proof";
const FCM_CLIENT = "relay-proof@plannotator-relay-proof.iam.gserviceaccount.com";
const FCM_KEY_ID = "0000000000000000000000000000000000000000";

/** A throwaway service account: an RSA key made for this run, in the JSON key file's shape. */
async function throwawayServiceAccount() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({ type: "service_account", project_id: FCM_PROJECT, private_key_id: FCM_KEY_ID, private_key: pem, client_email: FCM_CLIENT, token_uri: "https://oauth2.googleapis.com/token" });
  return { json, publicKey: pair.publicKey };
}

interface FcmSent {
  path: string;
  authorization: string;
  body: Json;
}

/**
 * oauth2.googleapis.com and fcm.googleapis.com on two local ports. The token
 * endpoint checks the JWT bearer grant (RS256 over the service account's key,
 * its issuer, scope, audience and hour) and mints an access token; FCM checks
 * that token and answers by the registration token: `fcm-gone…` UNREGISTERED
 * (404), `fcm-down…` UNAVAILABLE (503), anything else 200.
 */
async function fakeGoogle(publicKey: CryptoKey) {
  const exchanges: { header: Json; claims: Json; valid: boolean }[] = [];
  const minted = new Set<string>();
  let mintedCount = 0;
  const sent: FcmSent[] = [];
  const oauth = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const form = new URLSearchParams(await req.text());
      const assertion = form.get("assertion") ?? "";
      const [header, claims, signature] = assertion.split(".");
      let parsed = { header: {} as Json, claims: {} as Json, valid: false };
      try {
        parsed = {
          header: JSON.parse(Buffer.from(header!, "base64url").toString()),
          claims: JSON.parse(Buffer.from(claims!, "base64url").toString()),
          valid: await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, Buffer.from(signature!, "base64url"), new TextEncoder().encode(`${header}.${claims}`)),
        };
      } catch {
        // Refused below.
      }
      exchanges.push(parsed);
      const c = parsed.claims;
      const ok =
        req.method === "POST" &&
        new URL(req.url).pathname === "/token" &&
        req.headers.get("content-type") === "application/x-www-form-urlencoded" &&
        form.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer" &&
        parsed.valid &&
        parsed.header.alg === "RS256" &&
        parsed.header.kid === FCM_KEY_ID &&
        c.iss === FCM_CLIENT &&
        c.scope === "https://www.googleapis.com/auth/firebase.messaging" &&
        c.aud === "https://oauth2.googleapis.com/token" &&
        c.exp - c.iat === 3600;
      if (!ok) return Response.json({ error: "invalid_grant", error_description: "Invalid JWT Signature." }, { status: 400 });
      const token = `ya29.proof-${++mintedCount}`;
      minted.add(token);
      return Response.json({ access_token: token, expires_in: 3599, token_type: "Bearer" });
    },
  });
  const fcm = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const authorization = req.headers.get("authorization") ?? "";
      const body = (await req.json().catch(() => ({}))) as Json;
      sent.push({ path, authorization, body });
      const fcmError = (code: number, status: string, errorCode: string) =>
        Response.json({ error: { code, message: status, status, details: [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode }] } }, { status: code });
      if (req.method !== "POST" || path !== `/v1/projects/${FCM_PROJECT}/messages:send`) return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
      if (!minted.has(authorization.replace(/^Bearer /, ""))) return Response.json({ error: { code: 401, status: "UNAUTHENTICATED" } }, { status: 401 });
      const token = String(body.message?.token ?? "");
      if (token.startsWith("fcm-gone")) return fcmError(404, "NOT_FOUND", "UNREGISTERED");
      if (token.startsWith("fcm-down")) return fcmError(503, "UNAVAILABLE", "UNAVAILABLE");
      return Response.json({ name: `projects/${FCM_PROJECT}/messages/0:${sent.length}` });
    },
  });
  return {
    oauthOrigin: `http://127.0.0.1:${oauth.port}`,
    fcmOrigin: `http://127.0.0.1:${fcm.port}`,
    exchanges,
    sent,
    /** FCM stops accepting an access token it minted, as Google does for one revoked or expired early. */
    revoke: (token: string) => minted.delete(token),
    close: () => {
      oauth.stop(true);
      fcm.stop(true);
    },
  };
}

/** The Inbox's socket at the relay, held for one `hello`: what the relay lists for each device. */
async function helloOf(relayUrl: string, mailboxId: string, secret: string): Promise<Json> {
  // Bun's WebSocket takes headers as its second argument.
  const socket = new WebSocket(`${relayUrl.replace(/^http/, "ws")}/v1/mailboxes/${mailboxId}/socket`, { headers: { Authorization: `Bearer ${secret}` } } as unknown as string[]);
  try {
    return await new Promise<Json>((done, fail) => {
      socket.onmessage = (event) => done(JSON.parse(String(event.data)));
      socket.onerror = () => fail(new Error("the socket failed"));
      setTimeout(() => fail(new Error("no hello")), 10_000);
    });
  } finally {
    socket.close();
  }
}

// ── The relay under wrangler dev ──

interface Relay {
  url: string;
  persist: string;
  log: () => string;
  /** Resolves once wrangler has exited, so its storage may be opened. */
  stop: () => Promise<void>;
}

async function startRelay(name: string, vars: Record<string, string>, options: { keep?: boolean } = {}): Promise<Relay> {
  const port = freePort();
  const persist = join(relayDir, ".wrangler", `proof-${name}`);
  // `keep`: start again on the storage a stopped relay left (a mailbox made by an older schema).
  if (!options.keep) rmSync(persist, { recursive: true, force: true });
  mkdirSync(persist, { recursive: true });
  // The throwaway key lives in this env file for the run only (.wrangler/ is not committed), never on a command line.
  const envFile = join(persist, "relay.env");
  // A value that is not plain (the FCM service account's JSON) goes single-quoted: dotenv reads it literally.
  writeFileSync(envFile, Object.entries(vars).map(([k, v]) => (/^[\w.:/+=-]*$/.test(v) ? `${k}=${v}\n` : `${k}='${v}'\n`)).join(""), { mode: 0o600 });
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
    stop: async () => {
      child.kill();
      rmSync(envFile, { force: true });
      // The relay's own log, kept beside its storage for whoever reads the run (the workflow uploads it).
      writeFileSync(join(persist, "wrangler.log"), output);
      await child.exited;
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

/** The mailbox's tables as they are on disk, for the proof's record: ids, numbers, hashes and envelopes. */
function dumpMailbox(relay: Relay, mailboxId: string): Json {
  for (const file of mailboxFiles(relay)) {
    const db = new Database(file, { readonly: true });
    try {
      const name = db.query("SELECT name FROM __miniflare_do_name").get() as { name: string } | null;
      if (name?.name !== mailboxId) continue;
      const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").all() as { name: string }[]).map((t) => t.name);
      return Object.fromEntries(tables.map((t) => [t, db.query(`SELECT * FROM ${t}`).all()]));
    } finally {
      db.close();
    }
  }
  return {};
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
  let phone: { id: string; token: string; secret: string; key: string; collapseKey: string; relaySecret: string };
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

  /** The collapse id the Inbox sends: the thread id under the phone's collapse key, never the thread id itself. */
  const collapseOf = (threadId: string) => createHmac("sha256", Buffer.from(phone.collapseKey, "base64url")).update(threadId).digest("hex");

  const device = async (id: string) => ((await (await win("/api/inbox/devices")).json()) as Json).devices.find((d: Json) => d.id === id);

  beforeAll(async () => {
    const key = await throwawayKey();
    apple = await fakeApns(key.publicKey);
    relay = await startRelay("inbox", { APNS_KEY: key.pkcs8, APNS_KEY_ID: "KEY0000000", APNS_TEAM_ID: "TEAM000000", APNS_ORIGIN: `http://127.0.0.1:${apple.port}` });
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-relay-", "relay", "relay", { phones: true });
    env = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url };
    startTheInbox();
    agent = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Claude Code", host: "claude-code", cwd: w.project });
  }, 120_000);

  afterAll(async () => {
    await agent?.close().catch(() => {});
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
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
      { id: phone.id, secret_sha256: sha256(phone.relaySecret), carriage: 1, cursor: expect.any(Number), apns_token: null, apns_environment: null, next_n: expect.any(Number), fcm_token: null },
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
      type: "push",
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

  test("a 410 from Apple deletes the token: the next push answers no_push_token", async () => {
    expect((await atRelay("PUT", `/devices/${phone.id}/apns`, { token: TOKEN_GONE, environment: "production" })).status).toBe(204);
    apple.pushes.length = 0;
    await agent.send({ project_path: w.project, thread: "gone", body: [":::question", "Roll back?", "- Yes", "- No", ":::"].join("\n") });
    await until(() => apple.pushes.length, (n) => n === 1, "the push Apple refuses");
    await until(() => readMailbox(relay, mailbox.mailbox_id).devices[0]!.apns_token, (t) => t === null, "the token deleted");
    await until(inboxLog, (log) => log.includes(`${phone.id} 200 apns_gone`), "the Inbox's log line");
    await agent.send({ project_path: w.project, thread: "gone again", body: [":::question", "Roll back now?", "- Yes", "- No", ":::"].join("\n") });
    await until(inboxLog, (log) => log.includes(`${phone.id} 200 no_push_token`), "no_push_token");
    expect(apple.pushes.length).toBe(1);
  });

  test("hello: a restarted Inbox registers a phone the relay does not list and takes each phone's switch from the relay", async () => {
    const second = (await pair("iPad")).phone;
    await until(() => readMailbox(relay, mailbox.mailbox_id).devices.map((d) => d.id), (ids) => ids.includes(second.id), "the second phone registered");
    await stopInbox(w);
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

// ── The carriage (R2) ──

interface Phone {
  id: string;
  token: string;
  secret: string;
  key: string;
  upKey: string;
  relaySecret: string;
  /** The highest item number read, and every item opened so far. */
  n: number;
  seen: Json[];
}

describe("the carriage: a phone reads and answers the Inbox through the relay alone", () => {
  let relay: Relay;
  let w: InboxWorld;
  let stubs: string[] = [];
  let agent: SimAgent;
  let base = "";
  let env: Record<string, string> = {};
  let mailbox: { url: string; mailbox_id: string; secret: string };
  let a: Phone;
  let b: Phone;
  let threadId = "";
  let messageId = "";
  let questionKey = "";
  const proofDir = process.env.INBOX_PROOF_DIR ? join(process.env.INBOX_PROOF_DIR, "R2") : null;
  const PNG = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(1_400_000, 7)]);

  const say = (line: string) => w.proof(line);
  const record = (name: string, value: unknown) => {
    if (proofDir) writeFileSync(join(proofDir, name), `${JSON.stringify(value, null, 2)}\n`);
  };

  const win = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const atRelay = (phone: Phone, method: string, path: string, body?: unknown, bearer = phone.relaySecret) =>
    fetch(`${mailbox.url}/v1/mailboxes/${mailbox.mailbox_id}/devices/${phone.id}${path}`, {
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

  const pair = async (name: string): Promise<Phone> => {
    const health = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
    const offer = (await (await win("/api/inbox/pairing", { serverSession: health.serverSession })).json()) as Json;
    const secret = /[?&]secret=([A-Za-z0-9_-]+)/.exec(offer.link)![1]!;
    const answer = await fetch(`${base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret, name, platform: "ios" }) });
    expect(answer.status).toBe(201);
    const body = (await answer.json()) as Json;
    mailbox ??= JSON.parse(readFileSync(join(w.dataDir, "inbox", "relay.json"), "utf8"));
    return { id: body.device.id, token: body.token, secret: body.secret, ...(await deriveRelayKeys(body.secret, body.device.id)), n: 0, seen: [] };
  };

  /** The phone fetches what the relay holds for it after the last item it read, and opens each with its key. */
  const fetchItems = async (phone: Phone): Promise<{ items: Json[]; inbox_online: boolean }> => {
    const answer = await atRelay(phone, "GET", `/items?after=${phone.n}`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { items: { n: number; ciphertext: string }[]; inbox_online: boolean };
    const opened: Json[] = [];
    for (const item of body.items) {
      opened.push({ n: item.n, ...JSON.parse(await decryptWithKey(item.ciphertext, phone.key)) });
      phone.n = Math.max(phone.n, item.n);
    }
    phone.seen.push(...opened);
    return { items: opened, inbox_online: body.inbox_online };
  };

  /** One command up, sealed under the phone's up key: a POST's id is its idempotency key, a read's a fresh id. */
  const command = async (phone: Phone, method: "GET" | "POST", path: string, body?: Json) => {
    const id = (body?.idempotency_key as string | undefined) ?? crypto.randomUUID();
    const ciphertext = await encryptWithKey(JSON.stringify({ v: 1, id, method, path: `/api/inbox/device/${path}`, ...(body ? { body } : {}) }), phone.upKey);
    const answer = await atRelay(phone, "POST", "/commands", { id, ciphertext });
    return { id, ciphertext, status: answer.status, body: (await answer.json()) as Json };
  };

  /** The result item for a command: its status, and its body as JSON or bytes. */
  const resultOf = async (phone: Phone, id: string) => {
    const found = await until(
      async () => {
        await fetchItems(phone);
        return phone.seen.find((item) => item.type === "result" && item.id === id);
      },
      (item) => item !== undefined,
      `the result of ${id}`,
    );
    const bytes = Buffer.from(found!.body_b64, "base64");
    return { status: found!.status as number, contentType: found!.content_type as string, bytes, json: () => JSON.parse(bytes.toString("utf8")) as Json };
  };

  /** Ask and wait: a command and its result. */
  const ask = async (phone: Phone, method: "GET" | "POST", path: string, body?: Json) => {
    const sent = await command(phone, method, path, body);
    expect(sent.status).toBe(202);
    return { ...(await resultOf(phone, sent.id)), id: sent.id, ciphertext: sent.ciphertext };
  };

  const rows = (table: string): Json[] => (dumpMailbox(relay, mailbox.mailbox_id)[table] as Json[] | undefined) ?? [];

  beforeAll(async () => {
    relay = await startRelay("carriage", {});
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-relay-carriage-", "carriage", "R2", { phones: true });
    if (proofDir) mkdirSync(proofDir, { recursive: true });
    env = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url };
    // The files an agent attaches: a plan, and an HTML page with an image beside it (1.4 MB: its envelope passes one storage row).
    writeFileSync(join(w.project, "retry-plan.md"), "# Retry plan\n\nRetry at most three times, 2, 4 and 8 seconds apart.\n");
    mkdirSync(join(w.project, "pages", "images"), { recursive: true });
    writeFileSync(join(w.project, "pages", "ticket.html"), '<!doctype html><html><head><title>Low Tide</title></head><body><img src="images/sun.png" alt="sun"></body></html>');
    writeFileSync(join(w.project, "pages", "images", "sun.png"), PNG);
    // Past Cloudflare's 32 MiB WebSocket message once sealed (base64 twice): its result is a 413 in its place.
    writeFileSync(join(w.project, "pages", "images", "tide.png"), Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(26_000_000, 9)]));
    startTheInbox();
    agent = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Claude Code", host: "claude-code", cwd: w.project });
    say(`relay: wrangler dev at ${relay.url}; Wi-Fi and tailnet switches off (a fresh data dir); the phone reaches the Inbox only through the relay`);
  }, 120_000);

  afterAll(async () => {
    await agent?.close().catch(() => {});
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
    relay?.stop();
  });

  test("two phones pair; one turns its relay switch off; an agent's question goes down to the other only, sealed", async () => {
    a = await pair("iPhone");
    b = await pair("iPad");
    expect((await atRelay(b, "PUT", "/carriage", { on: false })).status).toBe(204);
    await until(async () => ((await (await win("/api/inbox/devices")).json()) as Json).devices.find((d: Json) => d.id === b.id)?.carriage, (on) => on === false, "b's switch off");
    await until(() => rows("devices").length, (n) => n === 2, "both phones registered");

    const sent = await agent.send({
      project_path: w.project,
      subject: SUBJECT,
      body: ["The retry worker is ready.", "", ":::question", SUBJECT, "They take about four minutes against the test key.", "- Yes", "- No", "Recommended: Yes", ":::"].join("\n"),
      attachments: ["retry-plan.md", "pages/ticket.html"],
    });
    threadId = sent.thread_id;
    messageId = sent.message_id ?? sent.thread_id;
    const down = await until(
      async () => (await fetchItems(a), a.seen),
      (seen) => seen.some((item) => item.type === "record" && item.kind === "question"),
      "the question down to the iPhone",
    );
    const message = down.find((item) => item.kind === "message" && item.id === messageId)!;
    expect(message).toMatchObject({ v: 1, type: "record", kind: "message", message: { id: messageId, subject: SUBJECT } });
    expect(typeof message.seq).toBe("number");
    questionKey = down.find((item) => item.kind === "question")!.question.key;
    // In seq order, each after the cursor the relay held at pairing.
    const seqs = down.filter((item) => item.type === "record").map((item) => item.seq);
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
    // Each record names the seq the previous one reached, so a phone notices a delayed or dropped item.
    const records = down.filter((item) => item.type === "record");
    for (let i = 1; i < records.length; i++) expect(records[i]!.after).toBe(records[i - 1]!.seq);
    say(`down to the iPhone: ${down.length} record items (${[...new Set(down.map((item) => item.kind))].join(", ")}), seq ${seqs[0]} to ${seqs.at(-1)}`);

    const held = rows("items");
    expect(held.length).toBeGreaterThan(0);
    expect(held.every((row) => row.device_id === a.id)).toBe(true);
    expect((await fetchItems(b)).items).toEqual([]);
    say("the iPad, its switch off: no items held, none fetched");
    // Storage holds ciphertext: no subject, body, file name or key.
    const bytes = storageBytes(relay);
    for (const value of [SUBJECT, "retry worker", "retry-plan.md", "Low Tide", a.key, a.upKey, a.secret, a.relaySecret, a.token, mailbox.secret]) expect(holds(bytes, value)).toBe(false);
    record("storage-1-items-held.json", dumpMailbox(relay, mailbox.mailbox_id));
  }, 60_000);

  test("the phone reads the list and the thread through the relay, then picks and sends; the agent's wait_for_reply gets the answer", async () => {
    const list = await ask(a, "GET", "threads");
    expect(list.status).toBe(200);
    expect(list.contentType).toContain("application/json");
    expect(JSON.stringify(list.json().sections)).toContain(threadId);
    const thread = await ask(a, "GET", `threads/${threadId}`);
    expect(thread.json().thread.messages[0].questions[0]).toMatchObject({ key: questionKey, state: "open", revision: 0 });
    say(`GET threads and GET threads/${threadId} as commands: results 200, the thread with its open question`);

    const pick = await ask(a, "POST", `messages/${messageId}/picks`, {
      idempotency_key: "00000000-0000-4000-8000-0000000000a1",
      questions: [{ key: questionKey, revision: 0, answer: { v: 1, key: questionKey, kind: "single", prompt: SUBJECT, selected: ["Yes"] } }],
    });
    expect(pick.status).toBe(200);
    expect(pick.json().questions[0]).toMatchObject({ state: "picked", revision: 1 });
    const reply = await ask(a, "POST", `messages/${messageId}/reply`, {
      idempotency_key: "00000000-0000-4000-8000-0000000000a2",
      words: "Go ahead.",
      questions: [{ key: questionKey, revision: 1 }],
    });
    expect(reply.status).toBe(200);
    expect(reply.json()).toMatchObject({ replayed: false, reply: { reply_to: messageId, author: { kind: "person" } } });
    const got = await agent.waitForReply(threadId, 20);
    expect(got.status).toBe("replied");
    expect(got.reply.body).toContain("Go ahead.");
    expect(got.reply.body).toContain("Yes");
    say(`pick and Send as commands: results 200; the agent's wait_for_reply: replied, "${got.reply.body.split("\n")[0]}"`);
    // Both commands are gone from the relay once applied.
    await until(() => rows("commands").length, (n) => n === 0, "the commands deleted once applied");

    // A replayed command writes nothing: the same reply, sealed again, answers the stored result.
    const cursorBefore = ((await (await fetch(`${base}/api/inbox/threads`)).json()) as Json).cursor;
    const again = await ask(a, "POST", `messages/${messageId}/reply`, {
      idempotency_key: "00000000-0000-4000-8000-0000000000a2",
      words: "Go ahead.",
      questions: [{ key: questionKey, revision: 1 }],
    });
    expect(again.status).toBe(200);
    expect(again.json().reply.id).toBe(reply.json().reply.id);
    const cursorAfter = ((await (await fetch(`${base}/api/inbox/threads`)).json()) as Json).cursor;
    expect(cursorAfter).toBe(cursorBefore);
    expect((await agent.readThread(threadId)).messages.filter((m: Json) => m.author.kind === "person").length).toBe(1);
    say(`the same reply command again: result 200 with the same reply id ${again.json().reply.id}; store cursor ${cursorBefore} before and after`);
  }, 60_000);

  test("a down envelope reflected up as a command is refused: the up key does not open it, and nothing is written", async () => {
    const item = rows("items").find((row) => row.device_id === a.id)!;
    const whole = rows("items").filter((row) => row.device_id === a.id && row.n === item.n).map((row) => row.data).join("");
    const cursorBefore = ((await (await fetch(`${base}/api/inbox/threads`)).json()) as Json).cursor;
    const answer = await atRelay(a, "POST", "/commands", { id: "reflected-1", ciphertext: whole });
    expect(answer.status).toBe(202);
    await until(inboxLog, (log) => log.includes(`command ${a.id} refused`), "the refusal in the Inbox's log");
    await until(() => rows("commands").length, (n) => n === 0, "the refused command let go");
    await fetchItems(a);
    expect(a.seen.some((s) => s.id === "reflected-1")).toBe(false);
    expect(((await (await fetch(`${base}/api/inbox/threads`)).json()) as Json).cursor).toBe(cursorBefore);
    say("a held down item posted back as a command: refused (no result item, store cursor unchanged), and deleted at the relay");

    // A relay that relabels a command: sealed with one id, posted under another. No result under either id.
    const ciphertext = await encryptWithKey(JSON.stringify({ v: 1, id: "sealed-id-y", method: "GET", path: "/api/inbox/device/threads" }), a.upKey);
    expect((await atRelay(a, "POST", "/commands", { id: "frame-label-x", ciphertext })).status).toBe(202);
    await until(inboxLog, (log) => log.includes(`command ${a.id} refused: its sealed id is not the frame's`), "the relabelled command refused");
    await until(() => rows("commands").length, (n) => n === 0, "the relabelled command let go");
    await fetchItems(a);
    expect(a.seen.some((s) => s.id === "frame-label-x" || s.id === "sealed-id-y")).toBe(false);
    say("a command sealed with one id and posted under another: refused, no result under either id, deleted at the relay");
  }, 60_000);

  test("an attachment's view and an HTML asset's bytes arrive by request", async () => {
    const attachments = (await ask(a, "GET", `threads/${threadId}/attachments`)).json().attachments as Json[];
    const plan = attachments.find((x) => x.name === "retry-plan.md")!;
    const page = attachments.find((x) => x.name === "ticket.html")!;
    const planView = await ask(a, "GET", `attachments/${plan.id}/view?version=sent`);
    expect(planView.json()).toMatchObject({ version: plan.sent_sha256, text: expect.stringContaining("Retry at most three times") });
    const pageView = (await ask(a, "GET", `attachments/${page.id}/view`)).json();
    const baseHref = /<base href="\/api\/html-assets\/([^/"]+)\//.exec(pageView.html)![1]!;
    const sun = await ask(a, "GET", `html-assets/${baseHref}/images/sun.png`);
    expect(sun.status).toBe(200);
    expect(sun.contentType).toBe("image/png");
    expect(sun.bytes.equals(PNG)).toBe(true);
    // Its envelope is held in more than one row: the relay sets no item size of its own.
    expect(rows("items").some((row) => row.part > 0)).toBe(true);

    // An answer past the platform's WebSocket message limit comes back as a 413, and the next command is still answered.
    const tide = await ask(a, "GET", `html-assets/${baseHref}/images/tide.png`);
    expect(tide.status).toBe(413);
    expect(tide.json()).toMatchObject({ code: "result_too_large", limit_bytes: 32 * 1024 * 1024 });
    expect((await ask(a, "GET", "threads")).status).toBe(200);
    say("html-assets/<token>/images/tide.png (26 MB, past the 32 MiB WebSocket message once sealed): result 413 result_too_large; the next GET threads: 200");
    say(`attachments/${plan.id}/view?version=sent: the plan's text as sent; html-assets/<token>/images/sun.png: ${sun.bytes.length} bytes, equal to the file, image/png`);
  }, 60_000);

  test("a message's image, from a question's context, arrives by request; one at the 10 MB cap still fits one result frame", async () => {
    mkdirSync(join(w.project, "shots"), { recursive: true });
    writeFileSync(join(w.project, "shots", "mock.png"), PNG);
    // Exactly the route's byte cap (MAX_REVIEW_IMAGE_PREVIEW_BYTES): base64 twice and sealed, still under 32 MiB.
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(10 * 1024 * 1024 - 8, 9)]);
    writeFileSync(join(w.project, "shots", "big.png"), big);
    const body = ["Two layouts.", "", ":::question", "Keep the new header?", "![mock](shots/mock.png)", "![big](shots/big.png)", "- Keep it", "- Go back", ":::"].join("\n");
    const sent = await agent.send({ project_path: w.project, body, thread: "relay-images" });
    const id = sent.message_id as string;
    const mock = await ask(a, "GET", `messages/${id}/image?path=${encodeURIComponent("shots/mock.png")}`);
    expect(mock.status).toBe(200);
    expect(mock.contentType).toBe("image/png");
    expect(mock.bytes.equals(PNG)).toBe(true);
    const large = await ask(a, "GET", `messages/${id}/image?path=${encodeURIComponent("shots/big.png")}`);
    expect(large.status).toBe(200);
    expect(large.bytes.equals(big)).toBe(true);
    const unshown = await ask(a, "GET", `messages/${id}/image?path=${encodeURIComponent("pages/images/sun.png")}`);
    expect(unshown.status).toBe(403);
    expect(unshown.json()).toMatchObject({ code: "image_not_referenced" });
    say(`messages/${id}/image?path=shots/mock.png (in a question's context): 200 image/png; shots/big.png (10 MiB, the cap): 200, equal to the file; an unreferenced path: 403 image_not_referenced`);
  }, 60_000);

  test("the Inbox stopped: the answer waits at the relay; started, it is applied once and the agent receives it once", async () => {
    const second = await agent.send({ project_path: w.project, thread: "deploy", body: [":::question", "Deploy to staging now?", "- Yes", "- No", ":::"].join("\n") });
    const secondId = second.message_id ?? second.thread_id;
    const q = await until(
      async () => (await fetchItems(a), a.seen.find((item) => item.kind === "question" && item.question.message_id === secondId)),
      (item) => item !== undefined,
      "the second question down",
    );
    await stopInbox(w);
    await agent.close();
    // The relay learns the socket closed when the stopped Inbox's close reaches it.
    await until(async () => (await fetchItems(a)).inbox_online, (online) => online === false, "the relay to see the Inbox gone");
    const key = "00000000-0000-4000-8000-0000000000b1";
    const body = { idempotency_key: key, questions: [{ key: q!.question.key, revision: 0, answer: { v: 1, key: q!.question.key, kind: "single", prompt: "Deploy to staging now?", selected: ["No"] } }] };
    const queued = await command(a, "POST", `messages/${secondId}/reply`, body);
    expect(queued).toMatchObject({ status: 202, body: { queued: true, inbox_online: false } });
    const twice = await command(a, "POST", `messages/${secondId}/reply`, body);
    expect(twice).toMatchObject({ status: 200, body: { queued: false, inbox_online: false } });
    expect(rows("commands").map((row) => row.id)).toEqual([key]);
    record("storage-2-command-queued.json", dumpMailbox(relay, mailbox.mailbox_id));
    expect(holds(storageBytes(relay), "Deploy to staging")).toBe(false);
    say(`Inbox stopped: the lock-screen answer queued at the relay (202 queued, inbox_online false); sent again: 200 queued false; one command held`);

    startTheInbox();
    agent = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Claude Code", host: "claude-code", cwd: w.project });
    const result = await resultOf(a, key);
    expect(result.status).toBe(200);
    const got = await agent.waitForReply(second.thread_id, 20);
    expect(got.status).toBe("replied");
    expect(got.reply.body).toContain("No");
    // Waiting again from the cursor that answer returned: no second reply comes.
    expect((await agent.waitForReply(second.thread_id, 2, got.cursor)).status).toBe("waiting");
    expect((await agent.readThread(second.thread_id)).messages.filter((m: Json) => m.author.kind === "person").length).toBe(1);
    await until(() => rows("commands").length, (n) => n === 0, "the command deleted once applied");
    say(`Inbox started: the command applied once (result 200); wait_for_reply: replied; again: waiting; one person reply in the thread`);
  }, 60_000);

  test("acknowledged items are deleted: the storage is empty of envelopes", async () => {
    await fetchItems(a);
    expect((await atRelay(a, "POST", "/ack", { through: a.n })).status).toBe(204);
    expect(rows("items")).toEqual([]);
    expect(rows("commands")).toEqual([]);
    record("storage-3-after-ack.json", dumpMailbox(relay, mailbox.mailbox_id));
    say(`ack through ${a.n}: items and commands tables empty`);
  }, 60_000);

  test("a store line past the WebSocket message limit goes down as a placeholder, and the next line still arrives; a command past it is refused at the relay", async () => {
    // The person pastes a 25 MiB log into a reply on the computer (the store caps nothing); sealed, its item would pass 32 MiB.
    const health = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
    const pasted = await win(`/api/inbox/messages/${messageId}/reply`, { serverSession: health.serverSession, idempotency_key: "00000000-0000-4000-8000-0000000000c1", words: `The whole log:\n\n${"x".repeat(25 * 1024 * 1024)}` });
    expect(pasted.status).toBe(200);
    const giantId = ((await pasted.json()) as Json).reply.id as string;
    const after = await agent.send({ project_path: w.project, thread: "after the giant", body: "The line after the giant one." });
    const seen = await until(
      async () => (await fetchItems(a), a.seen),
      (items) => items.some((item) => item.kind === "message" && item.id === (after.message_id ?? after.thread_id)),
      "the line after the giant one",
      60_000,
    );
    const placeholder = seen.find((item) => item.kind === "message" && item.id === giantId)!;
    expect(placeholder).toEqual({ n: expect.any(Number), v: 1, type: "record", after: expect.any(Number), seq: expect.any(Number), kind: "message", id: giantId, too_large: true });
    await until(inboxLog, (log) => log.includes(`record ${placeholder.seq} too large for ${a.id}`), "the log line");
    say(`a 25 MiB reply: down as the placeholder { seq ${placeholder.seq}, kind message, too_large: true }; the message after it delivered`);

    const huge = await atRelay(a, "POST", "/commands", { id: "huge-1", ciphertext: "A".repeat(32 * 1024 * 1024) });
    expect(huge.status).toBe(413);
    expect(await huge.json()).toMatchObject({ code: "command_too_large", limit_bytes: 32 * 1024 * 1024 });
    expect(rows("commands")).toEqual([]);
    expect((await ask(a, "GET", "threads")).status).toBe(200);
    say("a 32 MiB command: 413 command_too_large at the relay, not held; the next command answered");
    await fetchItems(a);
    expect((await atRelay(a, "POST", "/ack", { through: a.n })).status).toBe(204);
  }, 120_000);

  test("a phone that read the store directly acknowledges by cursor; a removed phone's items are gone with it", async () => {
    await agent.send({ project_path: w.project, thread: "news", body: "The migration finished." });
    await until(() => rows("items").filter((row) => row.device_id === a.id).length, (n) => n > 0, "news held for the iPhone");
    const cursor = ((await (await fetch(`${base}/api/inbox/threads`)).json()) as Json).cursor;
    expect((await atRelay(a, "POST", "/ack", { cursor })).status).toBe(204);
    expect(rows("items").filter((row) => row.device_id === a.id)).toEqual([]);

    await agent.send({ project_path: w.project, thread: "news", body: "The backfill finished too." });
    await until(() => rows("items").filter((row) => row.device_id === a.id).length, (n) => n > 0, "held again");
    const health = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
    expect((await win(`/api/inbox/devices/${a.id}/revoke`, { serverSession: health.serverSession })).status).toBe(200);
    await until(() => rows("devices").map((row) => row.id), (ids) => !ids.includes(a.id), "the iPhone removed");
    expect(rows("items").filter((row) => row.device_id === a.id)).toEqual([]);
    expect((await atRelay(a, "GET", "/items?after=0")).status).toBe(404);
    record("storage-4-after-revoke.json", dumpMailbox(relay, mailbox.mailbox_id));
    say("ack by store cursor deletes the record items; the iPhone revoked: its device row and held items gone, its items route 404");
  }, 60_000);
});

describe("a relay without the APNs key or an FCM service account", () => {
  let relay: Relay;
  const tokenSecret = "mailbox-secret-for-the-token-proof";
  let tokenMailbox = "";

  beforeAll(async () => {
    relay = await startRelay("no-key", {});
    // Made before the creation-brake test spends this minute's creations.
    const make = async (secret: string) => {
      const made = await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(secret) }) });
      expect(made.status).toBe(201);
      return ((await made.json()) as Json).mailbox_id as string;
    };
    tokenMailbox = await make(tokenSecret);
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

  test("10.1: one push token per device, its kind in hello; no FCM service account answers no_fcm_key, neither token no_push_token", async () => {
    const secret = tokenSecret;
    const mailbox_id = tokenMailbox;
    const at = (method: string, path: string, body: unknown, bearer: string) =>
      fetch(`${relay.url}/v1/mailboxes/${mailbox_id}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const dev = "dev_00000000000000000000000001";
    const row = () => readMailbox(relay, mailbox_id).devices[0]!;
    const flags = async () => ((await helloOf(relay.url, mailbox_id, secret)).devices as Json[]).map((d) => ({ apns: d.apns, fcm: d.fcm }));
    const push = async () => {
      const answer = await at("POST", "/push", { device_id: dev, collapse_id: "c".repeat(64), ciphertext: "AAAAexample" }, secret);
      return { status: answer.status, body: (await answer.json()) as Json };
    };
    expect((await at("PUT", `/devices/${dev}`, { secret_sha256: sha256("phone"), cursor: 0 }, secret)).status).toBe(200);
    expect(row()).toMatchObject({ apns_token: null, fcm_token: null });
    expect(await flags()).toEqual([{ apns: false, fcm: false }]);
    expect(await push()).toEqual({ status: 200, body: { sent: false, reason: "no_push_token" } });

    // The FCM token: kept plain, only the device's own bearer, a token that is not one refused.
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "fcm-ok:APA91bExample_token-1" }, secret)).status).toBe(401);
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "not a token" }, "phone")).status).toBe(400);
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "f".repeat(4097) }, "phone")).status).toBe(400);
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "f".repeat(4096) }, "phone")).status).toBe(204);
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "fcm-ok:APA91bExample_token-1" }, "phone")).status).toBe(204);
    expect(row()).toMatchObject({ apns_token: null, apns_environment: null, fcm_token: "fcm-ok:APA91bExample_token-1" });
    expect(await flags()).toEqual([{ apns: false, fcm: true }]);
    for (let i = 0; i < 2; i++) expect(await push()).toEqual({ status: 200, body: { sent: false, reason: "no_fcm_key" } });
    await until(relay.log, (log) => log.includes("no FCM service account"), "the log line");
    expect(relay.log().split("no FCM service account").length - 1).toBe(1);

    // Registering APNs clears FCM, and the reverse.
    expect((await at("PUT", `/devices/${dev}/apns`, { token: TOKEN_OK, environment: "sandbox" }, "phone")).status).toBe(204);
    expect(row()).toMatchObject({ apns_token: TOKEN_OK, apns_environment: "sandbox", fcm_token: null });
    expect(await flags()).toEqual([{ apns: true, fcm: false }]);
    expect(await push()).toEqual({ status: 200, body: { sent: false, reason: "no_apns_key" } });
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "fcm-ok-2" }, "phone")).status).toBe(204);
    expect(row()).toMatchObject({ apns_token: null, apns_environment: null, fcm_token: "fcm-ok-2" });
    expect(await flags()).toEqual([{ apns: false, fcm: true }]);

    // `token: null` removes it; a removed device takes its token with it.
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: null }, "phone")).status).toBe(204);
    expect(row()).toMatchObject({ apns_token: null, fcm_token: null });
    expect(await push()).toEqual({ status: 200, body: { sent: false, reason: "no_push_token" } });
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "fcm-ok-3" }, "phone")).status).toBe(204);
    expect((await at("DELETE", `/devices/${dev}`, undefined, secret)).status).toBe(204);
    expect(readMailbox(relay, mailbox_id).devices).toEqual([]);
  }, 30_000);

  test("a mailbox made before R3 (R2's devices table, no fcm_token) gains the column on its first request", async () => {
    const at = (method: string, path: string, body: unknown, bearer: string) =>
      fetch(`${relay.url}/v1/mailboxes/${tokenMailbox}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const dev = "dev_00000000000000000000000003";
    expect((await at("PUT", `/devices/${dev}`, { secret_sha256: sha256("phone"), cursor: 5 }, tokenSecret)).status).toBe(200);
    expect((await at("PUT", `/devices/${dev}/apns`, { token: TOKEN_OK, environment: "sandbox" }, "phone")).status).toBe(204);
    await relay.stop();
    // Rewrite the devices table exactly as R2 made it, keeping the row.
    const file = mailboxFiles(relay).find((f) => {
      const db = new Database(f, { readonly: true });
      try {
        return (db.query("SELECT name FROM __miniflare_do_name").get() as { name: string } | null)?.name === tokenMailbox;
      } finally {
        db.close();
      }
    })!;
    const db = new Database(file);
    try {
      db.exec(
        "BEGIN; CREATE TABLE devices_r2 (id TEXT PRIMARY KEY, secret_sha256 TEXT NOT NULL, carriage INTEGER NOT NULL, cursor INTEGER NOT NULL, apns_token TEXT, apns_environment TEXT, next_n INTEGER NOT NULL DEFAULT 1); " +
          "INSERT INTO devices_r2 SELECT id, secret_sha256, carriage, cursor, apns_token, apns_environment, next_n FROM devices; DROP TABLE devices; ALTER TABLE devices_r2 RENAME TO devices; COMMIT;",
      );
    } finally {
      db.close();
    }
    expect(Object.keys(readMailbox(relay, tokenMailbox).devices[0]!)).not.toContain("fcm_token");

    relay = await startRelay("no-key", {}, { keep: true });
    expect((await helloOf(relay.url, tokenMailbox, tokenSecret)).devices).toEqual([{ device_id: dev, cursor: 5, carriage: true, apns: true, fcm: false }]);
    expect(readMailbox(relay, tokenMailbox).devices[0]).toMatchObject({ id: dev, apns_token: TOKEN_OK, fcm_token: null });
    expect((await at("PUT", `/devices/${dev}/fcm`, { token: "fcm-ok-r2" }, "phone")).status).toBe(204);
    expect(readMailbox(relay, tokenMailbox).devices[0]).toMatchObject({ id: dev, apns_token: null, fcm_token: "fcm-ok-r2" });
  }, 120_000);
});

// ── FCM (R3, section 10) ──

describe("FCM: an Android phone gets its pushes through Google's hosts, played locally", () => {
  let google: Awaited<ReturnType<typeof fakeGoogle>>;
  let relay: Relay;
  let w: InboxWorld;
  let stubs: string[] = [];
  let agent: SimAgent;
  let base = "";
  let env: Record<string, string> = {};
  let phone: { id: string; secret: string; key: string; collapseKey: string; relaySecret: string };
  let mailbox: { url: string; mailbox_id: string; secret: string };
  const FCM_OK = "fcm-ok:APA91bH0000000000000000000000000000000000000000000000000000000000000_proof";

  const win = (path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Origin: base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const atRelay = (method: string, path: string, body?: unknown, bearer = phone.relaySecret) =>
    fetch(`${mailbox.url}/v1/mailboxes/${mailbox.mailbox_id}${path}`, {
      method,
      headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const inboxLog = () => readFileSync(join(w.dataDir, "inbox", "inbox.log"), "utf8");
  const collapseOf = (threadId: string) => createHmac("sha256", Buffer.from(phone.collapseKey, "base64url")).update(threadId).digest("hex");
  const row = () => readMailbox(relay, mailbox.mailbox_id).devices.find((d) => d.id === phone.id)!;
  const question = (thread: string, prompt: string, context?: string) =>
    agent.send({ project_path: w.project, thread, body: [":::question", prompt, ...(context ? [context] : []), "- Yes", "- No", "Recommended: Yes", ":::"].join("\n") });
  /** The relay's answer to a push posted by hand with the mailbox's bearer, as the Inbox posts it. */
  const pushByHand = async () => {
    const answer = await atRelay("POST", "/push", { device_id: phone.id, collapse_id: "c".repeat(64), ciphertext: "AAAAexample" }, mailbox.secret);
    return { status: answer.status, body: (await answer.json()) as Json };
  };

  beforeAll(async () => {
    const account = await throwawayServiceAccount();
    google = await fakeGoogle(account.publicKey);
    relay = await startRelay("fcm", { FCM_SERVICE_ACCOUNT: account.json, FCM_ORIGIN: google.fcmOrigin, FCM_OAUTH_ORIGIN: google.oauthOrigin });
    stubs = stubBuiltHtml();
    w = createInboxWorld("plannotator-relay-fcm-", "fcm", "R3", { phones: true });
    env = { ...(process.env as Record<string, string>), ...worldEnv(w), PLANNOTATOR_RELAY_URL: relay.url };
    // A harness proves its data dir before it spawns (row 5109): a temp path, never ~/.plannotator.
    expect(realpathSync(w.root).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(env.PLANNOTATOR_DATA_DIR).toBe(w.dataDir);
    const run = Bun.spawnSync([join(w.bin, "plannotator"), "inbox", "--background"], { env, cwd: w.root });
    if (run.exitCode !== 0) throw new Error(`inbox --background failed: ${run.stderr.toString()}`);
    base = `http://127.0.0.1:${registry(w).port}`;
    agent = await SimAgent.connect({ binary: join(w.bin, "plannotator"), env, name: "Claude Code", host: "claude-code", cwd: w.project });
  }, 120_000);

  afterAll(async () => {
    await agent?.close().catch(() => {});
    if (w) await destroyInboxWorld(w);
    removeStubbedHtml(stubs);
    relay?.stop();
    google?.close();
  });

  test("an Android phone pairs and registers its FCM token; an agent's question is one data-only FCM message, sealed, collapsed per thread", async () => {
    const health = (await (await fetch(`${base}/api/inbox/health`)).json()) as Json;
    const offer = (await (await win("/api/inbox/pairing", { serverSession: health.serverSession })).json()) as Json;
    const secret = /[?&]secret=([A-Za-z0-9_-]+)/.exec(offer.link)![1]!;
    const paired = await fetch(`${base}/api/inbox/device/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ secret, name: "Pixel", platform: "android" }) });
    expect(paired.status).toBe(201);
    const body = (await paired.json()) as Json;
    expect(body.device.platform).toBe("android");
    phone = { id: body.device.id, secret: body.secret, ...(await deriveRelayKeys(body.secret, body.device.id)) };
    mailbox = JSON.parse(readFileSync(join(w.dataDir, "inbox", "relay.json"), "utf8"));
    expect((await atRelay("PUT", `/devices/${phone.id}/fcm`, { token: FCM_OK })).status).toBe(204);
    expect(row()).toMatchObject({ fcm_token: FCM_OK, apns_token: null });

    const sent = await question("first", SUBJECT, "They take about four minutes against the test key.");
    await until(() => google.sent.length, (n) => n === 1, "one FCM message");
    await sleep(1000);
    expect(google.sent.length).toBe(1);
    const message = google.sent[0]!;
    expect(message.path).toBe(`/v1/projects/${FCM_PROJECT}/messages:send`);
    expect(message.authorization).toBe("Bearer ya29.proof-1");
    // Exactly the contract's body: data only, the envelope as `e`, high priority, the collapse id as the collapse key.
    expect(Object.keys(message.body)).toEqual(["message"]);
    expect(message.body.message).toEqual({ token: FCM_OK, data: { e: expect.any(String) }, android: { priority: "high", collapse_key: collapseOf(sent.thread_id) } });
    expect(JSON.stringify(message.body)).not.toContain("retry");
    expect(JSON.parse(await decryptWithKey(message.body.message.data.e, phone.key))).toEqual({
      v: 1,
      type: "push",
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
    // The JWT the relay signed: RS256 under the service account's key, checked by the token endpoint.
    expect(google.exchanges).toHaveLength(1);
    expect(google.exchanges[0]).toMatchObject({ valid: true, header: { alg: "RS256", typ: "JWT", kid: FCM_KEY_ID }, claims: { iss: FCM_CLIENT, aud: "https://oauth2.googleapis.com/token" } });
    await until(inboxLog, (log) => log.includes(`${phone.id} 202`), "the Inbox's log line");
  }, 60_000);

  test("the access token is reused: a second push mints no new one; the thread's next push carries the same collapse key", async () => {
    const sent = await question("first", "And the slow suite too?");
    await until(() => google.sent.length, (n) => n === 2, "the second FCM message");
    expect(google.exchanges).toHaveLength(1);
    expect(google.sent[1]!.authorization).toBe("Bearer ya29.proof-1");
    expect(google.sent[1]!.body.message.android.collapse_key).toBe(collapseOf(sent.thread_id));
    expect(google.sent[1]!.body.message.android.collapse_key).toBe(google.sent[0]!.body.message.android.collapse_key);
  }, 60_000);

  test("the size ladder holds for FCM: a long context is dropped against Apple's 4096 bytes, and FCM's data payload is never larger than the APNs body", async () => {
    const before = google.sent.length;
    await question("long", "Run the long suite?", "The four-minute run hits the test clock twice. ".repeat(120));
    await until(() => google.sent.length, (n) => n === before + 1, "one FCM message");
    const e = google.sent[before]!.body.message.data.e as string;
    const summary = JSON.parse(await decryptWithKey(e, phone.key));
    expect(summary.question).toMatchObject({ prompt: "Run the long suite?", context: null });
    // FCM counts the data payload (`{"e":"<envelope>"}`) against its 4096 bytes; the Inbox measures the APNs body around the same envelope.
    const data = Buffer.byteLength(JSON.stringify(google.sent[before]!.body.message.data));
    expect(data).toBeLessThan(Buffer.byteLength(apnsBody(e)));
    expect(Buffer.byteLength(apnsBody(e))).toBeLessThanOrEqual(4096);
    // And for any envelope, from empty to past the ceiling: the relay's own FCM data is the smaller.
    for (const length of [0, 1, 100, 2000, 4040, 4096, 10_000]) {
      const envelope = "A".repeat(length);
      expect(Buffer.byteLength(JSON.stringify(fcmMessage(FCM_OK, envelope, "c".repeat(64)).message.data))).toBeLessThan(Buffer.byteLength(apnsBody(envelope)));
    }
  }, 60_000);

  test("a 401 from FCM is 502 fcm_failed with fcm_status 401 and drops the access token; the next push mints a fresh one", async () => {
    expect(google.exchanges).toHaveLength(1);
    google.revoke("ya29.proof-1");
    expect(await pushByHand()).toEqual({ status: 502, body: { error: "FCM answered 401.", code: "fcm_failed", fcm_status: 401, fcm_reason: null } });
    expect(row().fcm_token).toBe(FCM_OK);
    const before = google.sent.length;
    expect(await pushByHand()).toEqual({ status: 202, body: { sent: true } });
    expect(google.exchanges).toHaveLength(2);
    expect(google.sent[before]!.authorization).toBe("Bearer ya29.proof-2");
  }, 30_000);

  test("a 5xx from FCM is 502 fcm_failed with FCM's status and errorCode, and keeps the token", async () => {
    expect((await atRelay("PUT", `/devices/${phone.id}/fcm`, { token: "fcm-down-1" })).status).toBe(204);
    expect(await pushByHand()).toEqual({ status: 502, body: { error: "FCM answered 503 UNAVAILABLE.", code: "fcm_failed", fcm_status: 503, fcm_reason: "UNAVAILABLE" } });
    expect(row().fcm_token).toBe("fcm-down-1");
    await question("down", "Retry the deploy?");
    await until(inboxLog, (log) => log.includes(`${phone.id} 502 fcm_failed`), "the Inbox's log line");
  }, 60_000);

  test("UNREGISTERED deletes the token and answers fcm_gone; the next push answers no_push_token", async () => {
    expect((await atRelay("PUT", `/devices/${phone.id}/fcm`, { token: "fcm-gone-1" })).status).toBe(204);
    expect(await pushByHand()).toEqual({ status: 200, body: { sent: false, reason: "fcm_gone" } });
    expect(row()).toMatchObject({ fcm_token: null, apns_token: null });

    expect((await atRelay("PUT", `/devices/${phone.id}/fcm`, { token: "fcm-gone-2" })).status).toBe(204);
    const before = google.sent.length;
    await question("gone", "Roll back?");
    await until(() => google.sent.length, (n) => n === before + 1, "the push FCM refuses");
    await until(() => row().fcm_token, (t) => t === null, "the token deleted");
    await until(inboxLog, (log) => log.includes(`${phone.id} 200 fcm_gone`), "fcm_gone");
    await question("gone again", "Roll back now?");
    await until(inboxLog, (log) => log.includes(`${phone.id} 200 no_push_token`), "no_push_token");
    expect(google.sent.length).toBe(before + 1);
  }, 60_000);

  test("the relay's storage holds the FCM token in the clear, and no key, secret, subject, body or Google credential", async () => {
    expect((await atRelay("PUT", `/devices/${phone.id}/fcm`, { token: FCM_OK })).status).toBe(204);
    const bytes = storageBytes(relay);
    expect(holds(bytes, FCM_OK)).toBe(true);
    expect(holds(bytes, sha256(phone.relaySecret))).toBe(true);
    for (const value of [phone.secret, phone.key, phone.relaySecret, mailbox.secret, SUBJECT, "Run the long suite?", "four minutes", "PRIVATE KEY", "ya29.proof"]) {
      expect(holds(bytes, value)).toBe(false);
    }
  });
});

describe("FCM with a service account Google refuses", () => {
  let google: Awaited<ReturnType<typeof fakeGoogle>>;
  let relay: Relay;

  beforeAll(async () => {
    // The relay signs with one throwaway key; Google knows another.
    const signer = await throwawayServiceAccount();
    const known = await throwawayServiceAccount();
    google = await fakeGoogle(known.publicKey);
    relay = await startRelay("fcm-refused", { FCM_SERVICE_ACCOUNT: signer.json, FCM_ORIGIN: google.fcmOrigin, FCM_OAUTH_ORIGIN: google.oauthOrigin });
  }, 90_000);
  afterAll(() => {
    relay?.stop();
    google?.close();
  });

  test("concurrent pushes share one refused token exchange: 502 fcm_failed for each, nothing reaches FCM, the refusal is remembered, the tokens kept", async () => {
    const secret = "mailbox-secret-for-the-refused-proof";
    const { mailbox_id } = (await (await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(secret) }) })).json()) as Json;
    const at = (method: string, path: string, body: unknown, bearer: string) =>
      fetch(`${relay.url}/v1/mailboxes/${mailbox_id}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const devs = ["dev_00000000000000000000000000", "dev_00000000000000000000000001", "dev_00000000000000000000000002"];
    for (const dev of devs) {
      await at("PUT", `/devices/${dev}`, { secret_sha256: sha256(`phone-${dev}`), cursor: 0 }, secret);
      expect((await at("PUT", `/devices/${dev}/fcm`, { token: `fcm-ok-${dev}` }, `phone-${dev}`)).status).toBe(204);
    }
    const push = async (dev: string) => {
      const answer = await at("POST", "/push", { device_id: dev, collapse_id: "c".repeat(64), ciphertext: "AAAAexample" }, secret);
      return { status: answer.status, body: (await answer.json()) as Json };
    };
    const refused = { status: 502, body: { error: "Google's token endpoint answered 400 invalid_grant.", code: "fcm_failed" } };
    expect(await Promise.all(devs.map(push))).toEqual([refused, refused, refused]);
    expect(google.exchanges).toHaveLength(1);
    expect(google.exchanges[0]!.valid).toBe(false);
    // Within the minute the refusal is answered from memory: Google is not asked again.
    expect(await push(devs[0]!)).toEqual(refused);
    expect(google.exchanges).toHaveLength(1);
    expect(google.sent).toEqual([]);
    expect(readMailbox(relay, mailbox_id).devices.map((d) => d.fcm_token)).toEqual(devs.map((dev) => `fcm-ok-${dev}`));
  }, 30_000);
});

describe("overrides that do not name a loopback host, and a private key that cannot be read", () => {
  let relay: Relay;

  beforeAll(async () => {
    const broken = JSON.stringify({ type: "service_account", project_id: FCM_PROJECT, private_key_id: FCM_KEY_ID, private_key: "-----BEGIN PRIVATE KEY-----\nnot*a*key\n-----END PRIVATE KEY-----\n", client_email: FCM_CLIENT });
    // Every host override names a host that is not loopback; the keys fail before any request, so nothing leaves the machine.
    relay = await startRelay("fenced", {
      FCM_SERVICE_ACCOUNT: broken,
      FCM_ORIGIN: "http://fcm.example.invalid",
      FCM_OAUTH_ORIGIN: "https://127.0.0.1.example.invalid",
      APNS_KEY: "bm90IGEga2V5",
      APNS_KEY_ID: "KEY0000000",
      APNS_TEAM_ID: "TEAM000000",
      APNS_ORIGIN: "http://apple.example.invalid:2197",
    });
  }, 90_000);
  afterAll(() => relay?.stop());

  test("each override is ignored with one log line; an unreadable private key is fcm_failed, not a transport failure", async () => {
    const secret = "mailbox-secret-for-the-fenced-proof";
    const { mailbox_id } = (await (await fetch(`${relay.url}/v1/mailboxes`, { method: "POST", body: JSON.stringify({ secret_sha256: sha256(secret) }) })).json()) as Json;
    const at = (method: string, path: string, body: unknown, bearer: string) =>
      fetch(`${relay.url}/v1/mailboxes/${mailbox_id}${path}`, { method, headers: { Authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
    const push = async (dev: string) => {
      const answer = await at("POST", "/push", { device_id: dev, collapse_id: "c".repeat(64), ciphertext: "AAAAexample" }, secret);
      return { status: answer.status, body: (await answer.json()) as Json };
    };
    const android = "dev_00000000000000000000000000";
    const iphone = "dev_00000000000000000000000001";
    for (const dev of [android, iphone]) await at("PUT", `/devices/${dev}`, { secret_sha256: sha256("phone"), cursor: 0 }, secret);
    expect((await at("PUT", `/devices/${android}/fcm`, { token: "fcm-ok-1" }, "phone")).status).toBe(204);
    expect((await at("PUT", `/devices/${iphone}/apns`, { token: TOKEN_OK, environment: "sandbox" }, "phone")).status).toBe(204);

    const unreadable = { status: 502, body: { error: "the service account's private key could not be read", code: "fcm_failed" } };
    expect(await push(android)).toEqual(unreadable);
    expect(await push(android)).toEqual(unreadable);
    expect(readMailbox(relay, mailbox_id).devices.find((d) => d.id === android)!.fcm_token).toBe("fcm-ok-1");
    expect(await push(iphone)).toMatchObject({ status: 502, body: { code: "apns_failed" } });
    await push(iphone);

    for (const name of ["FCM_ORIGIN", "FCM_OAUTH_ORIGIN", "APNS_ORIGIN"]) {
      await until(relay.log, (log) => log.includes(`relay: ${name} ignored (not loopback)`), `the ${name} log line`);
      expect(relay.log().split(`relay: ${name} ignored (not loopback)`).length - 1).toBe(1);
    }
  }, 30_000);
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
