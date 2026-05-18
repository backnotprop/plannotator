import { describe, expect, test } from "bun:test";
import {
  PLANNOTATOR_DAEMON_FEATURES,
  PLANNOTATOR_DAEMON_PROTOCOL,
  PLANNOTATOR_DAEMON_PROTOCOL_VERSION,
  PLANNOTATOR_DAEMON_SESSION_VIEWS,
  createDaemonErrorResponse,
  getDaemonCapabilities,
  isCompatibleDaemonCapabilities,
  serializeDaemonEvent,
  type DaemonEvent,
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
    expect(capabilities.features).toContain("events");
    expect(capabilities.features).toContain("debug-events");
    expect(PLANNOTATOR_DAEMON_FEATURES).toContain("session-bootstrap");
    expect(PLANNOTATOR_DAEMON_SESSION_VIEWS).toEqual([
      "plan",
      "review",
      "annotate",
      "archive",
      "setup-goal",
    ]);
  });

  test("validates compatible capabilities", () => {
    expect(isCompatibleDaemonCapabilities(getDaemonCapabilities())).toBe(true);
    expect(isCompatibleDaemonCapabilities({ ...getDaemonCapabilities(), protocolVersion: 999 })).toBe(false);
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

  test("serializes daemon events as named SSE messages", () => {
    const event: DaemonEvent = {
      type: "daemon-error",
      at: "2026-05-17T00:00:00.000Z",
      code: "internal-error",
      message: "Boom",
    };

    expect(serializeDaemonEvent(event)).toBe(
      `event: daemon-error\ndata: ${JSON.stringify(event)}\n\n`,
    );
  });
});
