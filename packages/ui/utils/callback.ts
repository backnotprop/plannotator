/**
 * Bot callback integration for Plannotator share URLs.
 *
 * When the bot posts a plan URL with ?cb=<encoded_url>&ct=<token>,
 * these utilities parse the config and POST the user's decision back.
 * A 2xx answer may carry `{ "return_url": "<http(s) url>" }`: the page then
 * goes there after the done screen (back to the issue the link came from).
 */

/** Actions the user can trigger via the in-Plannotator callback buttons. */
export enum CallbackAction {
  Approve  = "approve",
  Feedback = "feedback",
}

/** Callback config parsed from ?cb=<encoded_url>&ct=<token> in the URL. */
export interface CallbackConfig {
  callbackUrl: string;
  token: string;
}

export interface ToastSuccess {
  readonly type: 'success';
  readonly message: string;
  /**
   * Where the bot wants the person to go after the decision landed (the
   * issue or work item the link came from). Read from `return_url` in the
   * callback's 2xx JSON answer; only http: and https: are kept. Absent when
   * the answer names none.
   */
  readonly returnUrl?: string;
}
export interface ToastError   { readonly type: 'error';   readonly message: string }
export type ToastPayload = ToastSuccess | ToastError | null;

/** How long the done screen shows before the page goes to `returnUrl`. */
export const CALLBACK_RETURN_DELAY_MS = 1500;

/**
 * Parse callback configuration from URL search params.
 * Checks both the standard query string (before #) and query-style params
 * embedded in the hash (e.g. `#<hash>?cb=...&ct=...`).
 *
 * The decoded `cb` value must use http: or https: — other schemes (file://, javascript://, etc.)
 * are rejected to prevent protocol-based attacks.
 *
 * @param loc - Location object to parse (defaults to window.location; injectable for tests)
 * @returns CallbackConfig if both cb and ct are present and valid, null otherwise
 */
export function getCallbackConfig(
  loc: { readonly search: string; readonly hash: string } = window.location,
): CallbackConfig | null {
  const searchParams = new URLSearchParams(loc.search);
  let cb = searchParams.get("cb");
  let ct = searchParams.get("ct");

  if (!cb || !ct) {
    const qIdx = loc.hash.indexOf("?");
    if (qIdx !== -1) {
      const hashParams = new URLSearchParams(loc.hash.slice(qIdx + 1));
      cb = cb ?? hashParams.get("cb");
      ct = ct ?? hashParams.get("ct");
    }
  }

  if (!cb || !ct) return null;

  try {
    const { protocol } = new URL(cb);
    if (protocol !== "https:" && protocol !== "http:") return null;
  } catch {
    return null; // malformed URL
  }

  return { callbackUrl: cb, token: ct };
}

/**
 * Read an optional `return_url` from a callback's 2xx answer. Any other
 * answer (empty, not JSON, no string field, a scheme other than http: or
 * https:) gives undefined, so the decision still counts as sent.
 */
async function readReturnUrl(res: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return undefined;
  }
  if (!body || typeof body !== "object") return undefined;
  const raw = (body as { return_url?: unknown }).return_url;
  if (typeof raw !== "string" || raw === "") return undefined;
  try {
    const { protocol } = new URL(raw);
    return protocol === "https:" || protocol === "http:" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Execute a bot callback POST request.
 *
 * Pure function (no React deps) — testable without a DOM.
 *
 * @param action - The action to send
 * @param config - Callback URL and single-use token from `getCallbackConfig()`
 * @param annotatedUrl - Current share URL (with annotations encoded); sent to the bot
 * @returns Toast payload to display
 */
export async function executeCallback(
  action: CallbackAction,
  config: CallbackConfig,
  annotatedUrl: string,
): Promise<ToastPayload> {
  const successMsg = action === CallbackAction.Approve
    ? "Plan approved! The bot will proceed to implementation."
    : "Feedback sent! The bot will re-plan with your annotations.";
  try {
    const res = await fetch(config.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: config.token, annotated_url: annotatedUrl }),
    });
    if (!res.ok) {
      return {
        type: "error",
        message: res.status === 401
          ? "Plan link expired — request a new one from the bot."
          : "Callback failed.",
      };
    }
    const returnUrl = await readReturnUrl(res);
    return returnUrl
      ? { type: "success", message: successMsg, returnUrl }
      : { type: "success", message: successMsg };
  } catch {
    return { type: "error", message: "Callback failed." };
  }
}
