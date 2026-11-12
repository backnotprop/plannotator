import { HASH, Mailbox, json, refuse, type Env } from "./mailbox";

export { Mailbox };

const CREATE_PERIOD_SECONDS = 60;

const MAILBOX_ID = /^mbx_[A-Za-z0-9_-]{22}$/;

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
      let hash: unknown;
      try {
        hash = ((await req.json()) as { secret_sha256?: unknown } | null)?.secret_sha256;
      } catch {
        hash = undefined;
      }
      if (typeof hash !== "string" || !HASH.test(hash)) return refuse(400, "bad_request", "secret_sha256: 64 lowercase hex.");
      const id = mailboxId();
      if (!(await env.MAILBOX.get(env.MAILBOX.idFromName(id)).create(hash))) return refuse(500, "internal_error", "The mailbox could not be made.");
      return json({ mailbox_id: id }, 201);
    }
    const match = /^\/v1\/mailboxes\/([^/]+)(\/.+)$/.exec(url.pathname);
    if (!match) return refuse(404, "not_found");
    if (!MAILBOX_ID.test(match[1]!)) return refuse(404, "mailbox_not_found");
    const stub = env.MAILBOX.get(env.MAILBOX.idFromName(match[1]!));
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    return stub.fetch(`https://mailbox${match[2]}${url.search}`, { method: req.method, headers: req.headers, body });
  },
} satisfies ExportedHandler<Env>;
