/**
 * Why gh or glab could not answer, as one of six states (the errors system,
 * first slice; words in `@plannotator/core/problem-words`). Both runtimes:
 * vendored to Pi beside `ref-cards.ts`.
 *
 * Read from the run itself first:
 * - `missing`: exit 127 (the runners' answer when the program is not there),
 *   or the shell's "not found".
 * - `timed_out`: the runner's hard deadline ended it (`timedOut`).
 * - `rate_limited`: "rate limit", 429, "Too Many Requests".
 * - `signed_out`: gh exit 4 with "gh auth login" (no account), "Bad
 *   credentials" or HTTP 401 (a token GitHub refused); glab "401" /
 *   "Unauthorized" / "has not been authenticated".
 * - `refused`: 403/404, "Could not resolve to a Repository", SAML.
 * - `failed`: anything else; the tool's last line is kept as private detail.
 *
 * Then, for a run that says only "refused", "timed out", "failed", or that
 * never ran (a host the CLI lists no login for), the cheap status check
 * (`<cli> auth status --hostname <host>`) can say better: not installed, or
 * no login for that host at all. It has its own deadline (3 s), is cached
 * (a login 5 min, anything else 30 s) and shared by every caller, and
 * `peek` reads the cache without waiting, so a hover never waits on it.
 */

import type { ProblemDiag } from "@plannotator/core/problem";
import type { ToolCli, ToolState } from "@plannotator/core/problem-words";
import type { RefCommandResult, RefRunner } from "./ref-cards";

/** The tool's last non-empty line, cut to 300 characters, color codes out: private, never sent to a window. */
export function lastLineOf(text: string): string | null {
  const lines = text
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last ? last.slice(0, 300) : null;
}

export function toolDiagOf(result: RefCommandResult, ms: number | null = null): ProblemDiag {
  return { last_line: lastLineOf(result.stderr) ?? lastLineOf(result.stdout), exit: result.exitCode, ms };
}

/**
 * The state a failed run of `cli` says by itself (the same reading as `refErrorOf`, which the hover cards keep for
 * their older error codes; kept apart so ref-cards can use this module without a cycle).
 */
export function toolStateOfRun(cli: ToolCli, result: RefCommandResult): ToolState {
  const text = `${result.stderr}\n${result.stdout}`;
  if (result.timedOut || new RegExp(`^${cli}: timed out$`, "m").test(result.stderr)) return "timed_out";
  if (result.exitCode === 127 || /executable file not found|command not found|^(gh|glab): not found$/im.test(text)) return "missing";
  if (/rate limit|\b429\b|RATE_LIMITED|Too Many Requests/i.test(text)) return "rate_limited";
  if (/not logged in|auth login|authentication required|not authenticated|has not been authenticated/i.test(text)) return "signed_out";
  // A token the forge does not accept (an expired login, a stale GH_TOKEN) is a sign-in problem, not a refusal.
  if (/Bad credentials|\bHTTP 401\b/i.test(text) || (cli === "glab" && /\b401\b|Unauthorized/i.test(text))) return "signed_out";
  if (/Could not resolve to|NOT_FOUND|\bHTTP (404|403)\b|\b404\b|Not Found|SAML|\b403\b|Forbidden/i.test(text)) return "refused";
  return "failed";
}

/**
 * The variable a token for this host comes from, when one is set: then `<cli> auth login` would not help (the
 * variable wins), and the words say so. gh: GH_TOKEN / GITHUB_TOKEN for github.com, GH_ENTERPRISE_TOKEN /
 * GITHUB_ENTERPRISE_TOKEN elsewhere. glab: GITLAB_TOKEN, GITLAB_ACCESS_TOKEN, OAUTH_TOKEN.
 */
export function tokenEnvFor(cli: ToolCli, host: string, env: Record<string, string | undefined> = process.env): string | null {
  const names =
    cli === "glab" ? ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"] : host === "github.com" ? ["GH_TOKEN", "GITHUB_TOKEN"] : ["GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"];
  return names.find((name) => !!env[name]) ?? null;
}

/** What `<cli> auth status --hostname <host>` says. `unknown`: it answered, but not one of the others. */
export type ToolAuthState = "signed_in" | "signed_out" | "missing" | "timed_out" | "unknown";

/** Read one status answer. Only "no login for this host at all" is `signed_out`: a token gh could not check offline is not. */
export function toolAuthStateOf(result: RefCommandResult): ToolAuthState {
  if (result.timedOut || /: timed out$/m.test(result.stderr)) return "timed_out";
  if (result.exitCode === 127) return "missing";
  if (result.exitCode === 0) return "signed_in";
  if (/not logged into|not logged in|has not been authenticated|no token found|not authenticated/i.test(`${result.stderr}\n${result.stdout}`)) return "signed_out";
  return "unknown";
}

export const TOOL_STATUS_DEADLINE_MS = 3_000;
export const TOOL_STATUS_SIGNED_IN_MS = 5 * 60_000;
export const TOOL_STATUS_OTHER_MS = 30_000;

export interface ToolStatus {
  /** The status check's answer, run at most once per cache period and never longer than its deadline. */
  check(cli: ToolCli, host: string): Promise<ToolAuthState>;
  /** The cached answer, or undefined; never runs anything. */
  peek(cli: ToolCli, host: string): ToolAuthState | undefined;
}

export function createToolStatus(options: { run: RefRunner; now?: () => number; deadlineMs?: number }): ToolStatus {
  const now = options.now ?? Date.now;
  const deadlineMs = options.deadlineMs ?? TOOL_STATUS_DEADLINE_MS;
  const cache = new Map<string, { at: number; state: ToolAuthState | undefined; promise: Promise<ToolAuthState> }>();
  const key = (cli: ToolCli, host: string) => `${cli} ${host.toLowerCase()}`;
  const fresh = (entry: { at: number; state: ToolAuthState | undefined }) =>
    entry.state === undefined || now() - entry.at < (entry.state === "signed_in" ? TOOL_STATUS_SIGNED_IN_MS : TOOL_STATUS_OTHER_MS);
  return {
    check(cli, host) {
      const k = key(cli, host);
      const hit = cache.get(k);
      if (hit && fresh(hit)) return hit.promise;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entry: { at: number; state: ToolAuthState | undefined; promise: Promise<ToolAuthState> } = { at: now(), state: undefined, promise: Promise.resolve("unknown") };
      entry.promise = Promise.race([
        options
          .run(cli, ["auth", "status", "--hostname", host], { NO_COLOR: "1" })
          .then(toolAuthStateOf)
          .catch((): ToolAuthState => "unknown"),
        new Promise<ToolAuthState>((resolve) => {
          timer = setTimeout(() => resolve("timed_out"), deadlineMs);
        }),
      ]).then((state) => {
        clearTimeout(timer);
        entry.state = state;
        entry.at = now();
        return state;
      });
      cache.set(k, entry);
      // Bounded: one entry per (cli, host) this computer was asked about; a long-lived Inbox sees few hosts.
      if (cache.size > 200) cache.delete(cache.keys().next().value!);
      return entry.promise;
    },
    peek(cli, host) {
      const hit = cache.get(key(cli, host));
      return hit && fresh(hit) ? hit.state : undefined;
    },
  };
}

/**
 * A run's state, made precise by the status check where the run alone cannot tell: a refusal, a timeout or a failure
 * from a CLI with no login for that host is `signed_out`; one not installed is `missing`. `ran: false`: nothing ran
 * (a host the CLI lists no login for); the status check alone decides, `failed` when it cannot.
 */
export async function refineToolState(status: Pick<ToolStatus, "check">, cli: ToolCli, host: string, state: ToolState | null): Promise<ToolState> {
  if (state === "missing" || state === "signed_out" || state === "rate_limited") return state;
  const auth = await status.check(cli, host);
  if (auth === "missing") return "missing";
  if (auth === "signed_out") return "signed_out";
  if (state) return state;
  return auth === "timed_out" ? "timed_out" : "failed";
}
