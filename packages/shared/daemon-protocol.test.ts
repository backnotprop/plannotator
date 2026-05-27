import { describe, expect, test } from "bun:test";
import {
  PLANNOTATOR_DAEMON_FEATURES,
  PLANNOTATOR_DAEMON_EVENT_FAMILIES,
  PLANNOTATOR_DAEMON_PROTOCOL,
  PLANNOTATOR_DAEMON_PROTOCOL_VERSION,
  PLANNOTATOR_DAEMON_SESSION_VIEWS,
  createDaemonErrorResponse,
  getDaemonCapabilities,
  isCompatibleDaemonCapabilities,
  isDaemonWebSocketScope,
  parseDaemonWebSocketClientMessage,
  parseDaemonWebSocketClientMessageText,
  parseDaemonWebSocketServerMessageText,
  serializeDaemonWebSocketServerMessage,
  type DaemonWebSocketServerMessage,
} from "./daemon-protocol";

describe("daemon protocol", () => {
  test("exposes versioned multi-session HTTP capabilities", () => {
    const capabilities = getDaemonCapabilities();
    expect(capabilities.protocol).toBe(PLANNOTATOR_DAEMON_PROTOCOL);
    expect(capabilities.protocolVersion).toBe(PLANNOTATOR_DAEMON_PROTOCOL_VERSION);
    expect(capabilities.transport).toBe("http");
    expect(capabilities.multiSession).toBe(true);
    expect(capabilities.features).toContain("session-create");
    expect(capabilities.features).toContain("session-bootstrap");
    expect(capabilities.features).toContain("session-result-wait");
    expect(capabilities.features).toContain("websocket-events");
    expect(capabilities.features).toContain("session-events");
    expect(capabilities.features).toContain("session-actions");
    expect(capabilities.features).toContain("debug-events");
    expect(PLANNOTATOR_DAEMON_FEATURES).toContain("session-bootstrap");
    expect(PLANNOTATOR_DAEMON_EVENT_FAMILIES).toEqual([
      "daemon",
      "external-annotations",
      "agent-jobs",
      "session-revision",
    ]);
    expect(PLANNOTATOR_DAEMON_SESSION_VIEWS).toEqual([
      "plan",
      "review",
      "annotate",
      "goal-setup",
    ]);
  });

  test("validates compatible capabilities", () => {
    expect(isCompatibleDaemonCapabilities(getDaemonCapabilities())).toBe(true);
    expect(isCompatibleDaemonCapabilities({ ...getDaemonCapabilities(), protocolVersion: 999 })).toBe(true);
    expect(isCompatibleDaemonCapabilities({ ...getDaemonCapabilities(), protocolVersion: 0 })).toBe(false);
    expect(isCompatibleDaemonCapabilities({ ...getDaemonCapabilities(), minClientVersion: 999 })).toBe(false);
    expect(isCompatibleDaemonCapabilities({ ...getDaemonCapabilities(), transport: "stdio" })).toBe(false);
    expect(isCompatibleDaemonCapabilities({ ...getDaemonCapabilities(), multiSession: false })).toBe(false);
  });

  test("wraps daemon errors with stable protocol metadata", () => {
    const response = createDaemonErrorResponse("daemon-unreachable", "No daemon");
    expect(response.ok).toBe(false);
    expect(response.protocol).toBe(PLANNOTATOR_DAEMON_PROTOCOL);
    expect(response.error.code).toBe("daemon-unreachable");
    expect(response.error.message).toBe("No daemon");
  });

  test("validates WebSocket scopes and client messages", () => {
    expect(isDaemonWebSocketScope({ family: "daemon" })).toBe(true);
    expect(isDaemonWebSocketScope({ family: "external-annotations", sessionId: "s1" })).toBe(true);
    expect(isDaemonWebSocketScope({ family: "unknown" })).toBe(false);
    expect(parseDaemonWebSocketClientMessage({
      type: "subscribe",
      requestId: "r1",
      scopes: [{ family: "agent-jobs", sessionId: "s1" }],
    })).toEqual({
      type: "subscribe",
      requestId: "r1",
      scopes: [{ family: "agent-jobs", sessionId: "s1" }],
    });
    expect(parseDaemonWebSocketClientMessage({
      type: "action",
      requestId: "r2",
      sessionId: "s1",
      method: "POST",
      path: "/api/approve",
      body: { ok: true },
    })).toEqual({
      type: "action",
      requestId: "r2",
      sessionId: "s1",
      method: "POST",
      path: "/api/approve",
      body: { ok: true },
    });
    expect(parseDaemonWebSocketClientMessage({ type: "subscribe", scopes: [] })).toBeNull();
    expect(parseDaemonWebSocketClientMessageText("{")).toBeNull();
  });

  test("serializes WebSocket server messages with correlation IDs", () => {
    const message: DaemonWebSocketServerMessage = {
      type: "action-result",
      requestId: "action-1",
      ok: true,
      status: 200,
      payload: { accepted: true },
    };

    expect(serializeDaemonWebSocketServerMessage(message)).toBe(JSON.stringify(message));
    expect(parseDaemonWebSocketServerMessageText(JSON.stringify(message))).toEqual(message);
    expect(parseDaemonWebSocketServerMessageText('{"payload":true}')).toBeNull();
    expect(parseDaemonWebSocketServerMessageText('{"type":"event"}')).toBeNull();
    expect(parseDaemonWebSocketServerMessageText(JSON.stringify({
      type: "snapshot",
      at: "2026-01-01T00:00:00.000Z",
      scope: { family: "unknown" },
      payload: {},
    }))).toBeNull();
    expect(parseDaemonWebSocketServerMessageText(JSON.stringify({
      type: "event",
      at: "2026-01-01T00:00:00.000Z",
      scope: { family: "agent-jobs", sessionId: "s1" },
      payload: { type: "job:started" },
    }))).toEqual({
      type: "event",
      at: "2026-01-01T00:00:00.000Z",
      scope: { family: "agent-jobs", sessionId: "s1" },
      payload: { type: "job:started" },
    });
    expect(parseDaemonWebSocketServerMessageText("{")).toBeNull();
  });
});
