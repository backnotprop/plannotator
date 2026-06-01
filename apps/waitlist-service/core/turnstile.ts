// Cloudflare Turnstile siteverify wrapper.
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// Cloudflare documents Turnstile tokens as up to ~2048 chars. We accept a
// small buffer above that and reject anything obviously oversized so we
// don't bounce huge payloads through siteverify.
const MAX_TOKEN_LENGTH = 2500;

export interface TurnstileVerifyResult {
  success: boolean;
  // Cloudflare-defined error codes, e.g. "missing-input-response",
  // "invalid-input-response", "timeout-or-duplicate". See docs above.
  errorCodes: string[];
}

/**
 * Verify a Turnstile token against Cloudflare. Returns `success: false`
 * with a descriptive error code when the secret isn't configured, the
 * token is missing/oversized, or siteverify rejects it.
 */
export async function verifyTurnstile(
  token: string | null | undefined,
  secret: string | undefined,
  remoteIp: string | null
): Promise<TurnstileVerifyResult> {
  if (!secret) {
    return { success: false, errorCodes: ["missing-secret"] };
  }
  if (!token) {
    return { success: false, errorCodes: ["missing-input-response"] };
  }
  if (token.length > MAX_TOKEN_LENGTH) {
    return { success: false, errorCodes: ["invalid-input-response"] };
  }

  const body = new FormData();
  body.append("secret", secret);
  body.append("response", token);
  if (remoteIp) body.append("remoteip", remoteIp);

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
    });
    if (!res.ok) {
      return { success: false, errorCodes: [`http-${res.status}`] };
    }
    const data = (await res.json()) as {
      success?: boolean;
      "error-codes"?: string[];
    };
    return {
      success: !!data.success,
      errorCodes: data["error-codes"] ?? [],
    };
  } catch (e) {
    return {
      success: false,
      errorCodes: ["network-error"],
    };
  }
}
