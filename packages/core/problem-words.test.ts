/**
 * The one table of words for gh and glab problems (problem-words.ts). The
 * failures these guard: a state whose next step is missing or wrong (no
 * command to copy when signed out, no Try again on a timeout), a command
 * that is not exactly what the person must run, an older server's bare
 * error code that a newer window no longer draws, a server's answer that
 * smuggles in a link that is not a web page, and a sign-in command naming a
 * host the person never used (a look-alike an agent's link named).
 */
import { describe, expect, test } from "bun:test";
import { problemOf } from "./problem";
import { cardProblem, commandHostTrusted, TOOL_STATES, toolProblem, type ToolCli } from "./problem-words";

describe("each state maps to its code and its one next step", () => {
  const next = (cli: ToolCli, host: string, trusted?: boolean) =>
    TOOL_STATES.map((state) => {
      const p = toolProblem(state, { cli, host, kind: "pull", url: `https://${host}/o/r/pull/1`, trusted });
      const a = p.action;
      return [p.code, (a ? (a.kind === "retry" ? "retry" : `${a.kind} ${a.value}`) : "none") + (p.retry ? " + retry" : "")];
    });

  test("gh", () => {
    expect(next("gh", "github.com")).toEqual([
      ["tool.missing", "open_url https://cli.github.com + retry"],
      ["tool.signed_out", "copy_command gh auth login --hostname github.com + retry"],
      ["tool.timed_out", "retry"],
      ["tool.refused", "open_url https://github.com/o/r/pull/1"],
      ["tool.rate_limited", "none"],
      ["tool.failed", "retry"],
    ]);
  });

  test("glab on a self-hosted GitLab the person uses: the command names that host", () => {
    expect(next("glab", "gitlab.example.dev", true)).toEqual([
      ["tool.missing", "open_url https://gitlab.com/gitlab-org/cli#installation + retry"],
      ["tool.signed_out", "copy_command glab auth login --hostname gitlab.example.dev + retry"],
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
    expect(p.retry).toBe(true);
  });
});

describe("a sign-in command names only a host the person already uses", () => {
  const configured = ["ghe.acme.internal"];
  const projectHosts = ["gitlab.acme.dev"];
  test("the public forges exactly, a host in the CLI's configuration, the project's own origin host", () => {
    for (const host of ["github.com", "gitlab.com", "GitHub.com", "ghe.acme.internal", "gitlab.acme.dev"]) expect([host, commandHostTrusted(host, { configured, projectHosts })]).toEqual([host, true]);
  });
  test("a look-alike or any other host an agent's link names: no claim about it, no command, Try again", () => {
    for (const host of ["github.corn", "gitlab-acme.com", "gitlab.com.evil.example", "evil.example/gitlab.com", "ghe.acme.internal.evil.example"]) {
      expect([host, commandHostTrusted(host, { configured, projectHosts })]).toEqual([host, false]);
      const p = toolProblem("signed_out", { cli: host.includes("gitlab") ? "glab" : "gh", host, kind: "pull", trusted: commandHostTrusted(host, { configured, projectHosts }) });
      expect([p.code, p.action, p.retry]).toEqual(["tool.unsupported", undefined, true]);
      expect(`${p.title} ${p.detail}`).not.toContain(host);
    }
  });
  test("the default trusts only the public forges: an older server's bare signed_out on a self-hosted GitLab names no command", () => {
    const p = cardProblem({ ok: false, error: "signed_out", fetchedAt: 1 }, { platform: "gitlab", host: "gitlab.example.dev", kind: "pull" });
    expect([p?.code, p?.action]).toEqual(["tool.unsupported", undefined]);
  });
});

describe("older and newer answers", () => {
  test("an older server's bare card error reads as the same problem a newer one sends", () => {
    const ref = { platform: "gitlab" as const, host: "gitlab.com", kind: "pull" as const };
    const older = cardProblem({ ok: false, error: "signed_out", fetchedAt: 1 }, ref);
    const newer = toolProblem("signed_out", { cli: "glab", host: "gitlab.com", kind: "pull" });
    expect([older?.code, older?.title, older?.action]).toEqual([newer.code, newer.title, newer.action]);
    expect(cardProblem({ ok: false, error: "unavailable", fetchedAt: 1 }, ref)?.code).toBe("tool.failed");
    // A host this computer does not read is not a tool state.
    expect(cardProblem({ ok: false, error: "unsupported", fetchedAt: 1 }, ref)).toBeNull();
    // Bitbucket has no CLI: its bare errors never read as a gh or glab state (the card keeps its own line).
    expect(cardProblem({ ok: false, error: "signed_out", fetchedAt: 1 }, { platform: "bitbucket", host: "bitbucket.org", kind: "pull" })).toBeNull();
  });

  test("a problem off the wire: anything unreadable is dropped; a page that is not https is never offered", () => {
    expect(problemOf({ code: "tool.x" })).toBeNull();
    expect(problemOf("tool.signed_out")).toBeNull();
    const p = problemOf({ code: "tool.refused", kind: "tool", title: "t", detail: "d", action: { kind: "open_url", value: "javascript:alert(1)", label: "Open" } });
    expect(p?.action).toBeUndefined();
    expect(problemOf({ code: "tool.future", kind: "tool", title: "t", detail: "d", action: { kind: "teleport" } })?.code).toBe("tool.future");
    // A command is only ever a sign-in to a plain host.
    expect(problemOf({ code: "tool.signed_out", kind: "tool", title: "t", detail: "d", action: { kind: "copy_command", value: "gh auth login --hostname x.dev; curl evil" } })?.action).toBeUndefined();
  });
});
