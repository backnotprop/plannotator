/**
 * Which signed-in `gh` account a GitHub PR review runs as (#2157).
 *
 * `gh` can hold several accounts per host (a personal and a work one) and
 * uses the ACTIVE one for every command. When that account cannot see the
 * PR, the review used to open anyway and only the checkout failed. Before a
 * review starts, `ensureGhPRAccess` checks the active account can read the
 * PR; when it cannot it tries every other account signed in on that host
 * (`gh auth status`), and the first that can is used for THIS review only:
 * its token (`gh auth token --user`) is handed to the review's `gh` children
 * as GH_TOKEN (GH_ENTERPRISE_TOKEN on a GitHub Enterprise Server host). It
 * never runs `gh auth switch` and never changes the person's gh settings.
 * When no account can see it, the review does not open and the error says
 * which account was tried and how to switch.
 *
 * A token is never logged, printed or put in an error message: it lives in
 * the in-memory override map (keyed by host/owner/repo, so an in-process
 * host such as Pi can review a work PR and a personal one side by side) and
 * in the env of the `gh` children it is meant for.
 */

import type { CommandOptions, CommandResult, PRRuntime } from "./pr-types";
import { parsePRUrl } from "./pr-types";

/** The parts of a GitHub ref this module reads (a PRRef or PR metadata). */
export interface GhRepoRef {
  host: string;
  owner: string;
  repo: string;
}

export interface GhPRAccessRef extends GhRepoRef {
  number: number;
}

/** One account `gh auth status` reports for a host. */
export interface GhAccount {
  login: string;
  active: boolean;
  /** `success` when gh could use it; anything else is a broken login. */
  state: string;
  /** keyring, oauth_token, GH_TOKEN, GITHUB_TOKEN, … */
  tokenSource: string;
}

/** What a review startup learned; `childEnv` holds the token, so never print it. */
export interface GhPRAccess {
  /** The account the review runs as, when known. */
  login?: string;
  /** One line for stderr / the host's log when another account is used. */
  notice?: string;
  /** Env for the review's own children (`gh repo clone`, git with gh's credential helper, agent jobs). */
  childEnv?: Record<string, string>;
}

interface GhAccountOverride {
  login: string;
  envVar: string;
  token: string;
}

const overrides = new Map<string, GhAccountOverride>();

function repoKey(ref: GhRepoRef): string {
  return `${ref.host}/${ref.owner}/${ref.repo}`.toLowerCase();
}

/** github.com and *.ghe.com read GH_TOKEN; a GitHub Enterprise Server host reads GH_ENTERPRISE_TOKEN. */
export function ghTokenEnvVar(host: string): "GH_TOKEN" | "GH_ENTERPRISE_TOKEN" {
  const h = host.toLowerCase();
  return h === "github.com" || h.endsWith(".ghe.com") ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN";
}

/** The env a `gh` command for this repo runs with, when another account was chosen for it. */
export function ghAccountEnvFor(ref: GhRepoRef): Record<string, string> | undefined {
  const o = overrides.get(repoKey(ref));
  return o ? { [o.envVar]: o.token } : undefined;
}

/**
 * The env an agent job launched for this PR runs with (`prUrl` is the job's
 * launch PR): the chosen account's token for a GitHub PR whose repo has one,
 * else nothing. A job for another repo's PR never gets it.
 */
export function ghAccountEnvForPRUrl(prUrl: string | undefined): Record<string, string> {
  if (!prUrl) return {};
  const ref = parsePRUrl(prUrl);
  return ref?.platform === "github" ? ghAccountEnvFor(ref) ?? {} : {};
}

/** The token chosen for this repo (artifact downloads send it as a header), else undefined. */
export function ghAccountTokenFor(ref: GhRepoRef): string | undefined {
  return overrides.get(repoKey(ref))?.token;
}

/** Forget every chosen account (tests). */
export function clearGhAccountOverrides(): void {
  overrides.clear();
}

/**
 * A runtime that runs `gh` for this repo as the account chosen for it, or
 * the runtime itself when none was chosen (the active account).
 */
export function ghScopedRuntime(runtime: PRRuntime, ref: GhRepoRef): PRRuntime {
  const env = ghAccountEnvFor(ref);
  if (!env) return runtime;
  const merge = (options?: CommandOptions): CommandOptions => ({ ...options, env: { ...options?.env, ...env } });
  return {
    ...runtime,
    runCommand: (cmd, args, options) =>
      runtime.runCommand(cmd, args, cmd === "gh" ? merge(options) : options),
    ...(runtime.runCommandWithInput
      ? {
          runCommandWithInput: (cmd: string, args: string[], input: string, options?: CommandOptions) =>
            runtime.runCommandWithInput!(cmd, args, input, cmd === "gh" ? merge(options) : options),
        }
      : {}),
  };
}

function hostnameArgs(host: string, args: string[]): string[] {
  return host !== "github.com" ? [...args, "--hostname", host] : args;
}

// --- gh auth status ---

// CSI and OSC escape sequences (colors, hyperlinks).
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const ENV_TOKEN_SOURCES = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `gh auth status --json hosts` (gh v2.81.0+). Null when the output is not that JSON. */
export function parseGhAuthStatusJson(stdout: string, host: string): GhAccount[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const hosts = (parsed as { hosts?: unknown })?.hosts;
  if (!hosts || typeof hosts !== "object") return null;
  const entry = Object.entries(hosts as Record<string, unknown>).find(([h]) => h.toLowerCase() === host.toLowerCase())?.[1];
  if (!Array.isArray(entry)) return [];
  return entry
    .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
    .map((a) => ({
      login: str(a.login),
      active: a.active === true,
      state: str(a.state) || "success",
      tokenSource: str(a.tokenSource),
    }))
    // A token from the environment that GitHub refused has no login, and it is
    // still the source gh uses: keep it, so the notice can name it.
    .filter((a) => a.login !== "" || ENV_TOKEN_SOURCES.has(a.tokenSource));
}

/**
 * The text `gh auth status` prints, for a gh without `--json`:
 *
 *   github.com
 *     ✓ Logged in to github.com account octocat (keyring)
 *     - Active account: true
 *     X Failed to log in to github.com account work (keyring)
 *
 * and the single-account form before multi-account gh (v2.40.0): `Logged in to github.com as
 * octocat (oauth_token)`. A token from the environment that GitHub refused has no account:
 * `X Failed to log in to github.com using token (GH_TOKEN)`, read as an entry with no login.
 * Color codes, should gh print any, are stripped first.
 */
export function parseGhAuthStatusText(text: string, host: string): GhAccount[] {
  text = text.replace(ANSI_PATTERN, "");
  const accounts: GhAccount[] = [];
  const h = host.toLowerCase();
  let current: GhAccount | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const m = /^(\S+)\s+(Logged in to|Failed to log in to)\s+(\S+)\s+(account|as)\s+(\S+)(?:\s+\(([^)]*)\))?/.exec(line);
    const refused = m ? null : /^\S+\s+Failed to log in to\s+(\S+)\s+using token\s+\(([^)]*)\)/.exec(line);
    if (refused) {
      current = null;
      if (refused[1].toLowerCase() !== h) continue;
      current = { login: "", active: false, state: "error", tokenSource: refused[2] };
      accounts.push(current);
      continue;
    }
    if (m) {
      current = null;
      if (m[3].toLowerCase() !== h) continue;
      current = {
        login: m[5],
        // Before multi-account gh ("as") there was one account, and it was the one in use.
        active: m[4] === "as",
        state: m[2] === "Logged in to" ? "success" : "error",
        tokenSource: m[6] ?? "",
      };
      accounts.push(current);
      continue;
    }
    const active = /^-\s*Active account:\s*(true|false)/i.exec(line);
    if (active && current) current.active = active[1].toLowerCase() === "true";
  }
  return accounts;
}

/** Every account signed in to `host`, from `gh auth status` (JSON, else text). */
export async function listGhAccounts(runtime: PRRuntime, host: string): Promise<GhAccount[]> {
  try {
    const json = await runtime.runCommand("gh", ["auth", "status", "--hostname", host, "--json", "hosts"]);
    if (json.exitCode === 0) {
      const accounts = parseGhAuthStatusJson(json.stdout, host);
      if (accounts) return accounts;
    }
    // A gh before v2.81.0 refuses --json; read the text (stdout or stderr by
    // version) with color off.
    const text = await runtime.runCommand("gh", ["auth", "status", "--hostname", host], { env: { NO_COLOR: "1" } });
    return parseGhAuthStatusText(`${text.stdout}\n${text.stderr}`, host);
  } catch {
    return [];
  }
}

// --- Can this account see the PR? ---

/** `yes`, `no` (GitHub refused: 404/401/403), or `unknown` (network, rate limit, gh broken). */
export type GhSeesPR = "yes" | "no" | "unknown";

function refusal(result: CommandResult): "no" | "unknown" {
  const err = `${result.stderr}\n${result.stdout}`;
  if (/rate limit/i.test(err)) return "unknown";
  if (/\bHTTP (404|401|403)\b|Not Found|Bad credentials|SAML/i.test(err)) return "no";
  return "unknown";
}

export async function ghCanSeePR(
  runtime: PRRuntime,
  ref: GhPRAccessRef,
  env?: Record<string, string>,
): Promise<GhSeesPR> {
  try {
    const result = await runtime.runCommand(
      "gh",
      hostnameArgs(ref.host, ["api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`, "--jq", ".number"]),
      env ? { env } : undefined,
    );
    return result.exitCode === 0 ? "yes" : refusal(result);
  } catch {
    return "unknown";
  }
}

async function ghCanSeeRepo(runtime: PRRuntime, ref: GhRepoRef, env?: Record<string, string>): Promise<GhSeesPR> {
  try {
    const result = await runtime.runCommand(
      "gh",
      hostnameArgs(ref.host, ["api", `repos/${ref.owner}/${ref.repo}`, "--jq", ".full_name"]),
      env ? { env } : undefined,
    );
    return result.exitCode === 0 ? "yes" : refusal(result);
  } catch {
    return "unknown";
  }
}

async function ghTokenOf(runtime: PRRuntime, host: string, login: string): Promise<string | null> {
  try {
    const result = await runtime.runCommand("gh", ["auth", "token", "--hostname", host, "--user", login]);
    const token = result.exitCode === 0 ? result.stdout.trim() : "";
    // A token is one word; anything else is an error message, not a token.
    return token && !/\s/.test(token) ? token : null;
  } catch {
    return null;
  }
}

/**
 * Check that the gh account in use can see the PR; when it cannot, pick
 * another signed-in account that can for this review, or throw a clear error.
 * Answers `{}` (nothing to say) when it could not tell, so the fetch that
 * follows reports its own error as before.
 */
export async function ensureGhPRAccess(runtime: PRRuntime, ref: GhPRAccessRef): Promise<GhPRAccess> {
  const key = repoKey(ref);
  overrides.delete(key);
  const seen = await ghCanSeePR(runtime, ref);
  if (seen !== "no") return {};

  // The account sees the repository but not the PR: the PR number is wrong,
  // not the account. Let the fetch say so.
  if ((await ghCanSeeRepo(runtime, ref)) === "yes") return {};

  const accounts = await listGhAccounts(runtime, ref.host);
  const active = accounts.find((a) => a.active);
  // An entry with no login (a rejected env token) is not an account to try.
  const others = accounts.filter((a) => !a.active && a.login !== "" && a.login !== active?.login);
  const repo = `${ref.owner}/${ref.repo}`;
  const envVar = ghTokenEnvVar(ref.host);

  // What each other account answered: it can't read the repo, it reads the
  // repo but not the PR, or there was no verdict (a broken login, no token
  // from gh, the network, a rate limit).
  const cantSee: string[] = [];
  const repoOnly: string[] = [];
  const unchecked: string[] = [];
  for (const account of others) {
    if (account.state !== "success") {
      unchecked.push(account.login);
      continue;
    }
    const token = await ghTokenOf(runtime, ref.host, account.login);
    if (!token) {
      unchecked.push(account.login);
      continue;
    }
    const env = { [envVar]: token };
    const verdict = await ghCanSeePR(runtime, ref, env);
    if (verdict === "yes") {
      overrides.set(key, { login: account.login, envVar, token });
      if (active && ENV_TOKEN_SOURCES.has(active.tokenSource)) {
        // gh uses a token from the environment before any signed-in account,
        // so name that token plainly: it is what the person has to fix.
        const why = active.state !== "success"
          ? `GitHub rejected the token in ${active.tokenSource} (invalid or expired)`
          : `The token in ${active.tokenSource}${active.login ? ` (account ${active.login})` : ""} can't see ${repo}`;
        return {
          login: account.login,
          childEnv: env,
          notice:
            `${why}, so this review uses your signed-in gh account ${account.login} instead. ` +
            `Fix or unset ${active.tokenSource} to stop seeing this. Your gh setting is unchanged.`,
        };
      }
      const was = !active
        ? `the account in use can't see ${repo}`
        : active.state === "success"
          ? `your active account ${active.login} can't see ${repo}`
          : `your active account ${active.login} isn't signed in properly`;
      return {
        login: account.login,
        childEnv: env,
        notice: `Using gh account ${account.login} for this review: ${was}. Your gh setting is unchanged.`,
      };
    }
    if (verdict === "unknown") unchecked.push(account.login);
    else if ((await ghCanSeeRepo(runtime, ref, env)) === "yes") repoOnly.push(account.login);
    else cantSee.push(account.login);
  }

  const lines: string[] = [];
  if (!active) {
    lines.push(`The gh account in use can't see ${repo} (pull request #${ref.number}).`);
  } else if (ENV_TOKEN_SOURCES.has(active.tokenSource) && active.state !== "success") {
    lines.push(
      `GitHub rejected the token in ${active.tokenSource} (invalid or expired), so it can't see ${repo} (pull request #${ref.number}).`,
    );
  } else if (active.state !== "success") {
    lines.push(
      `Your active gh account ${active.login} isn't signed in properly (run \`gh auth status\`) and can't see ${repo} (pull request #${ref.number}).`,
    );
  } else {
    lines.push(`Your active gh account ${active.login} can't see ${repo} (pull request #${ref.number}).`);
  }
  if (cantSee.length > 0) {
    lines.push(`Your other signed-in ${ref.host} accounts can't see it either: ${cantSee.join(", ")}.`);
  }
  if (repoOnly.length > 0) {
    lines.push(`${repoOnly.join(", ")} can see ${repo} but not pull request #${ref.number}: the PR number may be wrong.`);
  }
  if (unchecked.length > 0) {
    lines.push(
      `Couldn't check: ${unchecked.join(", ")}. ` +
        `Switch with \`gh auth switch -u ${unchecked[0]}\` and run the review again.`,
    );
  } else if (repoOnly.length === 0) {
    const hostFlag = ref.host !== "github.com" ? ` --hostname ${ref.host}` : "";
    lines.push(
      `Sign in with an account that can see it (\`gh auth login${hostFlag}\`), ` +
        `then switch to it with \`gh auth switch -u <user>\`.`,
    );
  }
  if (active && ENV_TOKEN_SOURCES.has(active.tokenSource)) {
    lines.push(`${active.tokenSource} is set, and gh uses it before any signed-in account; unset it to use another account.`);
  }
  throw new Error(lines.join("\n"));
}
