import { randomBytes } from "node:crypto";
import { decryptWithKey, deriveRelayKeys, deriveRelaySignalToken, encryptWithKey } from "@plannotator/core/crypto";
import type { InboxAgentPairing, InboxAgentPairingRelay } from "./agent-pairing";

export const INBOX_AGENT_READ_WAIT_MS = 15_000;
export const INBOX_AGENT_WRITE_WAIT_MS = 30_000;
const POLL_MS = 300;
const REQUEST_MS = 10_000;
const BYTES_PER_EXTRA_SECOND = 256 * 1024;
/**
 * A result held at the relay that is older than this (by the clock of the computer that answered, which it seals in
 * as `now`) is one no call waits for any more: a call waits at most INBOX_AGENT_WRITE_WAIT_MS, so anything past ten
 * minutes was left by a call that was killed or gave up (or a write applied after its call stopped waiting). The next
 * call acks it, so leftovers never pile up at the relay and slow or break every later call. Ten minutes leaves room
 * for a clock between the two machines that is a few minutes off.
 */
export const INBOX_AGENT_STALE_RESULT_MS = 10 * 60_000;

export const INBOX_AGENT_WRITE_ACTIONS: readonly string[] = ["send_message", "resolve_message", "snooze_thread", "thread_pulls", "submit_guide", "card", "steps", "routine", "route"];

/** The `routine` ops that only read; every other op (create, update, on, off, run, delete, or one the Inbox refuses) writes. */
const ROUTINE_READ_OPS: readonly unknown[] = ["list", "get"];

/** A field the call sets: anything but absent or an empty list (a malformed value is the Inbox's to refuse, so it counts). */
const listed = (value: unknown): boolean => value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0);

/**
 * Whether a call changes something, by what it does rather than its tool's name: a write waits at the relay while the
 * person's computer sleeps (applied once when it is back), a read answers at once that it is asleep. `card` with op
 * list, `routine` with op list or get, and `thread_pulls` with nothing to add or remove only read, so their result
 * reaches the agent. A write that is not answered in time is said to be queued, never to be sent again: a routine run
 * or create classed as a read would be applied late and doubled by the agent's retry.
 */
export function isInboxAgentWrite(tool: string, args: Record<string, unknown>): boolean {
  if (!INBOX_AGENT_WRITE_ACTIONS.includes(tool)) return false;
  if (tool === "card") return args.op !== "list";
  if (tool === "routine") return !ROUTINE_READ_OPS.includes(args.op);
  // A command's window route (inbox-agent-routes.ts): a GET reads, a POST changes something.
  if (tool === "route") return args.method !== "GET";
  if (tool === "thread_pulls") return listed(args.add) || listed(args.remove);
  return true;
}

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
  const write = isInboxAgentWrite(tool, args);
  const unreachable = (error: unknown): InboxAgentRelayOutcome => ({
    kind: "refused",
    code: "relay_unreachable",
    message: `Could not reach the Inbox's relay at ${pairing.relay.url} (${error instanceof Error ? error.message : String(error)}). Nothing was sent. Check that this machine may reach that address; on a Claude Code routine, add its host under the environment's allowed domains.`,
  });
  const relay = (method: string, path: string, body?: unknown) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return http(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${keys.relaySecret}`, ...(text === undefined ? {} : { "Content-Type": "application/json" }) },
      body: text,
      signal: AbortSignal.timeout(REQUEST_MS + Math.ceil((text?.length ?? 0) / BYTES_PER_EXTRA_SECOND) * 1000),
    });
  };
  // The highest item number already read: each poll after the first asks only for items after it, so a result left at
  // the relay by an earlier call is downloaded once per call, not on every poll.
  let seen = 0;
  const held = async (): Promise<{ items: HeldItem[]; online: boolean } | InboxAgentRelayOutcome> => {
    const answer = await relay("GET", `/items?after=${seen}`);
    if (answer.status === 401 || answer.status === 404) return removed();
    if (!answer.ok) return { kind: "refused", code: "relay_error", message: `The Inbox's relay answered ${answer.status}. Nothing was sent. Try again later.` };
    const read = (await answer.json()) as { items?: HeldItem[]; inbox_online?: boolean };
    const items = Array.isArray(read.items) ? read.items : [];
    for (const item of items) if (Number.isSafeInteger(item.n) && item.n > seen) seen = item.n;
    return { items, online: read.inbox_online === true };
  };
  type Opened = { type?: string; id?: string; status?: number; body_b64?: string; now?: string } | null;
  const open = async (item: HeldItem): Promise<Opened> => {
    try {
      return JSON.parse(await decryptWithKey(item.ciphertext, keys.key)) as Opened;
    } catch {
      return null;
    }
  };
  /** Acks each result no call waits for any more (INBOX_AGENT_STALE_RESULT_MS), one by one: a newer one may be another call's, still waited for. */
  const clearStale = async (items: HeldItem[]) => {
    const now = Date.now();
    for (const item of items) {
      const result = await open(item);
      const at = result?.type === "result" && typeof result.now === "string" ? Date.parse(result.now) : NaN;
      if (Number.isFinite(at) && now - at > INBOX_AGENT_STALE_RESULT_MS) await relay("POST", "/ack", { item: item.n }).catch(() => null);
    }
  };

  let first: Awaited<ReturnType<typeof held>>;
  try {
    first = await held();
  } catch (error) {
    return unreachable(error);
  }
  if ("kind" in first) return first;
  await clearStale(first.items);
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
      const result = await open(item);
      if (result?.type !== "result" || result.id !== id || typeof result.status !== "number") continue;
      await relay("POST", "/ack", { item: item.n }).catch(() => null);
      return { kind: "answer", status: result.status, body: Buffer.from(result.body_b64 ?? "", "base64").toString("utf8") };
    }
    if (Date.now() > deadline) return write ? { kind: "queued", reason: "slow" } : { kind: "refused", code: "no_answer", message: "Your computer did not answer in time. Try again in a minute." };
    await new Promise((done) => setTimeout(done, options.pollMs ?? POLL_MS));
  }
}
