import type { CallbackConfig } from '../hooks/useSharing';

export type ToastPayload = { type: 'success' | 'error'; message: string } | null;

/**
 * Execute a bot callback POST request.
 *
 * Pure function (no React deps) so it can be unit-tested without a DOM.
 * App.tsx wraps this in a useCallback to wire up toast state.
 */
export async function executeCallback(
  action: "approve" | "feedback",
  config: CallbackConfig,
): Promise<ToastPayload> {
  const successMsg = action === "approve"
    ? "Plan approved! The bot will proceed to implementation."
    : "Feedback sent! The bot will re-plan with your annotations.";
  try {
    const res = await fetch(config.callbackUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, token: config.token, annotated_url: globalThis.location?.href ?? "" }),
    });
    if (!res.ok) {
      const msg = res.status === 401
        ? "Plan link expired — request a new one from the bot."
        : "Callback failed.";
      return { type: "error", message: msg };
    }
    return { type: "success", message: successMsg };
  } catch {
    return { type: "error", message: "Callback failed." };
  }
}
