/**
 * Tag an agent on another linked computer (the owner, 2026-11-24: "I need to be able to tag you in another agent's
 * thread on another computer"). This file is the tagged agent's own computer (A): the wakes a linked machine (B, the
 * thread's own computer) hands it for one of A's sessions, kept until that session's connection takes them.
 *
 * B pushes a wake through its outbox to A's door (`POST far-wake`, a machine's token only; inbox-far-tags.ts sends
 * it), with the command B would hand that session if it polled there: the same `tagged`, `added`, `handoff` fields,
 * so the connection words it with the same lines a local tag gets. A keeps it here (`inbox/far-wakes.jsonl`, 0600, one
 * snapshot per line, the last per key wins) and hands it with the session's next poll, after its own replies. When the
 * connection says it took it (`delivered`), A marks it delivered and tells B (`POST far-delivered`, held in A's outbox
 * as its own write), so the line under the person's reply reads delivered on every computer.
 *
 * Nothing of B's thread is kept but the wake itself: the agent reads the thread with read_thread (the far read,
 * inbox-far-read.ts) and answers with send_message's `reply_to` (inbox-mcp-far-reply.ts).
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INBOX_SESSION_ID_PATTERN, isInboxId } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";

/** One wake a linked machine handed this Inbox for one of its sessions. */
export interface FarWake {
  v: 1;
  /** The thread's own machine (`ibx_…`). */
  machine: string;
  reply_id: string;
  thread_id: string;
  session: string;
  host: string | null;
  command: InboxReplyCommand;
  received_at: string;
  delivered_at: string | null;
}

/** The most a far wake's body may be: what an outbox entry holds (256 KB) bounds it there already. */
const FAR_WAKE_BODY_MAX = 240 * 1024;
/** How long a delivered wake is kept (so a retried push answers it, and never wakes the session twice). */
const DELIVERED_KEPT_MS = 7 * 24 * 60 * 60_000;
const MACHINE_ID = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;

const keyOf = (machine: string, reply: string, session: string) => `${machine} ${reply} ${session}`;
const shortLine = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value) ? value : null);
const flag = (value: unknown) => value === true;

/**
 * The command as this Inbox hands it on: only the fields a tag's, an Add's, a hand-off's or a plain reply's wake
 * reads, each checked, so a far machine's answer can never set a field this Inbox does not word (Send now, a Tidy,
 * a routine). Its link is this Inbox's own window's, which shows that machine's thread. Null when it does not read.
 */
export function farWakeCommand(raw: unknown, ids: { reply_id: string; thread_id: string }, threadUrl: string): InboxReplyCommand | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const c = raw as Record<string, unknown>;
  if (c.type !== "reply" && c.type !== "message") return null;
  const stop = `${ids.reply_id}-stop`;
  if (c.id !== ids.reply_id && c.id !== stop) return null;
  if (c.thread_id !== ids.thread_id) return null;
  if (typeof c.body !== "string" || c.body.length > FAR_WAKE_BODY_MAX) return null;
  const subject = c.subject === null || c.subject === undefined ? null : shortLine(c.subject, 500);
  if (subject === null && c.subject !== null && c.subject !== undefined) return null;
  const replyTo = c.reply_to === null || c.reply_to === undefined ? null : isInboxId("msg", c.reply_to) ? c.reply_to : undefined;
  if (replyTo === undefined) return null;
  const named = (value: unknown) => shortLine(value, 80);
  const out: InboxReplyCommand = { type: c.type, id: c.id, thread_id: ids.thread_id, reply_to: replyTo, subject, body: c.body, url: threadUrl };
  const tagged = c.tagged as { owner?: unknown } | undefined;
  if (tagged && named(tagged.owner)) out.tagged = { owner: named(tagged.owner)! };
  if (flag(c.added)) out.added = true;
  const handoff = c.handoff as { from?: unknown } | undefined;
  if (handoff && named(handoff.from)) out.handoff = { from: named(handoff.from)! };
  const away = c.handed_away as { to?: unknown } | undefined;
  if (away && named(away.to)) out.handed_away = { to: named(away.to)! };
  if (Array.isArray(c.also_tagged)) {
    const names = c.also_tagged.flatMap((n) => (named(n) ? [named(n)!] : [])).slice(0, 20);
    if (names.length > 0) out.also_tagged = names;
  }
  if (named(c.redirected_from)) out.redirected_from = named(c.redirected_from)!;
  if (flag(c.continues_thread)) out.continues_thread = true;
  if (flag(c.new_thread)) out.new_thread = true;
  return out;
}

export function createInboxFarWakes(options: { dataDir: string; now?: () => Date }) {
  const now = () => options.now?.() ?? new Date();
  const dir = join(options.dataDir, "inbox");
  const file = join(dir, "far-wakes.jsonl");
  const wakes = new Map<string, FarWake>();
  const listeners = new Set<(session: string) => void>();

  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const wake = JSON.parse(line) as FarWake;
        if (wake && wake.v === 1 && typeof wake.machine === "string" && typeof wake.reply_id === "string" && typeof wake.session === "string") wakes.set(keyOf(wake.machine, wake.reply_id, wake.session), wake);
      } catch {
        // A torn last line: skipped.
      }
    }
  } catch {
    // No file yet: nothing was ever handed.
  }
  const cutoff = now().getTime() - DELIVERED_KEPT_MS;
  for (const [key, wake] of wakes) if (wake.delivered_at && Date.parse(wake.delivered_at) < cutoff) wakes.delete(key);

  const save = (wake: FarWake) => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(file, `${JSON.stringify(wake)}\n`, { mode: 0o600 });
    wakes.set(keyOf(wake.machine, wake.reply_id, wake.session), wake);
  };

  /** `POST far-wake` from `machine` (its token said so): kept once per reply and session. */
  const receive = (machine: string, body: Record<string, unknown>, threadUrl: (threadId: string) => string): { kept: boolean } => {
    if (!MACHINE_ID.test(machine)) throw new InboxError("validation_error", "machine: an ibx_ id.");
    const { reply_id, thread_id, session, host } = body;
    if (!isInboxId("msg", reply_id) || !isInboxId("msg", thread_id)) throw new InboxError("validation_error", "reply_id and thread_id: message ids.", { field: "reply_id" });
    if (typeof session !== "string" || !INBOX_SESSION_ID_PATTERN.test(session)) throw new InboxError("validation_error", "session: a session id.", { field: "session" });
    if (host !== null && host !== undefined && (typeof host !== "string" || host.length > 64)) throw new InboxError("validation_error", "host: a string.", { field: "host" });
    const command = farWakeCommand(body.command, { reply_id, thread_id }, threadUrl(thread_id));
    if (!command) throw new InboxError("validation_error", "command: a reply's wake.", { field: "command" });
    const key = keyOf(machine, reply_id, session);
    if (wakes.has(key)) return { kept: false };
    save({ v: 1, machine, reply_id, thread_id, session, host: typeof host === "string" ? host : null, command, received_at: now().toISOString(), delivered_at: null });
    for (const listener of listeners) listener(session);
    return { kept: true };
  };

  /** What waits for `session`, oldest first. */
  const pendingFor = (session: string): FarWake[] =>
    [...wakes.values()].filter((w) => w.session === session && !w.delivered_at).sort((a, b) => a.received_at.localeCompare(b.received_at));

  /** The session took the wake `id` (a reply id, or its stop notice's): marked here; null when no far wake is that one. */
  const delivered = (session: string, id: string): FarWake | null => {
    const reply = id.endsWith("-stop") ? id.slice(0, -"-stop".length) : id;
    const wake = [...wakes.values()].find((w) => w.session === session && w.reply_id === reply);
    if (!wake) return null;
    if (wake.delivered_at) return wake;
    const done = { ...wake, delivered_at: now().toISOString() };
    save(done);
    return done;
  };

  /** The machine whose thread a message id this Inbox was handed belongs to (the reply's own, or its thread's). */
  const placeOf = (id: string): { machine: string; thread_id: string } | null => {
    for (const w of wakes.values()) if (w.reply_id === id || w.thread_id === id) return { machine: w.machine, thread_id: w.thread_id };
    return null;
  };

  /** Whether `session` was handed a wake from that machine's thread (it may answer there). */
  const wasHanded = (machine: string, threadId: string, session: string): boolean =>
    [...wakes.values()].some((w) => w.machine === machine && w.thread_id === threadId && w.session === session);

  return {
    receive,
    pendingFor,
    delivered,
    placeOf,
    wasHanded,
    /** Called with the session a new wake waits for (a held poll answers at once). */
    onWake: (listener: (session: string) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type InboxFarWakes = ReturnType<typeof createInboxFarWakes>;
