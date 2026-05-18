import { describe, expect, test, vi } from "vitest";
import { daemonStatusFixture, sessionListFixture } from "../../testing/fixtures/daemon";
import { connectDaemonEvents, parseDaemonEventPayload, type EventSourceLike } from "./event-stream";

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, (event: MessageEvent<string>) => void>();

  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }

  emit(type: string, payload: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(payload) } as MessageEvent<string>);
  }

  close(): void {
    this.closed = true;
  }
}

describe("daemon event stream client", () => {
  test("parses daemon event payloads defensively", () => {
    const event = parseDaemonEventPayload(
      JSON.stringify({
        type: "daemon-status",
        at: "2026-05-17T12:00:00.000Z",
        status: daemonStatusFixture,
      }),
    );

    expect(event?.type).toBe("daemon-status");
    expect(
      parseDaemonEventPayload(
        JSON.stringify({
          type: "debug-log",
          at: "2026-05-17T12:00:00.000Z",
          source: "agent-simulator",
          message: "queued claude-plan-hook",
        }),
      )?.type,
    ).toBe("debug-log");
    expect(parseDaemonEventPayload("not json")).toBeNull();
    expect(parseDaemonEventPayload(JSON.stringify({ type: "unknown", at: "now" }))).toBeNull();
  });

  test("streams typed EventSource events into the frontend state callback", () => {
    const events: string[] = [];
    const states: string[] = [];
    const source = new FakeEventSource();

    const controller = connectDaemonEvents({
      client: {
        getEventsUrl: () => "/daemon/events",
        getStatus: async () => ({ ok: true, data: daemonStatusFixture }),
        listSessions: async () => ({ ok: true, data: sessionListFixture }),
      },
      eventSourceFactory: () => source,
      onEvent: (event) => events.push(event.type),
      onState: (state) => states.push(state),
      onError: (message) => events.push(message),
    });

    source.onopen?.(new Event("open"));
    source.emit("snapshot", {
      type: "snapshot",
      at: "2026-05-17T12:00:00.000Z",
      status: daemonStatusFixture,
      sessions: sessionListFixture.sessions,
    });
    controller.stop();

    expect(states).toEqual(["connecting", "open"]);
    expect(events).toEqual(["snapshot"]);
    expect(source.closed).toBe(true);
  });

  test("falls back to polling when EventSource is unavailable", async () => {
    const events: string[] = [];
    const states: string[] = [];
    const intervalHandles: unknown[] = [];
    const setIntervalFn = vi.fn((callback: () => void, _intervalMs: number) => {
      intervalHandles.push(callback);
      return { unref: vi.fn() } as unknown as ReturnType<typeof setInterval> & {
        unref?: () => void;
      };
    });
    const clearIntervalFn = vi.fn();

    const controller = connectDaemonEvents({
      client: {
        getEventsUrl: () => "/daemon/events",
        getStatus: async () => ({ ok: true, data: daemonStatusFixture }),
        listSessions: async () => ({ ok: true, data: sessionListFixture }),
      },
      eventSourceFactory: undefined,
      setIntervalFn,
      clearIntervalFn,
      onEvent: (event) => events.push(event.type),
      onState: (state) => states.push(state),
      onError: (message) => events.push(message),
    });

    await Promise.resolve();
    await Promise.resolve();
    controller.stop();

    expect(states).toEqual(["polling", "polling"]);
    expect(events).toContain("snapshot");
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(intervalHandles).toHaveLength(1);
  });
});
