/**
 * Close and reopen from the Inbox's Pull requests board (approval "inbox-pr-board-bulk": Close shows the count with
 * Undo, and Undo reopens exactly what that Close closed). The person's action from the window only: no agent tool, MCP
 * action or CLI command reaches it (the review agents keep `--deny-tool=shell(gh pr close)`).
 *
 * The forge is asked first, at that moment (never the list's minute-old answer): a PR that is already merged or closed
 * is refused with a plain reason, and so is a reopen of one that was merged meanwhile. Then one write as the person's
 * own `gh` / `glab`: GitHub `PATCH repos/{o}/{r}/pulls/{n}` with `state`, GitLab `PUT
 * projects/{id}/merge_requests/{iid}` with `state_event`. A refusal comes back in the forge's own words.
 *
 * No Bun or Node API: a `RefRunner` runs the CLI. Inbox-only (the Pi server has no Inbox).
 */

import type { RefCli, RefRunner } from "./ref-cards";
import { forgeMessage, splitRepo, type PullMergeTarget } from "./inbox-pull-merge";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

export type PullForgeState = "open" | "closed" | "merged";

/** A reopen is taken only for a PR this Inbox closed this recently (Close's Undo); any other is refused. */
export const PULL_REOPEN_WINDOW_MS = 5 * 60_000;

/** Whether a reopen may go: this Inbox closed the PR (`closedAt`, ms) no longer than `PULL_REOPEN_WINDOW_MS` ago. */
export function reopenAllowed(closedAt: number | undefined, now: number): boolean {
  return closedAt !== undefined && now - closedAt >= 0 && now - closedAt <= PULL_REOPEN_WINDOW_MS;
}

export type PullCloseRefusal = "pull_merged" | "pull_closed" | "pull_open" | "pull_state_unknown" | "pull_close_failed";

export type PullCloseResult = { ok: true } | { ok: false; code: PullCloseRefusal; message: string };

/** GitHub's `GET repos/{o}/{r}/pulls/{n}`: open, closed, or merged. Null when unreadable. */
export function githubPullStateOf(stdout: string): PullForgeState | null {
  let raw: Json;
  try {
    raw = obj(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (raw.merged === true || (typeof raw.merged_at === "string" && raw.merged_at)) return "merged";
  if (raw.state === "open") return "open";
  if (raw.state === "closed") return "closed";
  return null;
}

/** GitLab's `GET projects/{id}/merge_requests/{iid}`: open, closed (or locked), or merged. Null when unreadable. */
export function gitlabPullStateOf(stdout: string): PullForgeState | null {
  let raw: Json;
  try {
    raw = obj(JSON.parse(stdout));
  } catch {
    return null;
  }
  if (raw.state === "merged") return "merged";
  if (raw.state === "opened") return "open";
  if (raw.state === "closed" || raw.state === "locked") return "closed";
  return null;
}

const forgeOf = (pull: PullMergeTarget) => (pull.platform === "gitlab" ? "GitLab" : "GitHub");

/** The forge's answer now: open, closed or merged. Null when it could not be read. */
export async function readPullForgeState(run: RefRunner, pull: PullMergeTarget): Promise<PullForgeState | null> {
  const cli: RefCli = pull.platform === "gitlab" ? "glab" : "gh";
  if (pull.platform === "github") {
    const parts = splitRepo(pull.repo);
    if (!parts) return null;
    const read = await run(cli, ["api", "--hostname", pull.host, `repos/${parts.owner}/${parts.name}/pulls/${pull.number}`]).catch(() => null);
    return read && read.exitCode === 0 ? githubPullStateOf(read.stdout) : null;
  }
  const read = await run(cli, ["api", "--hostname", pull.host, `projects/${encodeURIComponent(pull.repo)}/merge_requests/${pull.number}`]).catch(() => null);
  return read && read.exitCode === 0 ? gitlabPullStateOf(read.stdout) : null;
}

/** The one write: GitHub `state=closed|open`, GitLab `state_event=close|reopen`. */
async function writeState(run: RefRunner, pull: PullMergeTarget, to: "closed" | "open"): Promise<PullCloseResult> {
  const cli = pull.platform === "gitlab" ? "glab" : "gh";
  let wrote;
  if (pull.platform === "github") {
    const parts = splitRepo(pull.repo)!;
    wrote = await run("gh", ["api", "--hostname", pull.host, "-X", "PATCH", `repos/${parts.owner}/${parts.name}/pulls/${pull.number}`, "-f", `state=${to}`]).catch(() => null);
  } else {
    wrote = await run("glab", ["api", "--hostname", pull.host, "-X", "PUT", `projects/${encodeURIComponent(pull.repo)}/merge_requests/${pull.number}`, "-f", `state_event=${to === "closed" ? "close" : "reopen"}`]).catch(() => null);
  }
  if (!wrote) return { ok: false, code: "pull_close_failed", message: `It didn’t go: ${cli} didn’t answer.` };
  if (wrote.exitCode !== 0) return { ok: false, code: "pull_close_failed", message: forgeMessage(wrote) };
  return { ok: true };
}

/** Close an open PR the person picked: the forge is asked first, then the PR is closed. Never throws. */
export async function closePull(run: RefRunner, pull: PullMergeTarget): Promise<PullCloseResult> {
  const state = await readPullForgeState(run, pull);
  if (!state) return { ok: false, code: "pull_state_unknown", message: `Couldn’t ask ${forgeOf(pull)} whether it is still open. Try again.` };
  if (state === "merged") return { ok: false, code: "pull_merged", message: "It is already merged." };
  if (state === "closed") return { ok: false, code: "pull_closed", message: "It is already closed." };
  return writeState(run, pull, "closed");
}

/** Reopen a PR this Inbox closed: the forge is asked first (merged meanwhile, or already open, is refused). Never throws. */
export async function reopenPull(run: RefRunner, pull: PullMergeTarget): Promise<PullCloseResult> {
  const state = await readPullForgeState(run, pull);
  if (!state) return { ok: false, code: "pull_state_unknown", message: `Couldn’t ask ${forgeOf(pull)} whether it is still closed. Try again.` };
  if (state === "merged") return { ok: false, code: "pull_merged", message: "It was merged meanwhile." };
  if (state === "open") return { ok: false, code: "pull_open", message: "It is already open." };
  return writeState(run, pull, "open");
}
