/**
 * Which signed-in `gh` account a GitHub PR review runs as: when the active account cannot see the PR, the first other account that can is used for THIS review only, through its token in the env of the review's `gh` children. Never `gh auth switch`.
 * A token is never logged, printed or put in an error message.
 */

import type { CommandOptions, CommandResult, PRRuntime } from "./pr-types";
import { parsePRUrl } from "./pr-types";

export interface GhRepoRef {
  host: string;
  owner: string;
  repo: string;
}

export interface GhPRAccessRef extends GhRepoRef {
  number: number;
}

export interface GhAccount {
  login: string;
  active: boolean;
  state: string;
  tokenSource: string;
}

/** What a review startup learned; `childEnv` holds the token, so never print it. */
export interface GhPRAccess {
  login?: string;
  notice?: string;
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

export function ghAccountEnvFor(ref: GhRepoRef): Record<string, string> | undefined {
  const o = overrides.get(repoKey(ref));
  return o ? { [o.envVar]: o.token } : undefined;
}

/** Env for an agent job launched for this PR: the chosen account's token for a GitHub PR whose repo has one, else nothing. A job for another repo's PR never gets it. */
export function ghAccountEnvForPRUrl(prUrl: string | undefined): Record<string, string> {
  if (!prUrl) return {};
  const ref = parsePRUrl(prUrl);
  return ref?.platform === "github" ? ghAccountEnvFor(ref) ?? {} : {};
}

export function ghAccountTokenFor(ref: GhRepoRef): string | undefined {
  return overrides.get(repoKey(ref))?.token;
}

export function clearGhAccountOverrides(): void {
  overrides.clear();
}

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

const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

const ENV_TOKEN_SOURCES = new Set(["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]);

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** `gh auth status --json hosts` (gh v2.81.0+). */
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

/** The text `gh auth status` prints for a gh without `--json`, including the single-account form before multi-account gh. A token from the environment that GitHub refused has no account: it reads as an entry with no login. Color codes are stripped first. */
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

/** Check the gh account in use can see the PR; else pick another signed-in account that can, or throw. Answers `{}` when it cannot tell, so the fetch that follows reports its own error. */
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
  const others = accounts.filter((a) => !a.active && a.login !== "" && a.login !== active?.login);
  const repo = `${ref.owner}/${ref.repo}`;
  const envVar = ghTokenEnvVar(ref.host);

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
