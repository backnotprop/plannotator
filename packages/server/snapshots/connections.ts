/**
 * Agent sessions connected to the Plannotator Snapshots hub.
 *
 * A session host (the Claude Code mod, `plannotator snapshot --wait`, later
 * Pi and OpenCode) dials OUT to the hub, says hello, and then long-polls its
 * own pull bridge (packages/ai/session-bridge-pull.ts) at
 * `/api/connections/:id/poll`. Over that one link the hub sends
 *  - the existing Ask commands (`ask` / `cancel` / `interrupt`), so "Ask this
 *    session" from the HUD is a real turn of that session, and
 *  - `deliver`: a send, re-sent every 5 s until the host takes it
 *    (`deliver_accepted`), then not again: the host claims it once across its
 *    processes and reports `delivered`. A hello (the session's process
 *    changed, or the link came back) hands every unfinished send out again;
 *    the host's claim keeps that from being a second turn.
 *
 * A connection is identified by (host, session id). `/clear` in Claude Code
 * starts a new session id in the same process: the host's hello names the id
 * it replaces, and the old connection records its successor, so a send latched
 * to the cleared session is never re-routed silently (the HUD asks).
 */

import {
  createPullSessionBridge,
  SESSION_BRIDGE_EVENT_PATH,
  SESSION_BRIDGE_POLL_PATH,
  SessionBridgeProvider,
  type PullSessionBridge,
  type SessionBridgeHost,
} from "@plannotator/ai";
import type { PendingSend } from "@plannotator/shared/snapshots/store";
import type { ConnectionHost, ConnectionView } from "@plannotator/shared/snapshots/types";

/** Resend an unacknowledged `deliver` after this long. */
const DELIVER_RESEND_MS = 5_000;
/** A connection gone this long is forgotten. */
const FORGET_GONE_MS = 10 * 60_000;

export const SNAPSHOTS_ASK_SURFACE = "Surface: Plannotator Snapshots (the user is collecting snapshots of their screen to send you)";

const HOSTS: ReadonlySet<string> = new Set(["claude-code", "pi", "opencode", "cli-wait"]);

export interface HelloBody {
  host: ConnectionHost;
  sessionId: string;
  processId: string;
  cwd: string;
  project: string;
  title: string;
  lastHumanInputAt: number;
  /** The session id this one replaces in the same process (`/clear`). */
  replaces?: string;
  ask: { turn: boolean; transient: boolean };
}

export function parseHello(body: unknown): HelloBody | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const str = (v: unknown, max = 4096) => (typeof v === "string" ? v.slice(0, max) : "");
  if (typeof b.host !== "string" || !HOSTS.has(b.host)) return null;
  const sessionId = str(b.sessionId, 200);
  if (!sessionId) return null;
  const ask = b.capabilities && typeof b.capabilities === "object" ? (b.capabilities as Record<string, unknown>).ask : undefined;
  const askRecord = ask && typeof ask === "object" ? (ask as Record<string, unknown>) : {};
  return {
    host: b.host as ConnectionHost,
    sessionId,
    processId: str(b.processId, 200),
    cwd: str(b.cwd),
    project: str(b.project, 200),
    title: str(b.title, 200),
    lastHumanInputAt: typeof b.lastHumanInputAt === "number" ? b.lastHumanInputAt : 0,
    ...(typeof b.replaces === "string" && b.replaces ? { replaces: b.replaces.slice(0, 200) } : {}),
    ask: { turn: askRecord.turn === true, transient: askRecord.transient === true },
  };
}

interface Delivery {
  send: PendingSend;
  sentAt: number;
  accepted: boolean;
}

export interface DeliveryEvent {
  type: "accepted" | "delivered" | "failed";
  sendId: string;
  queued?: boolean;
  reason?: string;
}

export class Connection {
  readonly id: string;
  readonly host: ConnectionHost;
  readonly sessionId: string;
  processId: string;
  cwd: string;
  project: string;
  title: string;
  lastHumanInputAt: number;
  ask: { turn: boolean; transient: boolean };
  successorSessionId: string | undefined;
  goneSince: number | null = null;
  disposed = false;
  readonly pull: PullSessionBridge;
  private provider: SessionBridgeProvider | null = null;
  private deliveries = new Map<string, Delivery>();

  constructor(id: string, hello: HelloBody, token: string, onDelivery: (connection: Connection, event: DeliveryEvent) => void, now?: () => number) {
    this.id = id;
    this.host = hello.host;
    this.sessionId = hello.sessionId;
    this.processId = hello.processId;
    this.cwd = hello.cwd;
    this.project = hello.project;
    this.title = hello.title;
    this.lastHumanInputAt = hello.lastHumanInputAt;
    this.ask = hello.ask;
    this.pull = createPullSessionBridge({
      token,
      // A waiting command never answers questions; the bridge host only labels Ask.
      host: (hello.host === "cli-wait" ? "claude-code" : hello.host) as SessionBridgeHost,
      modes: hello.ask,
      ...(now ? { now } : {}),
      extraCommands: (now) => {
        const due: Array<{ type: string } & Record<string, unknown>> = [];
        for (const delivery of this.deliveries.values()) {
          // Taken: the host delivers it (or says it failed); re-sending would only race it.
          if (delivery.accepted) continue;
          if (delivery.sentAt !== 0 && now - delivery.sentAt < DELIVER_RESEND_MS) continue;
          delivery.sentAt = now;
          due.push({ type: "deliver", sendId: delivery.send.sendId, text: delivery.send.text, files: delivery.send.files });
        }
        return due;
      },
      onExtraEvent: (event) => {
        const sendId = typeof event.sendId === "string" ? event.sendId : "";
        const delivery = this.deliveries.get(sendId);
        if (!delivery) return;
        if (event.type === "deliver_accepted") {
          delivery.accepted = true;
          onDelivery(this, { type: "accepted", sendId, queued: event.queued === true });
        } else if (event.type === "delivered") {
          this.deliveries.delete(sendId);
          onDelivery(this, { type: "delivered", sendId });
        } else if (event.type === "deliver_failed") {
          this.deliveries.delete(sendId);
          onDelivery(this, { type: "failed", sendId, reason: typeof event.reason === "string" ? event.reason : undefined });
        }
      },
    });
  }

  get key(): string {
    return connectionKey(this.host, this.sessionId);
  }

  get live(): boolean {
    return !this.disposed && this.pull.bridge.status() !== "gone";
  }

  get busy(): boolean {
    return this.pull.bridge.status() === "busy";
  }

  get canAsk(): boolean {
    return this.host !== "cli-wait" && (this.ask.turn || this.ask.transient);
  }

  update(hello: HelloBody): void {
    this.processId = hello.processId;
    this.cwd = hello.cwd || this.cwd;
    this.project = hello.project || this.project;
    this.title = hello.title || this.title;
    this.lastHumanInputAt = Math.max(this.lastHumanInputAt, hello.lastHumanInputAt);
    this.ask = hello.ask;
    this.successorSessionId = undefined;
    // A hello means the process on the other end may be a different one (two Claude Code
    // processes on one session, or one that restarted): what was accepted but never
    // delivered goes out again, and the host's claim decides who delivers it.
    for (const delivery of this.deliveries.values()) {
      delivery.accepted = false;
      delivery.sentAt = 0;
    }
  }

  /** The Ask provider over this connection's bridge, made on first use. */
  askProvider(): SessionBridgeProvider {
    this.provider ??= new SessionBridgeProvider(this.pull.bridge, { surface: SNAPSHOTS_ASK_SURFACE });
    return this.provider;
  }

  queue(send: PendingSend): void {
    if (this.deliveries.has(send.sendId)) return;
    this.deliveries.set(send.sendId, { send, sentAt: 0, accepted: false });
    this.pull.notify();
  }

  unqueue(sendId: string): void {
    this.deliveries.delete(sendId);
  }

  hasDelivery(sendId: string): boolean {
    return this.deliveries.has(sendId);
  }

  /** Forward a poll or event request to this connection's bridge under the bridge's own paths. */
  async handle(req: Request, kind: "poll" | "event"): Promise<Response> {
    const url = new URL(req.url);
    url.pathname = kind === "poll" ? SESSION_BRIDGE_POLL_PATH : SESSION_BRIDGE_EVENT_PATH;
    const body = await req.text();
    if (kind === "poll") this.notePoll(body);
    const forwarded = new Request(url, { method: "POST", headers: req.headers, body, signal: req.signal });
    return (await this.pull.handle(forwarded)) ?? new Response("Not found", { status: 404 });
  }

  /** The poll body also carries what the HUD routes on: the last human input and the title. */
  private notePoll(body: string): void {
    try {
      const value = JSON.parse(body) as Record<string, unknown>;
      if (typeof value.lastHumanInputAt === "number") this.lastHumanInputAt = Math.max(this.lastHumanInputAt, value.lastHumanInputAt);
      if (typeof value.title === "string" && value.title) this.title = value.title.slice(0, 200);
    } catch {
      // A poll without a body is still a poll.
    }
  }

  view(): ConnectionView {
    return {
      id: this.id,
      host: this.host,
      sessionId: this.sessionId,
      cwd: this.cwd,
      project: this.project,
      title: this.title,
      live: this.live,
      busy: this.busy,
      lastHumanInputAt: this.lastHumanInputAt,
      canAsk: this.canAsk,
      ...(this.successorSessionId ? { successorSessionId: this.successorSessionId } : {}),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.provider?.detach();
    this.pull.dispose();
  }
}

export function connectionKey(host: string, sessionId: string): string {
  return `${host}\u0000${sessionId}`;
}

export class ConnectionRegistry {
  private byKey = new Map<string, Connection>();
  private byId = new Map<string, Connection>();
  private seq = 0;

  constructor(
    private readonly token: () => string,
    private readonly onDelivery: (connection: Connection, event: DeliveryEvent) => void,
  ) {}

  hello(hello: HelloBody): Connection {
    if (hello.replaces) {
      const previous = this.byKey.get(connectionKey(hello.host, hello.replaces));
      if (previous) previous.successorSessionId = hello.sessionId;
    }
    const existing = this.byKey.get(connectionKey(hello.host, hello.sessionId));
    if (existing?.disposed) {
      // Said goodbye earlier and is back (a resumed session): a fresh link.
      this.byId.delete(existing.id);
      this.byKey.delete(existing.key);
    } else if (existing) {
      existing.update(hello);
      existing.goneSince = null;
      return existing;
    }
    this.seq += 1;
    const id = `c${this.seq}-${Math.random().toString(16).slice(2, 8)}`;
    const connection = new Connection(id, hello, this.token(), this.onDelivery);
    this.byKey.set(connection.key, connection);
    this.byId.set(id, connection);
    return connection;
  }

  get(id: string): Connection | null {
    return this.byId.get(id) ?? null;
  }

  find(host: string, sessionId: string): Connection | null {
    return this.byKey.get(connectionKey(host, sessionId)) ?? null;
  }

  all(): Connection[] {
    return [...this.byId.values()];
  }

  bye(connection: Connection): void {
    connection.goneSince = Date.now();
    connection.dispose();
  }

  /** Track liveness; forget connections gone for a long time. Returns true when anything changed. */
  tick(now: number): boolean {
    let changed = false;
    for (const connection of this.byId.values()) {
      const live = connection.live;
      if (!live && connection.goneSince === null) {
        connection.goneSince = now;
        changed = true;
      } else if (live && connection.goneSince !== null) {
        connection.goneSince = null;
        changed = true;
      }
      if (!live && connection.goneSince !== null && now - connection.goneSince > FORGET_GONE_MS) {
        connection.dispose();
        this.byId.delete(connection.id);
        this.byKey.delete(connection.key);
        changed = true;
      }
    }
    return changed;
  }

  dispose(): void {
    for (const connection of this.byId.values()) connection.dispose();
    this.byId.clear();
    this.byKey.clear();
  }
}
