import { h2Request } from "./apns-h2";
import { loopbackOverride } from "./origin";

export interface ApnsKey {
  key: string;
  keyId: string;
  teamId: string;
}

export type ApnsEnvironment = "sandbox" | "production";

export const APNS_TOPIC = "ai.plannotator.app";

const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: "https://api.sandbox.push.apple.com",
  production: "https://api.push.apple.com",
};

const TOKEN_LIFETIME_MS = 50 * 60_000;

export function apnsBody(envelope: string): string {
  return JSON.stringify({ aps: { alert: { title: "Plannotator", body: "New in your Inbox" }, "mutable-content": 1, sound: "default" }, e: envelope });
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();
let cached: { signer: string; token: string; madeAt: number } | null = null;

async function providerToken(apns: ApnsKey, now: number): Promise<string> {
  const signer = `${apns.teamId}\n${apns.keyId}`;
  if (cached && cached.signer === signer && now - cached.madeAt < TOKEN_LIFETIME_MS) return cached.token;
  const der = Uint8Array.from(atob(apns.key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "ES256", kid: apns.keyId })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: apns.teamId, iat: Math.floor(now / 1000) })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`)));
  cached = { signer, token: `${header}.${claims}.${base64url(signature)}`, madeAt: now };
  return cached.token;
}

export interface ApnsResult {
  status: number;
  reason: string | null;
}

export async function sendPush(input: {
  apns: ApnsKey;
  token: string;
  environment: ApnsEnvironment;
  collapseId: string;
  envelope: string;
  origin?: string;
}): Promise<ApnsResult> {
  const target = new URL(loopbackOverride("APNS_ORIGIN", input.origin) || APNS_HOSTS[input.environment]);
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
    }
  }
  return { status: answer.status, reason };
}
