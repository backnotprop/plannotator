import { describe, expect, test } from "bun:test";
import { toOriginSession } from "./origin-session";

describe("toOriginSession", () => {
  test("builds an opencode ParentSession when sessionId is present", () => {
    expect(toOriginSession({ sessionId: "session-1", cwd: "/workspace/example" })).toEqual({
      sessionId: "session-1",
      cwd: "/workspace/example",
      agent: "opencode",
    });
  });

  test("falls back to process.cwd() when cwd is omitted", () => {
    expect(toOriginSession({ sessionId: "session-1" })).toEqual({
      sessionId: "session-1",
      cwd: process.cwd(),
      agent: "opencode",
    });
  });

  test("returns null without a sessionId", () => {
    expect(toOriginSession({})).toBeNull();
    expect(toOriginSession({ cwd: "/workspace/example" })).toBeNull();
    expect(toOriginSession({ sessionId: "" })).toBeNull();
  });
});
