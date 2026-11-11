/** Ask AI's live answers: one pull bridge per agent session, with one slot per session holding the thread and the turn. */

import { createAIEndpoints } from "@plannotator/ai/endpoints";
import { ProviderRegistry } from "@plannotator/ai/provider";
import {
  SessionBridgeProvider,
  type SessionBridge,
  type SessionBridgeErrorCode,
  type SessionBridgeHost,
  type SessionBridgeSession,
} from "@plannotator/ai/session-bridge";
import { createPullSessionBridge, SESSION_BRIDGE_EVENT_PATH, SESSION_BRIDGE_POLL_PATH, type PullSessionBridge } from "@plannotator/ai/session-bridge-pull";
import { SessionManager } from "@plannotator/ai/session-manager";
import type { AIContext, AISession, CreateSessionOptions } from "@plannotator/ai/types";
import { INBOX_ASK_CUT_NOTE, INBOX_ASK_FILE_MAX, INBOX_ASK_TEXT_MAX, updateInboxAskTurn, type InboxAskTurn } from "@plannotator/shared/inbox/ask";
import { INBOX_ASK_BRIDGE_PREFIX } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";

export interface InboxAskTimes {
  connectWaitMs?: number;
  slotMs?: number;
  idleMs?: number;
  writeRetryMs?: number;
  /** Silence after which the host is gone (the bridge's 30 s). */
  goneAfterMs?: number;
  /** How long a host with a question may say `ready`, with no word of it, before the question counts as lost. */
  readyGraceMs?: number;
}

const WRITE_TRIES = 30;
const BRIDGE_HOSTS: ReadonlySet<string> = new Set(["pi", "opencode", "claude-code", "t3"]);
const HOST_PATH = new RegExp(`^${INBOX_ASK_BRIDGE_PREFIX}([^/]+)(${SESSION_BRIDGE_POLL_PATH}|${SESSION_BRIDGE_EVENT_PATH})$`);

interface Slot {
  threadId: string;
  turnId: string;
  query: SessionBridgeSession | null;
  timer: ReturnType<typeof setTimeout> | null;
  text: string | null;
  watch: ReturnType<typeof setInterval> | null;
  settled: boolean;
}

interface LiveBridge {
  session: string;
  providerId: string;
  pull: PullSessionBridge;
  slot: Slot | null;
  idle: ReturnType<typeof setTimeout> | null;
}

export interface InboxAskClaim {
  bridge: LiveBridge;
  slot: Slot;
}

export type InboxAskContext = AIContext & { turn: string };

const turnProvider = (bridge: LiveBridge, slot: Slot): string => `${bridge.providerId}#${slot.turnId}`;

class InboxAskProvider extends SessionBridgeProvider {
  private readonly slotHooks: { made(query: SessionBridgeSession, turn: string | undefined): void; take(query: SessionBridgeSession): boolean; ended(query: SessionBridgeSession): void };

  constructor(bridge: SessionBridge, slotHooks: InboxAskProvider["slotHooks"]) {
    super(bridge);
    this.slotHooks = slotHooks;
  }

  override async createSession(options: CreateSessionOptions): Promise<AISession> {
    const query = await super.createSession(options);
    this.slotHooks.made(query as SessionBridgeSession, (options.context as Partial<InboxAskContext>).turn);
    return query;
  }

  override claim(query: SessionBridgeSession): boolean {
    return this.slotHooks.take(query) && super.claim(query);
  }

  override release(query: SessionBridgeSession): void {
    super.release(query);
    this.slotHooks.ended(query);
  }
}

export function createInboxAskLive(options: {
  /** The Inbox's token: the connection gate's secret is the bridge's too, so no new one travels. */
  token: string;
  dir: string;
  hostOf: (session: string) => string | null;
  onChange: (threadId: string) => void;
  times?: InboxAskTimes;
}) {
  const { token, dir, hostOf, onChange } = options;
  const connectWaitMs = options.times?.connectWaitMs ?? 5_000;
  const slotMs = options.times?.slotMs ?? 30_000;
  const idleMs = options.times?.idleMs ?? 10 * 60_000;
  const writeRetryMs = options.times?.writeRetryMs ?? 1_000;
  const readyGraceMs = options.times?.readyGraceMs ?? 20_000;

  const bridges = new Map<string, LiveBridge>();
  const registry = new ProviderRegistry();
  const sessionManager = new SessionManager();
  const waitListeners = new Set<(session: string) => void>();
  let stopped = false;

  // The gate on every /api/ai path is the ask routes' own (inbox-ask.ts).
  const endpoints = createAIEndpoints({ registry, sessionManager, authorizeSessionBridgeRequest: () => true, keepRunningOnDisconnect: true });

  const write = (slot: Slot, patch: Partial<InboxAskTurn>, tries = 0): void => {
    try {
      if (updateInboxAskTurn(dir, slot.threadId, slot.turnId, patch)) onChange(slot.threadId);
    } catch (error) {
      // A passing read or disk failure must not cost the answer, and a damaged file cannot take it.
      const damaged = error instanceof InboxError && error.code === "ask_damaged";
      if (damaged || stopped || tries + 1 >= WRITE_TRIES) {
        process.stderr.write(`Inbox: an Ask AI answer for ${slot.threadId} was not saved: ${error instanceof Error ? error.message : String(error)}\n`);
        return;
      }
      const timer = setTimeout(() => write(slot, patch, tries + 1), writeRetryMs);
      (timer as { unref?: () => void }).unref?.();
    }
  };

  /** How the question ended. A failure with no words writes nothing: the turn reads as no answer arrived. */
  const settle = (slot: Slot, code: SessionBridgeErrorCode | null, finalAnswer?: string): void => {
    if (slot.settled) return;
    slot.settled = true;
    if (slot.watch) clearInterval(slot.watch);
    const text = finalAnswer || slot.text || "";
    const answer = text.length > INBOX_ASK_TEXT_MAX ? `${text.slice(0, INBOX_ASK_TEXT_MAX)}${INBOX_ASK_CUT_NOTE}` : text;
    const words: Partial<InboxAskTurn> = answer ? { answer, answered_at: new Date().toISOString() } : {};
    if (code === "aborted") write(slot, { ...words, stopped: true });
    else if (answer) write(slot, { ...words, ...(code ? { failure: code === "gone" || code === "taken_over" ? code : "failed" } : {}) });
  };

  const free = (bridge: LiveBridge, slot: Slot): void => {
    if (bridge.slot !== slot) return;
    bridge.slot = null;
    if (slot.timer) clearTimeout(slot.timer);
    // The question reached the host and no end came: only an abort leaves one, and the bridge may never say so.
    if (slot.text !== null) settle(slot, "aborted");
    if (!stopped && bridges.get(bridge.session) === bridge) {
      bridge.idle = setTimeout(() => close(bridge), idleMs);
      (bridge.idle as { unref?: () => void }).unref?.();
    }
    onChange(slot.threadId);
  };

  const close = (bridge: LiveBridge): void => {
    if (bridge.idle) clearTimeout(bridge.idle);
    bridge.idle = null;
    if (bridges.get(bridge.session) === bridge) bridges.delete(bridge.session);
    bridge.pull.dispose();
    registry.dispose(bridge.providerId);
  };

  const makeBridge = (session: string, host: SessionBridgeHost): LiveBridge => {
    const pull = createPullSessionBridge({
      token,
      host,
      modes: { turn: true, transient: false },
      // A `done` repeats the answer beside its last words, and JSON can double both: an answer at its limit has to arrive.
      maxBodyChars: INBOX_ASK_FILE_MAX,
      ...(options.times?.goneAfterMs !== undefined ? { goneAfterMs: options.times.goneAfterMs } : {}),
    });
    const live: LiveBridge = { session, providerId: `inbox-ask:${session}`, pull, slot: null, idle: null };
    /** The turn each AI session was made for: a late window's query can't answer a later turn. */
    const madeFor = new WeakMap<SessionBridgeSession, string>();
    const inner = pull.bridge;
    const wrapped: SessionBridge = {
      host: inner.host,
      modes: inner.modes,
      status: () => inner.status(),
      interrupt: () => inner.interrupt!(),
      get interruptible() {
        return inner.interruptible;
      },
      detach: () => inner.detach?.(),
      ask(request, sink, signal) {
        const slot = live.slot;
        if (!slot) {
          sink.error("gone");
          return;
        }
        slot.text = "";
        // Stops the host's side: the person's Stop, or a lost end, which has to clear the bridge too.
        const stopHost = new AbortController();
        signal.addEventListener("abort", () => stopHost.abort(), { once: true });
        let heardAt = Date.now();
        slot.watch = setInterval(() => {
          if (inner.status() !== "ready") heardAt = Date.now();
          if (Date.now() - heardAt < readyGraceMs) return;
          settle(slot, "gone");
          sink.error("gone");
          stopHost.abort();
        }, Math.min(1_000, readyGraceMs / 4));
        (slot.watch as { unref?: () => void }).unref?.();
        inner.ask(
          request,
          {
            delta(text) {
              heardAt = Date.now();
              // One past the limit is what marks an answer as cut.
              if (slot.text!.length <= INBOX_ASK_TEXT_MAX) slot.text += text;
              sink.delta(text);
            },
            tool(name) {
              heardAt = Date.now();
              sink.tool?.(name);
            },
            done(answer) {
              settle(slot, null, answer);
              sink.done(answer);
            },
            error(code, message) {
              settle(slot, code);
              sink.error(code, message);
            },
          },
          stopHost.signal,
        );
      },
    };
    const provider = new InboxAskProvider(wrapped, {
      made(query, turn) {
        if (turn) madeFor.set(query, turn);
      },
      // A query needs a turn to answer: POST /ask made one, this session was made for it, and it is not taken.
      take(query) {
        const slot = live.slot;
        if (!slot || madeFor.get(query) !== slot.turnId || (slot.query && slot.query !== query)) return false;
        slot.query = query;
        if (slot.timer) clearTimeout(slot.timer);
        slot.timer = null;
        return true;
      },
      ended(query) {
        if (live.slot?.query === query) free(live, live.slot);
      },
    });
    registry.register(provider, live.providerId);
    bridges.set(session, live);
    return live;
  };

  const slotOf = (threadId: string): { bridge: LiveBridge; slot: Slot } | null => {
    for (const bridge of bridges.values()) {
      if (bridge.slot?.threadId === threadId) return { bridge, slot: bridge.slot };
    }
    return null;
  };

  /** A thread runs one turn at a time, whoever owns it. */
  const claim = (turn: { threadId: string; turnId: string; session: string }): InboxAskClaim => {
    const held = slotOf(turn.threadId);
    const existing = bridges.get(turn.session);
    const sameTurn = held?.slot.turnId === turn.turnId;
    if (sameTurn && (held.slot.query || held.bridge === existing)) return held;
    if ((held && !sameTurn) || existing?.slot) throw new InboxError("ask_busy", "This agent is answering another question. Ask again when it finishes.");
    if (held) free(held.bridge, held.slot);
    const host = hostOf(turn.session);
    if (!host || !BRIDGE_HOSTS.has(host)) throw new InboxError("ask_no_live_path", "This agent can't answer live.");
    if (existing && existing.pull.bridge.status() === "gone") close(existing);
    const bridge = bridges.get(turn.session) ?? makeBridge(turn.session, host as SessionBridgeHost);
    if (bridge.idle) clearTimeout(bridge.idle);
    bridge.idle = null;
    const slot: Slot = { threadId: turn.threadId, turnId: turn.turnId, query: null, timer: null, text: null, watch: null, settled: false };
    bridge.slot = slot;
    slot.timer = setTimeout(() => free(bridge, slot), slotMs);
    (slot.timer as { unref?: () => void }).unref?.();
    if (!bridge.pull.connected) for (const listener of waitListeners) listener(turn.session);
    return { bridge, slot };
  };

  const waits = (session: string): boolean => {
    const bridge = bridges.get(session);
    return !!bridge?.slot && !bridge.pull.connected;
  };

  const connected = async ({ bridge, slot }: InboxAskClaim): Promise<boolean> => {
    const deadline = Date.now() + connectWaitMs;
    while (!bridge.pull.connected && bridge.slot === slot && Date.now() < deadline) await Bun.sleep(25);
    if (bridge.pull.connected && bridge.slot === slot) return true;
    free(bridge, slot);
    return false;
  };

  const heldBy = (providerId: unknown): InboxAskClaim | null => {
    for (const bridge of bridges.values()) {
      if (bridge.slot && turnProvider(bridge, bridge.slot) === providerId) return { bridge, slot: bridge.slot };
    }
    return null;
  };

  const stopThread = (threadId: string): void => {
    const held = slotOf(threadId);
    if (!held) return;
    if (held.slot.query) held.slot.query.abort();
    else free(held.bridge, held.slot);
  };

  const hostRoute = async (req: Request, url: URL): Promise<Response> => {
    const match = HOST_PATH.exec(url.pathname);
    let session: string | null = null;
    try {
      session = match ? decodeURIComponent(match[1]!) : null;
    } catch {
      // Not a session a bridge was made for.
    }
    const bridge = session === null ? undefined : bridges.get(session);
    if (!match || !bridge) throw new InboxError("ask_no_bridge", "No question has asked for this session.");
    // The bridge knows only its own two paths. The signal goes along: it is how a dropped client ends its poll.
    const inner = new Request(new URL(match[2]!, url), {
      method: req.method,
      headers: req.headers,
      signal: req.signal,
      ...(req.method === "POST" ? { body: await req.text() } : {}),
    });
    return (await bridge.pull.handle(inner)) ?? new Response(null, { status: 404 });
  };

  const stop = (): void => {
    stopped = true;
    for (const bridge of [...bridges.values()]) {
      if (bridge.slot && !bridge.slot.query) free(bridge, bridge.slot);
      close(bridge);
    }
    sessionManager.disposeAll();
    registry.disposeAll();
  };

  return {
    endpoints,
    claim,
    free: ({ bridge, slot }: InboxAskClaim) => free(bridge, slot),
    connected,
    heldBy,
    providerOf: ({ bridge, slot }: InboxAskClaim): string => turnProvider(bridge, slot),
    canAnswer: (session: string): boolean => BRIDGE_HOSTS.has(hostOf(session) ?? ""),
    waits,
    onWaits(listener: (session: string) => void): () => void {
      waitListeners.add(listener);
      return () => waitListeners.delete(listener);
    },
    running: (threadId: string): string | null => slotOf(threadId)?.slot.turnId ?? null,
    answering: ({ slot }: InboxAskClaim): boolean => slot.query !== null,
    stopThread,
    sweep(threadExists: (threadId: string) => boolean): void {
      for (const bridge of [...bridges.values()]) {
        if (bridge.slot && !threadExists(bridge.slot.threadId)) stopThread(bridge.slot.threadId);
      }
    },
    hostRoute,
    stop,
  };
}
