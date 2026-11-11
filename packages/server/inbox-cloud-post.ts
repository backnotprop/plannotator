/**
 * One webhook POST to a cloud agent (inbox-cloud-wake.ts, inbox-cloud-agents.ts).
 *
 * - The key goes only in the `Authorization` header of this request; a redirect is never followed (it would carry it
 *   elsewhere) and reads as an answer.
 * - `timeout`: no answer in time, or the connection broke after the request may have gone out. The caller never
 *   sends it again (a Claude routine has no idempotency key; a resend starts a second run).
 * - `unreachable`: the connection was never made (refused, no such host), so nothing reached the routine.
 * - Nothing here logs, and no error text (which can name the address) leaves this function.
 */

import { INBOX_CLOUD_WAKE_TIMEOUT_MS, inboxCloudWakeHeaders, type InboxCloudPreset } from "@plannotator/core/inbox-cloud";

export type CloudPostResult =
  | { kind: "answered"; status: number; retryAfter: string | null; body: unknown }
  | { kind: "timeout" }
  | { kind: "unreachable" };

/** Errors that mean no connection was made: nothing was sent. */
const NEVER_CONNECTED = /ConnectionRefused|ECONNREFUSED|FailedToOpenSocket|ENOTFOUND|EAI_AGAIN|DNS|getaddrinfo|Unable to connect|UnknownHost/i;

export async function postCloudWebhook(
  agent: { preset: InboxCloudPreset; url: string; key: string },
  body: Record<string, unknown>,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<CloudPostResult> {
  const send = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? INBOX_CLOUD_WAKE_TIMEOUT_MS);
  try {
    const response = await send(agent.url, {
      method: "POST",
      headers: inboxCloudWakeHeaders(agent.preset, agent.key),
      body: JSON.stringify(body),
      redirect: "manual",
      signal: controller.signal,
    });
    let parsed: unknown = null;
    try {
      const text = (await response.text()).slice(0, 64 * 1024);
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { kind: "answered", status: response.status, retryAfter: response.headers.get("retry-after"), body: parsed };
  } catch (error) {
    if (controller.signal.aborted) return { kind: "timeout" };
    const said = `${(error as { code?: unknown })?.code ?? ""} ${error instanceof Error ? error.message : String(error)}`;
    return NEVER_CONNECTED.test(said) ? { kind: "unreachable" } : { kind: "timeout" };
  } finally {
    clearTimeout(timer);
  }
}
