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
  /**
   * The host is one the person already uses (`commandHostTrusted`). Only then do the words name it in a claim or a
   * command. Default: only github.com and gitlab.com.
   */
  trusted?: boolean;
}

/** The public forges: the only hosts trusted by name alone. */
const PUBLIC_FORGE_HOSTS = new Set(["github.com", "gitlab.com"]);

/**
 * May a sign-in command (and "isn't signed in to <host>") name this host? Only a host the person already uses: the
 * exact github.com or gitlab.com, a host in the CLI's own configuration (any state), or a project's own origin host.
 * Never a host named only by a link an agent wrote: `gh auth login --hostname github.corn` would send the person's
 * sign-in to whoever runs that host. Every surface decides through this one rule (`toolProblem`).
 */
export function commandHostTrusted(host: string, known: { configured?: Iterable<string>; projectHosts?: Iterable<string> } = {}): boolean {
  const h = host.toLowerCase();
  if (PUBLIC_FORGE_HOSTS.has(h)) return true;
  for (const list of [known.configured, known.projectHosts]) {
    for (const k of list ?? []) if (k.toLowerCase() === h) return true;
  }
  return false;
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

type Words = { title: string; detail: string; action?: ProblemAction; retry?: true };

/** The table: one entry per state. A short bold line, at most one short muted line, one next step. */
export const TOOL_WORDS: Record<ToolState, (ctx: ToolProblemContext) => Words> = {
  missing: ({ cli }) => ({
    title: `${cli} isn't installed`,
    detail: `Install the ${forgeOf(cli)} CLI, then try again.`,
    action: { kind: "open_url", value: TOOL_INSTALL_URL[cli], label: `Install ${cli}` },
    retry: true,
  }),
  signed_out: ({ cli, host, envToken }) =>
    envToken
      ? { title: `${cli} isn't signed in to ${host}`, detail: `${forgeOf(cli)} refused the token in ${envToken}. Replace it, or remove it and sign in.`, retry: true }
      : {
          title: `${cli} isn't signed in to ${host}`,
          detail: "Run this once in a terminal, then try again.",
          action: { kind: "copy_command", value: `${cli} auth login --hostname ${host}` },
          retry: true,
        },
  timed_out: ({ cli, seconds = 8 }) => ({
    title: `${cli} didn't answer in ${seconds} seconds`,
    detail: "It may be slow or stuck. Try again in a moment.",
    action: { kind: "retry" },
  }),
  refused: (ctx) => ({
    title: `${ctx.cli} can't see this ${nounOf(ctx)}`,
    detail: ctx.cli === "glab" ? `Your GitLab account on ${ctx.host} can't see it, or it doesn't exist.` : "No signed-in GitHub account can see it, or it doesn't exist.",
    ...(ctx.url && /^https:\/\//.test(ctx.url) ? { action: { kind: "open_url" as const, value: ctx.url, label: `Open on ${forgeOf(ctx.cli)}` } } : {}),
  }),
  rate_limited: ({ cli }) => ({
    title: `${forgeOf(cli)} asked for a short break`,
    detail: "Try again in a minute.",
  }),
  failed: (ctx) => ({
    title: `${ctx.cli} couldn't read this ${nounOf(ctx)}`,
    detail: `If it keeps failing, check that ${ctx.cli} works in a terminal.`,
    action: { kind: "retry" },
  }),
};

/**
 * A tool's state as a problem, its words from the table. Signed out on a host the person does not already use
 * (`commandHostTrusted`) names neither the host nor a command: it says what the hover card says for such a host
 * (`tool.unsupported`, `refUnsupportedLine`).
 */
export function toolProblem(state: ToolState, ctx: ToolProblemContext, at: Date = new Date()): Problem {
  if (state === "signed_out" && !(ctx.trusted ?? commandHostTrusted(ctx.host))) {
    return { code: "tool.unsupported", kind: "tool", ...UNSUPPORTED_WORDS(ctx.cli), retry: true, at: at.toISOString() };
  }
  return { code: `tool.${state}`, kind: "tool", ...TOOL_WORDS[state](ctx), at: at.toISOString() };
}

/** A host this computer's CLI does not read: no claim about the host, no command. */
const UNSUPPORTED_WORDS = (cli: ToolCli) => ({ title: `Details show for hosts your ${cli} is signed in to`, detail: "This one isn't, so nothing was fetched." });

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
export const refUnsupportedLine = (cli: ToolCli) => `${UNSUPPORTED_WORDS(cli).title}. ${UNSUPPORTED_WORDS(cli).detail}`;

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
  // Bitbucket has no CLI: its failures keep the hover card's own lines.
  if (ref.platform === "bitbucket") return null;
  const state = toolStateOfCardError(failed.error);
  if (!state) return null;
  return toolProblem(state, { cli: ref.platform === "gitlab" ? "glab" : "gh", host: ref.host, kind: ref.kind }, new Date(result.fetchedAt || Date.now()));
}
