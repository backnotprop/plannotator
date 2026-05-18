import { describe, expect, test } from "bun:test";
import {
  PLANNOTATOR_DAEMON_PROTOCOL,
  PLANNOTATOR_DAEMON_PROTOCOL_VERSION,
  createDaemonErrorResponse,
  getDaemonCapabilities,
  isCompatibleDaemonCapabilities,
} from "./daemon-protocol";

describe("daemon protocol", () => {
  test("exposes versioned multi-session HTTP capabilities", () => {
    const capabilities = getDaemonCapabilities();
    expect(capabilities.protocol).toBe(PLANNOTATOR_DAEMON_PROTOCOL);
    expect(capabilities.protocolVersion).toBe(PLANNOTATOR_DAEMON_PROTOCOL_VERSION);
    expect(capabilities.transport).toBe("http");
    expect(capabilities.multiSession).toBe(true);
    expect(capabilities.features).toContain("session-create");
    expect(capabilities.features).toContain("session-result-wait");
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
});
