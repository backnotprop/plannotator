export const SERVER_SESSION_FIELD = "serverSession";

export const SERVER_SESSION_MISMATCH_CODE = "session_mismatch";

export const SERVER_SESSION_MISMATCH_ERROR =
  "This review was replaced by a newer Plannotator session on the same address. Reload the page to see what is open now; nothing was submitted.";

export function createServerSessionNonce(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function checkServerSession(body: unknown, expected: string): "ok" | "mismatch" {
  if (!body || typeof body !== "object") return "ok";
  const value = (body as Record<string, unknown>)[SERVER_SESSION_FIELD];
  if (typeof value !== "string") return "ok";
  return value === expected ? "ok" : "mismatch";
}

export const INBOX_SERVER_SESSION_MISMATCH_ERROR =
  "This Inbox page is out of date: a newer Plannotator Inbox runs on the same address. Reload the page to see it; nothing was saved.";

export function serverSessionMismatchBody(error: string = SERVER_SESSION_MISMATCH_ERROR): { error: string; code: string } {
  return { error, code: SERVER_SESSION_MISMATCH_CODE };
}
