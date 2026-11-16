/**
 * Why a thread's PR could not be read, as a problem the card shows (the
 * errors system, first slice): gh or glab missing, not signed in to that
 * host, timed out, refused, rate limited, or failed. The thread-pulls reader
 * (inbox-thread-pulls.ts) calls this only behind the window's read, so the
 * status check it may wait on (tool-state.ts: its own deadline, cached) never
 * holds a hover. What the tool printed stays here (`diag`), never sent.
 */

import type { ForgeRefCardResult } from "@plannotator/core/forge-ref-card";
import type { Problem, ProblemDiag } from "@plannotator/core/problem";
import { toolProblem, type ToolCli, type ToolState } from "@plannotator/core/problem-words";
import { REF_TIMEOUT_MS, type RefCards, type RefCommandResult } from "./ref-cards";
import { refineToolState, tokenEnvFor, toolDiagOf, toolStateOfRun, type ToolStatus } from "@plannotator/shared/tool-state";

export interface ThreadPullFailure {
  problem: Problem;
  diag: ProblemDiag | null;
}

const STATES = new Set<string>(["missing", "signed_out", "timed_out", "refused", "rate_limited", "failed"]);

function failure(state: ToolState, cli: ToolCli, host: string, url: string, at: number, diag: ProblemDiag | null, ran = true): ThreadPullFailure {
  const problem = toolProblem(state, { cli, host, kind: "pull", url, envToken: ran && state === "signed_out" ? tokenEnvFor(cli, host) : null, seconds: Math.round(REF_TIMEOUT_MS / 1000) }, new Date(at));
  return { problem, diag };
}

/**
 * A GitHub batch that got no answer: from the run, made precise by the status check. Nothing ran: held for a rate
 * limit, or a host gh lists no login for, which is signed out and is never named in a command (not even the check).
 */
export async function githubPullFailure(options: {
  tools: Pick<ToolStatus, "check">;
  host: string;
  url: string;
  at: () => number;
  /** The run, or null when nothing ran; `rateLimited`: the host is held. */
  run: { result: RefCommandResult; ms: number } | null;
  rateLimited?: boolean;
}): Promise<ThreadPullFailure> {
  const { tools, host, url, run } = options;
  if (options.rateLimited) return failure("rate_limited", "gh", host, url, options.at(), null);
  if (!run) return failure("signed_out", "gh", host, url, options.at(), null, false);
  const state = await refineToolState(tools, "gh", host, toolStateOfRun("gh", run.result));
  return failure(state, "gh", host, url, options.at(), toolDiagOf(run.result, run.ms));
}

/** A GitLab card that came back failed (or not at all): its problem, made precise by the status check. */
export async function gitlabPullFailure(options: {
  tools: Pick<ToolStatus, "check">;
  refCards: Pick<RefCards, "diagOf"> | null;
  host: string;
  url: string;
  at: () => number;
  result: ForgeRefCardResult | null;
}): Promise<ThreadPullFailure> {
  const { tools, host, url, result } = options;
  // `unsupported`: glab lists no login for that host. Signed out, and the host is never named in a command.
  if (result && !result.ok && result.error === "unsupported") return failure("signed_out", "glab", host, url, options.at(), null, false);
  const code = result && !result.ok ? result.problem?.code.replace(/^tool\./, "") : undefined;
  const fromCard = code && STATES.has(code) ? (code as ToolState) : null;
  // No card at all: nothing ran, the status check decides.
  const state = await refineToolState(tools, "glab", host, fromCard ?? (result ? "failed" : null));
  return failure(state, "glab", host, url, options.at(), (result && options.refCards?.diagOf?.(result)) ?? null);
}
