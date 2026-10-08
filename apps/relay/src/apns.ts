/**
 * The relay's one call to Apple: a push to one device token
 * (adr/implementation/inbox-mobile.md, section 4, "Push").
 *
 * The provider token is an ES256 JWT signed with the APNs key the Worker holds
 * as a secret (`APNS_KEY`, the .p8 file's text, with `APNS_KEY_ID` and
 * `APNS_TEAM_ID`). Apple accepts a token for an hour and refuses one renewed
 * more often than every 20 minutes, so it is kept for 50 minutes per isolate.
 */
import { h2Request } from "./apns-h2";

export interface ApnsKey {
  key: string;
  keyId: string;
  teamId: string;
}

export type ApnsEnvironment = "sandbox" | "production";

/** The bundle id the app ships under: the push topic. */
export const APNS_TOPIC = "ai.plannotator.app";

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

const TOKEN_LIFETIME_MS = 50 * 60_000;

/**
 * What APNs gets: a generic alert that shows only when the notification
 * service extension cannot run, and the envelope it decrypts. The Inbox sizes
 * its envelope against this same wrapper (packages/server/inbox-relay.ts).
 */
export function apnsBody(envelope: string): string {
  return JSON.stringify({ aps: { alert: { title: "Plannotator", body: "New in your Inbox" }, "mutable-content": 1, sound: "default" }, e: envelope });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();
let cached: { keyId: string; token: string; madeAt: number } | null = null;

/** The provider token, made again after 50 minutes or when the key id changes. */
async function providerToken(apns: ApnsKey, now: number): Promise<string> {
  if (cached && cached.keyId === apns.keyId && now - cached.madeAt < TOKEN_LIFETIME_MS) return cached.token;
  const der = Uint8Array.from(atob(apns.key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: apns.keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: apns.teamId, iat: Math.floor(now / 1000) })));
  // WebCrypto's ECDSA signature is r || s, the form JWS ES256 wants.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)));
  cached = { keyId: apns.keyId, token: `${header}.${claims}.${base64url(signature)}`, madeAt: now };
  return cached.token;
}

export interface ApnsResult {
  status: number;
  /** Apple's `reason` on a refusal (`Unregistered`, `BadDeviceToken`, `InvalidProviderToken`), else null. */
  reason: string | null;
}

/**
 * Send one push. `origin` replaces Apple's host for both environments: a
 * local HTTP/2 server in the relay's own proof (`APNS_ORIGIN` under
 * `wrangler dev`); `http:` there means cleartext HTTP/2.
 */
export async function sendPush(input: {
  apns: ApnsKey;
  token: string;
  environment: ApnsEnvironment;
  collapseId: string;
  envelope: string;
  origin?: string;
}): Promise<ApnsResult> {
  const target = new URL(input.origin || APNS_HOSTS[input.environment]);
  const tls = target.protocol === "https:";
  const body = encoder.encode(apnsBody(input.envelope));
  const answer = await h2Request({
    hostname: target.hostname,
    port: Number(target.port) || (tls ? 443 : 80),
    tls,
    path: `/3/device/${input.token}`,
    headers: [
      ["authorization", `bearer ${await providerToken(input.apns, Date.now())}`],
      ["apns-push-type", "alert"],
      ["apns-priority", "10"],
      ["apns-topic", APNS_TOPIC],
      ["apns-collapse-id", input.collapseId],
      ["content-type", "application/json"],
      ["content-length", String(body.length)],
    ],
    body,
  });
  let reason: string | null = null;
  if (answer.status !== 200 && answer.body) {
    try {
      const parsed = JSON.parse(answer.body) as { reason?: unknown };
      if (typeof parsed.reason === "string") reason = parsed.reason;
    } catch {
      // Not JSON: no reason.
    }
  }
  return { status: answer.status, reason };
}
