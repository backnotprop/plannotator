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
import { commandHostTrusted, toolProblem, type ToolCli, type ToolState } from "@plannotator/core/problem-words";
import { REF_TIMEOUT_MS, type CliHosts, type RefCards, type RefCommandResult } from "./ref-cards";
import { refineToolState, tokenEnvFor, toolDiagOf, toolStateOfRun, type ToolStatus } from "@plannotator/shared/tool-state";

export interface ThreadPullFailure {
  problem: Problem;
  diag: ProblemDiag | null;
}

const STATES = new Set<string>(["missing", "signed_out", "timed_out", "refused", "rate_limited", "failed"]);

function failure(state: ToolState, cli: ToolCli, host: string, url: string, at: number, diag: ProblemDiag | null, trusted: boolean, ran = true): ThreadPullFailure {
  const envToken = ran && state === "signed_out" ? tokenEnvFor(cli, host) : null;
  const problem = toolProblem(state, { cli, host, kind: "pull", url, trusted, envToken, seconds: Math.round(REF_TIMEOUT_MS / 1000) }, new Date(at));
  return { problem, diag };
}

/**
 * Nothing ran: the CLI lists no signed-in login for this host. Not installed says `missing`. A host in the CLI's own
 * configuration (an expired login, a host behind a VPN that is off) gets the cached status check, safe there, and
 * reads as failed or timed out when the check cannot tell. A project's own origin host the CLI has never heard of is
 * signed out. Any other host is named only by a link: `toolProblem` then names neither it nor a command.
 */
async function unreadFailure(options: { tools: Pick<ToolStatus, "check">; cli: ToolCli; host: string; url: string; at: () => number; hosts: CliHosts | null; projectHosts: readonly string[] }): Promise<ThreadPullFailure> {
  const { tools, cli, host, url, hosts, projectHosts } = options;
  const trusted = commandHostTrusted(host, { configured: hosts?.configured, projectHosts });
  if (hosts?.missing) return failure("missing", cli, host, url, options.at(), null, trusted, false);
  if (hosts?.configured.has(host.toLowerCase())) {
    const state = await refineToolState(tools, cli, host, null);
    return failure(state, cli, host, url, options.at(), null, trusted, false);
  }
  return failure("signed_out", cli, host, url, options.at(), null, trusted, false);
}

/** A GitHub batch that got no answer: from the run, made precise by the status check; `unread` when nothing ran. */
export async function githubPullFailure(options: {
  tools: Pick<ToolStatus, "check">;
  host: string;
  url: string;
  at: () => number;
  /** The run, or null when nothing ran; `rateLimited`: the host is held. */
  run: { result: RefCommandResult; ms: number } | null;
  rateLimited?: boolean;
  /** Nothing ran: what gh says about its hosts, and the projects' own origin hosts. */
  hosts?: CliHosts | null;
  projectHosts?: readonly string[];
}): Promise<ThreadPullFailure> {
  const { tools, host, url, run } = options;
  // A read ran for this host (github.com, or a host gh is signed in to): it is trusted.
  if (options.rateLimited) return failure("rate_limited", "gh", host, url, options.at(), null, true);
  if (!run) return unreadFailure({ tools, cli: "gh", host, url, at: options.at, hosts: options.hosts ?? null, projectHosts: options.projectHosts ?? [] });
  const state = await refineToolState(tools, "gh", host, toolStateOfRun("gh", run.result));
  return failure(state, "gh", host, url, options.at(), toolDiagOf(run.result, run.ms), true);
}

/** A GitLab card that came back failed (or not at all): its problem, made precise by the status check. */
export async function gitlabPullFailure(options: {
  tools: Pick<ToolStatus, "check">;
  refCards: Pick<RefCards, "diagOf"> | null;
  host: string;
  url: string;
  at: () => number;
  result: ForgeRefCardResult | null;
  /** `unsupported`: what glab says about its hosts, and the projects' own origin hosts. */
  hosts?: CliHosts | null;
  projectHosts?: readonly string[];
}): Promise<ThreadPullFailure> {
  const { tools, host, url, result } = options;
  // `unsupported`: glab lists no signed-in login for that host, so nothing ran.
  if (!result || (!result.ok && result.error === "unsupported")) {
    return unreadFailure({ tools, cli: "glab", host, url, at: options.at, hosts: options.hosts ?? null, projectHosts: options.projectHosts ?? [] });
  }
  const code = !result.ok ? result.problem?.code.replace(/^tool\./, "") : undefined;
  const fromCard = code && STATES.has(code) ? (code as ToolState) : null;
  const state = await refineToolState(tools, "glab", host, fromCard ?? "failed");
  return failure(state, "glab", host, url, options.at(), options.refCards?.diagOf?.(result) ?? null, true);
}
