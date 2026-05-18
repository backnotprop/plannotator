import { describe, expect, test } from "vitest";
import { PLANNOTATOR_DAEMON_SESSION_VIEWS } from "@plannotator/shared/daemon-protocol";
import { getSessionViewDefinition, supportedSessionModes } from "./session-view-registry";

describe("session view registry", () => {
  test("registers every daemon-supported shell view", () => {
    expect(supportedSessionModes().sort()).toEqual([...PLANNOTATOR_DAEMON_SESSION_VIEWS].sort());
  });

  test("returns undefined for unsupported session modes", () => {
    expect(getSessionViewDefinition("future-mode")).toBeUndefined();
  });
});
