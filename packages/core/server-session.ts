/**
 * Stale-tab guard for decision POSTs.
 *
 * Every Plannotator server process (plan, annotate, code review; Bun and Pi)
 * issues ONE random `serverSession` nonce at start and advertises it on the
 * payload the tab loads (`/api/plan`, `/api/diff`). The tab echoes it on every
 * decision it posts (approve, deny, feedback, exit). A tab left open on a port
 * that a NEW server now owns (a fixed `PLANNOTATOR_PORT`, remote mode's 19432,
 * or a rare random-port reuse) would otherwise approve or annotate a different
 * document than the one on its screen; the new server sees a nonce that is not
 * its own and answers `409 { code: "session_mismatch" }` before it claims or
 * settles anything.
 *
 * Compatibility: a body WITHOUT `serverSession` (an older client, a beacon or
 * an empty exit body) is accepted, exactly as before. Only a nonce that is
 * present and different is refused.
 *
 * Browser-safe and dependency-free (vendored to Pi).
 */

export const SERVER_SESSION_FIELD = "serverSession";

export const SERVER_SESSION_MISMATCH_CODE = "session_mismatch";

export const SERVER_SESSION_MISMATCH_ERROR =
  "This review was replaced by a newer Plannotator session on the same address. Reload the page to see what is open now; nothing was submitted.";

/** A fresh nonce for one server process: 16 random bytes as hex. */
export function createServerSessionNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * Whether a decision body may be accepted by the server holding `expected`.
 * Missing (or a non-string value, which no client of ours sends) passes for
 * compatibility; a string that differs is a mismatch.
 */
export function checkServerSession(body: unknown, expected: string): "ok" | "mismatch" {
  if (!body || typeof body !== "object") return "ok";
  const value = (body as Record<string, unknown>)[SERVER_SESSION_FIELD];
  if (typeof value !== "string") return "ok";
  return value === expected ? "ok" : "mismatch";
}

/**
 * The Plannotator Inbox's words for the same refusal: the Inbox holds no
 * review, and a refused write (a pick, a Send, a setting) saved nothing.
 */
export const INBOX_SERVER_SESSION_MISMATCH_ERROR =
  "This Inbox page is out of date: a newer Plannotator Inbox runs on the same address. Reload the page to see it; nothing was saved.";

/**
 * The JSON body a server answers a mismatch with (status 409). `error`
 * defaults to the review wording; the Inbox passes its own.
 */
export function serverSessionMismatchBody(error: string = SERVER_SESSION_MISMATCH_ERROR): { error: string; code: string } {
  return { error, code: SERVER_SESSION_MISMATCH_CODE };
}
