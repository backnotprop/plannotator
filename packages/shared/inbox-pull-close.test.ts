/**
 * Close and reopen from the board (inbox-pull-close.ts). What regresses: a PR closed or reopened without asking the
 * forge first; a merged or already closed PR written to; a reopen of one merged meanwhile; the wrong write (GitHub's
 * `state`, GitLab's `state_event`); a refusal not in the forge's words; a reopen taken for a PR this Inbox did not close
 * within the window. A scripted runner stands in for gh / glab.
 */
import { describe, expect, test } from "bun:test";
import { closePull, githubPullStateOf, gitlabPullStateOf, PULL_REOPEN_WINDOW_MS, reopenAllowed, reopenPull } from "./inbox-pull-close";
import type { PullMergeTarget } from "./inbox-pull-merge";
import type { RefCli, RefRunner } from "./ref-cards";

const GH: PullMergeTarget = { platform: "github", host: "github.com", repo: "northwind/ledger", number: 412 };
const GL: PullMergeTarget = { platform: "gitlab", host: "gitlab.com", repo: "northwind/group/web", number: 61 };

/** A runner that answers by method and endpoint and keeps every call. */
function forge(answers: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>) {
  const calls: { cli: RefCli; args: string[] }[] = [];
  const run: RefRunner = async (cli, args) => {
    calls.push({ cli, args });
    const method = args.includes("PATCH") ? "PATCH " : args.includes("PUT") ? "PUT " : "";
    const endpoint = args.find((a) => /^(repos|projects)\//.test(a)) ?? "";
    const answer = answers[`${method}${endpoint}`] ?? { stderr: "HTTP 404: Not Found", exitCode: 1 };
    return { stdout: answer.stdout ?? "", stderr: answer.stderr ?? "", exitCode: answer.exitCode ?? 0 };
  };
  return { run, calls, writes: () => calls.filter((c) => c.args.includes("PATCH") || c.args.includes("PUT")) };
}
const GH_PULL = "repos/northwind/ledger/pulls/412";
const GL_MR = `projects/${encodeURIComponent("northwind/group/web")}/merge_requests/61`;
const ghState = (state: string, merged = false) => ({ stdout: JSON.stringify({ state, merged, merged_at: merged ? "2026-11-12T10:00:00Z" : null }) });

describe("the forge's state", () => {
  test("GitHub and GitLab: open, closed, merged; anything else unread", () => {
    expect(githubPullStateOf(ghState("open").stdout)).toBe("open");
    expect(githubPullStateOf(ghState("closed").stdout)).toBe("closed");
    expect(githubPullStateOf(ghState("closed", true).stdout)).toBe("merged");
    expect(githubPullStateOf("not json")).toBeNull();
    expect(gitlabPullStateOf(JSON.stringify({ state: "opened" }))).toBe("open");
    expect(gitlabPullStateOf(JSON.stringify({ state: "locked" }))).toBe("closed");
    expect(gitlabPullStateOf(JSON.stringify({ state: "merged" }))).toBe("merged");
    expect(gitlabPullStateOf("{}")).toBeNull();
  });
});

describe("closePull", () => {
  test("GitHub: asked first, then one PATCH with state=closed", async () => {
    const f = forge({ [GH_PULL]: ghState("open"), [`PATCH ${GH_PULL}`]: { stdout: "{}" } });
    expect(await closePull(f.run, GH)).toEqual({ ok: true });
    expect(f.calls.map((c) => c.args.join(" "))).toEqual([
      `api --hostname github.com ${GH_PULL}`,
      `api --hostname github.com -X PATCH ${GH_PULL} -f state=closed`,
    ]);
  });

  test("GitLab: one PUT with state_event=close", async () => {
    const f = forge({ [GL_MR]: { stdout: JSON.stringify({ state: "opened" }) }, [`PUT ${GL_MR}`]: { stdout: "{}" } });
    expect(await closePull(f.run, GL)).toEqual({ ok: true });
    expect(f.writes().map((c) => [c.cli, c.args.at(-1)])).toEqual([["glab", "state_event=close"]]);
  });

  test("a merged or closed PR, or one the forge can't be asked about, is never written to", async () => {
    for (const [answer, code, message] of [
      [ghState("closed", true), "pull_merged", "It is already merged."],
      [ghState("closed"), "pull_closed", "It is already closed."],
      [{ stderr: "HTTP 502", exitCode: 1 }, "pull_state_unknown", "Couldn’t ask GitHub whether it is still open. Try again."],
    ] as const) {
      const f = forge({ [GH_PULL]: answer, [`PATCH ${GH_PULL}`]: { stdout: "{}" } });
      expect(await closePull(f.run, GH)).toEqual({ ok: false, code, message });
      expect(f.writes()).toEqual([]);
    }
  });

  test("a refusal comes back in the forge's words", async () => {
    const f = forge({ [GH_PULL]: ghState("open"), [`PATCH ${GH_PULL}`]: { stdout: JSON.stringify({ message: "Must have admin rights to Repository." }), stderr: "gh: Must have admin rights to Repository. (HTTP 403)", exitCode: 1 } });
    expect(await closePull(f.run, GH)).toEqual({ ok: false, code: "pull_close_failed", message: "Must have admin rights to Repository." });
  });
});

describe("reopenPull", () => {
  test("GitHub: a closed PR is reopened with state=open; GitLab with state_event=reopen", async () => {
    const gh = forge({ [GH_PULL]: ghState("closed"), [`PATCH ${GH_PULL}`]: { stdout: "{}" } });
    expect(await reopenPull(gh.run, GH)).toEqual({ ok: true });
    expect(gh.writes().map((c) => c.args.at(-1))).toEqual(["state=open"]);
    const gl = forge({ [GL_MR]: { stdout: JSON.stringify({ state: "closed" }) }, [`PUT ${GL_MR}`]: { stdout: "{}" } });
    expect(await reopenPull(gl.run, GL)).toEqual({ ok: true });
    expect(gl.writes().map((c) => c.args.at(-1))).toEqual(["state_event=reopen"]);
  });

  test("merged meanwhile, or open again, is refused and nothing is written", async () => {
    for (const [answer, code] of [
      [ghState("closed", true), "pull_merged"],
      [ghState("open"), "pull_open"],
    ] as const) {
      const f = forge({ [GH_PULL]: answer, [`PATCH ${GH_PULL}`]: { stdout: "{}" } });
      const result = await reopenPull(f.run, GH);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(code);
      expect(f.writes()).toEqual([]);
    }
  });

  test("the host refusing (a deleted head branch) is reported in its words", async () => {
    const f = forge({ [GH_PULL]: ghState("closed"), [`PATCH ${GH_PULL}`]: { stdout: JSON.stringify({ message: "state cannot be changed. The head branch was deleted." }), exitCode: 1 } });
    expect(await reopenPull(f.run, GH)).toEqual({ ok: false, code: "pull_close_failed", message: "state cannot be changed. The head branch was deleted." });
  });
});

describe("reopenAllowed", () => {
  test(`only a PR this Inbox closed, within ${PULL_REOPEN_WINDOW_MS / 60_000} minutes`, () => {
    const closed = 1_000_000;
    expect(PULL_REOPEN_WINDOW_MS).toBe(5 * 60_000);
    expect(reopenAllowed(undefined, closed)).toBe(false);
    expect(reopenAllowed(closed, closed)).toBe(true);
    expect(reopenAllowed(closed, closed + PULL_REOPEN_WINDOW_MS)).toBe(true);
    expect(reopenAllowed(closed, closed + PULL_REOPEN_WINDOW_MS + 1)).toBe(false);
    // A clock that went back is no licence either.
    expect(reopenAllowed(closed, closed - 1)).toBe(false);
  });
});
