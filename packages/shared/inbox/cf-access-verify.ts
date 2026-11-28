import { CF_ACCESS_JWT_HEADER, cfAccessFetchSiteAllowed, isCfAccessHost, normalizeCfAccessEmail, type CfAccessSettings } from "./cf-access";

export const CF_ACCESS_CLOCK_SKEW_S = 60;
export const CF_ACCESS_KEYS_TTL_MS = 60 * 60 * 1000;
export const CF_ACCESS_KEYS_REFETCH_MS = 10 * 1000;
export const CF_ACCESS_KEYS_RETRY_MS = 5 * 1000;
export const CF_ACCESS_MAX_TOKEN_CHARS = 16 * 1024;

export type CfAccessRefusalCode =
  | "forbidden_host"
  | "access_token_required"
  | "access_token_invalid"
  | "access_keys_unavailable"
  | "access_identity_refused"
  | "cross_site";

export type CfAccessCheck = { ok: true; email: string; world: "inbox" | "sessions" } | { ok: false; status: number; code: CfAccessRefusalCode; message: string };
type TokenCheck = { ok: true; email: string } | Extract<CfAccessCheck, { ok: false }>;

export type CfAccessKeysFetch = (url: string) => Promise<unknown>;

export interface CfAccessVerifierOptions {
  fetchKeys?: CfAccessKeysFetch;
  now?: () => number;
}

const refuse = (code: CfAccessRefusalCode, message: string, status = 403): Extract<CfAccessCheck, { ok: false }> => ({ ok: false, status, code, message });
const invalid = () => refuse("access_token_invalid", "The Cloudflare Access token is not valid here.");
const notAPerson = () => refuse("access_identity_refused", "This address opens only for its owner's e-mail.");

const defaultFetchKeys: CfAccessKeysFetch = async (url) => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(10_000), headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
};

function base64UrlBytes(part: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) return null;
  return new Uint8Array(Buffer.from(part, "base64url")) as Uint8Array<ArrayBuffer>;
}

function base64UrlJson(part: string): Record<string, unknown> | null {
  const bytes = base64UrlBytes(part);
  if (!bytes) return null;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const RS256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

async function importKeys(body: unknown): Promise<Map<string, CryptoKey>> {
  const keys = new Map<string, CryptoKey>();
  const list = body && typeof body === "object" ? (body as { keys?: unknown }).keys : undefined;
  if (!Array.isArray(list)) throw new Error("no keys");
  for (const jwk of list) {
    if (!jwk || typeof jwk !== "object") continue;
    const { kty, kid, alg, use, n, e } = jwk as Record<string, unknown>;
    if (kty !== "RSA" || typeof kid !== "string" || kid === "" || typeof n !== "string" || typeof e !== "string") continue;
    if (alg !== undefined && alg !== "RS256") continue;
    if (use !== undefined && use !== "sig") continue;
    if ((base64UrlBytes(n)?.length ?? 0) < 256) continue;
    try {
      keys.set(kid, await crypto.subtle.importKey("jwk", { kty: "RSA", n, e, alg: "RS256", ext: true }, RS256, false, ["verify"]));
    } catch {
      continue;
    }
  }
  if (keys.size === 0) throw new Error("no usable keys");
  return keys;
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function createCfAccessVerifier(settings: CfAccessSettings, options: CfAccessVerifierOptions = {}) {
  const fetchKeys = options.fetchKeys ?? defaultFetchKeys;
  const now = options.now ?? Date.now;
  const certsUrl = `${settings.issuer}/cdn-cgi/access/certs`;
  let keys: Map<string, CryptoKey> | null = null;
  let fetchedAt = -Infinity;
  let lastAttempt = -Infinity;
  let inFlight: Promise<void> | null = null;

  const fresh = () => keys !== null && now() - fetchedAt < CF_ACCESS_KEYS_TTL_MS;

  const refresh = (): Promise<void> => {
    if (inFlight) return inFlight;
    lastAttempt = now();
    inFlight = (async () => {
      try {
        keys = await importKeys(await fetchKeys(certsUrl));
        fetchedAt = now();
      } catch {
        if (!fresh()) keys = null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const keyFor = async (kid: string): Promise<CryptoKey | "unavailable" | "unknown"> => {
    if (inFlight) await inFlight;
    const wait = fresh() ? CF_ACCESS_KEYS_REFETCH_MS : CF_ACCESS_KEYS_RETRY_MS;
    if ((!fresh() || !keys!.has(kid)) && now() - lastAttempt >= wait) await refresh();
    if (!fresh()) return "unavailable";
    return keys!.get(kid) ?? "unknown";
  };

  const verifyToken = async (token: string): Promise<TokenCheck> => {
    if (token.length > CF_ACCESS_MAX_TOKEN_CHARS) return invalid();
    const parts = token.split(".");
    if (parts.length !== 3) return invalid();
    const [h, p, s] = parts as [string, string, string];
    const header = base64UrlJson(h);
    if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || header.kid === "" || "crit" in header) return invalid();
    const signature = base64UrlBytes(s);
    const claims = base64UrlJson(p);
    if (!signature || signature.length === 0 || !claims) return invalid();
    const key = await keyFor(header.kid);
    if (key === "unavailable") return refuse("access_keys_unavailable", "Cloudflare Access's keys could not be fetched; try again shortly.", 503);
    if (key === "unknown") return invalid();
    let good = false;
    try {
      good = await crypto.subtle.verify(RS256, key, signature, new TextEncoder().encode(`${h}.${p}`));
    } catch {
      good = false;
    }
    if (!good) return invalid();
    if (claims.iss !== settings.issuer) return invalid();
    const aud = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud : [];
    if (!aud.includes(settings.aud)) return invalid();
    const seconds = now() / 1000;
    if (!isTime(claims.exp) || claims.exp <= seconds - CF_ACCESS_CLOCK_SKEW_S) return invalid();
    if (claims.nbf !== undefined && (!isTime(claims.nbf) || claims.nbf > seconds + CF_ACCESS_CLOCK_SKEW_S)) return invalid();
    if (claims.iat !== undefined && (!isTime(claims.iat) || claims.iat > seconds + CF_ACCESS_CLOCK_SKEW_S)) return invalid();
    if (typeof claims.common_name === "string" && claims.common_name !== "") return notAPerson();
    if (typeof claims.email !== "string" || claims.email.trim() === "") return notAPerson();
    const email = normalizeCfAccessEmail(claims.email);
    if (!settings.allow.includes(email)) return notAPerson();
    return { ok: true, email };
  };

  const check = async (method: string, path: string, headers: Headers): Promise<CfAccessCheck> => {
    const host = headers.get("host");
    const world = isCfAccessHost(host, settings.host) ? "inbox" : settings.sessionHost && isCfAccessHost(host, settings.sessionHost) ? "sessions" : null;
    if (!world) return refuse("forbidden_host", "This address answers only its public hostname.");
    const token = headers.get(CF_ACCESS_JWT_HEADER)?.trim();
    if (!token) return refuse("access_token_required", "This address answers only requests through Cloudflare Access.");
    const verified = await verifyToken(token);
    if (!verified.ok) return verified;
    if (!cfAccessFetchSiteAllowed(method, path, headers, world === "sessions")) return refuse("cross_site", "Requests from other sites are not accepted.");
    return { ...verified, world };
  };

  return { check, verifyToken, certsUrl };
}

export type CfAccessVerifier = ReturnType<typeof createCfAccessVerifier>;
