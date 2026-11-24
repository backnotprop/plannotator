import { inboxThreadNameKey } from "@plannotator/core/inbox-types";

/**
 * What makes an agent's send with a used idempotency_key the same call: its body, reply target, thread name (and a
 * reply's `thread` where it could name the thread), guide, superseded ids, done ids and live sites. Any other is
 * `idempotency_key_reused`. One comparison for a send here (store.ts `sendMessage`) and an answer sent to a thread on
 * another computer (packages/server/inbox-mcp-far-reply.ts).
 */
export interface InboxSendCall {
  body: string;
  reply_to: string | null;
  thread_name: string | null;
  /** A reply's `thread`; null where it names nothing. */
  reply_thread: string | null;
  /** The guide's input_sha256. */
  guide: string | null;
  supersedes: readonly string[];
  done: readonly string[];
  /** The live sites' ids. */
  live: readonly string[];
}

const ids = (list: readonly string[]) => [...new Set(list)].sort().join("\n");
const name = (value: string | null) => inboxThreadNameKey(value ?? "");

export function sameInboxSend(a: InboxSendCall, b: InboxSendCall): boolean {
  return (
    a.body === b.body &&
    a.reply_to === b.reply_to &&
    name(a.thread_name) === name(b.thread_name) &&
    name(a.reply_thread) === name(b.reply_thread) &&
    a.guide === b.guide &&
    ids(a.supersedes) === ids(b.supersedes) &&
    ids(a.done) === ids(b.done) &&
    ids(a.live) === ids(b.live)
  );
}
