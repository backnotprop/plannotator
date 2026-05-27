import { afterEach, describe, expect, test } from "bun:test";
import { UiDaemonHubClient, type WebSocketLike } from "./daemonHub";

const originalWindow = globalThis.window;
const originalEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

class FakeWebSocket implements WebSocketLike {
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  readyState = 0;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  error(): void {
    this.readyState = 3;
    this.onerror?.(new Event("error"));
  }
}

function setWindow(value: Partial<Window>) {
  Object.defineProperty(globalThis, "window", {
    value,
    configurable: true,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    value: originalWindow,
    configurable: true,
  });
  Object.defineProperty(globalThis, "EventSource", {
    value: originalEventSource,
    configurable: true,
  });
  Object.defineProperty(globalThis, "WebSocket", {
    value: originalWebSocket,
    configurable: true,
  });
});

describe("daemon WebSocket hub client", () => {
  test("uses one WebSocket for external annotation and agent job subscriptions", () => {
    setWindow({
      location: {
        href: "http://localhost:19432/s/session-one",
        pathname: "/s/session-one",
      } as Location,
    });
    Object.defineProperty(globalThis, "EventSource", {
      value: class {
        constructor() {
          throw new Error("EventSource should not be constructed.");
        }
      },
      configurable: true,
    });

    const sockets: FakeWebSocket[] = [];
    const client = new UiDaemonHubClient((url) => {
      expect(url).toBe("ws://localhost:19432/daemon/ws");
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    });
    const externalEvents: string[] = [];
    const jobEvents: string[] = [];

    client.subscribe({ family: "external-annotations", sessionId: "session-one" }, (message) => {
      externalEvents.push(message.type);
    });
    client.subscribe({ family: "agent-jobs", sessionId: "session-one" }, (message) => {
      jobEvents.push(message.type);
    });

    expect(sockets).toHaveLength(1);
    sockets[0].open();
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      type: "subscribe",
      scopes: [
        { family: "external-annotations", sessionId: "session-one" },
        { family: "agent-jobs", sessionId: "session-one" },
      ],
    });

    sockets[0].emit({
      type: "snapshot",
      at: "2026-01-01T00:00:00.000Z",
      scope: { family: "external-annotations", sessionId: "session-one" },
      payload: { annotations: [] },
    });
    sockets[0].emit({
      type: "event",
      at: "2026-01-01T00:00:01.000Z",
      scope: { family: "agent-jobs", sessionId: "session-one" },
      payload: { type: "job-started" },
    });

    expect(externalEvents).toEqual(["snapshot"]);
    expect(jobEvents).toEqual(["event"]);
  });

  test("does not send duplicate subscribe frames for an already-active scope", () => {
    const sockets: FakeWebSocket[] = [];
    const client = new UiDaemonHubClient(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    });

    client.subscribe({ family: "agent-jobs", sessionId: "session-one" }, () => {});
    sockets[0].open();
    client.subscribe({ family: "agent-jobs", sessionId: "session-one" }, () => {});

    expect(sockets[0].sent.map((message) => JSON.parse(message))).toEqual([
      {
        type: "subscribe",
        scopes: [{ family: "agent-jobs", sessionId: "session-one" }],
      },
    ]);
  });

  test("reconnects and resubscribes active session scopes", async () => {
    setWindow({
      location: {
        href: "http://localhost:19432/s/session-one",
        pathname: "/s/session-one",
      } as Location,
    });
    const sockets: FakeWebSocket[] = [];
    const client = new UiDaemonHubClient(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    });

    client.subscribe({ family: "external-annotations", sessionId: "session-one" }, () => {});
    sockets[0].open();
    sockets[0].close();

    await sleep(550);
    expect(sockets).toHaveLength(2);
    sockets[1].open();
    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      type: "subscribe",
      scopes: [{ family: "external-annotations", sessionId: "session-one" }],
    });
  });

  test("does not let a stale close event clear a replacement socket", async () => {
    setWindow({
      location: {
        href: "http://localhost:19432/s/session-one",
        pathname: "/s/session-one",
      } as Location,
    });
    const sockets: FakeWebSocket[] = [];
    const client = new UiDaemonHubClient(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    });

    const unsubscribe = client.subscribe(
      { family: "external-annotations", sessionId: "session-one" },
      () => {},
    );

    sockets[0].error();
    await sleep(550);
    expect(sockets).toHaveLength(2);

    sockets[0].close();
    sockets[1].open();

    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      type: "subscribe",
      scopes: [{ family: "external-annotations", sessionId: "session-one" }],
    });
    unsubscribe();
  });

  test("reports connection state transitions for fallback polling", () => {
    const sockets: FakeWebSocket[] = [];
    const states: string[] = [];
    const client = new UiDaemonHubClient(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    });

    const unsubscribe = client.subscribe(
      { family: "external-annotations", sessionId: "session-one" },
      () => {},
      (state) => states.push(state),
    );

    expect(states).toEqual(["connecting"]);
    sockets[0].open();
    sockets[0].close();
    expect(states).toEqual(["connecting", "open", "closed"]);
    unsubscribe();
  });

  test("treats daemon error frames as terminal fallback without reconnecting", async () => {
    const sockets: FakeWebSocket[] = [];
    const states: string[] = [];
    const client = new UiDaemonHubClient(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    });

    const unsubscribe = client.subscribe(
      { family: "agent-jobs", sessionId: "session-one" },
      () => {},
      (state) => states.push(state),
    );

    sockets[0].open();
    sockets[0].emit({
      type: "error",
      code: "session-not-found",
      message: "No agent-jobs snapshot provider for session session-one.",
    });

    expect(states).toEqual(["connecting", "open", "closed"]);
    expect(sockets[0].closed).toBe(true);
    await sleep(550);
    expect(sockets).toHaveLength(1);
    unsubscribe();
  });

  test("reports unavailable when the runtime has no WebSocket implementation", () => {
    Object.defineProperty(globalThis, "WebSocket", {
      value: undefined,
      configurable: true,
    });
    const states: string[] = [];
    const client = new UiDaemonHubClient();

    const unsubscribe = client.subscribe(
      { family: "external-annotations", sessionId: "session-one" },
      () => {},
      (state) => states.push(state),
    );

    expect(states).toEqual(["unavailable"]);
    unsubscribe();
  });
});
