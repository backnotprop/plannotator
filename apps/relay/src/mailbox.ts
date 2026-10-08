/**
 * One mailbox: a Durable Object per Inbox (adr/implementation/inbox-mobile.md,
 * section 4). It holds what it cannot read: the SHA-256 of the Inbox's
 * mailbox secret and of each phone's relay secret, each phone's relay switch
 * (`carriage`), its APNs token and environment (Apple needs them in the
 * clear), and the store cursor the Inbox last gave for it. Never a key, a
 * secret, a subject or a body: a push's envelope goes to Apple and is not
 * kept. Logs carry ids and status codes only.
 *
 * Deleted: a device and everything it holds when the Inbox removes it; an
 * APNs token when Apple answers 410. There is no time sweep.
 *
 * R1 builds the mailbox, its devices, their APNs tokens, push, and the
 * Inbox's socket with its `hello` and `carriage` frames. The down items, the
 * phone's ack and its commands up (the rest of section 4) arrive with R2.
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
  [key: string]: SqlStorageValue;
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

const HASH = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^dev_[A-Za-z0-9]+$/;
const APNS_TOKEN = /^[0-9a-fA-F]+$/;
const ENVELOPE = /^[A-Za-z0-9_-]+$/;

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

  /** Tables exist only once the mailbox was made, so a probe of an unknown id writes nothing. */
  private secretHash(): string | null {
    const made = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'mailbox'").toArray().length > 0;
    if (!made) return null;
    const row = this.sql.exec<{ secret_sha256: string }>("SELECT secret_sha256 FROM mailbox").toArray()[0];
    return row?.secret_sha256 ?? null;
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
    if (path === "/create" && req.method === "POST") return this.create(req);

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

    const match = /^\/devices\/([^/]+)(?:\/(carriage|apns))?$/.exec(path);
    if (!match || !DEVICE_ID.test(match[1]!)) return refuse(404, "not_found");
    const deviceId = match[1]!;
    const sub = match[2];

    if (!sub && req.method === "PUT") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      return this.register(req, deviceId);
    }
    if (!sub && req.method === "DELETE") {
      if (!(await inbox())) return refuse(401, "unauthorized");
      this.sql.exec("DELETE FROM devices WHERE id = ?", deviceId);
      return new Response(null, { status: 204 });
    }
    if (sub && req.method === "PUT") {
      const device = this.device(deviceId);
      if (!device) return refuse(404, "device_not_found");
      const token = bearer(req);
      if (token === null || (await sha256Hex(token)) !== device.secret_sha256) return refuse(401, "unauthorized");
      return sub === "carriage" ? this.carriage(req, device) : this.apns(req, device);
    }
    return refuse(404, "not_found");
  }

  /** `POST /v1/mailboxes` (7.26), through the Worker, which named this object. */
  private async create(req: Request): Promise<Response> {
    const input = await body(req);
    const hash = input?.secret_sha256;
    if (typeof hash !== "string" || !HASH.test(hash)) return refuse(400, "bad_request", "secret_sha256: 64 lowercase hex.");
    this.sql.exec("CREATE TABLE IF NOT EXISTS mailbox (secret_sha256 TEXT NOT NULL)");
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, secret_sha256 TEXT NOT NULL, carriage INTEGER NOT NULL, cursor INTEGER NOT NULL, apns_token TEXT, apns_environment TEXT)",
    );
    this.sql.exec("DELETE FROM mailbox");
    this.sql.exec("INSERT INTO mailbox (secret_sha256) VALUES (?)", hash);
    return new Response(null, { status: 201 });
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
      this.sql.exec(
        "INSERT OR REPLACE INTO devices (id, secret_sha256, carriage, cursor, apns_token, apns_environment) VALUES (?, ?, 1, ?, NULL, NULL)",
        deviceId,
        hash,
        cursor,
      );
    }
    return json({ device_id: deviceId });
  }

  /** `PUT .../carriage` (7.35): the phone's relay switch, told to the Inbox's socket. */
  private async carriage(req: Request, device: DeviceRow): Promise<Response> {
    const input = await body(req);
    if (input?.on === false) {
      this.sql.exec("UPDATE devices SET carriage = 0 WHERE id = ?", device.id);
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

  /** `POST .../push` (7.30): one push to one device, the envelope passed to Apple and never kept. */
  private async push(req: Request): Promise<Response> {
    const input = await body(req);
    const deviceId = input?.device_id;
    const collapseId = input?.collapse_id;
    const envelope = input?.ciphertext;
    if (typeof deviceId !== "string" || typeof collapseId !== "string" || !collapseId || typeof envelope !== "string" || !ENVELOPE.test(envelope)) {
      return refuse(400, "bad_request", "{ device_id, collapse_id, ciphertext }.");
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
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Frames from the Inbox (`item`, `applied`) arrive with R2; until then none is read. */
  async webSocketMessage(): Promise<void> {}

  async webSocketClose(socket: WebSocket, code: number): Promise<void> {
    try {
      socket.close(code === 1005 || code === 1006 ? 1000 : code, "closed");
    } catch {
      // Already closed.
    }
  }
}
