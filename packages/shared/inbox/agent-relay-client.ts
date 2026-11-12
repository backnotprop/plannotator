import { randomBytes } from "node:crypto";
import { decryptWithKey, deriveRelayKeys, deriveRelaySignalToken, encryptWithKey } from "@plannotator/core/crypto";
import type { InboxAgentPairing, InboxAgentPairingRelay } from "./agent-pairing";

export const INBOX_AGENT_READ_WAIT_MS = 15_000;
export const INBOX_AGENT_WRITE_WAIT_MS = 30_000;
const POLL_MS = 300;
const REQUEST_MS = 10_000;

export const INBOX_AGENT_WRITE_ACTIONS: readonly string[] = ["send_message", "resolve_message"];

export type InboxAgentRelayOutcome =
  | { kind: "answer"; status: number; body: string }
  | { kind: "queued"; reason: "offline" | "slow" }
  | { kind: "refused"; code: string; message: string };

export interface InboxAgentRelayOptions {
  readWaitMs?: number;
  writeWaitMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
}

interface HeldItem {
  n: number;
  ciphertext: string;
}

export async function inboxAgentSignalUrl(pairing: InboxAgentPairing & { relay: InboxAgentPairingRelay }): Promise<string> {
  const token = await deriveRelaySignalToken(pairing.secret, pairing.device_id);
  return `${pairing.relay.url}/v1/mailboxes/${pairing.relay.mailbox_id}/signals/${token}`;
}

const removed = (): InboxAgentRelayOutcome => ({
  kind: "refused",
  code: "pairing_removed",
  message: "This cloud agent was removed from the person's Inbox, or paired again since this pairing string was made. Nothing was sent. Ask the person for a new pairing string.",
});

const asleep = (): InboxAgentRelayOutcome => ({
  kind: "refused",
  code: "computer_asleep",
  message: "Your computer is asleep or offline; nothing was sent. Try again later.",
});

export async function callInboxThroughRelay(
  pairing: InboxAgentPairing & { relay: InboxAgentPairingRelay },
  tool: string,
  args: Record<string, unknown>,
  options: InboxAgentRelayOptions = {},
): Promise<InboxAgentRelayOutcome> {
  const http = options.fetch ?? fetch;
  const keys = await deriveRelayKeys(pairing.secret, pairing.device_id);
  const base = `${pairing.relay.url}/v1/mailboxes/${pairing.relay.mailbox_id}/devices/${pairing.device_id}`;
  const write = INBOX_AGENT_WRITE_ACTIONS.includes(tool);
  const unreachable = (error: unknown): InboxAgentRelayOutcome => ({
    kind: "refused",
    code: "relay_unreachable",
    message: `Could not reach the Inbox's relay at ${pairing.relay.url} (${error instanceof Error ? error.message : String(error)}). Nothing was sent. Check that this machine may reach that address; on a Claude Code routine, add its host under the environment's allowed domains.`,
  });
  const relay = (method: string, path: string, body?: unknown) =>
    http(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${keys.relaySecret}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_MS),
    });
  const held = async (): Promise<{ items: HeldItem[]; online: boolean } | InboxAgentRelayOutcome> => {
    const answer = await relay("GET", "/items?after=0");
    if (answer.status === 401 || answer.status === 404) return removed();
    if (!answer.ok) return { kind: "refused", code: "relay_error", message: `The Inbox's relay answered ${answer.status}. Nothing was sent. Try again later.` };
    const read = (await answer.json()) as { items?: HeldItem[]; inbox_online?: boolean };
    return { items: Array.isArray(read.items) ? read.items : [], online: read.inbox_online === true };
  };

  let first: Awaited<ReturnType<typeof held>>;
  try {
    first = await held();
  } catch (error) {
    return unreachable(error);
  }
  if ("kind" in first) return first;
  if (!first.online && !write) return asleep();

  const id = `cmd_${randomBytes(16).toString("base64url")}`;
  const ciphertext = await encryptWithKey(JSON.stringify({ v: 1, type: "agent_call", id, tool, arguments: args }), keys.upKey);
  let posted: Response;
  try {
    posted = await relay("POST", "/commands", { id, ciphertext });
  } catch (error) {
    return unreachable(error);
  }
  if (posted.status === 401 || posted.status === 404) return removed();
  if (posted.status === 429) return { kind: "refused", code: "too_many_waiting", message: "Too many of your calls are already waiting for the person's computer. Nothing was sent. Try again once it is back." };
  if (posted.status === 413) return { kind: "refused", code: "command_too_large", message: "This call is too large to carry through the relay. Send smaller attachments." };
  if (!posted.ok) return { kind: "refused", code: "relay_error", message: `The Inbox's relay answered ${posted.status}. Nothing was sent. Try again later.` };
  const queued = (await posted.json().catch(() => ({}))) as { inbox_online?: boolean };
  if (queued.inbox_online !== true) return write ? { kind: "queued", reason: "offline" } : asleep();

  const deadline = Date.now() + (write ? (options.writeWaitMs ?? INBOX_AGENT_WRITE_WAIT_MS) : (options.readWaitMs ?? INBOX_AGENT_READ_WAIT_MS));
  for (;;) {
    let now: Awaited<ReturnType<typeof held>>;
    try {
      now = await held();
    } catch {
      now = { items: [], online: true };
    }
    if ("kind" in now) return now;
    for (const item of now.items) {
      let result: { type?: string; id?: string; status?: number; body_b64?: string } | null = null;
      try {
        result = JSON.parse(await decryptWithKey(item.ciphertext, keys.key));
      } catch {
        result = null;
      }
      if (result?.type !== "result" || result.id !== id || typeof result.status !== "number") continue;
      await relay("POST", "/ack", { item: item.n }).catch(() => null);
      return { kind: "answer", status: result.status, body: Buffer.from(result.body_b64 ?? "", "base64").toString("utf8") };
    }
    if (Date.now() > deadline) return write ? { kind: "queued", reason: "slow" } : { kind: "refused", code: "no_answer", message: "Your computer did not answer in time. Try again in a minute." };
    await new Promise((done) => setTimeout(done, options.pollMs ?? POLL_MS));
  }
}
