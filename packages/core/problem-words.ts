/**
 * The words for every problem, in one table (the errors system): code → the
 * bold line, the muted line and the one action. The servers fill a problem's
 * words from here, so the pull request card, the hover card on a link and the
 * Pull requests page say the same thing; a window uses it only to read an
 * older server's bare error code.
 *
 * First slice: outside tools (gh, glab), six states. Plain words, one
 * spelling ("isn't", "didn't", "can't"), never another program's own text.
 *
 * Pure: no runtime APIs (vendored to Pi with `problem.ts`).
 */

import type { ForgeRef, ForgeRefCardError, ForgeRefCardResult } from "./forge-ref-card";
import { problemOf, type Problem, type ProblemAction } from "./problem";

export type ToolCli = "gh" | "glab";

/** What an outside tool did when asked, as the person needs to know it. */
export type ToolState = "missing" | "signed_out" | "timed_out" | "refused" | "rate_limited" | "failed";

export const TOOL_STATES: readonly ToolState[] = ["missing", "signed_out", "timed_out", "refused", "rate_limited", "failed"];

export interface ToolProblemContext {
  cli: ToolCli;
  host: string;
  /** What was being read: its noun in the words ("this merge request"). */
  kind?: "pull" | "issue";
  /** The thing on its forge (refused: "Open on GitLab"). */
  url?: string;
  /** signed_out: the variable a refused token came from (GH_TOKEN, GITLAB_TOKEN…); then signing in would not help. */
  envToken?: string | null;
  /** timed_out: the deadline it was given. */
  seconds?: number;
}

export const TOOL_INSTALL_URL: Record<ToolCli, string> = {
  gh: "https://cli.github.com",
  glab: "https://gitlab.com/gitlab-org/cli#installation",
};

const forgeOf = (cli: ToolCli) => (cli === "glab" ? "GitLab" : "GitHub");

function nounOf(ctx: ToolProblemContext): string {
  if (ctx.kind === "issue") return "issue";
  if (ctx.kind === "pull") return ctx.cli === "glab" ? "merge request" : "pull request";
  return "one";
}

type Words = { title: string; detail: string; action?: ProblemAction };

/** The table: one entry per state. */
export const TOOL_WORDS: Record<ToolState, (ctx: ToolProblemContext) => Words> = {
  missing: ({ cli }) => ({
    title: `${cli} isn't installed on this computer`,
    detail: `Install the ${forgeOf(cli)} CLI to see details here.`,
    action: { kind: "open_url", value: TOOL_INSTALL_URL[cli], label: `Install ${cli}` },
  }),
  signed_out: ({ cli, host, envToken }) =>
    envToken
      ? {
          title: `${cli} isn't signed in to ${host}`,
          detail: `${forgeOf(cli)} refused the token in ${envToken}. Set a new one where Plannotator starts, or remove it and sign in.`,
        }
      : {
          title: `${cli} isn't signed in to ${host}`,
          detail: `Nothing from ${host} can be read until it is. Sign in once in a terminal.`,
          action: { kind: "copy_command", value: `${cli} auth login --hostname ${host}` },
        },
  timed_out: ({ cli, seconds = 8 }) => ({
    title: `${cli} didn't answer in ${seconds} seconds`,
    detail: `It was stopped, and is asked again in a minute. If this keeps happening, check that ${cli} works in a terminal.`,
    action: { kind: "retry" },
  }),
  refused: (ctx) => ({
    title: `${ctx.cli} can't see this ${nounOf(ctx)}`,
    detail:
      ctx.cli === "glab"
        ? `Your GitLab account on ${ctx.host} can't see it, or it doesn't exist.`
        : `None of your signed-in GitHub accounts can see it, or it doesn't exist.`,
    ...(ctx.url && /^https:\/\//.test(ctx.url) ? { action: { kind: "open_url" as const, value: ctx.url, label: `Open on ${forgeOf(ctx.cli)}` } } : {}),
  }),
  rate_limited: ({ cli }) => ({
    title: `${forgeOf(cli)} asked for a short break`,
    detail: "Details come back in a minute, by themselves.",
  }),
  failed: (ctx) => ({
    title: `${ctx.cli} couldn't read this ${nounOf(ctx)}`,
    detail: "It stopped with an error. Try again in a moment.",
    action: { kind: "retry" },
  }),
};

/** A tool's state as a problem, its words from the table. */
export function toolProblem(state: ToolState, ctx: ToolProblemContext, at: Date = new Date()): Problem {
  return { code: `tool.${state}`, kind: "tool", ...TOOL_WORDS[state](ctx), at: at.toISOString() };
}

/**
 * An older server's bare card error as a tool state (`unsupported` is not one: a host this computer does not read).
 * `unavailable` was every other failure, a timeout included: it reads as `failed`.
 */
export function toolStateOfCardError(error: ForgeRefCardError): ToolState | null {
  switch (error) {
    case "cli_missing":
      return "missing";
    case "signed_out":
      return "signed_out";
    case "not_found":
      return "refused";
    case "rate_limited":
      return "rate_limited";
    case "unavailable":
      return "failed";
    default:
      return null;
  }
}

/** A tool state as the hover card's older error code (what an older window understands). */
export function cardErrorOfToolState(state: ToolState): ForgeRefCardError {
  return state === "missing" ? "cli_missing" : state === "refused" ? "not_found" : state === "signed_out" || state === "rate_limited" ? state : "unavailable";
}

/** The hover card's line for a host this computer's CLI does not read (no tool state: nothing was run). */
export const refUnsupportedLine = (cli: ToolCli) => `Details show for hosts your ${cli} is signed in to. This one isn't, so nothing was fetched.`;

/**
 * A failed hover card's problem: the server's own (newer servers), else its older bare error code in the same words
 * (an older server). Null for a host this computer does not read (`unsupported`: say `refUnsupportedLine`) and for an
 * answer that is not a failure.
 */
export function cardProblem(result: ForgeRefCardResult | null | undefined, ref: Pick<ForgeRef, "platform" | "host" | "kind">): Problem | null {
  if (!result || result.ok) return null;
  const failed = result as Extract<ForgeRefCardResult, { ok: false }>;
  const sent = problemOf(failed.problem);
  if (sent) return sent;
  const state = toolStateOfCardError(failed.error);
  if (!state) return null;
  return toolProblem(state, { cli: ref.platform === "gitlab" ? "glab" : "gh", host: ref.host, kind: ref.kind }, new Date(result.fetchedAt || Date.now()));
}
