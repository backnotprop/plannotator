/**
 * The relay's one call to Google: a push to one Android device through FCM
 * HTTP v1 (adr/implementation/inbox-mobile.md, section 10, "Push through FCM").
 *
 * The access token is an OAuth2 token minted from the service account the
 * Worker holds as a secret (`FCM_SERVICE_ACCOUNT`, the service account's JSON
 * key file as text): a JWT signed RS256 with its private key (WebCrypto),
 * exchanged at Google's token endpoint, and kept for 50 minutes per isolate
 * (Google's tokens last an hour). Plain `fetch`: FCM accepts HTTP/1.1, so the
 * `connect()` path APNs needs is not used.
 *
 * No Workers-only imports: the test suite reads `fcmMessage` from here to
 * check the body.
 */
import { loopbackOverride } from "./origin";

/** The fields of a service account's JSON key file the relay uses. */
export interface FcmServiceAccount {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
}

/** Google's hosts. Fixed: only the relay's own proof replaces them (FCM_ORIGIN, FCM_OAUTH_ORIGIN under `wrangler dev`, loopback only). */
export const FCM_ORIGIN = "https://fcm.googleapis.com";
export const FCM_OAUTH_ORIGIN = "https://oauth2.googleapis.com";
/** The JWT's audience: Google's token endpoint, whichever host the exchange is sent to. */
export const FCM_OAUTH_AUDIENCE = `${FCM_OAUTH_ORIGIN}/token`;
export const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";

const TOKEN_LIFETIME_MS = 50 * 60_000;
/** How long one request to Google may take before the push answers fcm_failed. */
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Read the secret: the service account's JSON key file. Null when it is not
 * one (the relay then answers as if it held no key, and logs it once).
 */
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

/**
 * What FCM gets: data only, so the app draws every notification itself from
 * the decrypted summary; `collapse_key` lets a thread's newer push replace an
 * older one FCM still holds for an offline phone.
 */
export function fcmMessage(token: string, envelope: string, collapseKey: string) {
  return { message: { token, data: { e: envelope }, android: { priority: "high", collapse_key: collapseKey } } };
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const encoder = new TextEncoder();
/** The access token this isolate holds, for one signer. */
let cached: { signer: string; token: string; until: number } | null = null;
/** The exchange in flight, per signer: concurrent pushes wait on one exchange instead of each signing their own. */
const inflight = new Map<string, Promise<string>>();
/** A refused exchange, per signer, remembered for a minute: a burst of pushes does not hammer Google with a key it refuses. */
const refused = new Map<string, { error: FcmAuthError; until: number }>();
const REFUSAL_MEMORY_MS = 60_000;

/** Raised when the service account's key cannot be read, or Google's token endpoint refuses it or cannot be reached. */
export class FcmAuthError extends Error {}

/** The signed JWT bearer grant. A key that cannot be read or used is an FcmAuthError, never a transport failure. */
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

/** One exchange at Google's token endpoint. */
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
    // Not JSON: refused below.
  }
  if (answer.status !== 200 || typeof parsed.access_token !== "string") {
    throw new FcmAuthError(`Google's token endpoint answered ${answer.status}${typeof parsed.error === "string" ? ` ${parsed.error}` : ""}.`);
  }
  const lifetime = typeof parsed.expires_in === "number" && parsed.expires_in > 120 ? Math.min(TOKEN_LIFETIME_MS, (parsed.expires_in - 60) * 1000) : TOKEN_LIFETIME_MS;
  cached = { signer, token: parsed.access_token, until: now + lifetime };
  return cached.token;
}

/**
 * The OAuth access token, minted again after 50 minutes (sooner if Google
 * says so) or when the account or the endpoint changes. Concurrent callers
 * share one exchange; a refusal is answered from memory for a minute.
 */
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
  /** FCM's `errorCode` (`UNREGISTERED`, `INVALID_ARGUMENT`, `UNAVAILABLE`, ...) on a refusal, else null. */
  reason: string | null;
}

/**
 * Send one push. `origin` and `oauthOrigin` replace Google's hosts in the
 * relay's own proof only, and only when they name a loopback host. Throws on
 * a transport failure or a refused token exchange; a refusal by FCM itself is
 * a result.
 */
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
  // Drop the token only if it is still the one FCM refused: another push may have minted a fresh one meanwhile.
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
      // Not JSON: no reason.
    }
  }
  return { status: answer.status, reason };
}
