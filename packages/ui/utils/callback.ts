/**
 * Bot callback integration for Plannotator share URLs.
 *
 * When the bot posts a plan URL with ?cb=<encoded_url>&ct=<token>,
 * these utilities parse the config and POST the user's decision back.
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

export type ToastPayload = { type: 'success' | 'error'; message: string } | null;

/**
 * Parse callback configuration from URL search params.
 * Checks both the standard query string (before #) and query-style params
 * embedded in the hash (e.g. `#<hash>?cb=...&ct=...`).
 *
 * @param loc - Location object to parse (defaults to window.location; injectable for tests)
 * @returns CallbackConfig if both cb and ct are present, null otherwise
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

  if (cb && ct) {
    return { callbackUrl: decodeURIComponent(cb), token: ct };
  }
  return null;
}

/**
 * Execute a bot callback POST request.
 *
 * Pure function (no React deps) — testable without a DOM.
 *
 * @param action - The action to send
 * @param config - Callback URL and single-use token from `getCallbackConfig()`
 * @returns Toast payload to display
 */
export async function executeCallback(
  action: CallbackAction,
  config: CallbackConfig,
): Promise<ToastPayload> {
  const successMsg = action === CallbackAction.Approve
    ? "Plan approved! The bot will proceed to implementation."
    : "Feedback sent! The bot will re-plan with your annotations.";
  try {
    const res = await fetch(config.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: config.token, annotated_url: globalThis.location?.href ?? "" }),
    });
    if (!res.ok) {
      return {
        type: "error",
        message: res.status === 401
          ? "Plan link expired — request a new one from the bot."
          : "Callback failed.",
      };
    }
    return { type: "success", message: successMsg };
  } catch {
    return { type: "error", message: "Callback failed." };
  }
}
