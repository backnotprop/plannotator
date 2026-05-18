import { describe, expect, test } from "vitest";
import { encodeSessionId, isValidSessionId, parseSessionId } from "./session-id";

describe("session id validation", () => {
  test("accepts daemon-style session ids", () => {
    expect(isValidSessionId("plan-session-1")).toBe(true);
    expect(isValidSessionId("review_ABC123")).toBe(true);
    expect(parseSessionId("archive-session-4")).toBe("archive-session-4");
  });

  test("rejects path-like or empty ids", () => {
    expect(isValidSessionId("")).toBe(false);
    expect(isValidSessionId("../plan-session-1")).toBe(false);
    expect(isValidSessionId("plan/session")).toBe(false);
    expect(parseSessionId("plan/session")).toBe(false);
  });

  test("throws before encoding invalid ids", () => {
    expect(() => encodeSessionId("bad/session")).toThrow("Invalid Plannotator session id");
  });
});
