/**
 * Tag an agent on another linked computer (the owner, 2026-11-24: "I need to be able to tag you in another agent's
 * thread on another computer"; and "Whatever I can do on one computer, I should be able to do across computers").
 * This file is the thread's own computer (B). The tagged agent's computer (A) keeps its wakes (inbox-far-wakes.ts)
 * and sends its agent's answer (inbox-mcp-far-reply.ts).
 *
 * - The `@` list (`threads/:id/taggable`): this Inbox's own sessions, then each linked computer's (mark
 *   `tag-across`), read through that computer's door (`GET taggable-agents`, a machine's token only) and kept in
 *   memory, so an asleep computer's agents stay offered and their wake waits for it. Each far row names its computer
 *   (`machine`, `machine_name`). A computer that is older (no mark) is never asked, and its agents are not offered.
 * - The tag: the reply route's tag with `machine` is resolved against that list (`targets`) and stored as a local
 *   one is, with `machine` (Ask, Add and Hand off unchanged).
 * - The wake: once a person's reply here is for a far session (a tag, a hand-off, a reply to its message), it is sent
 *   to that session's computer (`POST far-wake`) through the outbox, as this Inbox's own held write, with the command
 *   this Inbox would hand that session if it polled here. Asleep: it waits there, and goes when the computer is back.
 * - Its answer: `POST agent-reply` from a computer writes as one of that computer's sessions only: one this thread
 *   names on that computer (`InboxStore.farSessions`). `POST far-delivered` records that session's delivery.
 */

import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { INBOX_SESSION_ID_PATTERN, isInboxId, type InboxTag } from "@plannotator/core/inbox-types";
import type { OutboxEntry } from "./inbox-outbox";
import type { PeerLink } from "./inbox-peer-link";
import type { InboxTaggableSession } from "./inbox-tags";

/** The mark a computer's list carries when its door answers the routes below. */
export const TAG_ACROSS_MARK = "tag-across";
/** The door routes (inbox-devices.ts `DOOR_OWN_ROUTES`). */
export const FAR_TAGGABLE_ROUTE = "taggable-agents";
export const FAR_WAKE_ROUTE = "far-wake";
export const FAR_AGENT_REPLY_ROUTE = "agent-reply";
export const FAR_DELIVERED_ROUTE = "far-delivered";

/** A computer's agents read within this long are not read again for the `@` list. */
const FAR_AGENTS_FRESH_MS = 5_000;
/** How long the `@` list waits for a computer's agents before it answers with what it has. */
const FAR_AGENTS_WAIT_MS = 1_500;
const FAR_AGENTS_MAX = 60;
const FAR_REPLY_BODY_MAX = 200_000;

export interface FarTagsDeps {
  store: InboxStore;
  selfId: () => string | null;
  selfName: () => string;
  peers: () => readonly PeerLink[];
  nameOf: (machine: string) => string | null;
  holdWrite: (machine: string, route: string, body: Record<string, unknown>, thread: string | null, waitMs: number) => Promise<OutboxEntry | null> | null;
  heldWrite: (key: string) => OutboxEntry | null;
  /** The wake this Inbox would hand `session` for `reply` if it polled here (inbox.ts `replyCommand`); `now`: its Send now. */
  commandFor: (reply: InboxMessage, session: string, now: boolean) => InboxReplyCommand;
  /** An agent's send_message run here as a far session, the tool's own answer (inbox-far-send.ts). */
  sendAs: (input: FarReplyInput) => Promise<{ text: string; structured: Record<string, unknown> }>;
  /** Whether `session` is one of this computer's own (live here, or it wrote here with no other computer). */
  ownSession: (session: string) => boolean;
  /** Whether a tag naming no computer is for `session` here: live here, or an agent of this computer's that reads the Inbox. Absent: `ownSession`. */
  knownHere?: (session: string) => boolean;
  now?: () => number;
}

export interface FarReplyInput {
  machine: string;
  machine_name: string | null;
  session: string;
  host: string | null;
  name: string | null;
  /** send_message's own arguments, as the agent gave them there (its files as upload ids here). */
  args: Record<string, unknown>;
}

/** The send_message fields a far answer carries (its paths are the other computer's: `project_path` stays there). */
const FAR_SEND_FIELDS = ["body", "subject", "thread", "reply_to", "idempotency_key", "attachments", "supersedes", "done", "priority", "pulls", "steps", "branch"] as const;

const isMachineId = (value: unknown): value is string => typeof value === "string" && /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
const shortText = (value: unknown, max: number): string | null => (typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null);

/** One computer's agents as its door sent them, each row checked. */
export function farAgentRows(raw: unknown): InboxTaggableSession[] {
  const list = raw && typeof raw === "object" && Array.isArray((raw as { sessions?: unknown }).sessions) ? (raw as { sessions: unknown[] }).sessions : [];
  const out: InboxTaggableSession[] = [];
  for (const item of list.slice(0, FAR_AGENTS_MAX)) {
    if (!item || typeof item !== "object") continue;
    const s = item as Record<string, unknown>;
    if (typeof s.session !== "string" || !INBOX_SESSION_ID_PATTERN.test(s.session)) continue;
    const host = shortText(s.host, 64);
    const project = s.project && typeof s.project === "object" ? shortText((s.project as { name?: unknown }).name, 200) : null;
    const label = shortText(s.label, 120);
    const time = (value: unknown) => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null);
    out.push({
      session: s.session,
      host,
      kind: "live",
      name: null,
      ...(label ? { label } : {}),
      project: project ? { id: null, name: project, root: null } : null,
      started_at: time(s.started_at),
      last_at: time(s.last_at) ?? new Date(0).toISOString(),
      busy: typeof s.busy === "boolean" ? s.busy : null,
      idle_since: time(s.idle_since),
      taggable: s.taggable === true,
      ...(s.send_now === true ? { send_now: true } : {}),
      owner: false,
      wrote_thread: false,
    });
  }
  return out;
}

export function createInboxFarTags(deps: FarTagsDeps) {
  const { store } = deps;
  const now = () => deps.now?.() ?? Date.now();
  /** Each computer's agents as last read (in memory: an asleep computer's stay offered until this Inbox restarts). */
  const agents = new Map<string, { at: number; rows: InboxTaggableSession[] }>();
  const reading = new Map<string, Promise<void>>();

  const takes = (peer: PeerLink) => peer.state !== "revoked" && peer.state !== "needs_update" && !!peer.list?.marks.includes(TAG_ACROSS_MARK);

  const readAgents = (peer: PeerLink): Promise<void> => {
    const running = reading.get(peer.id);
    if (running) return running;
    const run = (async () => {
      try {
        const response = await peer.request(FAR_TAGGABLE_ROUTE, "", { method: "GET", headers: {}, timeoutMs: 4_000 });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          // An older door: nobody of that computer is offered.
          if (response.status === 404) agents.delete(peer.id);
          return;
        }
        agents.set(peer.id, { at: now(), rows: farAgentRows(await response.json()) });
      } catch {
        // Away: what was read before stays.
      } finally {
        reading.delete(peer.id);
      }
    })();
    reading.set(peer.id, run);
    return run;
  };

  /** Every linked computer's agents for the `@` list of `threadId` here. */
  const rows = async (threadId: string, owner: string | null, writers: ReadonlySet<string>): Promise<InboxTaggableSession[]> => {
    const peers = deps.peers().filter(takes);
    const stale = peers.filter((peer) => peer.state === "online" && now() - (agents.get(peer.id)?.at ?? 0) > FAR_AGENTS_FRESH_MS);
    if (stale.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([Promise.all(stale.map(readAgents)), new Promise((resolve) => (timer = setTimeout(resolve, FAR_AGENTS_WAIT_MS)))]);
      clearTimeout(timer);
    }
    const members = store.farSessions(threadId);
    return peers.flatMap((peer) =>
      (agents.get(peer.id)?.rows ?? []).map((row) => ({
        ...row,
        owner: row.session === owner,
        wrote_thread: writers.has(row.session) && members.get(row.session)?.machine === peer.id,
        machine: peer.id,
        machine_name: deps.nameOf(peer.id) ?? "A linked computer",
      })),
    );
  };

  const here = (session: string) => (deps.knownHere ?? deps.ownSession)(session);

  /** The linked computers whose agents, as last read, list `session`. */
  const listedBy = (session: unknown): string[] => deps.peers().filter((peer) => takes(peer) && !!agents.get(peer.id)?.rows.some((row) => row.session === session)).map((peer) => peer.id);

  /**
   * The computer a tag is for, when it is another one: the one it names (`machine`), or, for a tag that names none
   * (the phone's), the one linked computer whose agents list that session, when it is not one of this computer's own.
   */
  const farMachineOf = (item: unknown): string | null => {
    if (!item || typeof item !== "object") return null;
    const { machine, session } = item as { machine?: unknown; session?: unknown };
    if (isMachineId(machine)) return machine !== deps.selfId() ? machine : null;
    if (machine !== undefined && machine !== null) return null;
    if (typeof session !== "string" || here(session)) return null;
    const by = listedBy(session);
    return by.length === 1 ? by[0]! : null;
  };

  /**
   * Before the reply route resolves its tags: a far session its computer's agents (as last read) do not list is read
   * there once more, so a computer that restarted since the `@` list opened is not refused as "not live".
   */
  const prepare = async (value: unknown): Promise<void> => {
    if (!Array.isArray(value)) return;
    const self = deps.selfId();
    const peers = deps.peers().filter((peer) => takes(peer) && peer.state === "online");
    const again = new Set<PeerLink>();
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const { machine, session } = item as { machine?: unknown; session?: unknown };
      if (isMachineId(machine)) {
        const peer = machine !== self ? peers.find((p) => p.id === machine) : undefined;
        if (peer && !agents.get(peer.id)?.rows.some((row) => row.session === session)) again.add(peer);
      } else if ((machine === undefined || machine === null) && typeof session === "string" && !here(session) && listedBy(session).length === 0) {
        for (const peer of peers) again.add(peer);
      }
    }
    if (again.size > 0) await Promise.all([...again].map(readAgents));
  };

  /**
   * The reply route's tags: the ones for another computer (`farMachineOf`) resolved here against that computer's
   * agents, the rest by `local` (inbox-sessions.ts `tagTargets`, its refusals unchanged), in the order typed.
   */
  const targets = (value: unknown, local: (value: unknown) => InboxTag[]): InboxTag[] => {
    if (!Array.isArray(value)) return local(value);
    const placed = value.map((item) => ({ item, machine: farMachineOf(item) }));
    const near = local(placed.filter((p) => !p.machine).map((p) => p.item));
    const missing: string[] = [];
    const old: string[] = [];
    const far: InboxTag[] = [];
    for (const { item: raw, machine } of placed) {
      if (!machine) continue;
      const item = raw as Record<string, unknown>;
      const session = item.session;
      const peer = deps.peers().find((p) => p.id === machine);
      const row = peer && takes(peer) ? agents.get(machine)?.rows.find((r) => r.session === session && (item.host === undefined || item.host === null || item.host === r.host)) : undefined;
      if (!row) {
        missing.push(String(session));
        continue;
      }
      if (!row.taggable) {
        old.push(row.session);
        continue;
      }
      const label = typeof item.label === "string" ? { label: item.label } : {};
      far.push({ host: row.host, session: row.session, ...label, wakes: true, machine });
    }
    if (old.length > 0) {
      throw new InboxError("tag_needs_update", "A session you tagged runs an older Plannotator that can't be tagged: nothing was sent. Update Plannotator where it runs, or remove the tag.", { sessions: old });
    }
    if (missing.length > 0) {
      throw new InboxError("session_not_live", "A session you tagged is not live any more: nothing was sent. Remove the tag, or tag another session.", { sessions: missing });
    }
    const order = value.map((item) => (item && typeof item === "object" ? (item as { session?: unknown }).session : null));
    return [...near, ...far].sort((a, b) => order.indexOf(a.session) - order.indexOf(b.session));
  };

  const farWakeKey = (reply: string, session: string) => `far-wake:${reply}:${session}`;

  /** A person's message was written here: every far session of its thread that it (or anything still owed) is for is sent its wake. */
  const onPersonMessage = (record: InboxMessage) => {
    // An agent's words in a ghost thread go to its far members as a person's do (Swarm, store.ts `isGhostSay`).
    if (record.author.kind !== "person" && !store.isGhostSay(record)) return;
    const members = store.farSessions(record.thread_id);
    for (const [session, member] of members) {
      // This reply's own change after its wake went: taken back (not handed there), or Send now (into the running turn).
      const first = deps.heldWrite(farWakeKey(record.id, session));
      if (first && store.isFor(record, session)) {
        const tag = store.isOwner(record, session) ? null : (record.tags?.find((t) => t.session === session) ?? null);
        const nowAt = tag ? tag.deliver_now_at : record.deliver_now_at;
        const change = record.taken_back_at ? "taken" : nowAt ? `now:${nowAt}` : null;
        const key = change ? `${farWakeKey(record.id, session)}:${change}` : null;
        if (key && !deps.heldWrite(key)) {
          try {
            const body = record.taken_back_at ? { withdrawn: true } : { replaces: true, command: deps.commandFor(record, session, true) };
            void deps.holdWrite(member.machine, FAR_WAKE_ROUTE, { idempotency_key: key, reply_id: record.id, thread_id: record.thread_id, session, host: member.host, ...body }, record.thread_id, 0);
          } catch {
            // The computer was unlinked: nothing waits there for it.
          }
        }
      }
      let owed: InboxMessage[];
      try {
        owed = store.pendingReplies(session, { tags: true });
      } catch {
        continue;
      }
      for (const reply of owed) {
        const key = farWakeKey(reply.id, session);
        if (deps.heldWrite(key)) continue;
        try {
          const command = deps.commandFor(reply, session, false);
          void deps.holdWrite(member.machine, FAR_WAKE_ROUTE, { idempotency_key: key, reply_id: reply.id, thread_id: reply.thread_id, session, host: member.host, command }, reply.thread_id, 0);
        } catch {
          // Too big to hold, or the computer was unlinked: the wake waits for the next message here.
        }
      }
    }
  };

  /**
   * Whether `machine`'s token may write as `session` in the thread of `message`: any session of that computer may, as
   * any agent here may write in a thread it can read. Refused only when the session is not that computer's: one of
   * this computer's own, or one this Inbox knows on another computer.
   */
  const asSession = (machine: string, message: InboxMessage, session: unknown): { host: string | null } => {
    if (typeof session !== "string" || !INBOX_SESSION_ID_PATTERN.test(session)) throw new InboxError("validation_error", "session: a session id.", { field: "session" });
    const member = store.farSessions(message.thread_id).get(session);
    const elsewhere = store.sessionMachine(session);
    if (deps.ownSession(session) || (member && member.machine !== machine) || (elsewhere !== null && elsewhere !== machine)) {
      throw new InboxError("not_your_session", "That session is not one of your computer's: nothing was written.");
    }
    return { host: member?.host ?? null };
  };

  const messageOf = (id: unknown, field: string): InboxMessage => {
    if (!isInboxId("msg", id)) throw new InboxError("validation_error", `${field}: a message id.`, { field });
    const message = store.message(id);
    if (!message) throw new InboxError("message_not_found", `No message ${id}.`);
    return message;
  };

  /** `POST agent-reply` from `machine`: its session's send_message into a thread here, run here as that session. */
  const agentReply = async (machine: string, body: Record<string, unknown>) => {
    const raw = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? (body.args as Record<string, unknown>) : null;
    if (!raw) throw new InboxError("validation_error", "args: send_message's arguments.", { field: "args" });
    // A thread id, a message id or a stop notice's id, as reply_to takes them here.
    const replyTo = typeof raw.reply_to === "string" ? raw.reply_to.trim().replace(/-stop$/, "") : null;
    const { host } = asSession(machine, messageOf(replyTo, "reply_to"), body.session);
    if (typeof raw.body !== "string" || raw.body.length > FAR_REPLY_BODY_MAX) throw new InboxError("validation_error", "body: the message's words.", { field: "body" });
    if (!shortText(raw.idempotency_key, 200)) throw new InboxError("validation_error", "idempotency_key: required.", { field: "idempotency_key" });
    const args = Object.fromEntries(FAR_SEND_FIELDS.flatMap((field) => (raw[field] === undefined ? [] : [[field, raw[field]]])));
    return deps.sendAs({ machine, machine_name: deps.nameOf(machine), session: body.session as string, host: shortText(body.host, 64) ?? host, name: shortText(body.name, 80), args });
  };

  /** `POST far-delivered` from `machine`: its session took the wake of `reply_id`. */
  const delivered = (machine: string, body: Record<string, unknown>) => {
    const message = messageOf(body.reply_id, "reply_id");
    const { host } = asSession(machine, message, body.session);
    // A hand-off's notice to the former owner is delivered by its own id (`<reply>-stop`).
    const id = body.id === `${message.id}-stop` ? body.id : message.id;
    const reply = store.recordDelivery(id, { host: host ?? "agent", session: body.session as string });
    return { ok: true, delivered: true, reply_id: reply.id };
  };

  /** This computer for the `@` list's answer, only while a linked computer takes tags from here. */
  const self = () => {
    const id = deps.selfId();
    return id && deps.peers().some(takes) ? { id, name: deps.selfName() } : null;
  };

  /** Whether a linked computer's agents, as last read, list `session` (it is live there). */
  const lists = (session: string): boolean => [...agents.values()].some((entry) => entry.rows.some((row) => row.session === session));

  /** A far session's connection as its computer last said (busy, and whether it takes Send now), for Send now here. */
  const connectionOf = (session: string): { busy: boolean | null; send_now: boolean } | null => {
    for (const entry of agents.values()) {
      const row = entry.rows.find((r) => r.session === session);
      if (row) return { busy: row.busy, send_now: row.send_now === true };
    }
    return null;
  };

  /**
   * The linked computers' agents as last read, as a window shows them (who is live there and whether each works: a
   * swarm member's state, inbox-swarm-context.ts): it moves only when one of those does, so the delivery watch in
   * inbox.ts tells the windows, which then read their swarm's thread again.
   */
  const liveSignature = (): string =>
    [...agents.entries()]
      .map(([machine, entry]) => `${machine}:${entry.rows.map((row) => `${row.session}=${row.busy}`).sort().join(",")}`)
      .sort()
      .join(";");

  return { rows, prepare, targets, onPersonMessage, agentReply, delivered, self, lists, connectionOf, liveSignature };
}

export type InboxFarTags = ReturnType<typeof createInboxFarTags>;
