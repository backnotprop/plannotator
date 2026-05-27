import {
  parseDaemonWebSocketClientMessageText,
  serializeDaemonWebSocketServerMessage,
  type DaemonEvent,
  type DaemonEventFamily,
  type DaemonWebSocketClientMessage,
  type DaemonWebSocketScope,
  type DaemonWebSocketServerMessage,
} from "@plannotator/shared/daemon-protocol";
import type { ServerWebSocket, WebSocketHandler } from "bun";

const HEARTBEAT_INTERVAL_MS = 15_000;

type DaemonSocketData = {
  daemonAuthenticated?: boolean;
};
type DaemonSocket = ServerWebSocket<DaemonSocketData>;
type DaemonEventMessage = Extract<DaemonWebSocketServerMessage, { type: "event" }>;

export type DaemonSnapshotProvider = () => unknown | Promise<unknown>;

export interface DaemonEventHubOptions {
  daemonSnapshot: () => unknown | Promise<unknown>;
  dispatchAction: (
    message: Extract<DaemonWebSocketClientMessage, { type: "action" }>,
  ) => Promise<{ status: number; payload?: unknown }>;
}

interface ConnectionState {
  subscriptions: Set<string>;
  // A subscription is not live until its baseline snapshot is sent. Events
  // published while the snapshot is being created are flushed after it, so
  // clients never apply a live event and then roll back to an older snapshot.
  pendingSubscriptions: Map<string, DaemonEventMessage[]>;
  heartbeat: ReturnType<typeof setInterval>;
  daemonAuthenticated: boolean;
  tabVisible: boolean;
  activeSessionId: string | null;
}

export interface FrontendState {
  connected: boolean;
  anyVisible: boolean;
  allActiveSessionIds: Set<string>;
}

function scopeKey(scope: DaemonWebSocketScope): string {
  return `${scope.family}:${scope.sessionId ?? ""}`;
}

function normalizeScope(scope: DaemonWebSocketScope): DaemonWebSocketScope {
  return scope.sessionId
    ? { family: scope.family, sessionId: scope.sessionId }
    : { family: scope.family };
}

function decodeMessage(message: string | Buffer): string {
  return typeof message === "string" ? message : message.toString("utf-8");
}

function nowIso(): string {
  return new Date().toISOString();
}

export class DaemonEventHub {
  private readonly connections = new Map<DaemonSocket, ConnectionState>();
  private readonly snapshotProviders = new Map<string, DaemonSnapshotProvider>();
  readonly websocket: WebSocketHandler<DaemonSocketData>;

  constructor(private readonly options: DaemonEventHubOptions) {
    this.websocket = {
      open: (socket) => this.open(socket),
      message: (socket, message) => this.message(socket, message),
      close: (socket) => this.close(socket),
    };
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  registerSnapshotProvider(
    sessionId: string,
    family: Exclude<DaemonEventFamily, "daemon">,
    provider: DaemonSnapshotProvider,
  ): () => void {
    const key = scopeKey({ family, sessionId });
    this.snapshotProviders.set(key, provider);
    return () => {
      if (this.snapshotProviders.get(key) === provider) {
        this.snapshotProviders.delete(key);
      }
    };
  }

  publishDaemonEvent(event: DaemonEvent): void {
    this.publish({ family: "daemon" }, event);
  }

  publishSessionEvent(
    sessionId: string,
    family: Exclude<DaemonEventFamily, "daemon">,
    event: unknown,
  ): void {
    this.publish({ family, sessionId }, event);
  }

  getFrontendState(): FrontendState {
    let connected = false;
    let anyVisible = false;
    const allActiveSessionIds = new Set<string>();
    for (const conn of this.connections.values()) {
      if (!conn.daemonAuthenticated) continue;
      connected = true;
      if (conn.tabVisible) anyVisible = true;
      if (conn.activeSessionId) allActiveSessionIds.add(conn.activeSessionId);
    }
    return { connected, anyVisible, allActiveSessionIds };
  }

  closeAll(): void {
    for (const socket of Array.from(this.connections.keys())) {
      try {
        socket.close();
      } catch {
        // The internal cleanup still needs to happen if the socket close fails.
      } finally {
        this.close(socket);
      }
    }
  }

  private open(socket: DaemonSocket): void {
    const heartbeat = setInterval(() => {
      this.send(socket, { type: "heartbeat", at: nowIso() });
    }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    this.connections.set(socket, {
      subscriptions: new Set(),
      pendingSubscriptions: new Map(),
      heartbeat,
      daemonAuthenticated: socket.data?.daemonAuthenticated === true,
      tabVisible: true,
      activeSessionId: null,
    });
  }

  private async message(socket: DaemonSocket, raw: string | Buffer): Promise<void> {
    const message = parseDaemonWebSocketClientMessageText(decodeMessage(raw));
    if (!message) {
      this.sendError(socket, "invalid-request", "Invalid daemon WebSocket message.");
      return;
    }

    switch (message.type) {
      case "subscribe":
        await this.subscribe(socket, message);
        return;
      case "unsubscribe":
        this.unsubscribe(socket, message);
        return;
      case "action":
        await this.action(socket, message);
        return;
      case "ping":
        this.send(socket, { type: "pong", requestId: message.requestId, at: nowIso() });
        return;
      case "client-state": {
        const connection = this.connections.get(socket);
        if (connection) {
          connection.tabVisible = message.visible;
          connection.activeSessionId = message.activeSessionId;
        }
        return;
      }
    }
  }

  private close(socket: DaemonSocket): void {
    const connection = this.connections.get(socket);
    if (connection) clearInterval(connection.heartbeat);
    this.connections.delete(socket);
  }

  private async subscribe(
    socket: DaemonSocket,
    message: Extract<DaemonWebSocketClientMessage, { type: "subscribe" }>,
  ): Promise<void> {
    const connection = this.connections.get(socket);
    if (!connection) return;

    for (const rawScope of message.scopes) {
      const scope = normalizeScope(rawScope);
      if (!connection.daemonAuthenticated && scope.family === "daemon") {
        this.sendError(socket, "unauthorized", "Daemon event subscriptions require authentication.", message.requestId);
        continue;
      }
      if (scope.family !== "daemon" && !scope.sessionId) {
        this.sendError(socket, "invalid-request", `${scope.family} subscriptions require a sessionId.`, message.requestId);
        continue;
      }
      const key = scopeKey(scope);
      if (connection.subscriptions.has(key) || connection.pendingSubscriptions.has(key)) {
        continue;
      }
      connection.pendingSubscriptions.set(key, []);
      try {
        const payload = await this.snapshot(scope);
        if (this.connections.get(socket) !== connection || !connection.pendingSubscriptions.has(key)) {
          continue;
        }
        this.send(socket, {
          type: "snapshot",
          at: nowIso(),
          scope,
          payload,
        });
        if (this.connections.get(socket) !== connection) continue;
        connection.subscriptions.add(key);
        const pending = connection.pendingSubscriptions.get(key) ?? [];
        connection.pendingSubscriptions.delete(key);
        for (const pendingMessage of pending) {
          this.send(socket, pendingMessage);
        }
      } catch (err) {
        connection.pendingSubscriptions.delete(key);
        this.sendError(
          socket,
          "session-not-found",
          err instanceof Error ? err.message : "Could not create subscription snapshot.",
          message.requestId,
        );
      }
    }
  }

  private unsubscribe(
    socket: DaemonSocket,
    message: Extract<DaemonWebSocketClientMessage, { type: "unsubscribe" }>,
  ): void {
    const connection = this.connections.get(socket);
    if (!connection) return;
    for (const scope of message.scopes) {
      const key = scopeKey(normalizeScope(scope));
      connection.subscriptions.delete(key);
      connection.pendingSubscriptions.delete(key);
    }
  }

  private async action(
    socket: DaemonSocket,
    message: Extract<DaemonWebSocketClientMessage, { type: "action" }>,
  ): Promise<void> {
    try {
      const connection = this.connections.get(socket);
      if (!connection?.daemonAuthenticated) {
        this.sendError(socket, "unauthorized", "Daemon WebSocket actions require authentication.", message.requestId);
        return;
      }
      const result = await this.options.dispatchAction(message);
      this.send(socket, {
        type: "action-result",
        requestId: message.requestId,
        ok: true,
        status: result.status,
        ...(result.payload !== undefined && { payload: result.payload }),
      });
    } catch (err) {
      this.sendError(
        socket,
        "internal-error",
        err instanceof Error ? err.message : "Daemon WebSocket action failed.",
        message.requestId,
      );
    }
  }

  private async snapshot(scope: DaemonWebSocketScope): Promise<unknown> {
    if (scope.family === "daemon") return this.options.daemonSnapshot();
    const provider = this.snapshotProviders.get(scopeKey(scope));
    if (!provider) {
      throw new Error(`No ${scope.family} snapshot provider for session ${scope.sessionId}.`);
    }
    return provider();
  }

  private publish(scope: DaemonWebSocketScope, payload: unknown): void {
    const key = scopeKey(scope);
    const message: DaemonEventMessage = {
      type: "event",
      at: nowIso(),
      scope,
      payload,
    };
    for (const [socket, connection] of this.connections) {
      const pending = connection.pendingSubscriptions.get(key);
      if (pending) {
        pending.push(message);
        continue;
      }
      if (!connection.subscriptions.has(key)) continue;
      this.send(socket, message);
    }
  }

  private send(socket: DaemonSocket, message: DaemonWebSocketServerMessage): void {
    try {
      socket.send(serializeDaemonWebSocketServerMessage(message));
    } catch {
      this.close(socket);
    }
  }

  private sendError(socket: DaemonSocket, code: string, message: string, requestId?: string): void {
    this.send(socket, {
      type: "error",
      ...(requestId && { requestId }),
      code,
      message,
    });
  }
}
