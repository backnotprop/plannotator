import { describe, expect, test } from "bun:test";
import { agentByShort, claudeAttachCommand, parseAgentsJson, parseBackgrounded, startFailureOf, versionAtLeast } from "./inbox-launch-claude";

describe("parseBackgrounded", () => {
  test("reads the short id and name from the line Claude Code 2.1.314 prints (bg-test RESULTS)", () => {
    const stdout = "Starting background service…\nbackgrounded · 844d238d · bgtest-B (idle — send a prompt to start)\n";
    expect(parseBackgrounded(stdout)).toEqual({ short: "844d238d", name: "bgtest-B" });
    expect(parseBackgrounded("backgrounded · ad91b9e9 · bgperm")).toEqual({ short: "ad91b9e9", name: "bgperm" });
  });

  test("anything else is not a start", () => {
    expect(parseBackgrounded("Error: Workspace not trusted")).toBeNull();
    expect(parseBackgrounded("backgrounded · XYZ · name")).toBeNull();
  });
});

describe("agentByShort", () => {
  const agents = parseAgentsJson(
    JSON.stringify([
      { id: "844d238d", sessionId: "844d238d-0000-4000-8000-000000000001", status: "idle", state: "running" },
      { sessionId: "2b2ff057-0000-4000-8000-000000000002", status: null, state: "stopped" },
      { sessionId: "2b2ff099-0000-4000-8000-000000000003", status: "busy", state: "running" },
      { id: "no-session" },
    ]),
  )!;

  test("drops entries without a session id and falls back to the session id's prefix", () => {
    expect(agents.map((a) => a.id)).toEqual(["844d238d", "2b2ff057", "2b2ff099"]);
    expect(agentByShort(agents, "844d238d")?.sessionId).toBe("844d238d-0000-4000-8000-000000000001");
    expect(agentByShort(agents, "2b2ff057")?.state).toBe("stopped");
  });

  test("an ambiguous prefix matches nothing, so a launch never adopts another session", () => {
    expect(agentByShort(agents, "2b2ff0")).toBeNull();
  });

  test("output that is not a JSON list is unreadable", () => {
    expect(parseAgentsJson("not json")).toBeNull();
    expect(parseAgentsJson("{}")).toBeNull();
  });
});

describe("startFailureOf", () => {
  test("Claude's untrusted-folder error becomes the run line's untrusted cause with the folder", () => {
    const failure = startFailureOf({ exitCode: 1, timedOut: false, stdout: "", stderr: "Error: Workspace not trusted. Run claude in /x first." }, "~/oss/side");
    expect(failure.code).toBe("untrusted");
    expect(failure.text).toStartWith("~/oss/side isn't a trusted folder yet.");
  });

  test("otherwise the first real output line, skipping the supervisor's banner", () => {
    expect(startFailureOf({ exitCode: 2, timedOut: false, stdout: "Starting background service…\nboom: no tty", stderr: "" }, "/x")).toEqual({ code: "failed", text: "boom: no tty" });
    expect(startFailureOf({ exitCode: 3, timedOut: false, stdout: "", stderr: "" }, "/x").text).toBe("claude exited with code 3.");
    expect(startFailureOf({ exitCode: -1, timedOut: true, stdout: "", stderr: "" }, "/x").text).toContain("too long");
  });
});

test("versionAtLeast compares numerically, not as text", () => {
  expect(versionAtLeast("2.1.314", "2.1.314")).toBe(true);
  expect(versionAtLeast("2.10.0", "2.1.314")).toBe(true);
  expect(versionAtLeast("2.1.99", "2.1.314")).toBe(false);
});

test("the attach command quotes the folder for the shell", () => {
  expect(claudeAttachCommand("/Users/me/it's here", "4f1c9a2e")).toBe("cd '/Users/me/it'\\''s here' && claude attach 4f1c9a2e");
});
