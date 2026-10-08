/**
 * One mailbox: a Durable Object per Inbox (adr/implementation/inbox-mobile.md,
 * section 4). It holds what it cannot read: the SHA-256 of the Inbox's
 * mailbox secret and of each phone's relay secret, each phone's relay switch
 * (`carriage`), its APNs token and environment (Apple needs them in the
 * clear), the store cursor the Inbox last gave for it, and the envelopes in
 * transit: down items for the phone, commands up for the Inbox. Never a key,
 * a secret, a subject or a body: a push's envelope goes to Apple and is not
 * kept. Logs carry ids and status codes only.
 *
 * Deleted: a down item when the phone acknowledges it; every down item of a
 * phone that turns carriage off; a command when the Inbox reports it applied;
 * a device and everything it holds when the Inbox removes it; an APNs token
 * when Apple answers 410. There is no time sweep.
 *
 * An envelope is kept in parts of at most PART characters, one row each: a
 * SQLite-backed object refuses a row above 2 MB, and the relay sets no item
 * size of its own.
 */
import { DurableObject } from "cloudflare:workers";
import { sendPush, type ApnsEnvironment } from "./apns";

export interface Env {
  MAILBOX: DurableObjectNamespace<Mailbox>;
  /** Cloudflare's rate limiting binding on mailbox creation, the rule guides.show uses (wrangler.toml). Absent: no brake. */
  MAILBOX_CREATE_LIMITER?: RateLimit;
  /** The APNs key (.p8 text), its key id and the team id: Worker secrets. Without the key a push answers `no_apns_key`. */
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  /** Replaces Apple's host in the relay's own proof under `wrangler dev` (a local HTTP/2 server). Never set in a deploy. */
  APNS_ORIGIN?: string;
}

interface DeviceRow {
  id: string;
  secret_sha256: string;
  carriage: number;
  cursor: number;
  apns_token: string | null;
  apns_environment: string | null;
  next_n: number;
  [key: string]: SqlStorageValue;
}

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
const DEVICE_ID = /^dev_[A-Za-z0-9]+$/;
const APNS_TOKEN = /^[0-9a-fA-F]+$/;
const ENVELOPE = /^[A-Za-z0-9_-]+$/;
const COLLAPSE_ID = /^[\x21-\x7e]{1,64}$/;
/** A command's id: the phone's idempotency key, or a fresh random id for a read. */
const COMMAND_ID = /^[A-Za-z0-9_.:-]+$/;
/** Cloudflare's WebSocket message limit (32 MiB), the platform's: a command whose frame to the Inbox would pass it could never be handed over. */
const WEBSOCKET_MESSAGE_LIMIT = 32 * 1024 * 1024;

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
   * no `next_n`, no items, no commands) gains them on its first request.
   */
  private schema(): void {
    if (this.schemaReady) return;
    this.sql.exec("CREATE TABLE IF NOT EXISTS mailbox (secret_sha256 TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret_sha256 TEXT NOT NULL, carriage INTEGER NOT NULL, cursor INTEGER NOT NULL, apns_token TEXT, apns_environment TEXT, next_n INTEGER NOT NULL DEFAULT 1)",
    );
    const columns = this.sql.exec<{ name: string }>("PRAGMA table_info(devices)").toArray().map((c) => c.name);
    if (!columns.includes("next_n")) this.sql.exec("ALTER TABLE devices ADD COLUMN next_n INTEGER NOT NULL DEFAULT 1");
    // Down items: `cursor` is the record's store seq, null for a result.
    this.sql.exec("CREATE TABLE IF NOT EXISTS items (device_id TEXT NOT NULL, n INTEGER NOT NULL, part INTEGER NOT NULL, cursor INTEGER, data TEXT NOT NULL, PRIMARY KEY (device_id, n, part))");
    // Commands up, in the order they arrived (`seq`).
    this.sql.exec("CREATE TABLE IF NOT EXISTS commands (seq INTEGER NOT NULL, device_id TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (device_id, id, part))");
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
  }

  private online(): boolean {
    return this.sockets().length > 0;
  }

  private device(id: string): DeviceRow | null {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE id = ?", id).toArray()[0] ?? null;
  }

  /** The Inbox's socket, if one is connected. */
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets();
  }

  private toInbox(frame: unknown): void {
    const text = JSON.stringify(frame);
    for (const socket of this.sockets()) {
      try {
        socket.send(text);
      } catch {
        // A closing socket: the Inbox reads the state again from `hello`.
      }
    }
  }

  private hello() {
    const devices = this.sql.exec<DeviceRow>("SELECT * FROM devices ORDER BY id").toArray();
    return {
      type: "hello",
      devices: devices.map((d) => ({ device_id: d.id, cursor: d.cursor, carriage: d.carriage === 1, apns: d.apns_token !== null })),
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

    const match = /^\/devices\/([^/]+)(?:\/(carriage|apns|items|ack|commands))?$/.exec(path);
    if (!match || !DEVICE_ID.test(match[1]!)) return refuse(404, "not_found");
    const deviceId = match[1]!;
    const sub = match[2];

    if (!sub && req.method === "PUT") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      return this.register(req, deviceId);
    }
    if (!sub && req.method === "DELETE") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      this.deleteDevice(deviceId);
      return new Response(null, { status: 204 });
    }
    const method = sub === "carriage" || sub === "apns" ? "PUT" : sub === "items" ? "GET" : "POST";
    if (sub && req.method === method) {
      const device = this.device(deviceId);
      if (!device) return refuse(404, "device_not_found");
      const token = bearer(req);
      if (token === null || (await sha256Hex(token)) !== device.secret_sha256) return refuse(401, "unauthorized");
      if (sub === "carriage") return this.carriage(req, device);
      if (sub === "apns") return this.apns(req, device);
      if (sub === "items") return this.items(new URL(req.url), device);
      if (sub === "ack") return this.ack(req, device);
      return this.command(req, device);
    }
    return refuse(404, "not_found");
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
    const existing = this.device(deviceId);
    if (existing?.secret_sha256 !== hash) {
      this.deleteDevice(deviceId);
      this.sql.exec(
        "INSERT INTO devices (id, secret_sha256, carriage, cursor, apns_token, apns_environment, next_n) VALUES (?, ?, 1, ?, NULL, NULL, 1)",
        deviceId,
        hash,
        cursor,
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

  /** `PUT .../apns` (7.29): the phone's APNs token and its environment; `token: null` removes it. */
  private async apns(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    if (input?.token === null) {
      this.sql.exec("UPDATE devices SET apns_token = NULL, apns_environment = NULL WHERE id = ?", device.id);
      return new Response(null, { status: 204 });
    }
    const token = input?.token;
    const environment = input?.environment;
    if (typeof token !== "string" || !APNS_TOKEN.test(token)) return refuse(400, "bad_request", "token: the APNs device token as hex, or null.");
    if (environment !== "sandbox" && environment !== "production") return refuse(400, "bad_request", 'environment: "sandbox" or "production".');
    this.sql.exec("UPDATE devices SET apns_token = ?, apns_environment = ? WHERE id = ?", token.toLowerCase(), environment, device.id);
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
    else if (isCursor(input?.cursor)) this.sql.exec("DELETE FROM items WHERE device_id = ? AND cursor IS NOT NULL AND cursor <= ?", device.id, input.cursor);
    else return refuse(400, "bad_request", "{ through: n }, or { cursor }.");
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
    const seq = (this.sql.exec<{ seq: number }>("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM commands").one().seq);
    parts(envelope).forEach((data, part) => this.sql.exec("INSERT INTO commands (seq, device_id, id, part, data) VALUES (?, ?, ?, ?, ?)", seq, device.id, id, part, data));
    console.log(`relay: command ${device.id} queued`);
    this.toInbox({ type: "command", device_id: device.id, id, ciphertext: envelope });
    return json({ queued: true, inbox_online: this.online() }, 202);
  }

  /** `POST .../push` (7.30): one push to one device, the envelope passed to Apple and never kept. */
  private async push(req: Request): Promise<Response> {
    const input = await body(req);
    const deviceId = input?.device_id;
    const collapseId = input?.collapse_id;
    const envelope = input?.ciphertext;
    // Apple takes a collapse id of at most 64 bytes.
    if (typeof deviceId !== "string" || typeof collapseId !== "string" || !COLLAPSE_ID.test(collapseId) || typeof envelope !== "string" || !ENVELOPE.test(envelope)) {
      return refuse(400, "bad_request", "{ device_id, collapse_id (1 to 64 printable ASCII), ciphertext }.");
    }
    const device = this.device(deviceId);
    if (!device) return refuse(404, "device_not_found");
    if (!device.apns_token) return json({ sent: false, reason: "no_apns_token" });
    const { APNS_KEY, APNS_KEY_ID, APNS_TEAM_ID } = this.env;
    if (!APNS_KEY || !APNS_KEY_ID || !APNS_TEAM_ID) {
      if (!missingKeyLogged) console.log("relay: no APNs key; pushes answer no_apns_key");
      missingKeyLogged = true;
      return json({ sent: false, reason: "no_apns_key" });
    }
    let result: { status: number; reason: string | null };
    try {
      result = await sendPush({
        apns: { key: APNS_KEY, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID },
        token: device.apns_token,
        environment: device.apns_environment as ApnsEnvironment,
        collapseId,
        envelope,
        origin: this.env.APNS_ORIGIN,
      });
    } catch (error) {
      console.log(`relay: push ${device.id} transport failed`);
      return json({ error: `APNs could not be reached: ${error instanceof Error ? error.message : String(error)}`, code: "apns_failed" }, 502);
    }
    console.log(`relay: push ${device.id} ${result.status}`);
    if (result.status === 200) return json({ sent: true }, 202);
    if (result.status === 410) {
      this.sql.exec("UPDATE devices SET apns_token = NULL, apns_environment = NULL WHERE id = ?", device.id);
      return json({ sent: false, reason: "apns_gone" });
    }
    return json({ error: `APNs answered ${result.status}${result.reason ? ` ${result.reason}` : ""}.`, code: "apns_failed", apns_status: result.status, apns_reason: result.reason }, 502);
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
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.hello()));
    // Then every held command, in the order it arrived, until the Inbox reports it applied.
    for (const held of this.heldCommands()) server.send(JSON.stringify({ type: "command", ...held }));
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Frames from the Inbox. `item`: one down item, kept for a phone with
   * carriage on (dropped otherwise), with the store cursor raised to it.
   * `applied`: the command is done, so it is deleted. Anything else is ignored.
   */
  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
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
    if (!device || device.carriage !== 1) return;
    const n = device.next_n;
    parts(frame.ciphertext).forEach((data, part) => this.sql.exec("INSERT INTO items (device_id, n, part, cursor, data) VALUES (?, ?, ?, ?, ?)", device.id, n, part, cursor, data));
    this.sql.exec("UPDATE devices SET next_n = ?, cursor = MAX(cursor, ?) WHERE id = ?", n + 1, cursor ?? device.cursor, device.id);
  }

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }
}
