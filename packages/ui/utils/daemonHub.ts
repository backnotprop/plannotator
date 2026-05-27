import type {
  DaemonEventFamily,
  DaemonWebSocketFactory,
  DaemonWebSocketLike,
  DaemonWebSocketScope,
  DaemonWebSocketServerMessage,
} from "@plannotator/shared/daemon-protocol";
import { parseDaemonWebSocketServerMessageText } from "@plannotator/shared/daemon-protocol";

type ScopeSubscriber = (message: DaemonWebSocketServerMessage) => void;
export type DaemonHubConnectionState = "connecting" | "open" | "closed" | "unavailable";
type ConnectionStateSubscriber = (state: DaemonHubConnectionState) => void;

export type WebSocketLike = DaemonWebSocketLike;
export type WebSocketFactory = DaemonWebSocketFactory;

const OPEN = 1;
const RECONNECT_MS = 500;

function socketUrl(): string {
  const url = new URL(
    "/daemon/ws",
    typeof window === "undefined" ? "http://localhost" : window.location.href,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function scopeKey(scope: DaemonWebSocketScope): string {
  return `${scope.family}:${scope.sessionId ?? ""}`;
}

function currentSessionId(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const match = window.location.pathname.match(/^\/s\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : undefined;
}

function defaultWebSocketFactory(): WebSocketFactory | undefined {
  if (typeof WebSocket === "undefined") return undefined;
  return (url) => new WebSocket(url) as WebSocketLike;
}

export class UiDaemonHubClient {
  private socket?: WebSocketLike;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private subscribers = new Map<string, Set<ScopeSubscriber>>();
  private stateSubscribers = new Set<ConnectionStateSubscriber>();
  private scopes = new Map<string, DaemonWebSocketScope>();
  private connectionState: DaemonHubConnectionState;

  constructor(private readonly webSocketFactory: WebSocketFactory | undefined = defaultWebSocketFactory()) {
    this.connectionState = webSocketFactory ? "closed" : "unavailable";
  }

  subscribe(
    scope: DaemonWebSocketScope,
    subscriber: ScopeSubscriber,
    onState?: ConnectionStateSubscriber,
  ): () => void {
    const key = scopeKey(scope);
    const isNewScope = !this.subscribers.has(key);
    this.scopes.set(key, scope);
    const subscribers = this.subscribers.get(key) ?? new Set<ScopeSubscriber>();
    subscribers.add(subscriber);
    this.subscribers.set(key, subscribers);
    if (onState) this.stateSubscribers.add(onState);
    const previousState = this.connectionState;
    this.connect();
    if (onState && this.connectionState === previousState) onState(this.connectionState);
    // If the socket is already open, subscribe immediately; new sockets send
    // all active scopes from onopen once the connection is actually writable.
    if (isNewScope) this.sendSubscribe([scope]);
    return () => {
      subscribers.delete(subscriber);
      if (onState) this.stateSubscribers.delete(onState);
      if (subscribers.size === 0) {
        this.subscribers.delete(key);
        this.scopes.delete(key);
        this.send({ type: "unsubscribe", scopes: [scope] });
      }
      if (this.subscribers.size === 0) this.close();
    };
  }

  private connect(): void {
    if (!this.webSocketFactory) {
      this.setConnectionState("unavailable");
      return;
    }
    if (this.socket?.readyState === OPEN) {
      this.setConnectionState("open");
      return;
    }
    if (this.socket) {
      this.setConnectionState("connecting");
      return;
    }
    this.setConnectionState("connecting");
    const socket = this.webSocketFactory(socketUrl());
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.setConnectionState("open");
      this.sendSubscribe(Array.from(this.scopes.values()));
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      const message = parseDaemonWebSocketServerMessageText(event.data);
      if (!message) return;
      if (message.type === "error") {
        // Server errors are not scoped/correlated for subscriptions yet. Close
        // without reconnecting so deleted sessions fall back to polling instead
        // of re-subscribing to the same permanent failure forever.
        this.socket = undefined;
        socket.close();
        this.setConnectionState("closed");
        return;
      }
      if (message.type !== "snapshot" && message.type !== "event") return;
      const subscribers = this.subscribers.get(scopeKey(message.scope));
      if (!subscribers) return;
      for (const subscriber of subscribers) subscriber(message);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      socket.close();
      this.setConnectionState("closed");
      this.scheduleReconnect();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.setConnectionState("closed");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.subscribers.size === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, RECONNECT_MS);
  }

  private sendSubscribe(scopes: DaemonWebSocketScope[]): void {
    if (scopes.length === 0) return;
    this.send({ type: "subscribe", scopes });
  }

  private send(message: { type: "subscribe" | "unsubscribe"; scopes: DaemonWebSocketScope[] }): void {
    if (this.socket?.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.socket?.close();
    this.socket = undefined;
    this.setConnectionState(this.webSocketFactory ? "closed" : "unavailable");
  }

  private setConnectionState(state: DaemonHubConnectionState): void {
    if (this.connectionState === state) return;
    this.connectionState = state;
    for (const subscriber of this.stateSubscribers) subscriber(state);
  }
}

const client = new UiDaemonHubClient();

export function subscribeToDaemonSessionFamily(
  family: Exclude<DaemonEventFamily, "daemon">,
  subscriber: ScopeSubscriber,
  onState?: ConnectionStateSubscriber,
): (() => void) | undefined {
  const sessionId = currentSessionId();
  if (!sessionId) return undefined;
  return client.subscribe({ family, sessionId }, subscriber, onState);
}
