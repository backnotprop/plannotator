/**
 * Plannotator Inbox: New message (PLAN step 8; owner Q4, "just another button
 * next to reply", built as a try).
 *
 * The live sessions: every agent connection long-polls the bridge for its
 * session (packages/server/inbox.ts, `bridgePoll`), and a poll says where the
 * session works (`project_path`), when it started and whether a turn runs; a
 * `state` event says when that changes. A session is live while it polled
 * within `INBOX_SESSION_LIVE_MS`, or holds a poll open now. Kept in memory
 * only: after an Inbox restart a session is live again at its next poll.
 *
 * A session is in a thread's project when its `project_path` resolves to the
 * project's root (the resolution send_message uses: realpath, then the
 * repository, a linked worktree counting as its main repository), or, for
 * a connection that does not say where it works, when it wrote in that
 * project.
 *
 * The window's two routes (same origin and the page's serverSession, as every
 * window route):
 *   GET  /api/inbox/threads/:id/sessions  the project's live sessions, the
 *        thread's own writers first;
 *   POST /api/inbox/threads/:id/message   `{ session, body, idempotency_key }`:
 *        the person's message, addressed to that session while it is live
 *        (409 `session_not_live` otherwise, nothing written). Its connection
 *        is handed it on its next poll and delivers it like a reply.
 *
 * Replying when the asking session has ended (design record "replying when
 * the asking agent's session has ended", not in this repo): the sessions
 * route also answers whether the session that asked (`?asker=<session>`) is
 * still there (`asker: { session, live }`), with a grace of
 * `INBOX_ASKER_GRACE_MS` so a short gap, or an Inbox that just started and
 * has not heard from its sessions yet, never reads as ended. The reply route
 * (packages/server/inbox.ts) takes `to: { host, session }` and checks it with
 * `replyTarget`, as New message does.
 */

import { homedir } from "node:os";
import { basename } from "node:path";
import { INBOX_AUTO_SEND_AFTER_MS, type InboxHostSessions, type InboxMessage, type InboxOpenSession, type InboxProject, type InboxRestartAgents, type InboxSessionOutdated, type InboxTag, type InboxToolHostId } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { INBOX_ASK_POLL_FIELD, INBOX_AUTO_RELOAD_POLL_FIELD, INBOX_CONTINUES_POLL_FIELD, INBOX_HELD_POLL_FIELD, INBOX_RELOAD_FIELD, INBOX_SEND_NOW_POLL_FIELD, INBOX_SESSION_LABEL_INPUT_MAX, INBOX_SESSION_LIVE_MS, INBOX_TAGS_POLL_FIELD } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import { graphemesOf, inboxStoredAgentName } from "@plannotator/core/inbox-format";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import { createInboxContinuations, parseInboxContinues } from "./inbox-continuations";
import { inboxClaimAbandoned } from "./inbox-stuck-delivery";
import { parseEngine, parseLoadedPlugin, parseSessionFolder, runtimeOf, tagUpdateFix, type LoadedPlugin } from "./inbox-restart";

/** One live session as the window reads it. */
export interface InboxLiveSession {
  session: string;
  host: string;
  started_at: string;
  last_seen_at: string;
  /** A turn runs now; null when the connection does not say. */
  busy: boolean | null;
  /** Idle since then; null while busy or when the connection does not say. */
  idle_since: string | null;
  /** It wrote in this thread. */
  wrote_thread: boolean;
  /** Its connection can deliver into a running turn (Send now); false when it does not say. */
  send_now: boolean;
  /** The session's label (issue #2450), on the window's route for this computer's owner only; absent when it has none. */
  label?: string;
}

/** A session the Agents section may list (`agentSessions`): live, or ended and heard from today. Times in ms. */
export interface InboxAgentSession {
  session: string;
  host: string;
  /** The project root its `project_path` resolved to; null when it sent none. */
  root: string | null;
  startedAt: number;
  /** The last poll, state change or Inbox tool call. */
  lastSeen: number;
  live: boolean;
  /** A turn runs now (live only); null when the connection does not say, or it is not live. */
  busy: boolean | null;
  label: string | null;
}

/**
 * How the session a person's message goes to is connected now, for the
 * window's line under that message: present while the session's connection
 * polls (live, no grace). `busy` null when the connection does not say.
 */
export interface InboxRecipientConnection {
  busy: boolean | null;
  idle_since: string | null;
  /** Send now can be offered: the connection said it can deliver into a running turn. */
  send_now: boolean;
  /**
   * Claude Code refused the reply its connection tried to put in, and holds
   * this session's replies until the person types there (`held`; #2780): the
   * line says "Stopped: goes in when you type in that session" (approval
   * "inbox-stopped-reply"). Present only while true. Additive.
   */
  held?: true;
  /**
   * The session runs an older Plannotator plugin than a restart would load,
   * or one the installed plugin is itself behind (packages/server/inbox-restart.ts);
   * null when it is up to date or the Inbox cannot tell. Additive.
   */
  outdated: InboxSessionOutdated | null;
  /** Claude Code's own version as its poll reported it (`engine`); null when it does not say. Additive. */
  engine: string | null;
  /** The command that starts the same session again in its folder (`cd <folder> && claude --resume <id>`); null when unknown. Additive. */
  restart_command: string | null;
  /**
   * How long a reply waits on this busy session before it goes into the
   * running turn by itself, where `send_now` (`INBOX_AUTO_SEND_AFTER_MS`;
   * approval "inbox-busy-agent-reply"). Absent from an older Inbox, which
   * never does. Additive.
   */
  auto_send_after_ms: number;
  /**
   * Items that may not have reached this session (a Codex thread whose
   * `codex queue` call ran out of time): the line says they are saved for the
   * agent's next read, not queued. Absent when none. Additive.
   */
  uncertain?: string[];
  /**
   * The items waiting on this session, by id: since when it waits on the
   * busy session (`since`, the "Undelivered N min"), and since when it may go
   * in by itself (`auto_since`: the first time the session was seen busy with
   * Send now possible; null until then). Kept in memory: the session going
   * away or an Inbox restart starts the clock again. Additive.
   */
  waits: Record<string, { since: string; auto_since: string | null }>;
}

/** The server's clock for one item waiting on a busy session (ms). */
interface WaitClock {
  since: number;
  autoSince: number | null;
}

interface SeenSession {
  host: string;
  /** The project root its `project_path` resolved to; null when it sent none. */
  root: string | null;
  startedAt: number;
  /** The `started_at` its last poll said (when its wake started); absent when the poll said none. */
  wakeStartedAt?: number | null;
  lastSeen: number;
  /** Polls held open now. */
  holding: number;
  busy: boolean | null;
  idleSince: number | null;
  /** When its current turn started (busy went true); null while idle or unknown. A launched thread's "working · N min". */
  busySince?: number | null;
  /** How many polls it started (launch: a stopped or respawned session counts as live again only once it polls anew). */
  polls?: number;
  /** The last time it was seen idle (busy false); null when never. Decides whether an automatic mark went into a turn. */
  idleAt?: number | null;
  /**
   * When it last went idle (the `idleSince` of its latest idle spell), kept
   * through a later busy turn and after the session ends (Tidy's "Nothing to
   * change" must not flip back). Unlike `idleAt`, not refreshed by each poll.
   */
  lastIdleSince?: number | null;
  /** Its poll said it can deliver into a running turn (`send_now`). */
  sendNow: boolean;
  /** Its connection said Claude Code holds its replies until the person types there (`held`). Absent: no. */
  held?: boolean;
  /** Its poll said it understands a reply it was tagged in (`tags`): only then can it be tagged. */
  tags: boolean;
  /** The title its latest poll sent (`label`, cleaned). Display only: nothing routes on it, and no MCP call reaches it. */
  label?: string | null;
  /** Its poll said it can answer Ask AI live (`ask`). */
  ask?: boolean;
  /** The working folder its poll named (`project_path`), as sent; null when it sent none. */
  cwd: string | null;
  /**
   * Where the session started (`session_folder`, the Claude Code mod's
   * `$.session.root()` as it was at session start): the folder its
   * `claude --resume` runs in. Null when its connection sends none.
   */
  folder: string | null;
  /** What its poll said it loaded (`plugin`); null when it sent none (a connection older than the field). */
  plugin: LoadedPlugin | null;
  /** Claude Code's version (`engine`); null when it sent none. */
  engine: string | null;
  /**
   * A session the Inbox wakes itself, with no connection that polls (Codex:
   * `codex queue`; packages/server/inbox-codex-wake.ts): seen from its MCP
   * calls, live while it called within `INBOX_WAKE_ONLY_LIVE_MS` and its
   * thread is not known to have ended. Its id, for that check.
   */
  wakeOnly?: string;
}

/**
 * An agent that reads the Inbox through MCP only (approval "inbox-tag-agents",
 * Q2: any MCP agent may be tagged): it is never woken, and sees a tag the next
 * time it reads the thread or waits for a reply.
 */
export interface InboxMcpAgent {
  session: string;
  host: string | null;
  /** The name it gave itself, if any. */
  name: string | null;
  /** Where it last wrote, if it wrote. */
  project_id: string | null;
  /** When it last wrote or called an Inbox tool. */
  last_at: string;
}

/** How long an MCP agent stays on the tag list after it last wrote or called a tool. */
export const INBOX_MCP_AGENT_LISTED_MS = 14 * 24 * 60 * 60 * 1000;
/** The most MCP agents the tag list offers. */
export const INBOX_MCP_AGENTS_MAX = 30;

/**
 * How long the session that asked may go without a poll before the window
 * says it has ended: twice the live window, so a slept laptop or a slow poll
 * does not show the note for a moment.
 */
export const INBOX_ASKER_GRACE_MS = 60_000;

/**
 * How long after the Inbox starts a session it has not heard from counts as there: this Inbox knows nothing of the
 * sessions from before it, and a session that kept trying a stopped Inbox tries again only every 60 s
 * (`INBOX_RETRY_MS.max`), on a 1 s tick. Past that, so no list row says "Session ended" of a live session.
 */
export const INBOX_ASKER_RESTART_GRACE_MS = 90_000;

/**
 * How long a session handed an item to go into its running turn counts as there with no poll, on a connection from
 * before its tick stopped waiting on a steer (no `steer_polls`): it does not poll until the steer goes in, which a long
 * tool call can hold for minutes.
 */
export const INBOX_ASKER_STEER_GRACE_MS = 10 * 60_000;

/**
 * Whether the agent message a reply answers came from a session that has ended: one that can be known to (its
 * connection wakes it) and that the Inbox has not heard from, with the grace.
 */
export function replacesEndedAsker(asked: InboxMessage | null | undefined, live: { askerLive(session: string): boolean }): boolean {
  if (asked?.author.kind !== "agent" || asked.wakes !== true || !asked.author.session) return false;
  return !live.askerLive(asked.author.session);
}

/**
 * Whether a session is there, for moving a reply off it or taking its thread. A launched thread's own session reads by
 * its launch: one a reply starts again is there even when stopped, and one that is gone is not, however recent.
 */
export function thereInThread(
  live: { askerLive(session: string): boolean },
  launch: { resumes(threadId: string, session: string): boolean; gone(threadId: string, session: string): boolean } | undefined,
  threadId: string,
): { askerLive(session: string): boolean } {
  return {
    askerLive: (session) => {
      if (launch?.gone(threadId, session)) return false;
      return !!launch?.resumes(threadId, session) || live.askerLive(session);
    },
  };
}

/**
 * Whether a reply aimed away from `leaving` (the session it waits on, if any) takes the thread (`took_over`): only from
 * an owner known to have ended (`ownerCanEnd`), so answering an older message cannot take a thread from a hand-off's new
 * owner or from an agent that reads through MCP; then when it leaves that owner, or answers a session read as ended.
 */
export function takesOver(
  store: { threadOwner(threadId: string): { session: string } | null; ownerCanEnd(threadId: string, session: string): boolean },
  threadId: string,
  asked: InboxMessage | null | undefined,
  leaving: string | null | undefined,
  live: { askerLive(session: string): boolean },
): boolean {
  const owner = store.threadOwner(threadId);
  if (!owner || !store.ownerCanEnd(threadId, owner.session) || live.askerLive(owner.session)) return false;
  return owner.session === leaving || replacesEndedAsker(asked, live);
}

/**
 * How long a session the Inbox wakes itself (Codex) is listed as live after
 * its last Inbox tool call: New message, compose and tags offer it that long.
 * Its thread takes a queued message whenever it runs, so this only bounds
 * the list.
 */
export const INBOX_WAKE_ONLY_LIVE_MS = 60 * 60_000;

/** The longest session label kept, in user-perceived characters (`graphemesOf`, so a family emoji or a flag is never split). */
export const INBOX_SESSION_LABEL_MAX = 60;

/**
 * A poll's `label` as the window may draw it: control characters, line
 * separators and bidi controls stripped (the same characters a thread name
 * refuses), trimmed, at most INBOX_SESSION_LABEL_MAX characters. Null for
 * anything that is not a string, that leaves nothing visible, or that reads
 * as the person (`readsAsYou`).
 */
export function cleanInboxSessionLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Twice as many UTF-16 units always hold that many code points, so the first cut never spends on the rest of a long
  // string. Whole characters only: the last one of a string cut there may be half of one, and what is kept stays
  // within INBOX_SESSION_LABEL_INPUT_MAX code points.
  const head = value.slice(0, INBOX_SESSION_LABEL_INPUT_MAX * 2);
  const parts = graphemesOf(head);
  if (head.length < value.length) parts.pop();
  let points = 0;
  let input = "";
  for (const part of parts) {
    points += Array.from(part).length;
    if (points > INBOX_SESSION_LABEL_INPUT_MAX) break;
    input += part;
  }
  const text = input.replace(/[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu, "").trim();
  const label = graphemesOf(text).slice(0, INBOX_SESSION_LABEL_MAX).join("").trimEnd();
  const visible = label.replace(/\p{Default_Ignorable_Code_Point}/gu, "").trim();
  return visible && !readsAsYou(visible) ? label : null;
}

/**
 * A label that reads as the person: "You", ignoring case, spacing and zero-width characters. A label is display
 * only, but a message's author shows it where the person's own messages say "You", and Claude Code's comes from
 * the session's transcript, which its own model can append to. An agent's name stays allowed (a session named "Pi"
 * or "Codex" is a real name); the agent's mark beside the name, and "Claude Code · Review" where two sessions share
 * a label, tell those apart.
 */
function readsAsYou(label: string): boolean {
  return label.replace(/[\s\p{Default_Ignorable_Code_Point}]+/gu, "").toLowerCase() === "you";
}

const iso = (ms: number) => new Date(ms).toISOString();
const finiteMs = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

export function createInboxLiveSessions(options: {
  store: InboxStore;
  serverSession: string;
  resolveRoot: (path: string) => Promise<string>;
  now?: () => number;
  /**
   * Whether a session on `host` that loaded `plugin` (null: its poll sent
   * none) is outdated (packages/server/inbox-restart.ts). Absent: never.
   */
  outdatedOf?: (host: string, plugin: LoadedPlugin | null, folder: string | null) => InboxSessionOutdated | null;
  /** A working folder as the window shows it (the home folder as `~`). */
  displayFolder?: (path: string) => string;
  /** The command that restarts a session as itself, in its folder (shown); null for a host without one. */
  restartCommandOf?: (host: string, folder: string, session: string) => string | null;
  /** How long a reply waits on a busy session before it goes in by itself. Default `INBOX_AUTO_SEND_AFTER_MS`. */
  autoSendAfterMs?: number;
  /**
   * For a session the Inbox wakes itself, with no polling connection (Codex):
   * `alive`, `dead` (its thread is gone), or null (not such a session). Such a
   * session never "ends" for want of a poll: only `dead` ends it.
   */
  wakeOnlyStatus?: (session: string) => "alive" | "dead" | null;
  /** The items of a session the Inbox wakes itself that may not have reached it (a `codex queue` that ran out of time). */
  uncertainItemsOf?: (session: string) => string[];
  /** Each poll, with the sessions its conversation continues (nearest first): the agent icons' faces link it (inbox-agent-faces.ts). */
  onPoll?: (session: string, continues: readonly string[]) => void;
}) {
  const { store, serverSession } = options;
  const now = options.now ?? Date.now;
  const autoSendAfterMs = options.autoSendAfterMs ?? INBOX_AUTO_SEND_AFTER_MS;
  const startedAt = now();
  const sessions = new Map<string, SeenSession>();
  /**
   * MCP activity per agent session: when a tool call last named it. Presence
   * only (a session that asked is not "ended" while it talks to the Inbox); it
   * never makes a session live for New message, which needs a connection that
   * wakes it.
   */
  const mcpSeen = new Map<string, { lastSeen: number; host?: string; name?: string }>();
  const mcpEntry = (session: string) => {
    let entry = mcpSeen.get(session);
    if (!entry) {
      entry = { lastSeen: now() };
      mcpSeen.set(session, entry);
    }
    return entry;
  };
  /** A tool call named this agent session (and, when the call said so, its host and name: the tag list's MCP rows). */
  const seenOverMcp = (session: string, who: { host?: unknown; name?: unknown } = {}) => {
    if (!session) return;
    const entry = mcpEntry(session);
    entry.lastSeen = now();
    if (typeof who.host === "string" && who.host.trim() && who.host.length <= 64) entry.host = who.host.trim();
    if (typeof who.name === "string" && who.name.trim()) entry.name = inboxStoredAgentName(who.name) ?? undefined;
  };
  /**
   * project_path to its project's root. The Inbox passes its shared
   * project-root cache (packages/server/inbox-project-root.ts), which asks
   * git once per folder, so every poll after the first answers from memory
   * and a session agrees with where its sends land (a linked worktree's
   * session is in its main repository's project).
   */
  const rootOf = (path: unknown): Promise<string | null> => {
    if (typeof path !== "string" || !path) return Promise.resolve(null);
    return options.resolveRoot(path).catch(() => null);
  };

  /**
   * How many times a session's busy or Send now flag changed. Part of the
   * delivery signature: the signature is only compared once a second, so a
   * turn that ends and starts again between two looks (idle, then busy again)
   * left it unchanged, while a window that read the list in between kept the
   * idle state ("Sending") with no event to read it again.
   */
  let deliveryChanges = 0;
  const setDeliveryFlags = (entry: SeenSession, busy: boolean | null, sendNow: boolean) => {
    if (entry.busy !== busy || entry.sendNow !== sendNow) deliveryChanges += 1;
    entry.busy = busy;
    entry.sendNow = sendNow;
  };
  /** Whether Claude Code holds the session's replies until the person types (`held`): a change moves the rows' "Stopped". */
  const setHeld = (entry: SeenSession, held: boolean) => {
    if ((entry.held === true) !== held) deliveryChanges += 1;
    entry.held = held;
  };

  const applyState = (entry: SeenSession, body: Record<string, unknown>, at: number) => {
    if (typeof body.busy !== "boolean") return;
    if (body.busy) {
      if (entry.busy !== true) entry.busySince = at;
      setDeliveryFlags(entry, true, entry.sendNow);
      entry.idleSince = null;
    } else {
      entry.idleSince = entry.busy === false && entry.idleSince !== null ? entry.idleSince : (finiteMs(body.idle_since) ?? at);
      entry.lastIdleSince = entry.idleSince;
      entry.idleAt = at;
      setDeliveryFlags(entry, false, entry.sendNow);
    }
  };

  /**
   * The clocks of the items waiting on each session (approval
   * "inbox-busy-agent-reply"): an item's wait starts the first time its
   * session is seen busy while the item waits for it, and its clock toward
   * going in by itself the first time that session is also seen able to take
   * it mid-turn (`send_now`). Never from `created_at`: a reply left for a
   * session that ended, or moved to another session, starts its wait when
   * that session is busy. A delivered or moved item leaves its session's
   * clocks; a session that stops being live loses them all. In memory only,
   * so a restart starts every clock again (never shorter).
   */
  const waits = new Map<string, Map<string, WaitClock>>();
  const trackWaitsOf = (session: string, entry: SeenSession | undefined, t: number) => {
    let clocks = waits.get(session);
    if (!entry || !isLive(entry)) {
      waits.delete(session);
      return;
    }
    if (entry.busy !== true && !clocks) return;
    const pending = pendingOf(session, { tags: entry.tags }).map((item) => item.message);
    if (clocks) {
      const ids = new Set(pending.map((item) => item.id));
      for (const id of [...clocks.keys()]) if (!ids.has(id)) clocks.delete(id);
    }
    if (entry.busy === true) {
      for (const item of pending) {
        clocks ??= new Map();
        const clock = clocks.get(item.id) ?? { since: t, autoSince: null };
        if (clock.autoSince === null && entry.sendNow) clock.autoSince = t;
        clocks.set(item.id, clock);
      }
    }
    if (clocks && clocks.size > 0) waits.set(session, clocks);
    else waits.delete(session);
  };
  /** Look at every session's waiting items now (the server's sweep, every few seconds). */
  const trackWaits = () => {
    const t = now();
    for (const session of [...waits.keys()]) if (!sessions.has(session)) waits.delete(session);
    for (const [session, entry] of sessions) trackWaitsOf(session, entry, t);
  };
  /** The clock of an item waiting on `session` (ms), or null. */
  const waitClockOf = (session: string, itemId: string): WaitClock | null => waits.get(standInOf(session)?.session ?? session)?.get(itemId) ?? null;
  /** The same, as the rows read it (ISO). */
  const waitOf = (session: string, itemId: string): { since: string; autoSince: string | null } | null => {
    const clock = waitClockOf(session, itemId);
    return clock ? { since: iso(clock.since), autoSince: clock.autoSince === null ? null : iso(clock.autoSince) } : null;
  };
  /**
   * Whether an item the Inbox marked to go in by itself at `markedAt` went
   * into a running turn when its session took it: false when the session was
   * seen idle after the mark (its own Ask question held the turn, so it went
   * in when the turn ended).
   */
  const deliveredIntoTurn = (session: string, markedAt: string | null | undefined): boolean | undefined => {
    const entry = sessions.get(session);
    const marked = markedAt ? Date.parse(markedAt) : NaN;
    if (!entry || !Number.isFinite(marked)) return undefined;
    return !(typeof entry.idleAt === "number" && entry.idleAt >= marked);
  };

  /**
   * Every session's label as its latest poll sent it (issue #2450: the `@` picker, the list rows' agents, a
   * message's author): live sessions and the ones that ended while this Inbox ran, so a finished thread keeps
   * its names until the Inbox restarts. Display only, like the To picker's: nothing routes on it, nothing is
   * stored, and no MCP read carries it. The routes give it to this computer's owner only (`isOwnerRequest`).
   * No prototype, so a session id like "__proto__" or "constructor" is a plain key.
   */
  const labels = (): Record<string, string> => {
    const out = Object.create(null) as Record<string, string>;
    for (const [session, entry] of sessions) if (entry.label) out[session] = entry.label;
    return out;
  };
  /** One session's label (`labels`); null when it has none. */
  const labelOf = (session: string): string | null => sessions.get(session)?.label ?? null;
  /** Bumped each time a poll changes a label: the windows read the rows again (`event: deliveries`, `labels`). */
  let labelChanges = 0;
  const labelVersion = () => labelChanges;

  /** A poll arrived: the session is live, and says where it works. Returns the call to make when the poll answers. */
  const pollStarted = async (session: string, host: string, body: Record<string, unknown>): Promise<() => void> => {
    const at = now();
    const root = await rootOf(body.project_path);
    const entry: SeenSession = sessions.get(session) ?? {
      host,
      root,
      startedAt: finiteMs(body.started_at) ?? at,
      lastSeen: at,
      holding: 0,
      busy: null,
      idleSince: null,
      sendNow: false,
      cwd: null,
      folder: null,
      plugin: null,
      engine: null,
      tags: false,
    };
    entry.host = host;
    setDeliveryFlags(entry, entry.busy, body[INBOX_SEND_NOW_POLL_FIELD] === true);
    setHeld(entry, body[INBOX_HELD_POLL_FIELD] === true);
    entry.tags = body[INBOX_TAGS_POLL_FIELD] === true;
    // Sent on every poll, so the latest stands: a poll without it withdraws the claim.
    const continues = parseInboxContinues(body[INBOX_CONTINUES_POLL_FIELD], session);
    continuations.claim(session, continues);
    options.onPoll?.(session, continues);
    // Sent on every poll, so the latest stands: empty clears it, and an older connection never has one.
    const label = cleanInboxSessionLabel(body.label);
    if ((entry.label ?? null) !== label) labelChanges += 1;
    entry.label = label;
    entry.ask = body[INBOX_ASK_POLL_FIELD] === true;
    // What the session loaded (additive poll fields; an older connection sends neither).
    entry.plugin = parseLoadedPlugin(body.plugin);
    entry.engine = parseEngine(body.engine);
    if (typeof body.project_path === "string" && body.project_path) entry.cwd = body.project_path;
    const folder = parseSessionFolder(body.session_folder);
    if (folder) entry.folder = folder;
    if (root !== null) entry.root = root;
    entry.startedAt = finiteMs(body.started_at) ?? entry.startedAt;
    entry.wakeStartedAt = finiteMs(body.started_at);
    entry.lastSeen = at;
    entry.holding += 1;
    entry.polls = (entry.polls ?? 0) + 1;
    applyState(entry, body, at);
    sessions.set(session, entry);
    trackWaitsOf(session, entry, at);
    return () => {
      entry.holding = Math.max(0, entry.holding - 1);
      entry.lastSeen = now();
    };
  };

  /** A `state` event: a turn started or ended, or whether a Send now reply can go in changed. */
  const stateChanged = (session: string, host: string, body: Record<string, unknown>) => {
    const entry = sessions.get(session);
    if (!entry) return;
    const at = now();
    entry.host = host;
    entry.lastSeen = at;
    applyState(entry, body, at);
    if (typeof body[INBOX_SEND_NOW_POLL_FIELD] === "boolean") setDeliveryFlags(entry, entry.busy, body[INBOX_SEND_NOW_POLL_FIELD] === true);
    if (typeof body[INBOX_HELD_POLL_FIELD] === "boolean") setHeld(entry, body[INBOX_HELD_POLL_FIELD] === true);
    trackWaitsOf(session, entry, at);
  };

  /** When each session was last handed an item to go into its running turn (`INBOX_ASKER_STEER_GRACE_MS`). */
  const steering = new Map<string, number>();
  const steerHanded = (session: string) => void steering.set(session, now());
  const steerDone = (session: string) => void steering.delete(session);

  const isLive = (entry: SeenSession) =>
    entry.wakeOnly !== undefined
      ? now() - entry.lastSeen <= INBOX_WAKE_ONLY_LIVE_MS && options.wakeOnlyStatus?.(entry.wakeOnly) !== "dead"
      : entry.holding > 0 || now() - entry.lastSeen <= INBOX_SESSION_LIVE_MS;

  /**
   * A conversation that goes on under a new session id (inbox-continuations.ts): a poll's `continues` names the
   * ids it continues, and while one of those does not poll, the continuing session stands in for it.
   */
  const continuations = createInboxContinuations({
    isLive: (session) => {
      const entry = sessions.get(session);
      return !!entry && isLive(entry);
    },
  });
  /** The entry that answers for `session` now: its own while it is live, else that of the live session continuing it. */
  const standInOf = (session: string): { session: string; entry: SeenSession } | null => {
    const own = sessions.get(session);
    if (own && isLive(own)) return { session, entry: own };
    const heir = continuations.heirOf(session);
    const entry = heir === null ? undefined : sessions.get(heir);
    return heir !== null && entry ? { session: heir, entry } : null;
  };
  /**
   * What waits for `session`'s connection: its own items, then those of the sessions it stands in for, oldest
   * first. `as` is the session an item waits for (the one its delivery is recorded for).
   */
  const pendingOf = (session: string, options: { tags?: boolean } = {}): { message: InboxMessage; as: string }[] => {
    const own = store.pendingReplies(session, options).map((message) => ({ message, as: session }));
    const inherited = continuations.inheritedBy(session);
    if (inherited.length === 0) return own;
    const seen = new Set(own.map((item) => item.message.id));
    const out = [...own];
    for (const [as, list] of store.pendingRepliesFor(new Set(inherited), options)) {
      for (const message of list) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        out.push({ message, as });
      }
    }
    const seqOf = (id: string) => store.messageCursor(id) ?? 0;
    return out.sort((a, b) => seqOf(a.message.id) - seqOf(b.message.id));
  };
  /** The session `session`'s connection acts as for item `itemId`: itself, or the session it stands in for that the item goes to. */
  const actingFor = (session: string, itemId: string): string => {
    const message = store.message(itemId);
    if (!message || store.isFor(message, session)) return session;
    return continuations.inheritedBy(session).find((old) => store.isFor(message, old)) ?? session;
  };

  /**
   * A session the Inbox wakes itself (Codex) called an Inbox tool: it is live
   * (New message, compose and tags offer it), in the project its
   * `project_path` names. Never over a session whose connection polls.
   */
  const seenWakeOnly = async (session: string, host: string, projectPath: unknown): Promise<void> => {
    if (!session) return;
    const root = await rootOf(projectPath);
    const at = now();
    const known = sessions.get(session);
    if (known && known.wakeOnly === undefined) return;
    const entry: SeenSession = known ?? {
      host,
      root,
      startedAt: at,
      lastSeen: at,
      holding: 0,
      busy: null,
      idleSince: null,
      sendNow: false,
      cwd: null,
      folder: null,
      plugin: null,
      engine: null,
      tags: true,
      wakeOnly: session,
    };
    entry.lastSeen = at;
    if (root !== null) entry.root = root;
    if (typeof projectPath === "string" && projectPath) entry.cwd = projectPath;
    sessions.set(session, entry);
  };

  /** How a session the Inbox wakes itself is connected: it takes the item as its next turn; nothing else is known. */
  const wakeOnlyConnection = (): InboxRecipientConnection => ({
    busy: null,
    idle_since: null,
    send_now: false,
    outdated: null,
    engine: null,
    restart_command: null,
    auto_send_after_ms: autoSendAfterMs,
    waits: {},
  });
  /** `uncertain` on a connection: the items that may not have reached the session (absent when none). */
  const uncertainOf = (session: string): { uncertain?: string[] } => {
    const items = options.uncertainItemsOf?.(session) ?? [];
    return items.length > 0 ? { uncertain: items } : {};
  };

  /**
   * Whether the session that asked is still there, with the grace above: it
   * holds a poll, or polled or called an MCP tool
   * within `INBOX_ASKER_GRACE_MS`, or this Inbox started less than that long
   * ago (sessions are kept in memory only). The window asks only about a
   * session whose message came through a connection that wakes it
   * (`InboxMessage.wakes`).
   */
  const askerLive = (session: string): boolean => {
    // A session the Inbox wakes itself (Codex) is there until its thread is known to be gone.
    const wakeOnly = options.wakeOnlyStatus?.(session) ?? null;
    if (wakeOnly !== null) return wakeOnly === "alive";
    const recent = (entry: { holding?: number; lastSeen: number } | undefined) =>
      !!entry && ((entry.holding ?? 0) > 0 || now() - entry.lastSeen <= INBOX_ASKER_GRACE_MS);
    if (recent(sessions.get(session)) || recent(mcpSeen.get(session))) return true;
    // Its conversation goes on under another session id, and that one polls.
    if (continuations.heirOf(session) !== null) return true;
    const steered = steering.get(session);
    if (steered !== undefined && now() - steered <= INBOX_ASKER_STEER_GRACE_MS) return true;
    return now() - startedAt <= INBOX_ASKER_RESTART_GRACE_MS;
  };

  /**
   * Whether `session`'s connection claimed item `itemId` and will never deliver it (its wake was killed while it
   * delivered: packages/server/inbox-stuck-delivery.ts). It never goes to that session again; the person may move it.
   */
  const stuck = (session: string, itemId: string): boolean =>
    inboxClaimAbandoned(store.dir, itemId, session, { there: askerLive(session), startedAt: sessions.get(session)?.wakeStartedAt ?? null }, now());
  /** The thread's latest person item `session` owes, when that session claimed it and will never deliver it (`stuck`). */
  const stuckField = (threadId: string, session: string): { stuck?: string[] } => {
    const owed = (store.thread(threadId)?.messages ?? []).filter((m) => m.author.kind === "person" && store.isOwner(m, session)).at(-1);
    return owed && !owed.delivery && stuck(session, owed.id) ? { stuck: [owed.id] } : {};
  };

  /**
   * The reply route's `to`: the live session of the thread's project it
   * names (the host, when given, must match), or null when it is not live.
   */
  const replyTarget = (threadId: string, to: unknown): { host: string; session: string } | null => {
    if (!to || typeof to !== "object" || Array.isArray(to)) {
      throw new InboxError("validation_error", "to: { host, session } of a live session.", { field: "to" });
    }
    const { host, session } = to as Record<string, unknown>;
    if (typeof session !== "string" || !session) throw new InboxError("validation_error", "to.session: the live session to send to.", { field: "to.session" });
    if (host !== undefined && typeof host !== "string") throw new InboxError("validation_error", "to.host: a string.", { field: "to.host" });
    const target = liveFor(threadId).sessions.find((candidate) => candidate.session === session) ?? null;
    if (!target || (host !== undefined && target.host !== host)) return null;
    return { host: target.host, session: target.session };
  };

  /**
   * The live sessions of a thread's project, and those of the thread itself from any folder (its writers and
   * the sessions tagged in it): its writers first (the latest writer first), then by start.
   */
  const liveFor = (threadId: string): { project: InboxProject; sessions: InboxLiveSession[] } => {
    const thread = store.thread(threadId);
    if (!thread) throw new InboxError("thread_not_found", `No thread ${threadId}.`);
    const project = thread.project;
    const lastWrote = new Map<string, number>();
    /** The sessions of the thread itself: its writers and the ones tagged in it, from any folder. */
    const inThread = new Set<string>();
    thread.messages.forEach((message, index) => {
      if (message.author.kind === "agent" && message.author.session) {
        lastWrote.set(message.author.session, index);
        inThread.add(message.author.session);
      }
      for (const tag of message.tags ?? []) inThread.add(tag.session);
    });
    let wroteInProject: Set<string> | null = null;
    // Every folder of a combined project: a session in either can take the thread.
    const roots = new Set([project.root, ...store.projectGroup(project.id).flatMap((id) => store.project(id)?.root ?? [])]);
    const out: (InboxLiveSession & { order: number; started: number })[] = [];
    for (const [session, entry] of sessions) {
      if (!isLive(entry)) continue;
      // A session that wrote in the thread or was tagged in it takes it from any folder (approval
      // "inbox-reply-recipient": the recipient pill lists it, and a reply may go to it alone).
      if (!inThread.has(session)) {
        if (entry.root !== null) {
          if (!roots.has(entry.root)) continue;
        } else {
          wroteInProject ??= new Set(
            store
              .threadsOf(project.id)
              .flatMap((summary) => store.thread(summary.thread_id)?.messages ?? [])
              .flatMap((message) => (message.author.kind === "agent" && message.author.session ? [message.author.session] : [])),
          );
          if (!wroteInProject.has(session)) continue;
        }
      }
      out.push({
        session,
        host: entry.host,
        started_at: iso(entry.startedAt),
        last_seen_at: iso(entry.lastSeen),
        busy: entry.busy,
        idle_since: entry.busy === false && entry.idleSince !== null ? iso(entry.idleSince) : null,
        wrote_thread: lastWrote.has(session),
        send_now: entry.sendNow,
        order: lastWrote.get(session) ?? -1,
        started: entry.startedAt,
      });
    }
    out.sort((a, b) => b.order - a.order || a.started - b.started);
    return { project, sessions: out.map(({ order: _order, started: _started, ...session }) => session) };
  };

  /**
   * Every live session in any project (compose), with the root its
   * `project_path` resolved to (null when its connection sends none).
   */
  const allLive = (): {
    session: string;
    host: string;
    root: string | null;
    startedAt: number;
    lastSeen: number;
    busy: boolean | null;
    idleSince: number | null;
    /** Its connection understands a reply it was tagged in (`tags`). */
    tags: boolean;
    sendNow: boolean;
    label: string | null;
  }[] => {
    const out = [];
    for (const [session, entry] of sessions) {
      if (!isLive(entry)) continue;
      out.push({
        session,
        host: entry.host,
        root: entry.root,
        startedAt: entry.startedAt,
        lastSeen: entry.lastSeen,
        busy: entry.busy,
        idleSince: entry.busy === false ? entry.idleSince : null,
        tags: entry.tags,
        sendNow: entry.sendNow,
        label: entry.label ?? null,
      });
    }
    return out;
  };

  /**
   * The sessions the Agents section can list (packages/server/inbox-agents-list.ts): every live one, and every one
   * last heard at or after `since` (the start of today) that has ended. In memory, so a restart forgets the ended.
   * A launch's permission prompt (`perm:…`) is no session of its own.
   */
  const agentSessions = (since: number): InboxAgentSession[] => {
    const out: InboxAgentSession[] = [];
    for (const [session, entry] of sessions) {
      const live = isLive(entry);
      const heard = Math.max(entry.lastSeen, mcpSeen.get(session)?.lastSeen ?? 0);
      if ((!live && heard < since) || isInboxPermissionSession(session)) continue;
      out.push({
        session,
        host: entry.host,
        root: entry.root,
        startedAt: entry.startedAt,
        lastSeen: heard,
        live,
        busy: live ? entry.busy : null,
        label: entry.label ?? null,
      });
    }
    return out;
  };

  /**
   * What the Agents section reads from the sessions, as one string (`event: deliveries`' `agents`): which are listed,
   * live, busy or idle, and where they work. Never the time they were last heard, which every poll moves, nor a label:
   * a label's change says `labels` to the owner's windows (which read the list for it), and nothing to a guest's.
   */
  const agentsSignature = (since: number): string =>
    agentSessions(since)
      // Which ids its conversation continues: an agent is listed once for them all (inbox-agents-list.ts).
      .map((entry) => `${entry.session}:${entry.live ? (entry.busy === true ? "b" : "i") : "e"}:${entry.root ?? ""}${entry.live ? continuations.lineOf(entry.session).map((old) => `>${old}`).join("") : ""}`)
      .join("|") + `#${continuations.signature()}`;

  /**
   * The agents that read the Inbox through MCP only, newest first: every
   * session whose latest message did not come through a waking connection,
   * and every session an MCP tool call named with its host or name, within
   * `INBOX_MCP_AGENT_LISTED_MS`; never a session that polls now (that one is
   * live and woken).
   */
  const mcpAgents = (): InboxMcpAgent[] => {
    const cutoff = now() - INBOX_MCP_AGENT_LISTED_MS;
    const out = new Map<string, InboxMcpAgent & { at: number }>();
    for (const [session, message] of store.latestAgentMessages()) {
      if (message.wakes === true || message.author.kind !== "agent") continue;
      const polling = sessions.get(session);
      if (polling && isLive(polling)) continue;
      const at = Date.parse(message.created_at);
      if (!(at >= cutoff)) continue;
      out.set(session, { session, host: message.author.host ?? null, name: message.author.name ?? null, project_id: message.project_id, last_at: message.created_at, at });
    }
    for (const [session, entry] of mcpSeen) {
      if (entry.lastSeen < cutoff) continue;
      const polling = sessions.get(session);
      if (polling && isLive(polling)) continue;
      const known = out.get(session);
      if (known) {
        if (entry.lastSeen > known.at) Object.assign(known, { at: entry.lastSeen, last_at: iso(entry.lastSeen) });
        known.host ??= entry.host ?? null;
        known.name ??= entry.name ?? null;
        continue;
      }
      // A session that never wrote is listed only when its calls said who it is.
      if (!entry.host && !entry.name) continue;
      out.set(session, { session, host: entry.host ?? null, name: entry.name ?? null, project_id: null, last_at: iso(entry.lastSeen), at: entry.lastSeen });
    }
    return [...out.values()]
      .sort((a, b) => b.at - a.at || a.session.localeCompare(b.session))
      .slice(0, INBOX_MCP_AGENTS_MAX)
      .map(({ at: _at, ...agent }) => agent);
  };

  /**
   * The reply route's `tags` (approval "inbox-tag-agents"): each `{ host?, session }`
   * names a live session whose connection understands tags (woken), or an MCP
   * agent the Inbox knows (not woken), in any project. Refused before anything
   * is written: a live session on an older Plannotator (`tag_needs_update`),
   * a session the Inbox knows under another host than the tag says
   * (`tag_host_mismatch`), and one that is neither (`session_not_live`).
   */
  const tagTargets = (value: unknown): InboxTag[] => {
    if (!Array.isArray(value)) throw new InboxError("validation_error", "tags: a list of { host, session }.", { field: "tags" });
    const out: InboxTag[] = [];
    const old: string[] = [];
    const missing: string[] = [];
    const mismatched: string[] = [];
    let agents: InboxMcpAgent[] | null = null;
    for (const item of value) {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new InboxError("validation_error", "tags: each one { host, session }.", { field: "tags" });
      const { host, session, label } = item as Record<string, unknown>;
      if (typeof session !== "string" || !session) throw new InboxError("validation_error", "tags: each one names a session.", { field: "tags" });
      // The readable label rides along (the store checks its shape).
      const labeled = typeof label === "string" ? { label } : {};
      if (host !== undefined && host !== null && typeof host !== "string") throw new InboxError("validation_error", "tags: host a string.", { field: "tags" });
      const entry = sessions.get(session);
      if (entry && isLive(entry) && (host === undefined || host === entry.host)) {
        if (entry.tags) out.push({ host: entry.host, session, ...labeled, wakes: true });
        else old.push(session);
        continue;
      }
      agents ??= mcpAgents();
      const agent = agents.find((candidate) => candidate.session === session && (host === undefined || host === candidate.host));
      if (agent) {
        out.push({ host: agent.host, session, ...(agent.name ? { name: agent.name } : {}), ...labeled, wakes: false });
        continue;
      }
      // Known, but as another agent than the tag names: say that, not "not live".
      const known = (entry && isLive(entry)) || agents.some((candidate) => candidate.session === session);
      if (known) mismatched.push(session);
      else missing.push(session);
    }
    if (old.length > 0) {
      // Name the host's own command (owner approval "reload-hosts"): `/reload-plugins` in Claude Code,
      // `/reload` in Pi, `/restart` in Oh My Pi, `opencode2 reload` for OpenCode 2, with the update first
      // when the plugin on disk is itself behind this Inbox.
      const fixes = [
        ...new Set(
          old.map((session) => {
            const entry = sessions.get(session)!;
            return tagUpdateFix(runtimeOf(entry.host, entry.plugin), outdatedOf(entry));
          }),
        ),
      ];
      throw new InboxError(
        "tag_needs_update",
        `A session you tagged runs an older Plannotator that can't be tagged: nothing was sent. ${fixes.join(" ")} Or remove the tag.`,
        { sessions: old },
      );
    }
    if (mismatched.length > 0) {
      throw new InboxError(
        "tag_host_mismatch",
        "A session you tagged is another agent than the tag says: nothing was sent. Remove the tag and pick the session from the list again.",
        { sessions: mismatched },
      );
    }
    if (missing.length > 0) {
      throw new InboxError("session_not_live", "A session you tagged is not live any more: nothing was sent. Remove the tag, or tag another session.", { sessions: missing });
    }
    return out;
  };

  /** Whether a session is live now with a connection that understands tags (so a notice reaches it truthfully). */
  const wakesTagged = (session: string): boolean => {
    const entry = sessions.get(session);
    return !!entry && isLive(entry) && entry.tags;
  };

  /** The host of a live session whose connection can answer Ask AI (its poll said `ask`), else null. */
  const askHostOf = (session: string): string | null => {
    const entry = sessions.get(session);
    return entry?.ask === true && isLive(entry) ? entry.host : null;
  };

  /** How a session is connected now (live, no grace), or null when its connection does not poll. */
  const connectionOf = (asked: string): InboxRecipientConnection | null => {
    // A session whose conversation goes on under another id is connected as that one is.
    const stand = standInOf(asked);
    if (!stand) return options.wakeOnlyStatus?.(asked) === "alive" ? { ...wakeOnlyConnection(), ...uncertainOf(asked) } : null;
    const { session, entry } = stand;
    return {
      busy: entry.busy,
      idle_since: entry.busy === false && entry.idleSince !== null ? iso(entry.idleSince) : null,
      send_now: entry.sendNow,
      ...(entry.held === true ? { held: true as const } : {}),
      outdated: outdatedOf(entry),
      engine: entry.engine,
      restart_command: restartCommandOf(session, entry),
      auto_send_after_ms: autoSendAfterMs,
      waits: Object.fromEntries(
        [...(waits.get(session) ?? new Map<string, WaitClock>())].map(([id, clock]) => [
          id,
          { since: iso(clock.since), auto_since: clock.autoSince === null ? null : iso(clock.autoSince) },
        ]),
      ),
      ...uncertainOf(session),
    };
  };

  /**
   * The live sessions a reply may go into by itself now: a turn runs and the
   * connection said it can take an item mid-turn (`send_now`). With `tags`:
   * whether the connection understands a reply it was only tagged in.
   */
  const steerableSessions = (): { session: string; tags: boolean }[] => {
    const out: { session: string; tags: boolean }[] = [];
    for (const [session, entry] of sessions) {
      if (isLive(entry) && entry.busy === true && entry.sendNow) out.push({ session, tags: entry.tags });
    }
    return out;
  };

  /** The fields a list row's delivery reads (`InboxStore.setDeliveryPresence`): `connectionOf` without its plugin checks. */
  const deliveryConnectionOf = (session: string): { busy: boolean | null; send_now: boolean; held?: true } | null => {
    const entry = standInOf(session)?.entry;
    if (!entry) return options.wakeOnlyStatus?.(session) === "alive" ? { busy: null, send_now: false } : null;
    return { busy: entry.busy, send_now: entry.sendNow, ...(entry.held === true ? { held: true as const } : {}) };
  };

  /**
   * The sessions with a waking message that `askerLive` reads as there, the only ones a row can call ended, each once
   * however it is known: a change means one of them ended or came back, so a row's "Session ended" may have moved
   * (`sessions` on `event: deliveries`). A turn starting, an MCP call or its window running out does not change it.
   */
  const presenceSignature = (): string => {
    const known = new Set([...sessions.keys(), ...mcpSeen.keys(), ...steering.keys(), ...continuations.claimed()]);
    const there = [...known].filter((session) => options.store.hasWakingMessage(session) && askerLive(session)).sort();
    return [now() - startedAt <= INBOX_ASKER_RESTART_GRACE_MS ? "g" : "", ...there].join("|");
  };

  /**
   * Everything the rows' delivery reads from the sessions, as one string:
   * which sessions are live, busy or idle, can take Send now, and are still
   * there for the asker grace (MCP presence and the Inbox's own start
   * included). Time alone changes it (a session stops polling, a grace runs
   * out), so the server compares it on a short timer and tells the windows
   * when it moved (`event: deliveries`). O(sessions), from memory.
   */
  const deliverySignature = (): string => {
    const t = now();
    const parts: string[] = [now() - startedAt <= INBOX_ASKER_RESTART_GRACE_MS ? "g" : "", String(deliveryChanges), `c:${continuations.signature()}`];
    for (const [id, entry] of sessions) {
      const recent = entry.holding > 0 || t - entry.lastSeen <= INBOX_ASKER_GRACE_MS;
      if (!recent) continue;
      const clocks = waits.get(id);
      const clocked = clocks ? `w${clocks.size}a${[...clocks.values()].filter((clock) => clock.autoSince !== null).length}` : "";
      parts.push(`${id}:${isLive(entry) ? 1 : 0}${entry.busy === null ? "n" : entry.busy ? "b" : "i"}${entry.sendNow ? "s" : ""}${entry.held ? "h" : ""}${clocked}`);
    }
    for (const [id, entry] of mcpSeen) {
      if (t - entry.lastSeen <= INBOX_ASKER_GRACE_MS) parts.push(`m:${id}`);
    }
    return parts.join("|");
  };

  /** The folder a restart runs in (shown with ~): where the session started, else where it works now. */
  const folderOf = (entry: SeenSession): string | null => {
    const path = entry.folder ?? entry.cwd;
    return path ? (options.displayFolder?.(path) ?? path) : null;
  };
  const restartCommandOf = (session: string, entry: SeenSession): string | null => {
    const folder = folderOf(entry);
    return folder && options.restartCommandOf ? options.restartCommandOf(entry.host, folder, session) : null;
  };

  const outdatedOf = (entry: SeenSession): InboxSessionOutdated | null => options.outdatedOf?.(entry.host, entry.plugin, entry.folder ?? entry.cwd) ?? null;

  /**
   * The live sessions of the Plannotator hosts, for Settings → Agents'
   * "Open sessions" row: each with what it loaded and whether a restart (or
   * an update) would bring it up to date. Newest first.
   */
  const hostSessions = (
    extra: (host: InboxToolHostId) => { installed: string | null; update_command: string | null },
  ): Partial<Record<InboxToolHostId, InboxHostSessions>> => {
    const out: Partial<Record<InboxToolHostId, InboxHostSessions>> = {};
    const hosts: readonly InboxToolHostId[] = ["claude-code", "pi", "opencode", "dsh", "cline", "openclaw"];
    for (const [session, entry] of [...sessions].sort((a, b) => b[1].startedAt - a[1].startedAt)) {
      if (!isLive(entry) || !(hosts as readonly string[]).includes(entry.host)) continue;
      const host = entry.host as InboxToolHostId;
      const info = extra(host);
      const group = (out[host] ??= { running: 0, outdated: 0, installed: info.installed, update_command: info.update_command, sessions: [] });
      const outdated = outdatedOf(entry);
      const folder = folderOf(entry);
      const row: InboxOpenSession = {
        session,
        project: entry.root ? basename(entry.root) : entry.cwd ? basename(entry.cwd) : null,
        folder,
        started_at: iso(entry.startedAt),
        busy: entry.busy,
        plugin: entry.plugin?.version ?? null,
        outdated,
        restart_command: restartCommandOf(session, entry),
        ...(runtimeOf(entry.host, entry.plugin) ? { runtime: runtimeOf(entry.host, entry.plugin)! } : {}),
      };
      group.running += 1;
      if (outdated) group.outdated += 1;
      group.sessions.push(row);
    }
    return out;
  };

  /**
   * The version a `/reload-plugins` loads for this Claude Code session, when
   * the Inbox judges it outdated with a reload as the fix (`restart`): what a
   * poll answer tells a connection that reloads itself (INBOX_RELOAD_FIELD).
   * Null for any other session, or one that is up to date. The same judgment
   * as Settings → Agents and the sidebar, so the two never disagree.
   */
  const reloadOfferFor = (session: string): { installed: string | null } | null => {
    const entry = sessions.get(session);
    if (!entry || entry.host !== "claude-code") return null;
    const outdated = outdatedOf(entry);
    return outdated?.fix === "restart" ? { installed: outdated.installed ?? null } : null;
  };

  /**
   * What a poll answer carries about auto reload: `{ reload: offer }` only to
   * a connection that said it reloads itself (INBOX_AUTO_RELOAD_POLL_FIELD
   * `true` in the poll body) while reloadOfferFor has an offer; else nothing.
   */
  const reloadAnswerFor = (session: string, body: Record<string, unknown>): { [INBOX_RELOAD_FIELD]?: { installed: string | null } } => {
    const offer = body[INBOX_AUTO_RELOAD_POLL_FIELD] === true ? reloadOfferFor(session) : null;
    return offer ? { [INBOX_RELOAD_FIELD]: offer } : {};
  };

  /**
   * Whether the sidebar's row counts this outdated Claude Code session: a
   * reload brings it up to date (`restart`), or its plugin on disk is itself
   * behind this Inbox (`update_plugin`: the update first, then the reload;
   * Settings → Agents, which the row opens, carries both steps). Once nothing
   * updates the plugin by itself, nothing else in plain view says so.
   */
  const claudeRowFix = (fix: string | undefined): boolean => fix === "restart" || fix === "update_plugin";

  /** Live Claude Code sessions the sidebar's "Reload Claude Code N" counts (claudeRowFix). */
  const restartCount = (): number => {
    let count = 0;
    for (const entry of sessions.values()) {
      if (entry.host === "claude-code" && isLive(entry) && claudeRowFix(outdatedOf(entry)?.fix)) count += 1;
    }
    return count;
  };

  /**
   * Live sessions the sidebar's row counts, per runtime (owner approval
   * "reload-hosts"): Claude Code's `restart` and `update_plugin` (its plugin
   * on disk is behind this Inbox, so the update comes first: `update_first`),
   * and Pi's, Oh My Pi's and OpenCode 2's `reload`. Pi's and OpenCode 2's
   * `update_extension` is not counted, as before: Settings carries it.
   */
  const restartAgents = (): InboxRestartAgents => {
    const runtimes: InboxRestartAgents["runtimes"] = {};
    let total = 0;
    let updateFirst = 0;
    for (const entry of sessions.values()) {
      if (!isLive(entry)) continue;
      const fix = outdatedOf(entry)?.fix;
      const claude = entry.host === "claude-code" && claudeRowFix(fix);
      if (!claude && fix !== "restart" && fix !== "reload") continue;
      const runtime = runtimeOf(entry.host, entry.plugin);
      if (!runtime) continue;
      runtimes[runtime] = (runtimes[runtime] ?? 0) + 1;
      total += 1;
      if (claude && fix === "update_plugin") updateFirst += 1;
    }
    return { total, runtimes, ...(updateFirst > 0 ? { update_first: updateFirst } : {}) };
  };

  /** Whether a session is live now (no grace: compose sends only to a session that polls). */
  const isSessionLive = (session: string): boolean => {
    const entry = sessions.get(session);
    return !!entry && isLive(entry);
  };

  /** A live session's turn state (a launched thread's run line); null when it is not live. */
  const runStateOf = (session: string): { busy: boolean | null; busySince: number | null; polls: number } | null => {
    const entry = sessions.get(session);
    return entry && isLive(entry) ? { busy: entry.busy, busySince: entry.busy === true ? (entry.busySince ?? null) : null, polls: entry.polls ?? 0 } : null;
  };

  /**
   * Whether `session` of `host` holds or made a bridge poll within the live
   * window now: its connection (the Claude Code mod, Pi, OpenCode 2) will
   * hand it the person's reply as a turn. MCP activity never counts.
   */
  const pollsNow = (host: string, session: string): boolean => {
    const entry = sessions.get(session);
    return !!entry && entry.host === host && isLive(entry);
  };

  /** `{ host?, session }` naming a live session in any project, or null when it is not live (compose's Send). */
  const composeTarget = (to: unknown): { host: string; session: string; root: string | null } | null => {
    if (!to || typeof to !== "object" || Array.isArray(to)) {
      throw new InboxError("validation_error", "to: { host, session } of a live session.", { field: "to" });
    }
    const { host, session } = to as Record<string, unknown>;
    if (typeof session !== "string" || !session) throw new InboxError("validation_error", "to.session: the live session to send to.", { field: "to.session" });
    if (host !== undefined && typeof host !== "string") throw new InboxError("validation_error", "to.host: a string.", { field: "to.host" });
    const entry = sessions.get(session);
    if (!entry || !isLive(entry) || (host !== undefined && entry.host !== host)) return null;
    return { host: entry.host, session, root: entry.root };
  };

  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
    });

  /**
   * The window's routes; null when the path is not one of them. `owner`: this computer's owner asks (this
   * computer, the owner's tailnet login, their phone): only then does a session carry its `label`.
   * `byGuest`: the request is a tailnet guest's (`isGuest`), so a new message it writes is marked `by_guest`.
   */
  const route = async (req: Request, path: string, owner = false, byGuest = false): Promise<Response | null> => {
    const sessionsMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/sessions$/.exec(path);
    if (sessionsMatch) {
      if (req.method !== "GET") return answer({ error: "Use GET." }, 405);
      const found = liveFor(sessionsMatch[1]!);
      // Send to another session's rows (issue #2450): the label, absent when the session has none.
      const live = owner
        ? {
            ...found,
            sessions: found.sessions.map((session) => {
              const label = labelOf(session.session);
              return label ? { ...session, label } : session;
            }),
          }
        : found;
      const asker = new URL(req.url).searchParams.get("asker");
      const recipients = (new URL(req.url).searchParams.get("recipients") ?? "")
        .split(",")
        .map((session) => session.trim())
        .filter((session) => session !== "");
      return answer({
        serverSession,
        home: homedir(),
        project: live.project,
        sessions: live.sessions,
        // `connection` (additive): how that session is connected now, for the line under the person's message ("Queued", "Sending", Send now).
        // `stuck` (additive, absent when none): its items that session claimed and will never deliver.
        ...(asker ? { asker: { session: asker, live: askerLive(asker), connection: connectionOf(asker), ...stuckField(sessionsMatch[1]!, asker) } } : {}),
        // `recipients` (additive, "inbox-tag-agents"): how each session a reply tags is connected now, for its own line.
        ...(recipients.length > 0 ? { recipients: Object.fromEntries(recipients.map((session) => [session, connectionOf(session)])) } : {}),
      });
    }
    const sendNowMatch = /^\/api\/inbox\/messages\/([A-Za-z0-9_]+)\/send-now$/.exec(path);
    if (sendNowMatch) {
      if (req.method !== "POST") return answer({ error: "Use POST." }, 405);
      let body: Record<string, unknown> = {};
      try {
        const value = await req.json();
        body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
      } catch {
        throw new InboxError("validation_error", "body: expected a JSON object.");
      }
      if (checkServerSession(body, serverSession) === "mismatch") return answer(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
      return answer({ message: sendNow(sendNowMatch[1]!, typeof body.session === "string" && body.session ? body.session : null) });
    }
    const messageMatch = /^\/api\/inbox\/threads\/([A-Za-z0-9_]+)\/message$/.exec(path);
    if (!messageMatch) return null;
    if (req.method !== "POST") return answer({ error: "Use POST." }, 405);
    let body: Record<string, unknown>;
    try {
      const value = await req.json();
      body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
    } catch {
      throw new InboxError("validation_error", "body: expected a JSON object.");
    }
    if (checkServerSession(body, serverSession) === "mismatch") return answer(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (typeof body.session !== "string" || !body.session) {
      throw new InboxError("validation_error", "session: the live session to write to.", { field: "session" });
    }
    const threadId = messageMatch[1]!;
    const target = liveFor(threadId).sessions.find((candidate) => candidate.session === body.session) ?? null;
    const result = store.sendNewMessage(threadId, {
      body: body.body,
      idempotency_key: body.idempotency_key,
      to: target ? { host: target.host, session: target.session } : null,
      ...(byGuest ? { by_guest: true } : {}),
    });
    return answer({ message: result.message, replayed: result.replayed });
  };

  /**
   * Send now: the person's reply or message, delivered at once by its
   * session's connection (into the running turn when one runs). Refused when
   * that session's connection does not poll now or cannot deliver into a
   * running turn (`send_now_unavailable`), or once delivered.
   */
  const sendNow = (messageId: string, session: string | null = null) => {
    const message = store.message(messageId);
    if (!message) throw new InboxError("message_not_found", `No message ${messageId}.`);
    // A tagged session's own line (approval "inbox-tag-agents"): its own Send now.
    const tag = session && !store.isOwner(message, session) ? (message.tags?.find((t) => t.session === session) ?? null) : null;
    if (session && !tag && !store.isOwner(message, session)) throw new InboxError("not_addressed", "That session is not one this message goes to.");
    const delivery = tag ? tag.delivery : message.delivery;
    if (delivery) throw new InboxError("already_delivered", "That session already took this.", { delivery });
    const recipient = tag ? { host: tag.host, session: tag.session } : store.recipientOf(message);
    if (!recipient) throw new InboxError("not_addressed", "Only your reply or message to an agent session can be sent now.");
    const connection = connectionOf(recipient.session);
    if (!connection?.send_now) {
      throw new InboxError(
        "send_now_unavailable",
        connection ? "This agent's connection cannot take a message mid-turn; it gets it when its turn ends." : "That session is not connected now; it gets this when it is back.",
      );
    }
    return store.requestDeliverNow(messageId, tag ? tag.session : null);
  };

  /** When `session` last went idle, live or not; null when never seen idle (Tidy's "Nothing to change"). */
  const lastIdleOf = (session: string): number | null => sessions.get(session)?.lastIdleSince ?? null;

  /** When `session` was last heard at all: a poll, a state event or an MCP tool call; null when never (thread steps' presence). */
  const lastHeardOf = (session: string): number | null => {
    const polled = sessions.get(session)?.lastSeen ?? null;
    const called = mcpSeen.get(session)?.lastSeen ?? null;
    return polled === null ? called : called === null ? polled : Math.max(polled, called);
  };

  /**
   * Evidence that `session` ended (thread steps' presence): it polled in this run and no longer does, or the
   * Inbox wakes it itself and knows its thread is gone. A session never seen polling is never ended here,
   * whatever host it names: it may read the thread at any time (inbox-compose.md, "Replying when the asking
   * session has ended").
   */
  const endedOf = (session: string): boolean => {
    if (options.wakeOnlyStatus?.(session) === "dead") return true;
    const entry = sessions.get(session);
    return !!entry && entry.wakeOnly === undefined && !isLive(entry);
  };

  return {
    lastHeardOf,
    endedOf,
    pollStarted,
    stateChanged,
    seenWakeOnly,
    liveFor,
    askerLive,
    pendingOf,
    actingFor,
    /** The sessions `session` stands in for now (its conversation continues them, and they do not poll). */
    inheritedBy: continuations.inheritedBy,
    /** The live session standing in for `session` now, or null (the Agents list: one agent for one conversation). */
    continuedBy: continuations.heirOf,
    /** Every session id `session`'s conversation continues, nearest first. */
    continuesOf: continuations.lineOf,
    stuck,
    replyTarget,
    seenOverMcp,
    route,
    allLive,
    agentSessions,
    agentsSignature,
    /** The sessions' clock (ms): "today" for the Agents section is by it. */
    clock: now,
    isSessionLive,
    runStateOf,
    pollsNow,
    composeTarget,
    connectionOf,
    askHostOf,
    deliveryConnectionOf,
    lastIdleOf,
    steerableSessions,
    autoSendAfterMs,
    trackWaits,
    waitClockOf,
    waitOf,
    deliveredIntoTurn,
    deliverySignature,
    presenceSignature,
    steerHanded,
    steerDone,
    hostOf: (session: string): string | null => sessions.get(session)?.host ?? mcpSeen.get(session)?.host ?? null,
    hostSessions,
    reloadOfferFor,
    reloadAnswerFor,
    restartCount,
    restartAgents,
    mcpAgents,
    tagTargets,
    wakesTagged,
    labels,
    labelOf,
    labelVersion,
  };
}
