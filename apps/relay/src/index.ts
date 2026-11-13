/**
 * The Plannotator Inbox relay: a Cloudflare Worker with one Durable Object
 * per mailbox (adr/implementation/inbox-mobile.md, sections 4 and 10). It carries
 * pushes, and the phone's reads and answers, between a person's
 * Inbox and their phones, and holds only what it cannot read: every body is
 * an envelope under a key made at pairing on the computer and the phone.
 *
 * The routes, each JSON, errors `{ error, code }`:
 *   POST   /v1/mailboxes                                the Inbox, at its first pairing (braked per IP)
 *   PUT    /v1/mailboxes/:mbx/devices/:dev              Inbox bearer: register a phone
 *   DELETE /v1/mailboxes/:mbx/devices/:dev              Inbox bearer: remove it
 *   PUT    /v1/mailboxes/:mbx/devices/:dev/carriage     device bearer: the phone's relay switch
 *   PUT    /v1/mailboxes/:mbx/devices/:dev/apns         device bearer: the phone's APNs token
 *   PUT    /v1/mailboxes/:mbx/devices/:dev/fcm          device bearer: the phone's FCM token (one push token per device)
 *   GET    /v1/mailboxes/:mbx/devices/:dev/items        device bearer: the held down items after a number
 *   POST   /v1/mailboxes/:mbx/devices/:dev/ack          device bearer: delete them, by number or store cursor
 *   POST   /v1/mailboxes/:mbx/devices/:dev/commands     device bearer: a command up, held for the Inbox
 *   POST   /v1/mailboxes/:mbx/push                      Inbox bearer: one push to one phone, through APNs or FCM
 *   GET    /v1/mailboxes/:mbx/socket                    Inbox bearer, WebSocket: hello, carriage, command; item, applied
 *
 * Owner-deployed (`wrangler deploy` from this folder, never from CI); lanes
 * run it under `wrangler dev` only.
 */
import { braked } from "./brake";
import { DEVICE_ID, HASH, Mailbox, SIGNAL_TOKEN, WEBSOCKET_MESSAGE_LIMIT, json, refuse, type Env } from "./mailbox";

export { Mailbox };

/**
 * The `simple.period` of the `[[ratelimits]]` block, echoed as `Retry-After`.
 * Not exported: workerd refuses a named export from the entry module that is
 * not a handler or a class.
 */
const CREATE_PERIOD_SECONDS = 60;

const MAILBOX_ID = /^mbx_[A-Za-z0-9_-]{22}$/;

const SMALL_BODY_MAX = 64 * 1024;
const COMMAND_BODY_MAX = WEBSOCKET_MESSAGE_LIMIT + 4096;

function routeOf(method: string, rest: string): { auth: boolean; max: number } | null {
  if (rest === "/socket") return method === "GET" ? { auth: true, max: 0 } : null;
  if (rest === "/push") return method === "POST" ? { auth: true, max: SMALL_BODY_MAX } : null;
  const signal = /^\/signals\/([^/]+)$/.exec(rest);
  if (signal) return method === "GET" && SIGNAL_TOKEN.test(signal[1]!) ? { auth: false, max: 0 } : null;
  const device = /^\/devices\/([^/]+)(?:\/([a-z]+))?$/.exec(rest);
  if (!device || !DEVICE_ID.test(device[1]!)) return null;
  const sub = device[2];
  const wanted: Record<string, string> = { "": "PUT DELETE", carriage: "PUT", apns: "PUT", fcm: "PUT", items: "GET", ack: "POST", commands: "POST", signal: "POST" };
  if (!(wanted[sub ?? ""] ?? "").split(" ").includes(method)) return null;
  return { auth: true, max: sub === "commands" ? COMMAND_BODY_MAX : SMALL_BODY_MAX };
}

async function cappedBody(req: Request, max: number): Promise<ArrayBuffer | null> {
  const length = Number(req.headers.get("content-length"));
  if (Number.isFinite(length) && length > max) return null;
  if (!req.body) return new ArrayBuffer(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

function mailboxId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `mbx_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/mailboxes") {
      if (req.method !== "POST") return refuse(404, "not_found");
      const brake = await braked(req, env.MAILBOX_CREATE_LIMITER, CREATE_PERIOD_SECONDS);
      if (brake) return brake;
      const raw = await cappedBody(req, SMALL_BODY_MAX);
      if (raw === null) return refuse(413, "body_too_large");
      let hash: unknown;
      try {
        hash = (JSON.parse(new TextDecoder().decode(raw)) as { secret_sha256?: unknown } | null)?.secret_sha256;
      } catch {
        hash = undefined;
      }
      if (typeof hash !== "string" || !HASH.test(hash)) return refuse(400, "bad_request", "secret_sha256: 64 lowercase hex.");
      // Made through an RPC on the object, never a fetchable path: a client cannot reach creation under an id it picks.
      const id = mailboxId();
      if (!(await env.MAILBOX.get(env.MAILBOX.idFromName(id)).create(hash))) return refuse(500, "internal_error", "The mailbox could not be made.");
      return json({ mailbox_id: id }, 201);
    }
    const match = /^\/v1\/mailboxes\/([^/]+)(\/.+)$/.exec(url.pathname);
    if (!match) return refuse(404, "not_found");
    if (!MAILBOX_ID.test(match[1]!)) return refuse(404, "mailbox_not_found");
    const route = routeOf(req.method, match[2]!);
    if (!route) return refuse(404, "not_found");
    if (route.auth && !/^Bearer\s+\S+$/i.test((req.headers.get("authorization") ?? "").trim())) return refuse(401, "unauthorized");
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await cappedBody(req, route.max);
    if (body === null) return refuse(413, "body_too_large");
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(match[1]!));
    return stub.fetch(`https://mailbox${match[2]}${url.search}`, { method: req.method, headers: req.headers, body });
  },
} satisfies ExportedHandler<Env>;
