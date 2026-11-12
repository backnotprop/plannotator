import { loopbackOverride } from "./origin";

export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
}

export const FCM_ORIGIN = "https://fcm.googleapis.com";
export const FCM_OAUTH_ORIGIN = "https://oauth2.googleapis.com";
export const FCM_OAUTH_AUDIENCE = `${FCM_OAUTH_ORIGIN}/token`;
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const TOKEN_LIFETIME_MS = 50 * 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export function parseServiceAccount(text: string | undefined): FcmServiceAccount | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    const { project_id, client_email, private_key, private_key_id } = value;
    if (typeof project_id !== "string" || !/^[a-z0-9-]+$/.test(project_id)) return null;
    if (typeof client_email !== "string" || !client_email.includes("@")) return null;
    if (typeof private_key !== "string" || !private_key.includes("PRIVATE KEY")) return null;
    return { projectId: project_id, clientEmail: client_email, privateKey: private_key, privateKeyId: typeof private_key_id === "string" ? private_key_id : null };
  } catch {
    return null;
  }
}

export function fcmMessage(token: string, envelope: string, collapseKey: string) {
  return { message: { token, data: { e: envelope }, android: { priority: "high", collapse_key: collapseKey } } };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();
let cached: { signer: string; token: string; until: number } | null = null;
const inflight = new Map<string, Promise<string>>();
const refused = new Map<string, { error: FcmAuthError; until: number }>();
const REFUSAL_MEMORY_MS = 60_000;

export class FcmAuthError extends Error {}

async function assertion(account: FcmServiceAccount, now: number): Promise<string> {
  const iat = Math.floor(now / 1000);
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", ...(account.privateKeyId ? { kid: account.privateKeyId } : {}) })));
  const claims = base64url(encoder.encode(JSON.stringify({ iss: account.clientEmail, scope: FCM_SCOPE, aud: FCM_OAUTH_AUDIENCE, iat, exp: iat + 3600 })));
  try {
    const der = Uint8Array.from(atob(account.privateKey.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(`${header}.${claims}`)));
    return `${header}.${claims}.${base64url(signature)}`;
  } catch {
    throw new FcmAuthError("the service account's private key could not be read");
  }
}

async function exchange(account: FcmServiceAccount, oauthOrigin: string, signer: string, now: number): Promise<string> {
  const grant = await assertion(account, now);
  let answer: Response;
  try {
    answer = await fetch(`${oauthOrigin}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${grant}`,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new FcmAuthError(`Google's token endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await answer.text();
  let parsed: { access_token?: unknown; expires_in?: unknown; error?: unknown } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
  }
  if (answer.status !== 200 || typeof parsed.access_token !== "string") {
    throw new FcmAuthError(`Google's token endpoint answered ${answer.status}${typeof parsed.error === "string" ? ` ${parsed.error}` : ""}.`);
  }
  const lifetime = typeof parsed.expires_in === "number" && parsed.expires_in > 120 ? Math.min(TOKEN_LIFETIME_MS, (parsed.expires_in - 60) * 1000) : TOKEN_LIFETIME_MS;
  cached = { signer, token: parsed.access_token, until: now + lifetime };
  return cached.token;
}

async function accessToken(account: FcmServiceAccount, oauthOrigin: string, now: number): Promise<string> {
  const signer = `${oauthOrigin}\n${account.clientEmail}\n${account.privateKeyId ?? ""}`;
  if (cached && cached.signer === signer && now < cached.until) return cached.token;
  const memory = refused.get(signer);
  if (memory && now < memory.until) throw memory.error;
  let pending = inflight.get(signer);
  if (!pending) {
    pending = exchange(account, oauthOrigin, signer, now)
      .then((token) => {
        refused.delete(signer);
        return token;
      })
      .catch((error: unknown) => {
        if (error instanceof FcmAuthError) refused.set(signer, { error, until: Date.now() + REFUSAL_MEMORY_MS });
        throw error;
      })
      .finally(() => inflight.delete(signer));
    inflight.set(signer, pending);
  }
  return pending;
}

export interface FcmResult {
  status: number;
  reason: string | null;
}

export async function sendFcm(input: {
  account: FcmServiceAccount;
  token: string;
  collapseKey: string;
  envelope: string;
  origin?: string;
  oauthOrigin?: string;
}): Promise<FcmResult> {
  const origin = (loopbackOverride("FCM_ORIGIN", input.origin) || FCM_ORIGIN).replace(/\/+$/, "");
  const oauthOrigin = (loopbackOverride("FCM_OAUTH_ORIGIN", input.oauthOrigin) || FCM_OAUTH_ORIGIN).replace(/\/+$/, "");
  const bearer = await accessToken(input.account, oauthOrigin, Date.now());
  const answer = await fetch(`${origin}/v1/projects/${input.account.projectId}/messages:send`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(fcmMessage(input.token, input.envelope, input.collapseKey)),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await answer.text();
  if (answer.status === 401 && cached?.token === bearer) cached = null;
  let reason: string | null = null;
  if (answer.status !== 200) {
    try {
      const details = (JSON.parse(text) as { error?: { details?: unknown } }).error?.details;
      if (Array.isArray(details)) {
        for (const detail of details) {
          const code = (detail as { errorCode?: unknown } | null)?.errorCode;
          if (typeof code === "string") {
            reason = code;
            break;
          }
        }
      }
    } catch {
    }
  }
  return { status: answer.status, reason };
}
