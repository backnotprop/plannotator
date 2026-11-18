/**
 * One mailbox: a Durable Object per Inbox (adr/implementation/inbox-mobile.md,
 * sections 4 and 10). It holds what it cannot read: the SHA-256 of the
 * Inbox's mailbox secret and of each phone's relay secret, each phone's relay
 * switch (`carriage`), its one push token, APNs with its environment or FCM
 * (Apple and Google need them in the clear), the store cursor the Inbox last
 * gave for it, and the envelopes in transit: down items for the phone,
 * commands up for the Inbox. Never a key, a secret, a subject or a body: a
 * push's envelope goes to Apple or Google and is not kept. Logs carry ids and
 * status codes only.
 *
 * Deleted: a down item when the phone acknowledges it; every down item of a
 * phone that turns carriage off; a command when the Inbox reports it applied;
 * a device and everything it holds when the Inbox removes it; an APNs token
 * when Apple answers 410; an FCM token when FCM answers UNREGISTERED.
 *
 * An envelope is kept in parts of at most PART characters, one row each: a
 * SQLite-backed object refuses a row above 2 MB, and the relay sets no item
 * size of its own.
 *
 * Relay 1.1 (contract section 4, "Relay 1.1"): a device's own socket, told
 * only `{ n }` when an item is stored for it; a held command the phone takes
 * back before the Inbox has it; the APNs topic per device; a Live Activity
 * token and the `live` push of counts. Sockets are told apart by their tags
 * (`inbox`, or `device` and `device:<id>`), which survive hibernation; a
 * socket with no tag, accepted before 1.1, is the Inbox's.
 */
import { DurableObject } from "cloudflare:workers";
import type { CreateBrake } from "./create-brake";
import { apnsBody, sendPush, type ApnsEnvironment } from "./apns";
import { FcmAuthError, parseServiceAccount, sendFcm } from "./fcm";
import { HELD_COMMANDS_MAX, HELD_COMMAND_BYTES_MAX, heldMaxAgeMs, SIGNAL_LIMIT, SIGNAL_WINDOW_MS } from "./limits";
import { liveBody, readLive } from "./live";
import { allowedTopics, deviceTopic, isBundleId, liveTopic, RELAY_VERSION } from "./topics";

export interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
  /** Cloudflare's rate limiting binding on mailbox creation, the rule guides.show uses (wrangler.toml): the cheap first filter. Absent: no creation off loopback. */
  MAILBOX_CREATE_LIMITER?: RateLimit;
  /** One CreateBrake object per client address: the hard count behind the binding. Absent: no creation off loopback. */
  CREATE_BRAKE?: DurableObjectNamespace<CreateBrake>;
  /** The APNs key (.p8 text), its key id and the team id: Worker secrets. Without the key a push answers `no_apns_key`. */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** Replaces Apple's host in the relay's own proof under `wrangler dev` (a local HTTP/2 server). Honored only for a loopback host; never set in a deploy. */
  APNS_ORIGIN?: string;
  /** The FCM service account's JSON key file, as text: a Worker secret. Without it a push to an FCM token answers `no_fcm_key`. */
  FCM_SERVICE_ACCOUNT?: string;
  /** Replace fcm.googleapis.com and oauth2.googleapis.com in the relay's own proof under `wrangler dev` (local mocks). Honored only for a loopback host; never set in a deploy. */
  FCM_ORIGIN?: string;
  FCM_OAUTH_ORIGIN?: string;
  HELD_MAX_AGE_SECONDS?: string;
  /** The bundle ids a phone may name as its APNs topic, comma-separated (src/topics.ts). Unset: `ai.plannotator.app` alone. */
  APNS_TOPICS?: string;
}

interface DeviceRow {
  id: string;
  secret_sha256: string;
  carriage: number;
  cursor: number;
  apns_token: string | null;
  apns_environment: string | null;
  next_n: number;
  fcm_token: string | null;
  agent: number;
  signal_sha256: string | null;
  signal: string | null;
  /** The bundle id the phone named with its APNs token (1.1); null: the legacy topic. */
  apns_topic: string | null;
  /** The Live Activity push token and its environment (1.1). */
  live_token: string | null;
  live_environment: string | null;
  [key: string]: SqlStorageValue;
}

/** Close codes on a device's socket: a newer socket for the same device, and the device removed or started over. */
const DEVICE_SOCKET_REPLACED = 4000;
const DEVICE_SOCKET_REMOVED = 4001;

/** One row's share of an envelope: well under the 2 MB a SQLite-backed object allows a row. */
const PART = 1_000_000;

function parts(envelope: string): string[] {
  const out: string[] = [];
  for (let at = 0; at < envelope.length; at += PART) out.push(envelope.slice(at, at + PART));
  return out.length ? out : [""];
}

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
}

export function refuse(status: number, code: string, error = code.replace(/_/g, " ")): Response {
  return json({ error, code }, status);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const HASH = /^[0-9a-f]{64}$/;
export const DEVICE_ID = /^dev_[A-Za-z0-9]+$/;
const APNS_TOKEN = /^[0-9a-fA-F]+$/;
/** An FCM registration token: base64url text and colons, well under 4 KiB. */
const FCM_TOKEN = /^[A-Za-z0-9_:.-]{1,4096}$/;
const ENVELOPE = /^[A-Za-z0-9_-]+$/;
const COLLAPSE_ID = /^[\x21-\x7e]{1,64}$/;
/** A command's id: the phone's idempotency key, or a fresh random id for a read. */
const COMMAND_ID = /^[A-Za-z0-9_.:-]+$/;
export const SIGNAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;

function signalValue(): string {
  let binary = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** Cloudflare's WebSocket message limit (32 MiB), the platform's: a command whose frame to the Inbox would pass it could never be handed over. */
export const WEBSOCKET_MESSAGE_LIMIT = 32 * 1024 * 1024;

const isCursor = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function bearer(req: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec((req.headers.get("authorization") ?? "").trim());
  return match ? match[1]! : null;
}

let missingKeyLogged = false;
let missingFcmKeyLogged = false;

export class Mailbox extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
  }

  private schemaReady = false;

  /** Tables exist only once the mailbox was made, so a probe of an unknown id writes nothing. */
  private secretHash(): string | null {
    const made = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mailbox'").toArray().length > 0;
    if (!made) return null;
    this.schema();
    const row = this.sql.exec<{ secret_sha256: string }>("SELECT secret_sha256 FROM mailbox").toArray()[0];
    return row?.secret_sha256 ?? null;
  }

  /**
   * The tables, made with the mailbox. A mailbox made before R2 (R1's schema:
   * no `next_n`, no items, no commands) or before R3 (no `fcm_token`) gains
   * them on its first request.
   */
  private schema(): void {
    if (this.schemaReady) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS mailbox (secret_sha256 TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret_sha256 TEXT NOT NULL, carriage INTEGER NOT NULL, cursor INTEGER NOT NULL, apns_token TEXT, apns_environment TEXT, next_n INTEGER NOT NULL DEFAULT 1)",
    );
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray().map((c) => c.name);
    if (!columns.includes("next_n")) this.sql.exec("ALTER TABLE devices ADD COLUMN next_n INTEGER NOT NULL DEFAULT 1");
    if (!columns.includes("fcm_token")) this.sql.exec("ALTER TABLE devices ADD COLUMN fcm_token TEXT");
    if (!columns.includes("agent")) this.sql.exec("ALTER TABLE devices ADD COLUMN agent INTEGER NOT NULL DEFAULT 0");
    if (!columns.includes("signal_sha256")) this.sql.exec("ALTER TABLE devices ADD COLUMN signal_sha256 TEXT");
    if (!columns.includes("signal")) this.sql.exec("ALTER TABLE devices ADD COLUMN signal TEXT");
    // Relay 1.1: the topic named with the APNs token, and the Live Activity token. Added columns only, so 1.0's code reads and writes these tables as before (a rollback keeps working).
    for (const column of ["apns_topic", "live_token", "live_environment"]) if (!columns.includes(column)) this.sql.exec(`ALTER TABLE devices ADD COLUMN ${column} TEXT`);
    // Down items: `cursor` is the record's store seq, null for a result.
    this.sql.exec("CREATE TABLE IF NOT EXISTS items (device_id TEXT NOT NULL, n INTEGER NOT NULL, part INTEGER NOT NULL, cursor INTEGER, data TEXT NOT NULL, PRIMARY KEY (device_id, n, part))");
    // Commands up, in the order they arrived (`seq`).
    this.sql.exec("CREATE TABLE IF NOT EXISTS commands (seq INTEGER NOT NULL, device_id TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (device_id, id, part))");
    for (const table of ["items", "commands"]) {
      const held = this.sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map((c) => c.name);
      if (!held.includes("held_at")) {
        this.sql.exec(`ALTER TABLE ${table} ADD COLUMN held_at INTEGER`);
        this.sql.exec(`UPDATE ${table} SET held_at = ? WHERE held_at IS NULL`, Date.now());
      }
    }
    // Relay 1.1: a command handed to an Inbox socket at least once can no longer be taken back. The column
    // defaults to handed, so a row any code that knows no `handed` writes (1.0, before this, or during a rollback
    // to it) counts as handed: 1.0 may have handed it already. 1.1 inserts `handed = 0` itself (`command()`).
    const commandColumns = this.sql.exec<{ name: string }>("PRAGMA table_info(commands)").toArray().map((c) => c.name);
    if (!commandColumns.includes("handed")) {
      this.sql.exec("ALTER TABLE commands ADD COLUMN handed INTEGER NOT NULL DEFAULT 1");
    }
    this.schemaReady = true;
  }

  /** Every held command, in arrival order, each joined from its parts. */
  private heldCommands(): { device_id: string; id: string; ciphertext: string }[] {
    const rows = this.sql.exec<{ device_id: string; id: string; data: string }>("SELECT device_id, id, data FROM commands ORDER BY seq, part").toArray();
    const out: { device_id: string; id: string; ciphertext: string }[] = [];
    for (const row of rows) {
      const last = out[out.length - 1];
      if (last && last.device_id === row.device_id && last.id === row.id) last.ciphertext += row.data;
      else out.push({ device_id: row.device_id, id: row.id, ciphertext: row.data });
    }
    return out;
  }

  private deleteDevice(id: string): void {
    this.sql.exec("DELETE FROM devices WHERE id = ?", id);
    this.sql.exec("DELETE FROM items WHERE device_id = ?", id);
    this.sql.exec("DELETE FROM commands WHERE device_id = ?", id);
    this.closeDeviceSockets(id, DEVICE_SOCKET_REMOVED, "removed");
  }

  private online(): boolean {
    return this.sockets().length > 0;
  }

  /** A device's own sockets (1.1), found by their tag, so they are found again after the object hibernates. */
  private deviceSockets(id: string): WebSocket[] {
    return this.ctx.getWebSockets(`device:${id}`);
  }

  private closeDeviceSockets(id: string, code: number, reason: string): void {
    for (const socket of this.deviceSockets(id)) {
      try {
        socket.close(code, reason);
      } catch {
        // Already closing.
      }
    }
  }

  /** Tell a device's sockets that item `n` is stored for it: the number only, nothing else travels there. */
  private notifyDevice(id: string, n: number): void {
    const text = JSON.stringify({ n });
    for (const socket of this.deviceSockets(id)) {
      try {
        socket.send(text);
      } catch {
        // A closing socket: the phone polls `items` when it opens a new one.
      }
    }
  }

  private isDeviceSocket(socket: WebSocket): boolean {
    return this.ctx.getTags(socket).includes("device");
  }

  private device(id: string): DeviceRow | null {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", id).toArray()[0] ?? null;
  }

  /** The Inbox's socket, if one is connected: every socket but a device's (one accepted before 1.1 has no tag). */
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((socket) => !this.isDeviceSocket(socket));
  }

  /** Sends a frame to the Inbox's socket; true when one took it. */
  private toInbox(frame: unknown): boolean {
    const text = JSON.stringify(frame);
    let sent = false;
    for (const socket of this.sockets()) {
      try {
        socket.send(text);
        sent = true;
      } catch {
        // A closing socket: the Inbox reads the state again from `hello`.
      }
    }
    return sent;
  }

  private hello() {
    const devices = this.sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY id").toArray();
    return {
      type: "hello",
      // Relay 1.1 says its version; an Inbox that reads none is talking to 1.0.
      version: RELAY_VERSION,
      devices: devices.map((d) => ({ device_id: d.id, cursor: d.cursor, carriage: d.carriage === 1, apns: d.apns_token !== null, fcm: d.fcm_token !== null, topic: d.apns_topic !== null, ...(d.agent === 1 ? { agent: true } : {}) })),
    };
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const secretHash = this.secretHash();
    if (!secretHash) return refuse(404, "mailbox_not_found");
    const inbox = async () => {
      const token = bearer(req);
      return token !== null && (await sha256Hex(token)) === secretHash;
    };

    if (path === "/socket" && req.method === "GET") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(400, "bad_request", "A WebSocket upgrade is required.");
      if (!(await inbox())) return refuse(401, "unauthorized");
      return this.socket();
    }
    if (path === "/push" && req.method === "POST") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      return this.push(req);
    }

    const signal = /^\/signals\/([^/]+)$/.exec(path);
    if (signal && req.method === "GET") return this.readSignal(signal[1]!);

    const match = /^\/devices\/([^/]+)(?:\/(carriage|apns|fcm|items|ack|commands|signal|socket|liveactivity)(?:\/([^/]+))?)?$/.exec(path);
    if (!match || !DEVICE_ID.test(match[1]!)) return refuse(404, "not_found");
    const deviceId = match[1]!;
    const sub = match[2];
    // Relay 1.1: `DELETE .../commands/:id`, the only route with a third part.
    if (match[3] !== undefined) {
      if (sub !== "commands" || req.method !== "DELETE") return refuse(404, "not_found");
      const device = await this.deviceOf(req, deviceId);
      if (!device) return refuse(401, "unauthorized");
      return this.cancelCommand(device, match[3]);
    }

    if (!sub && req.method === "PUT") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      return this.register(req, deviceId);
    }
    if (!sub && req.method === "DELETE") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      this.deleteDevice(deviceId);
      return new Response(null, { status: 204 });
    }
    if (sub === "signal" && req.method === "POST") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      return this.bumpSignal(deviceId);
    }
    const method = sub === "carriage" || sub === "apns" || sub === "fcm" || sub === "liveactivity" ? "PUT" : sub === "items" || sub === "socket" ? "GET" : "POST";
    if (sub && sub !== "signal" && req.method === method) {
      const device = await this.deviceOf(req, deviceId);
      if (!device) return refuse(401, "unauthorized");
      if (device.agent === 1 && (sub === "carriage" || sub === "apns" || sub === "fcm" || sub === "liveactivity")) return refuse(403, "agent_device", "A cloud agent's device gets answers to its own commands only.");
      if (sub === "carriage") return this.carriage(req, device);
      if (sub === "apns") return this.apns(req, device);
      if (sub === "fcm") return this.fcm(req, device);
      if (sub === "liveactivity") return this.liveActivity(req, device);
      if (sub === "items") return this.items(new URL(req.url), device);
      if (sub === "socket") return this.deviceSocket(req, device);
      if (sub === "ack") return this.ack(req, device);
      return this.command(req, device);
    }
    return refuse(404, "not_found");
  }

  /** The device in the path when the request carries its bearer; null for a wrong bearer and for a device the mailbox does not hold alike. */
  private async deviceOf(req: Request, deviceId: string): Promise<DeviceRow | null> {
    const token = bearer(req);
    const presented = token === null ? null : await sha256Hex(token);
    const device = this.device(deviceId);
    return presented !== null && device && presented === device.secret_sha256 ? device : null;
  }

  /**
   * `POST /v1/mailboxes` (7.26): an RPC the Worker calls on the object it
   * named with a fresh random id, never a path `fetch` serves, so no client
   * request reaches it. A mailbox that already has its hash keeps it: false.
   */
  async create(hash: string): Promise<boolean> {
    if (!HASH.test(hash) || this.secretHash() !== null) return false;
    this.schema();
    this.sql.exec("INSERT INTO mailbox (secret_sha256) VALUES (?)", hash);
    return true;
  }

  /** `PUT .../devices/:dev` (7.27): the same hash again changes nothing; another hash starts the device over. */
  private async register(req: Request, deviceId: string): Promise<Response> {
    const input = await body(req);
    const hash = input?.secret_sha256;
    const cursor = input?.cursor;
    if (typeof hash !== "string" || !HASH.test(hash)) return refuse(400, "bad_request", "secret_sha256: 64 lowercase hex.");
    if (!isCursor(cursor)) return refuse(400, "bad_request", "cursor: a store seq.");
    const kind = input?.kind ?? "phone";
    if (kind !== "phone" && kind !== "agent") return refuse(400, "bad_request", 'kind: "phone" or "agent".');
    const signalHash = input?.signal_sha256 ?? null;
    if (signalHash !== null && (kind !== "agent" || typeof signalHash !== "string" || !HASH.test(signalHash))) return refuse(400, "bad_request", "signal_sha256: 64 lowercase hex, for an agent.");
    const agent = kind === "agent" ? 1 : 0;
    const existing = this.device(deviceId);
    if (existing?.secret_sha256 !== hash || existing.agent !== agent || existing.signal_sha256 !== signalHash) {
      this.deleteDevice(deviceId);
      // Started over: no topic until its app names one again, and the Inbox is told so (it would still count a 1.1 app).
      if (existing) this.topicChanged(existing, null);
      this.sql.exec(
        "INSERT INTO devices (id, secret_sha256, carriage, cursor, apns_token, apns_environment, next_n, fcm_token, agent, signal_sha256, signal) VALUES (?, ?, ?, ?, NULL, NULL, 1, NULL, ?, ?, ?)",
        deviceId,
        hash,
        agent ? 0 : 1,
        cursor,
        agent,
        signalHash,
        signalHash ? signalValue() : null,
      );
    }
    return json({ device_id: deviceId });
  }

  /** `PUT .../carriage` (7.35): the phone's relay switch, told to the Inbox's socket. Off deletes the phone's held items. */
  private async carriage(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    if (input?.on === false) {
      this.sql.exec("UPDATE devices SET carriage = 0 WHERE id = ?", device.id);
      this.sql.exec("DELETE FROM items WHERE device_id = ?", device.id);
      this.toInbox({ type: "carriage", device_id: device.id, on: false, cursor: null });
    } else if (input?.on === true && isCursor(input.cursor)) {
      this.sql.exec("UPDATE devices SET carriage = 1, cursor = ? WHERE id = ?", input.cursor, device.id);
      this.toInbox({ type: "carriage", device_id: device.id, on: true, cursor: input.cursor });
    } else {
      return refuse(400, "bad_request", "{ on: false }, or { on: true, cursor }.");
    }
    return new Response(null, { status: 204 });
  }

  /**
   * `PUT .../apns` (7.29): the phone's APNs token and its environment; `token: null` removes it. A device holds one push token: this clears its FCM token.
   * Relay 1.1: `topic`, the app build's bundle id, one of `APNS_TOPICS` (`400 topic_not_allowed` otherwise); absent, the legacy topic, as 1.0.
   */
  private async apns(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    if (input?.token === null) {
      this.sql.exec("UPDATE devices SET apns_token = NULL, apns_environment = NULL, apns_topic = NULL WHERE id = ?", device.id);
      this.topicChanged(device, null);
      return new Response(null, { status: 204 });
    }
    const token = input?.token;
    const environment = input?.environment;
    const topic = input?.topic ?? null;
    if (typeof token !== "string" || !APNS_TOKEN.test(token)) return refuse(400, "bad_request", "token: the APNs device token as hex, or null.");
    if (environment !== "sandbox" && environment !== "production") return refuse(400, "bad_request", 'environment: "sandbox" or "production".');
    if (topic !== null && !isBundleId(topic)) return refuse(400, "bad_request", "topic: the app's bundle id.");
    if (topic !== null && !allowedTopics(this.env.APNS_TOPICS).has(topic)) return refuse(400, "topic_not_allowed", "This relay does not push to that app.");
    this.sql.exec("UPDATE devices SET apns_token = ?, apns_environment = ?, apns_topic = ?, fcm_token = NULL WHERE id = ?", token.toLowerCase(), environment, topic, device.id);
    this.topicChanged(device, topic);
    return new Response(null, { status: 204 });
  }

  /**
   * Relay 1.1: tells the Inbox's socket when a phone starts or stops naming its app's topic, as `hello` lists it
   * (`topic`). Only an app that registers through the 1.1 route names one, and the Inbox sends the kinds of push
   * that came with it (a new thread, a failed turn) only to such a phone. An Inbox from before ignores the frame.
   */
  private topicChanged(device: DeviceRow, topic: string | null): void {
    if ((device.apns_topic !== null) !== (topic !== null)) this.toInbox({ type: "topic", device_id: device.id, topic: topic !== null });
  }

  /** `PUT .../liveactivity` (1.1): the token of the phone's Live Activity, `{ token, environment? }` (the APNs token's environment when absent); `token: null` removes it. */
  private async liveActivity(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    if (input?.token === null) {
      this.sql.exec("UPDATE devices SET live_token = NULL, live_environment = NULL WHERE id = ?", device.id);
      return new Response(null, { status: 204 });
    }
    const token = input?.token;
    const environment = input?.environment ?? device.apns_environment;
    if (typeof token !== "string" || !APNS_TOKEN.test(token)) return refuse(400, "bad_request", "token: the Live Activity push token as hex, or null.");
    if (environment !== "sandbox" && environment !== "production") return refuse(400, "bad_request", 'environment: "sandbox" or "production" (or an APNs token registered first).');
    this.sql.exec("UPDATE devices SET live_token = ?, live_environment = ? WHERE id = ?", token.toLowerCase(), environment, device.id);
    return new Response(null, { status: 204 });
  }

  /**
   * `DELETE .../commands/:id` (1.1): Cancel on a held write. Removed while no
   * Inbox socket has had it (`204`); once one has, the Inbox may have applied
   * it, so it stays (`409 already_handed`) and its result tells. `404
   * command_not_found` when it is not held: never posted, or applied and gone.
   */
  private cancelCommand(device: DeviceRow, raw: string): Response {
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      return refuse(400, "bad_request", "The command id.");
    }
    if (!COMMAND_ID.test(id)) return refuse(400, "bad_request", "The command id.");
    const held = this.sql.exec<{ handed: number | null }>("SELECT MAX(handed) AS handed FROM commands WHERE device_id = ? AND id = ?", device.id, id).one();
    if (held.handed === null) return refuse(404, "command_not_found", "No command with this id is held: it was never sent, or the computer has applied it.");
    if (held.handed === 1) return refuse(409, "already_handed", "The computer already has this command.");
    this.sql.exec("DELETE FROM commands WHERE device_id = ? AND id = ?", device.id, id);
    console.log(`relay: command ${device.id} taken back`);
    return new Response(null, { status: 204 });
  }

  /**
   * `GET .../devices/:dev/socket` (1.1): the phone's live feed while it is in
   * front with no direct path. Hibernating; the relay sends `{ n }` when an item
   * is stored for this device, and nothing else; the phone then reads `items`.
   * Anything the phone sends on it is ignored. One per device: a newer one
   * closes the older with 4000; removing the device closes it with 4001.
   */
  private deviceSocket(req: Request, device: DeviceRow): Response {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return refuse(400, "bad_request", "A WebSocket upgrade is required.");
    this.closeDeviceSockets(device.id, DEVICE_SOCKET_REPLACED, "replaced");
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ["device", `device:${device.id}`]);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** `PUT .../fcm` (10.1): the phone's FCM registration token; `token: null` removes it. A device holds one push token: this clears its APNs token. */
  private async fcm(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    if (input?.token === null) {
      this.sql.exec("UPDATE devices SET fcm_token = NULL WHERE id = ?", device.id);
      return new Response(null, { status: 204 });
    }
    const token = input?.token;
    if (typeof token !== "string" || !FCM_TOKEN.test(token)) return refuse(400, "bad_request", "token: the FCM registration token, or null.");
    this.sql.exec("UPDATE devices SET fcm_token = ?, apns_token = NULL, apns_environment = NULL, apns_topic = NULL, live_token = NULL, live_environment = NULL WHERE id = ?", token, device.id);
    this.topicChanged(device, null);
    return new Response(null, { status: 204 });
  }

  /** `GET .../items?after=n` (7.32): every held item after `n`, in order, each joined from its parts. */
  private items(url: URL, device: DeviceRow): Response {
    const raw = url.searchParams.get("after");
    const after = raw === null || raw === "" ? 0 : Number(raw);
    if (!isCursor(after)) return refuse(400, "bad_request", "after: an item number.");
    const rows = this.sql.exec<{ n: number; data: string }>("SELECT n, data FROM items WHERE device_id = ? AND n > ? ORDER BY n, part", device.id, after).toArray();
    const items: { n: number; ciphertext: string }[] = [];
    for (const row of rows) {
      const last = items[items.length - 1];
      if (last?.n === row.n) last.ciphertext += row.data;
      else items.push({ n: row.n, ciphertext: row.data });
    }
    return json({ items, inbox_online: this.online() });
  }

  /** `POST .../ack` (7.33): by item number, or by store cursor when the phone read those lines directly. */
  private async ack(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    if (isCursor(input?.through)) this.sql.exec("DELETE FROM items WHERE device_id = ? AND n <= ?", device.id, input.through);
    else if (isCursor(input?.item)) this.sql.exec("DELETE FROM items WHERE device_id = ? AND n = ?", device.id, input.item);
    else if (isCursor(input?.cursor)) this.sql.exec("DELETE FROM items WHERE device_id = ? AND cursor IS NOT NULL AND cursor <= ?", device.id, input.cursor);
    else return refuse(400, "bad_request", "{ through: n }, { item: n }, or { cursor }.");
    return new Response(null, { status: 204 });
  }

  /** `POST .../commands` (7.34): held for the Inbox, and handed to its socket at once when it is connected. */
  private async command(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    const id = input?.id;
    const envelope = input?.ciphertext;
    if (typeof id !== "string" || !COMMAND_ID.test(id) || typeof envelope !== "string" || !ENVELOPE.test(envelope)) {
      return refuse(400, "bad_request", "{ id, ciphertext }.");
    }
    if (this.sql.exec("SELECT 1 FROM commands WHERE device_id = ? AND id = ? LIMIT 1", device.id, id).toArray().length > 0) {
      return json({ queued: false, inbox_online: this.online() });
    }
    // Refused at the door: held, it would close the Inbox's socket at every hello and stop every command behind it.
    if (JSON.stringify({ type: "command", device_id: device.id, id, ciphertext: envelope }).length > WEBSOCKET_MESSAGE_LIMIT) {
      return json({ error: "This command is too large to carry through the relay.", code: "command_too_large", limit_bytes: WEBSOCKET_MESSAGE_LIMIT }, 413);
    }
    const held = this.sql.exec<{ count: number; bytes: number }>("SELECT COUNT(DISTINCT id) AS count, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM commands WHERE device_id = ?", device.id).one();
    if (held.count >= HELD_COMMANDS_MAX || held.bytes + envelope.length > HELD_COMMAND_BYTES_MAX) {
      return json(
        {
          error: `This device already has ${held.count} commands waiting for the computer. Wait until the computer is back and has taken them.`,
          code: "too_many_held",
          held_commands_max: HELD_COMMANDS_MAX,
          held_bytes_max: HELD_COMMAND_BYTES_MAX,
        },
        429,
        { "Retry-After": "60" },
      );
    }
    const seq = (this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM commands").one().seq);
    const at = Date.now();
    parts(envelope).forEach((data, part) => this.sql.exec("INSERT INTO commands (seq, device_id, id, part, data, held_at, handed) VALUES (?, ?, ?, ?, ?, ?, 0)", seq, device.id, id, part, data, at));
    await this.armExpiry();
    console.log(`relay: command ${device.id} queued`);
    if (this.toInbox({ type: "command", device_id: device.id, id, ciphertext: envelope })) this.sql.exec("UPDATE commands SET handed = 1 WHERE device_id = ? AND id = ?", device.id, id);
    return json({ queued: true, inbox_online: this.online() }, 202);
  }

  /**
   * `POST .../push` (7.30): one push to one device, to whichever token it holds; the envelope passed to Apple or Google and never kept.
   * Relay 1.1: `kind: "live"` with `live` instead is a Live Activity update (src/live.ts); `kind` absent or `"alert"` is the sealed push.
   */
  private async push(req: Request): Promise<Response> {
    const input = await body(req);
    if (input?.kind === "live") return this.pushLive(input);
    if (input?.kind !== undefined && input.kind !== "alert") return refuse(400, "bad_request", 'kind: "alert" (the default) or "live".');
    const deviceId = input?.device_id;
    const collapseId = input?.collapse_id;
    const envelope = input?.ciphertext;
    // Apple takes a collapse id of at most 64 bytes.
    if (typeof deviceId !== "string" || typeof collapseId !== "string" || !COLLAPSE_ID.test(collapseId) || typeof envelope !== "string" || !ENVELOPE.test(envelope)) {
      return refuse(400, "bad_request", "{ device_id, collapse_id (1 to 64 printable ASCII), ciphertext }.");
    }
    const device = this.device(deviceId);
    if (!device) return refuse(404, "device_not_found");
    if (device.agent === 1) return refuse(403, "agent_device", "A cloud agent's device gets no pushes.");
    if (device.fcm_token) return this.pushFcm(device, device.fcm_token, collapseId, envelope);
    if (!device.apns_token) return json({ sent: false, reason: "no_push_token" });
    const topic = deviceTopic(device.apns_topic);
    // The list may have changed since the token was registered (a bundle id taken off it).
    if (!allowedTopics(this.env.APNS_TOPICS).has(topic)) return json({ sent: false, reason: "topic_not_allowed" });
    const apns = this.apnsKey();
    if (!apns) return json({ sent: false, reason: "no_apns_key" });
    let result: { status: number; reason: string | null };
    try {
      result = await sendPush({
        apns,
        token: device.apns_token,
        environment: device.apns_environment as ApnsEnvironment,
        topic,
        pushType: "alert",
        collapseId,
        body: apnsBody(envelope),
        origin: this.env.APNS_ORIGIN,
      });
    } catch (error) {
      console.log(`relay: push ${device.id} transport failed`);
      return json({ error: `APNs could not be reached: ${error instanceof Error ? error.message : String(error)}`, code: "apns_failed" }, 502);
    }
    console.log(`relay: push ${device.id} ${result.status}`);
    if (result.status === 200) return json({ sent: true }, 202);
    if (result.status === 410) {
      // Only the token Apple refused: one registered while this push was on its way stays.
      this.sql.exec("UPDATE devices SET apns_token = NULL, apns_environment = NULL WHERE id = ? AND apns_token = ?", device.id, device.apns_token);
      return json({ sent: false, reason: "apns_gone" });
    }
    return json({ error: `APNs answered ${result.status}${result.reason ? ` ${result.reason}` : ""}.`, code: "apns_failed", apns_status: result.status, apns_reason: result.reason }, 502);
  }

  private apnsKey(): { key: string; keyId: string; teamId: string } | null {
    const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID } = this.env;
    if (APNS_KEY && APNS_KEY_ID && APNS_TEAM_ID) return { key: APNS_KEY, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID };
    if (!missingKeyLogged) console.log("relay: no APNs key; pushes answer no_apns_key");
    missingKeyLogged = true;
    return null;
  }

  /**
   * A Live Activity update (1.1): counts only, checked field by field and
   * rebuilt (src/live.ts), under the device's topic with
   * `.push-type.liveactivity`. `no_live_token` when the phone registered none
   * (an FCM phone never does); Apple's 410 deletes the token (`live_gone`).
   */
  private async pushLive(input: Record<string, unknown>): Promise<Response> {
    const deviceId = input.device_id;
    const live = readLive(input.live);
    if (typeof deviceId !== "string" || !live) return refuse(400, "bad_request", '{ device_id, kind: "live", live: { timestamp, event, content-state: { working, stopped_on_you, ended } } }.');
    const device = this.device(deviceId);
    if (!device) return refuse(404, "device_not_found");
    if (device.agent === 1) return refuse(403, "agent_device", "A cloud agent's device gets no pushes.");
    if (!device.live_token || !device.live_environment) return json({ sent: false, reason: "no_live_token" });
    if (!allowedTopics(this.env.APNS_TOPICS).has(deviceTopic(device.apns_topic))) return json({ sent: false, reason: "topic_not_allowed" });
    const apns = this.apnsKey();
    if (!apns) return json({ sent: false, reason: "no_apns_key" });
    const token = device.live_token;
    let result: { status: number; reason: string | null };
    try {
      result = await sendPush({
        apns,
        token,
        environment: device.live_environment as ApnsEnvironment,
        topic: liveTopic(device.apns_topic),
        pushType: "liveactivity",
        collapseId: null,
        body: liveBody(live),
        origin: this.env.APNS_ORIGIN,
      });
    } catch (error) {
      console.log(`relay: live ${device.id} transport failed`);
      return json({ error: `APNs could not be reached: ${error instanceof Error ? error.message : String(error)}`, code: "apns_failed" }, 502);
    }
    console.log(`relay: live ${device.id} ${result.status}`);
    if (result.status === 200) return json({ sent: true }, 202);
    if (result.status === 410) {
      this.sql.exec("UPDATE devices SET live_token = NULL, live_environment = NULL WHERE id = ? AND live_token = ?", device.id, token);
      return json({ sent: false, reason: "live_gone" });
    }
    return json({ error: `APNs answered ${result.status}${result.reason ? ` ${result.reason}` : ""}.`, code: "apns_failed", apns_status: result.status, apns_reason: result.reason }, 502);
  }

  /** The push to an FCM token (section 10): `UNREGISTERED` deletes the token, as Apple's 410 does. */
  private async pushFcm(device: DeviceRow, token: string, collapseId: string, envelope: string): Promise<Response> {
    const account = parseServiceAccount(this.env.FCM_SERVICE_ACCOUNT);
    if (!account) {
      if (!missingFcmKeyLogged) console.log(this.env.FCM_SERVICE_ACCOUNT ? "relay: FCM_SERVICE_ACCOUNT is not a service account key file; pushes answer no_fcm_key" : "relay: no FCM service account; pushes answer no_fcm_key");
      missingFcmKeyLogged = true;
      return json({ sent: false, reason: "no_fcm_key" });
    }
    let result: { status: number; reason: string | null };
    try {
      result = await sendFcm({ account, token, collapseKey: collapseId, envelope, origin: this.env.FCM_ORIGIN, oauthOrigin: this.env.FCM_OAUTH_ORIGIN });
    } catch (error) {
      console.log(`relay: push ${device.id} fcm ${error instanceof FcmAuthError ? "token exchange" : "transport"} failed`);
      const message = error instanceof Error ? error.message : String(error);
      return json({ error: error instanceof FcmAuthError ? message : `FCM could not be reached: ${message}`, code: "fcm_failed" }, 502);
    }
    console.log(`relay: push ${device.id} fcm ${result.status}`);
    if (result.status === 200) return json({ sent: true }, 202);
    if (result.reason === "UNREGISTERED") {
      // Only the token FCM refused: one the phone registered meanwhile stays.
      this.sql.exec("UPDATE devices SET fcm_token = NULL WHERE id = ? AND fcm_token = ?", device.id, token);
      return json({ sent: false, reason: "fcm_gone" });
    }
    return json({ error: `FCM answered ${result.status}${result.reason ? ` ${result.reason}` : ""}.`, code: "fcm_failed", fcm_status: result.status, fcm_reason: result.reason }, 502);
  }

  /** `GET .../socket` (7.31): the Inbox's one socket. A new one replaces an older one; `hello` goes out at once. */
  private socket(): Response {
    for (const older of this.sockets()) {
      try {
        older.close(4000, "replaced");
      } catch {
        // Already closing.
      }
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ["inbox"]);
    server.send(JSON.stringify(this.hello()));
    // Then every held command, in the order it arrived, until the Inbox reports it applied. From here none can be taken back.
    for (const held of this.heldCommands()) server.send(JSON.stringify({ type: "command", ...held }));
    this.sql.exec("UPDATE commands SET handed = 1 WHERE handed = 0");
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Frames from the Inbox. `item`: one down item, kept for a phone with
   * carriage on (dropped otherwise), with the store cursor raised to it.
   * `applied`: the command is done, so it is deleted. Anything else is ignored.
   */
  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // A device's socket carries nothing up: whatever a phone sends there, shaped like the Inbox's frames or not, changes nothing.
    if (typeof message !== "string" || this.isDeviceSocket(socket)) return;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(message);
    } catch {
      return;
    }
    if (!frame || typeof frame.device_id !== "string") return;
    if (frame.type === "applied" && typeof frame.id === "string") {
      this.sql.exec("DELETE FROM commands WHERE device_id = ? AND id = ?", frame.device_id, frame.id);
      return;
    }
    if (frame.type !== "item" || typeof frame.ciphertext !== "string" || !ENVELOPE.test(frame.ciphertext)) return;
    const cursor = frame.cursor === null ? null : isCursor(frame.cursor) ? frame.cursor : undefined;
    if (cursor === undefined) return;
    const device = this.device(frame.device_id);
    if (!device) return;
    if (device.agent === 1 ? cursor !== null : device.carriage !== 1) return;
    const n = device.next_n;
    const at = Date.now();
    parts(frame.ciphertext).forEach((data, part) => this.sql.exec("INSERT INTO items (device_id, n, part, cursor, data, held_at) VALUES (?, ?, ?, ?, ?, ?)", device.id, n, part, cursor, data, at));
    this.sql.exec("UPDATE devices SET next_n = ?, cursor = MAX(cursor, ?) WHERE id = ?", n + 1, cursor ?? device.cursor, device.id);
    await this.armExpiry();
    this.notifyDevice(device.id, n);
  }

  private readonly signalReads = new Map<string, { since: number; count: number }>();

  private async readSignal(token: string): Promise<Response> {
    if (!SIGNAL_TOKEN.test(token)) return refuse(404, "not_found");
    const hash = await sha256Hex(token);
    const row = this.sql.exec<{ signal: string }>("SELECT signal FROM devices WHERE agent = 1 AND signal_sha256 = ? AND signal IS NOT NULL", hash).toArray()[0];
    if (!row) return refuse(404, "not_found");
    const now = Date.now();
    for (const [key, slot] of this.signalReads) if (now - slot.since >= SIGNAL_WINDOW_MS) this.signalReads.delete(key);
    const slot = this.signalReads.get(hash) ?? { since: now, count: 0 };
    slot.count += 1;
    this.signalReads.set(hash, slot);
    if (slot.count > SIGNAL_LIMIT) {
      return json({ error: "too many requests", code: "too_many_requests" }, 429, { "Retry-After": String(Math.max(1, Math.ceil((slot.since + SIGNAL_WINDOW_MS - now) / 1000))) });
    }
    return json({ signal: row.signal });
  }

  private bumpSignal(deviceId: string): Response {
    const device = this.device(deviceId);
    if (!device || device.agent !== 1 || !device.signal_sha256) return refuse(404, "device_not_found");
    this.sql.exec("UPDATE devices SET signal = ? WHERE id = ?", signalValue(), deviceId);
    return new Response(null, { status: 204 });
  }

  private oldestHeld(): number | null {
    const row = this.sql.exec<{ at: number | null }>("SELECT MIN(at) AS at FROM (SELECT MIN(held_at) AS at FROM items UNION ALL SELECT MIN(held_at) AS at FROM commands)").one();
    return row.at ?? null;
  }

  private async armExpiry(): Promise<void> {
    const oldest = this.oldestHeld();
    if (oldest === null) return;
    const due = oldest + heldMaxAgeMs(this.env.HELD_MAX_AGE_SECONDS);
    const armed = await this.ctx.storage.getAlarm();
    if (armed === null || armed > due) await this.ctx.storage.setAlarm(Math.max(due, Date.now() + 1));
  }

  async alarm(): Promise<void> {
    if (this.secretHash() === null) return;
    const before = Date.now() - heldMaxAgeMs(this.env.HELD_MAX_AGE_SECONDS);
    this.sql.exec("DELETE FROM items WHERE held_at <= ?", before);
    this.sql.exec("DELETE FROM commands WHERE held_at <= ?", before);
    await this.armExpiry();
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }
}
