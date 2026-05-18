import { describe, expect, test } from "vitest";
import { PLANNOTATOR_DAEMON_SESSION_VIEWS } from "@plannotator/shared/daemon-protocol";
import { sessionApiGroups } from "../../sessions/session-api-groups";
import { sessionBootstraps, sessionListFixture } from "./daemon";

describe("daemon fixtures", () => {
  test("include a bootstrap fixture for every supported shell view", () => {
    for (const mode of PLANNOTATOR_DAEMON_SESSION_VIEWS) {
      expect(sessionBootstraps[mode].session.mode).toBe(mode);
    }
  });

  test("include dashboard sessions for every supported shell view", () => {
    const modes = sessionListFixture.sessions.map((session) => session.mode).sort();
    expect(modes).toEqual([...PLANNOTATOR_DAEMON_SESSION_VIEWS].sort());
  });

  test("represent every inventory API group with scoped API paths or explicit deferral", () => {
    for (const [mode, groups] of Object.entries(sessionApiGroups)) {
      expect(groups.length, `${mode} has groups`).toBeGreaterThan(0);
      for (const group of groups) {
        if (group.status === "planned") {
          expect(group.reason).toBeTruthy();
          continue;
        }
        expect(group.endpoints.length, `${group.id} has endpoints`).toBeGreaterThan(0);
        for (const endpoint of group.endpoints) {
          expect(endpoint.path.startsWith("/api/") || endpoint.path === "/favicon.svg").toBe(true);
        }
      }
    }
  });
});
