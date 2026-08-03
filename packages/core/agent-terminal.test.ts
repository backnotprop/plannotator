import { describe, expect, test } from "bun:test";
import {
  AGENT_TERMINAL_WS_BASE_PATH,
  buildAgentTerminalWsPath,
  isAgentTerminalWsRoute,
  supportsAnnotateAgentTerminalMode,
} from "./agent-terminal";

describe("supportsAnnotateAgentTerminalMode", () => {
  test("enables the terminal only for annotate file and folder modes", () => {
    expect(supportsAnnotateAgentTerminalMode("annotate")).toBe(true);
    expect(supportsAnnotateAgentTerminalMode("annotate-folder")).toBe(true);
    expect(supportsAnnotateAgentTerminalMode("annotate-last")).toBe(false);
    expect(supportsAnnotateAgentTerminalMode("archive")).toBe(false);
    expect(supportsAnnotateAgentTerminalMode(undefined)).toBe(false);
  });
});

describe("agent terminal WebSocket paths", () => {
  test("builds a tokenized browser-facing path", () => {
    expect(buildAgentTerminalWsPath("abc123")).toBe(`${AGENT_TERMINAL_WS_BASE_PATH}/abc123`);
  });

  test("rejects invalid token segments", () => {
    expect(() => buildAgentTerminalWsPath("")).toThrow();
    expect(() => buildAgentTerminalWsPath("abc/123")).toThrow();
    expect(() => buildAgentTerminalWsPath("abc?123")).toThrow();
    expect(() => buildAgentTerminalWsPath("abc#123")).toThrow();
  });

  test("recognizes only the terminal route namespace", () => {
    expect(isAgentTerminalWsRoute(AGENT_TERMINAL_WS_BASE_PATH)).toBe(true);
    expect(isAgentTerminalWsRoute(`${AGENT_TERMINAL_WS_BASE_PATH}/abc123`)).toBe(true);
    expect(isAgentTerminalWsRoute("/api/plan")).toBe(false);
    expect(isAgentTerminalWsRoute(`${AGENT_TERMINAL_WS_BASE_PATH}-other`)).toBe(false);
  });
});
