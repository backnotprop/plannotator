/**
 * The Codex wake: the person's reply, message or tag for a Codex thread goes
 * into that thread as a new turn, through `codex queue` (Codex CLI 0.149+).
 *
 * Codex has no Plannotator plugin to poll the Inbox, so the Inbox delivers
 * itself. A Codex session is learned from its MCP calls: the stdio shim
 * (`plannotator inbox mcp`) sends as `agent_host: "codex"`, `agent_session:
 * <thread id>` (Codex names its thread on every tool call,
 * `params._meta.threadId`), and the message is marked `wakes` when the call
 * comes from a thread that keeps running (its turn metadata's `turn_trigger`
 * is not `exec`: a `codex exec` run exits after its turn, so its agent keeps
 * wait_for_reply) and this Inbox can run a Codex CLI that queues
 * (packages/server/inbox-mcp.ts). Then each item waiting for that session
 * (`InboxStore.pendingRepliesFor`) is handed to
 * `codex queue --thread=<id> --message=<the wake text>` exactly once:
 *
 *  - an idle thread starts the turn within about a second, a busy one gets it
 *    as its next turn when the current one ends (never mid-turn), and a
 *    thread whose Codex is closed runs it when it is resumed (or headless,
 *    within a minute, while Codex's background server still holds it);
 *  - every call adds an item to Codex's queue, so each item is claimed once,
 *    on disk (`inbox/codex-queue/<item id>.<thread id>/`, made with mkdir
 *    before the call), and never queued twice, across restarts too;
 *  - exit 0 means queued, not delivered: the item is "Delivered" once the
 *    thread calls an Inbox tool from a turn that started after it was queued
 *    (`x-codex-turn-metadata.turn_started_at_unix_ms`), or when the agent
 *    reads it (wait_for_reply, read_thread). A turn that starts while the
 *    call still runs counts, once the call exits 0. Until then the window says
 *    "Queued for Codex; it gets this as its next turn.";
 *  - a call that ran out of time (or that the Inbox's stop cut short) may or
 *    may not have queued: it is kept claimed (never sent twice), never marked
 *    delivered by a turn, and the window says "Saved for Codex. It sees it
 *    when it next reads this thread.";
 *  - a thread Codex does not know (exit 1, "no rollout found") is ended: the
 *    reply is saved for the next agent, and the session is alive again the
 *    next time it calls the Inbox;
 *  - any other failure is tried again later (30 s, doubling to 10 min). With
 *    no Codex CLI found at all, nothing is retried on a timer: the reply waits
 *    for the next look (any person's item, a Codex thread's next message, a
 *    thread coming back, an Inbox restart).
 *
 * The text goes to `codex queue` as an argument, so while the call runs (a
 * few hundred milliseconds) it can be read in the process list (`ps`) by
 * other processes of this user and, on a shared machine, by anyone who can
 * list processes.
 *
 * A sweep is one pass over the person's messages (bucketed by recipient), and
 * runs only when it can find something: a store line, a retry coming due, a
 * thread coming back, a wait_for_reply ending, and once at start. No Send now
 * and no going in by itself after five minutes: Codex never takes a message
 * mid-turn.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { INBOX_CODEX_HOST, codexCallWakes, codexCliQueues, isCodexThreadId, parseCodexCliVersion, type InboxMessage } from "@plannotator/core/inbox-types";
import { INBOX_TOOL_NAME, inboxWakeText, type InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { INBOX_BOARD_REQUEST_CLOSE, INBOX_BOARD_REQUEST_OPEN } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { AgentEnvironment } from "./inbox-agents";

/** The ChatGPT desktop app's own Codex CLI (macOS), used when no `codex` is on PATH. */
export const INBOX_CODEX_DESKTOP_CLI = "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
/** The Codex app's own Codex CLI (macOS). */
export const INBOX_CODEX_APP_CLI = "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex";

/** One `codex queue` may take this long. */
export const INBOX_CODEX_QUEUE_TIMEOUT_MS = 30_000;

/**
 * The longest message text handed to `codex queue`, in bytes: one argument on
 * Linux may not pass 128 KiB (MAX_ARG_STRLEN). A longer reply goes cut, with
 * a line saying where the rest is.
 */
export const INBOX_CODEX_MESSAGE_MAX_BYTES = 100_000;

/** The folder of claims under `inbox/`. */
const QUEUE_DIR = "codex-queue";
const DEAD_DIR = "dead";
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const CLI_FOUND_TTL_MS = 5 * 60_000;
const CLI_MISSING_TTL_MS = 60_000;

/** What `codex queue` says for a thread it does not have (0.160: "no rollout found …"; a name: "No active session found …"). */
const UNKNOWN_THREAD = /no rollout found|no active session|thread not found|unknown thread|no such (thread|session)/i;

export interface InboxCodexCli {
  path: string;
  version: string;
}

export interface InboxCodexWake {
  /** The Codex CLI this Inbox would queue with (null: none that queues). Probed once a few minutes. */
  cli(): Promise<InboxCodexCli | null>;
  /** The last probe's answer, without waiting (null before the first one finished). */
  knownCli(): InboxCodexCli | null;
  /**
   * Whether a message from this host and session, sent by a tool call with
   * this `_meta`, wakes it: a Codex thread id, the call from that thread and
   * not from `codex exec`, and a Codex CLI that queues.
   */
  wakes(host: unknown, session: unknown, meta: unknown): Promise<boolean>;
  /**
   * How a session stands for the presence rules: `alive` (a Codex session the
   * Inbox wakes), `dead` (Codex did not know its thread), null (not a Codex
   * session the Inbox wakes).
   */
  status(session: string): "alive" | "dead" | null;
  /**
   * The thread called an Inbox tool, from a turn that started at `turnStartedAt`
   * (ms; null when the call does not say): it is there, and what was queued
   * before that turn started has reached it.
   */
  noteToolCall(session: string, turnStartedAt: number | null): void;
  /**
   * Whether `codex queue` may or may not have queued this item for this
   * session (the call ran out of time, or the Inbox stopped while it ran):
   * the window says it is saved for the agent's next read, not queued.
   */
  uncertain(session: string, itemId: string): boolean;
  /** The items of `session` that are uncertain (see `uncertain`). */
  uncertainItems(session: string): string[];
  /** Look for items to queue now (the Inbox runs it on every store line, a retry coming due, a wait ending). */
  sweep(): Promise<void>;
  stop(): void;
}

/** The text a body is put in for, so the tool names are named only outside the person's words. */
const BODY_SLOT = "\u0000PLANNOTATOR_BODY\u0000";

/**
 * The wake text as Codex reads it: `inboxWakeText`, with the tools named as
 * Codex lists them (`send_message`, `read_thread` of the plannotator-inbox
 * MCP server, not the `plannotator_inbox` tool of Plannotator's own
 * connections). The person's words are never touched.
 */
export function codexWakeText(command: InboxReplyCommand): string {
  const template = inboxWakeText({ ...command, body: BODY_SLOT }).split(`${INBOX_TOOL_NAME} `).join("");
  return template.replace(BODY_SLOT, () => command.body);
}

/** The wake text, cut to INBOX_CODEX_MESSAGE_MAX_BYTES with a pointer to the thread when the reply is longer. */
export function codexQueueMessage(command: InboxReplyCommand): string {
  const clean = (text: string) => text.replace(/\u0000/g, "");
  const whole = clean(command.body);
  const full = codexWakeText({ ...command, body: whole });
  if (Buffer.byteLength(full) <= INBOX_CODEX_MESSAGE_MAX_BYTES) return full;
  // The Board request (compose's chip) ends the body: only the words before it are cut, and it stays whole after the note.
  const at = whole.lastIndexOf(`\n\n${INBOX_BOARD_REQUEST_OPEN}\n`);
  const tail = at >= 0 && whole.endsWith(INBOX_BOARD_REQUEST_CLOSE) ? whole.slice(at) : "";
  const body = tail ? whole.slice(0, at) : whole;
  const note = `\n\n[Cut here: the rest is in the Inbox. read_thread with message_id ${command.id} shows it whole.]${tail}`;
  const overhead = Buffer.byteLength(codexWakeText({ ...command, body: note }));
  const room = Math.max(0, INBOX_CODEX_MESSAGE_MAX_BYTES - overhead - 16);
  // Cut on a character, never inside one.
  const bytes = Buffer.from(body);
  let cut = body;
  if (bytes.length > room) {
    let end = room;
    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
    cut = bytes.subarray(0, end).toString("utf8");
  }
  return codexWakeText({ ...command, body: `${cut}${note}` });
}

export function createInboxCodexWake(options: {
  store: InboxStore;
  environment: AgentEnvironment;
  /** The wake command for an item and the session it goes to (the bridge's `replyCommand`). */
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand;
  /** The session holds a wait_for_reply open now that returns items of this thread: those are not queued as well. */
  waitingOverMcp?: (session: string, threadId: string) => boolean;
  /** Where to look for a Codex CLI besides PATH. Default: the ChatGPT and Codex apps' own (macOS), never under the test sandbox. */
  extraClis?: readonly string[];
  now?: () => number;
  /** How long one `codex queue` may take. Default INBOX_CODEX_QUEUE_TIMEOUT_MS; tests shorten it. */
  queueTimeoutMs?: number;
  log?: (line: string) => void;
}): InboxCodexWake {
  const { store, environment } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const dir = join(store.dir, QUEUE_DIR);
  const deadDir = join(dir, DEAD_DIR);
  const stopping = new AbortController();

  const extraClis =
    options.extraClis ??
    (environment.platform === "darwin"
      ? [
          ...(process.env.PLANNOTATOR_TEST_SANDBOX ? [] : [INBOX_CODEX_DESKTOP_CLI, INBOX_CODEX_APP_CLI]),
          join(environment.homeDir, "Applications", "ChatGPT.app", "Contents", "Resources", "codex-cli", "CodexCLI.app", "Contents", "MacOS", "codex"),
          join(environment.homeDir, "Applications", "Codex.app", "Contents", "Resources", "codex-cli", "bin", "codex"),
        ]
      : []);

  // ── The CLI ──
  let cliAnswer: { cli: InboxCodexCli | null; at: number } | null = null;
  let cliProbe: Promise<InboxCodexCli | null> | null = null;
  const probe = async (): Promise<InboxCodexCli | null> => {
    // Only absolute paths: a relative PATH entry would name another file wherever the Inbox runs. The `codex` on
    // PATH is the one the person uses: when there is one, an app's own CLI is never tried instead.
    const onPath = environment.which("codex");
    const first = onPath && isAbsolute(onPath) ? [onPath] : [];
    const candidates = (first.length > 0 ? first : extraClis).filter((path) => isAbsolute(path) && existsSync(path));
    for (const path of [...new Set(candidates)]) {
      const run = await environment.run([path, "--version"], { timeoutMs: 10_000, signal: stopping.signal });
      const version = parseCodexCliVersion(run.stdout);
      if (run.exitCode === 0 && codexCliQueues(version)) return { path, version: version!.join(".") };
    }
    return null;
  };
  const cli = (): Promise<InboxCodexCli | null> => {
    if (cliAnswer && now() - cliAnswer.at < (cliAnswer.cli ? CLI_FOUND_TTL_MS : CLI_MISSING_TTL_MS)) return Promise.resolve(cliAnswer.cli);
    cliProbe ??= probe()
      .catch(() => null)
      .then((found) => {
        cliAnswer = { cli: found, at: now() };
        return found;
      })
      .finally(() => {
        cliProbe = null;
      });
    return cliProbe;
  };

  // ── The sessions it wakes, and the ones Codex did not know ──
  let known: Set<string> | null = null;
  const knownSessions = (): Set<string> => (known ??= store.wakingSessionsOfHost(INBOX_CODEX_HOST));
  const dead = new Set<string>();
  try {
    for (const session of readdirSync(deadDir)) if (isCodexThreadId(session)) dead.add(session);
  } catch {
    // None yet.
  }

  // ── Claims: one folder per item and session, made before the call ──
  const claimDir = (itemId: string, session: string) => join(dir, `${itemId}.${session}`);
  /** What was queued and not yet seen delivered, per session: item id -> when it was queued (ms). */
  const queued = new Map<string, Map<string, number>>();
  /** Calls running now, by claim key: when it was queued (ms), and whether a turn already took it (recorded on exit 0). */
  const inFlight = new Map<string, { at: number; session: string; itemId: string; taken: boolean }>();
  const claimed = new Set<string>();
  /**
   * Claims whose call may or may not have queued: it ran out of time, or the
   * Inbox stopped while it ran. Never sent again (no double send), never
   * marked delivered by a turn (the call may never have queued): the window
   * says the reply is saved for the agent's next read.
   */
  const uncertain = new Set<string>();
  try {
    for (const name of readdirSync(dir)) {
      const dot = name.indexOf(".");
      if (dot <= 0) continue;
      const itemId = name.slice(0, dot);
      const session = name.slice(dot + 1);
      if (!isCodexThreadId(session)) continue;
      claimed.add(name);
      try {
        const record = JSON.parse(readFileSync(join(dir, name, "queued.json"), "utf8")) as { at?: unknown; timed_out?: unknown };
        if (typeof record.at === "number" && record.timed_out !== true) (queued.get(session) ?? queued.set(session, new Map()).get(session)!).set(itemId, record.at);
        else uncertain.add(name);
      } catch {
        // Claimed and never finished (the Inbox stopped mid-call): never queued again, and not known to have gone.
        uncertain.add(name);
      }
    }
  } catch {
    // No claims yet.
  }
  const dropClaim = (itemId: string, session: string) => {
    claimed.delete(`${itemId}.${session}`);
    uncertain.delete(`${itemId}.${session}`);
    queued.get(session)?.delete(itemId);
    rmSync(claimDir(itemId, session), { recursive: true, force: true });
  };
  const delivered = (itemId: string, session: string) => {
    try {
      store.recordDelivery(itemId, { host: INBOX_CODEX_HOST, session });
    } catch {
      // Gone, or no longer this session's.
    }
    dropClaim(itemId, session);
  };

  /** Whether the item goes to `session` through a wake: its owner's message woke, it is addressed to it, or a waking tag. */
  const wakesItem = (item: InboxMessage, session: string): boolean => {
    if (!store.isOwner(item, session)) return item.tags?.some((tag) => tag.session === session && tag.host === INBOX_CODEX_HOST && tag.wakes) ?? false;
    if (item.to) return item.to.host === INBOX_CODEX_HOST;
    const asked = item.reply_to ? store.message(item.reply_to) : null;
    return asked?.author.kind === "agent" && asked.author.host === INBOX_CODEX_HOST && asked.wakes === true;
  };

  const retryAt = new Map<string, { at: number; wait: number }>();
  const failuresSaid = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** A sweep when the earliest retry comes due (never a timer that runs while nothing waits). */
  const scheduleRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (retryAt.size === 0 || stopping.signal.aborted) return;
    const next = Math.min(...[...retryAt.values()].map((retry) => retry.at));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void sweep();
    }, Math.max(0, next - now()) + 10);
    (retryTimer as { unref?: () => void }).unref?.();
  };

  const queueOne = async (path: string, item: InboxMessage, session: string): Promise<void> => {
    const key = `${item.id}.${session}`;
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return;
    try {
      mkdirSync(dir, { recursive: true });
      mkdirSync(claimDir(item.id, session));
    } catch {
      // Claimed already (another sweep, or before a restart).
      claimed.add(key);
      return;
    }
    claimed.add(key);
    const text = codexQueueMessage(options.commandOf(item, session));
    const at = now();
    // An idle thread starts its turn while `codex queue` still runs; that turn's tool call is kept until the call exits 0.
    const flight = { at, session, itemId: item.id, taken: false };
    inFlight.set(key, flight);
    // `--name=value`: a value that starts with "-" would be read as a flag.
    const run = await environment.run([path, "queue", `--thread=${session}`, `--message=${text}`], { timeoutMs: options.queueTimeoutMs ?? INBOX_CODEX_QUEUE_TIMEOUT_MS, signal: stopping.signal });
    inFlight.delete(key);
    if (stopping.signal.aborted && run.exitCode !== 0) {
      // Stopped mid-call: it may have queued, so it stays claimed (no queued.json: uncertain after a restart).
      uncertain.add(key);
      return;
    }
    if (run.timedOut) {
      // It may or may not have queued: kept claimed (never twice) and uncertain (never marked delivered by a turn).
      retryAt.delete(key);
      log(`codex queue ran out of time for ${item.id} (thread ${session}); it may not have gone, and is not sent again: the agent sees it when it reads the thread.`);
      if (!claimed.has(key)) return;
      uncertain.add(key);
      writeFileSync(join(claimDir(item.id, session), "queued.json"), `${JSON.stringify({ at, timed_out: true })}\n`);
      return;
    }
    if (run.exitCode === 0) {
      retryAt.delete(key);
      if (!claimed.has(key)) return;
      if (flight.taken) {
        delivered(item.id, session);
        return;
      }
      writeFileSync(join(claimDir(item.id, session), "queued.json"), `${JSON.stringify({ at })}\n`);
      (queued.get(session) ?? queued.set(session, new Map()).get(session)!).set(item.id, at);
      return;
    }
    dropClaim(item.id, session);
    const said = `${run.stderr}${run.stdout}`.trim().split("\n")[0]?.slice(0, 300) ?? "";
    if (run.exitCode === 1 && UNKNOWN_THREAD.test(`${run.stderr}\n${run.stdout}`)) {
      dead.add(session);
      try {
        mkdirSync(deadDir, { recursive: true });
        writeFileSync(join(deadDir, session), `${JSON.stringify({ at: new Date(at).toISOString(), said })}\n`);
      } catch {
        // Kept in memory.
      }
      log(`Codex does not know thread ${session} (${said}); the reply waits in the Inbox for the next agent.`);
      return;
    }
    const wait = Math.min((retry?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
    const line = `codex queue failed (exit ${run.exitCode}): ${said}`;
    if (!failuresSaid.has(line)) {
      failuresSaid.add(line);
      log(`${line}. Trying again later.`);
    }
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
  const sweepOnce = async (): Promise<void> => {
    const sessions = knownSessions();
    if (sessions.size === 0 && claimed.size === 0) return;
    // One pass over the messages, bucketed by recipient (dead sessions included, for their claims).
    const pending = store.pendingRepliesFor(sessions, { tags: true });
    const pendingKeys = new Set<string>();
    const work: { item: InboxMessage; session: string }[] = [];
    for (const [session, items] of pending) {
      for (const item of items) {
        if (!wakesItem(item, session)) continue;
        const key = `${item.id}.${session}`;
        pendingKeys.add(key);
        if (dead.has(session) || claimed.has(key)) continue;
        // An open wait_for_reply returns it: it is not queued as a turn as well.
        if (options.waitingOverMcp?.(session, item.thread_id)) continue;
        work.push({ item, session });
      }
    }
    // A claim whose item no longer waits (delivered, read, deleted) is done with; one in flight is kept.
    for (const key of [...claimed]) {
      if (pendingKeys.has(key) || inFlight.has(key)) continue;
      const dot = key.indexOf(".");
      dropClaim(key.slice(0, dot), key.slice(dot + 1));
    }
    for (const key of [...retryAt.keys()]) if (!pendingKeys.has(key)) retryAt.delete(key);
    if (work.length > 0) {
      const found = await cli();
      if (found) {
        for (const { item, session } of work) {
          if (stopping.signal.aborted) return;
          await queueOne(found.path, item, session);
        }
      }
    }
    scheduleRetry();
  };
  const sweep = (): Promise<void> => {
    if (stopping.signal.aborted) return Promise.resolve();
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      try {
        do {
          again = false;
          await sweepOnce();
        } while (again && !stopping.signal.aborted);
      } catch (error) {
        log(`the Codex wake could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  };

  // A person's item, or a Codex message that wakes, is looked at at once (one pass, after the line lands).
  let sweepQueued = false;
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message") return;
    const message = line.record as InboxMessage;
    if (message.author.kind === "agent") {
      // A Codex message that wakes: also a moment to look again (a reply that waited for a Codex CLI to appear).
      if (message.wakes !== true || message.author.host !== INBOX_CODEX_HOST || !message.author.session) return;
      knownSessions().add(message.author.session);
    } else {
      if (message.to?.host === INBOX_CODEX_HOST) knownSessions().add(message.to.session);
      for (const tag of message.tags ?? []) if (tag.host === INBOX_CODEX_HOST && tag.wakes) knownSessions().add(tag.session);
    }
    if (knownSessions().size === 0 || sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => {
      sweepQueued = false;
      void sweep();
    }, 0);
  });
  // The first look: items left from before a restart. The CLI is probed only when something waits.
  void sweep();

  const noteToolCall = (session: string, turnStartedAt: number | null) => {
    if (!isCodexThreadId(session)) return;
    if (dead.delete(session)) {
      rmSync(join(deadDir, session), { force: true });
      void sweep();
    }
    if (turnStartedAt === null) return;
    for (const flight of inFlight.values()) if (flight.session === session && flight.at < turnStartedAt) flight.taken = true;
    const items = queued.get(session);
    if (!items) return;
    for (const [itemId, at] of [...items]) if (at < turnStartedAt) delivered(itemId, session);
  };

  return {
    cli,
    knownCli: () => cliAnswer?.cli ?? null,
    wakes: async (host, session, meta) => host === INBOX_CODEX_HOST && isCodexThreadId(session) && codexCallWakes(meta, session) && (await cli()) !== null,
    status: (session) => (!knownSessions().has(session) ? null : dead.has(session) ? "dead" : "alive"),
    uncertain: (session, itemId) => uncertain.has(`${itemId}.${session}`),
    uncertainItems: (session) => [...uncertain].filter((key) => key.endsWith(`.${session}`)).map((key) => key.slice(0, key.indexOf("."))),
    noteToolCall,
    sweep,
    stop: () => {
      stopping.abort();
      if (retryTimer) clearTimeout(retryTimer);
      unsubscribe();
    },
  };
}
