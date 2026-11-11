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

export interface ToastSuccess { readonly type: 'success'; readonly message: string }
export interface ToastError   { readonly type: 'error';   readonly message: string }
export type ToastPayload = ToastSuccess | ToastError | null;

/**
 * The decoded `cb` value must use http: or https: — other schemes (file://, javascript://, etc.)
 * are rejected to prevent protocol-based attacks.
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
    return { type: "success", message: successMsg };
  } catch {
    return { type: "error", message: "Callback failed." };
  }
}
