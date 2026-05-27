import {
  type DaemonWebSocketFactory,
  type DaemonWebSocketLike,
  type DaemonWebSocketClientMessage,
  type DaemonWebSocketServerMessage,
  parseDaemonWebSocketServerMessageText,
} from "@plannotator/shared/daemon-protocol";

export type WebSocketLike = DaemonWebSocketLike;
export type WebSocketFactory = DaemonWebSocketFactory;

export interface DaemonHubActionResult {
  status: number;
  payload?: unknown;
}

export type DaemonHubConnectionState = "connecting" | "open" | "closed" | "error";

export class DaemonHubOpenError extends Error {
  constructor(message = "Daemon WebSocket connection failed.") {
    super(message);
    this.name = "DaemonHubOpenError";
  }
}

export class DaemonHubActionError extends Error {
  constructor(
    message = "Daemon WebSocket action failed.",
    readonly code?: string,
  ) {
    super(message);
    this.name = "DaemonHubActionError";
  }
}

interface ActionWaiter {
  resolve(result: DaemonHubActionResult): void;
  reject(error: Error): void;
}

const OPEN = 1;
let requestSequence = 0;
const clients = new Map<string, DaemonHubClient>();

function nextRequestId(prefix: string): string {
  requestSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${requestSequence}`;
}

function defaultWebSocketFactory(): WebSocketFactory {
  return (url) => new WebSocket(url) as WebSocketLike;
}

export class DaemonHubClient {
  private socket?: WebSocketLike;
  private readonly daemonSubscribers = new Set<(message: DaemonWebSocketServerMessage) => void>();
  private readonly stateSubscribers = new Set<(state: DaemonHubConnectionState) => void>();
  private readonly errorSubscribers = new Set<(message: string) => void>();
  private readonly actionWaiters = new Map<string, ActionWaiter>();
  private openPromise?: Promise<void>;
  private resolveOpen?: () => void;
  private rejectOpen?: (error: Error) => void;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private daemonSubscribed = false;

  constructor(
    private readonly url: string,
    private readonly factory: WebSocketFactory = defaultWebSocketFactory(),
  ) {}

  subscribeDaemon(
    onMessage: (message: DaemonWebSocketServerMessage) => void,
    onState: (state: DaemonHubConnectionState) => void,
    onError: (message: string) => void,
  ): () => void {
    this.daemonSubscribers.add(onMessage);
    this.stateSubscribers.add(onState);
    this.errorSubscribers.add(onError);
    void this.ensureOpen()
      .then(() => {
        this.ensureDaemonSubscription();
      })
      .catch((err) => {
        if (this.errorSubscribers.has(onError)) onError(err.message);
      });
    return () => {
      this.daemonSubscribers.delete(onMessage);
      this.stateSubscribers.delete(onState);
      this.errorSubscribers.delete(onError);
      this.closeIfIdle();
    };
  }

  async runAction(input: {
    sessionId: string;
    method: string;
    path: string;
    body?: unknown;
  }): Promise<DaemonHubActionResult> {
    await this.ensureOpen();
    const requestId = nextRequestId("action");
    return new Promise<DaemonHubActionResult>((resolve, reject) => {
      this.actionWaiters.set(requestId, { resolve, reject });
      try {
        this.send({
          type: "action",
          requestId,
          sessionId: input.sessionId,
          method: input.method,
          path: input.path,
          ...(input.body !== undefined && { body: input.body }),
        });
      } catch (err) {
        this.actionWaiters.delete(requestId);
        reject(err instanceof Error ? err : new Error("Daemon WebSocket action failed."));
      }
    });
  }

  stop(): void {
    this.clearReconnect();
    this.daemonSubscribers.clear();
    this.stateSubscribers.clear();
    this.errorSubscribers.clear();
    const socket = this.socket;
    this.socket = undefined;
    this.daemonSubscribed = false;
    socket?.close();
    this.rejectActionWaiters(new Error("Daemon WebSocket closed."));
  }

  private ensureOpen(): Promise<void> {
    if (this.socket?.readyState === OPEN) return Promise.resolve();
    if (this.openPromise) return this.openPromise;

    this.emitState("connecting");
    let socket: WebSocketLike;
    try {
      socket = this.factory(this.url);
    } catch (cause) {
      const error = new DaemonHubOpenError(
        cause instanceof Error ? cause.message : "Daemon WebSocket connection failed.",
      );
      this.emitError(error.message);
      this.emitState("error");
      return Promise.reject(error);
    }
    this.socket = socket;
    this.openPromise = new Promise<void>((resolve, reject) => {
      this.resolveOpen = resolve;
      this.rejectOpen = reject;
    });
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.daemonSubscribed = false;
      this.emitState("open");
      this.resolveOpen?.();
      this.openPromise = undefined;
      this.ensureDaemonSubscription();
    };
    socket.onmessage = (event) => {
      if (this.socket !== socket) return;
      this.handleMessage(event.data);
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      const wasOpening = !!this.openPromise;
      const error = new DaemonHubOpenError();
      this.emitError(error.message);
      this.emitState("error");
      this.rejectOpen?.(error);
      this.openPromise = undefined;
      this.socket = undefined;
      this.daemonSubscribed = false;
      if (!wasOpening) this.rejectActionWaiters(new Error("Daemon WebSocket closed."));
      socket.close();
      this.scheduleReconnect();
    };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      const wasOpening = !!this.openPromise;
      if (wasOpening)
        this.rejectOpen?.(new DaemonHubOpenError("Daemon WebSocket closed before opening."));
      this.daemonSubscribed = false;
      this.emitState("closed");
      this.socket = undefined;
      this.openPromise = undefined;
      this.rejectActionWaiters(new Error("Daemon WebSocket closed."));
      this.scheduleReconnect();
    };
    return this.openPromise;
  }

  private handleMessage(data: string): void {
    const message = parseDaemonWebSocketServerMessageText(data);
    if (!message) {
      this.emitError("Daemon WebSocket sent an invalid message.");
      return;
    }
    if (message.type === "action-result") {
      const waiter = this.actionWaiters.get(message.requestId);
      if (!waiter) return;
      this.actionWaiters.delete(message.requestId);
      waiter.resolve({ status: message.status, payload: message.payload });
      this.closeIfIdle();
      return;
    }
    if (message.type === "error" && message.requestId) {
      const waiter = this.actionWaiters.get(message.requestId);
      if (!waiter) return;
      this.actionWaiters.delete(message.requestId);
      waiter.reject(new DaemonHubActionError(message.message, message.code));
      this.closeIfIdle();
      return;
    }
    if (message.type === "error") {
      this.emitError(message.message);
      this.emitState("error");
      this.rejectActionWaiters(new Error(message.message));
      const socket = this.socket;
      this.socket = undefined;
      this.daemonSubscribed = false;
      socket?.close();
      this.scheduleReconnect();
      return;
    }
    if (
      message.type === "event" ||
      message.type === "snapshot" ||
      message.type === "pong" ||
      message.type === "heartbeat"
    ) {
      for (const subscriber of this.daemonSubscribers) subscriber(message);
    }
  }

  private send(message: DaemonWebSocketClientMessage): void {
    if (this.socket?.readyState !== OPEN) {
      throw new DaemonHubOpenError("Daemon WebSocket is not open.");
    }
    this.socket.send(JSON.stringify(message));
  }

  private ensureDaemonSubscription(): void {
    if (this.daemonSubscribers.size === 0 || this.daemonSubscribed) return;
    if (this.socket?.readyState !== OPEN) return;
    this.send({
      type: "subscribe",
      scopes: [{ family: "daemon" }],
    });
    this.daemonSubscribed = true;
  }

  private sendDaemonUnsubscribe(): void {
    if (!this.daemonSubscribed || this.socket?.readyState !== OPEN) return;
    this.send({
      type: "unsubscribe",
      scopes: [{ family: "daemon" }],
    });
    this.daemonSubscribed = false;
  }

  private scheduleReconnect(): void {
    if (this.daemonSubscribers.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.daemonSubscribers.size === 0) return;
      void this.ensureOpen().catch((err) => {
        this.emitError(err.message);
      });
    }, 500);
  }

  private clearReconnect(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private closeIfIdle(): void {
    if (this.daemonSubscribers.size > 0 || this.actionWaiters.size > 0) return;
    this.clearReconnect();
    this.sendDaemonUnsubscribe();
    const socket = this.socket;
    if (this.openPromise) {
      this.rejectOpen?.(new DaemonHubOpenError("Daemon WebSocket closed before opening."));
      this.openPromise = undefined;
    }
    this.resolveOpen = undefined;
    this.rejectOpen = undefined;
    this.socket = undefined;
    socket?.close();
  }

  private rejectActionWaiters(error: Error): void {
    for (const waiter of this.actionWaiters.values()) {
      waiter.reject(error);
    }
    this.actionWaiters.clear();
  }

  private emitState(state: DaemonHubConnectionState): void {
    for (const subscriber of this.stateSubscribers) subscriber(state);
  }

  private emitError(message: string): void {
    for (const subscriber of this.errorSubscribers) subscriber(message);
  }
}

export function getDaemonHubClient(url: string, factory?: WebSocketFactory): DaemonHubClient {
  if (factory) return new DaemonHubClient(url, factory);
  const existing = clients.get(url);
  if (existing) return existing;
  const client = new DaemonHubClient(url);
  clients.set(url, client);
  return client;
}
