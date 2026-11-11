/**
 * The one table of words for gh and glab problems (problem-words.ts). The
 * failures these guard: a state whose next step is missing or wrong (no
 * command to copy when signed out, no Try again on a timeout), a command
 * that is not exactly what the person must run, an older server's bare
 * error code that a newer window no longer draws, and a server's answer that
 * smuggles in a link that is not a web page.
 */
import { describe, expect, test } from "bun:test";
import { problemOf } from "./problem";
import { cardProblem, TOOL_STATES, toolProblem, type ToolCli } from "./problem-words";

describe("each state maps to its code and its one next step", () => {
  const next = (cli: ToolCli, host: string) =>
    TOOL_STATES.map((state) => {
      const p = toolProblem(state, { cli, host, kind: "pull", url: `https://${host}/o/r/pull/1` });
      const a = p.action;
      return [p.code, a ? (a.kind === "retry" ? "retry" : `${a.kind} ${a.value}`) : "none"];
    });

  test("gh", () => {
    expect(next("gh", "github.com")).toEqual([
      ["tool.missing", "open_url https://cli.github.com"],
      ["tool.signed_out", "copy_command gh auth login --hostname github.com"],
      ["tool.timed_out", "retry"],
      ["tool.refused", "open_url https://github.com/o/r/pull/1"],
      ["tool.rate_limited", "none"],
      ["tool.failed", "retry"],
    ]);
  });

  test("glab on a self-hosted GitLab: the command names that host", () => {
    expect(next("glab", "gitlab.example.dev")).toEqual([
      ["tool.missing", "open_url https://gitlab.com/gitlab-org/cli#installation"],
      ["tool.signed_out", "copy_command glab auth login --hostname gitlab.example.dev"],
      ["tool.timed_out", "retry"],
      ["tool.refused", "open_url https://gitlab.example.dev/o/r/pull/1"],
      ["tool.rate_limited", "none"],
      ["tool.failed", "retry"],
    ]);
  });

  test("a refused token from the environment offers no sign-in (the variable would still win) and names it", () => {
    const p = toolProblem("signed_out", { cli: "gh", host: "github.com", envToken: "GH_TOKEN" });
    expect(p.action).toBeUndefined();
    expect(p.detail).toContain("GH_TOKEN");
  });
});

describe("older and newer answers", () => {
  test("an older server's bare card error reads as the same problem a newer one sends", () => {
    const ref = { platform: "gitlab" as const, host: "gitlab.example.dev", kind: "pull" as const };
    const older = cardProblem({ ok: false, error: "signed_out", fetchedAt: 1 }, ref);
    const newer = toolProblem("signed_out", { cli: "glab", host: "gitlab.example.dev", kind: "pull" });
    expect([older?.code, older?.title, older?.action]).toEqual([newer.code, newer.title, newer.action]);
    expect(cardProblem({ ok: false, error: "unavailable", fetchedAt: 1 }, ref)?.code).toBe("tool.failed");
    // A host this computer does not read is not a tool state.
    expect(cardProblem({ ok: false, error: "unsupported", fetchedAt: 1 }, ref)).toBeNull();
  });

  test("a problem off the wire: anything unreadable is dropped; a page that is not https is never offered", () => {
    expect(problemOf({ code: "tool.x" })).toBeNull();
    expect(problemOf("tool.signed_out")).toBeNull();
    const p = problemOf({ code: "tool.refused", kind: "tool", title: "t", detail: "d", action: { kind: "open_url", value: "javascript:alert(1)", label: "Open" } });
    expect(p?.action).toBeUndefined();
    expect(problemOf({ code: "tool.future", kind: "tool", title: "t", detail: "d", action: { kind: "teleport" } })?.code).toBe("tool.future");
  });
});
