/**
 * The Plannotator Inbox relay: a Cloudflare Worker with one Durable Object
 * per mailbox (adr/implementation/inbox-mobile.md, section 4). It carries
 * pushes, and with R2 the phone's reads and answers, between a person's
 * Inbox and their phones, and holds only what it cannot read: every body is
 * an envelope under a key made at pairing on the computer and the phone.
 *
 * The routes, each JSON, errors `{ error, code }`:
 *   POST   /v1/mailboxes                                the Inbox, at its first pairing (the one braked route)
 *   PUT    /v1/mailboxes/:mbx/devices/:dev              Inbox bearer: register a phone
 *   DELETE /v1/mailboxes/:mbx/devices/:dev              Inbox bearer: remove it
 *   PUT    /v1/mailboxes/:mbx/devices/:dev/carriage     device bearer: the phone's relay switch
 *   PUT    /v1/mailboxes/:mbx/devices/:dev/apns         device bearer: the phone's APNs token
 *   POST   /v1/mailboxes/:mbx/push                      Inbox bearer: one push to one phone
 *   GET    /v1/mailboxes/:mbx/socket                    Inbox bearer, WebSocket: hello, carriage
 *
 * Owner-deployed (`wrangler deploy` from this folder, never from CI); lanes
 * run it under `wrangler dev` only.
 */
import { Mailbox, json, refuse, type Env } from "./mailbox";

export { Mailbox };

/**
 * The `simple.period` of the `[[ratelimits]]` block, echoed as `Retry-After`.
 * Not exported: workerd refuses a named export from the entry module that is
 * not a handler or a class.
 */
const CREATE_PERIOD_SECONDS = 60;

const MAILBOX_ID = /^mbx_[A-Za-z0-9_-]{22}$/;

/**
 * The brake on mailbox creation, the anonymous write, as guides.show brakes
 * guide creation (apps/guides-show/worker/index.ts): keyed on the client's
 * IP, open wherever it cannot resolve (no binding, no CF-Connecting-IP, a
 * limiter that throws). No other route is braked.
 */
async function braked(req: Request, limiter: RateLimit | undefined): Promise<Response | null> {
  if (!limiter) return null;
  const ip = req.headers.get("CF-Connecting-IP");
  if (!ip) return null;
  try {
    if ((await limiter.limit({ key: ip })).success) return null;
  } catch (error) {
    console.log("relay: rate limiter failed, allowing the create", error instanceof Error ? error.message : String(error));
    return null;
  }
  return json({ error: "too many requests", code: "too_many_requests" }, 429, { "Retry-After": String(CREATE_PERIOD_SECONDS) });
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
      const brake = await braked(req, env.MAILBOX_CREATE_LIMITER);
      if (brake) return brake;
      const id = mailboxId();
      const made = await env.MAILBOX.get(env.MAILBOX.idFromName(id)).fetch("https://mailbox/create", { method: "POST", body: await req.text() });
      return made.status === 201 ? json({ mailbox_id: id }, 201) : made;
    }
    const match = /^\/v1\/mailboxes\/([^/]+)(\/.+)$/.exec(url.pathname);
    if (!match) return refuse(404, "not_found");
    if (!MAILBOX_ID.test(match[1]!)) return refuse(404, "mailbox_not_found");
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(match[1]!));
    // The body is read here, whole: a mailbox that refuses before reading a streamed body leaves workerd an unread request stream.
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    return stub.fetch(`https://mailbox${match[2]}`, { method: req.method, headers: req.headers, body });
  },
} satisfies ExportedHandler<Env>;
