/**
 * Settings → Accounts (approval "accounts-page", step 1): this computer's
 * Claude accounts and their usage, read through claude-swap (`cswap`, which
 * the person installs). Plannotator never reads, stores or moves credentials.
 *
 * `cswap list --json` reads the Keychain and fetches usage from Anthropic. To
 * fetch usage it may refresh an expired login: it spends the old one-time
 * token and writes the new one back, all inside claude-swap, as typing
 * `cswap list` does. The Inbox itself touches no credential, but killing that
 * run between the spend and the write would lose the login, so:
 *
 *  - A run is never killed for being slow, and the Inbox stopping leaves it to
 *    finish. A person waits `INBOX_ACCOUNTS_TIMEOUT_MS`; only a run still going
 *    at `INBOX_ACCOUNTS_HARD_LIMIT_MS` is killed, as truly stuck.
 *  - One run at a time in this Inbox, until it has really ended. Whoever asks
 *    while it runs joins it, even after an earlier caller was told it timed
 *    out. A run a stopped Inbox left behind can overlap the next Inbox's:
 *    `cswap` holds its own locks for that. Nothing polls: a run starts when a
 *    window, the page or the Usage peek opens, or on Refresh.
 *  - A good answer serves for `INBOX_ACCOUNTS_CACHE_MS`, so a reloading window
 *    starts no process per load. `cswap` refreshes a login at most once per
 *    its own 3 minutes however often it runs: this saves processes, not logins.
 *    Refresh skips it: someone may have just run `cswap add`.
 *
 * Its output sits next to secrets:
 *
 *  - Named fields only: every value below is picked by name, so a field a later
 *    `cswap` adds cannot reach the window.
 *  - Its output and error text are never logged, stored or passed on. A
 *    failure is a fixed reason code.
 *
 * A linked machine's read is this same read on that machine, asked for through
 * its door (`accountsOf` in inbox-machines.ts) and picked by name again here.
 */

import type { InboxAccount, InboxAccountsFailure, InboxAccountsRead, InboxAccountUsage, InboxUsageWindow } from "@plannotator/core/inbox-types";
import { runUntilExit, type AgentEnvironment } from "./inbox-agents";

/** The `schemaVersion` of `cswap list --json` this build reads. Extra fields are fine; another version is not. */
const CSWAP_SCHEMA_VERSION = 1;
/** How long a person waits. The Keychain and Anthropic's usage endpoint are behind this read. The run goes on. */
export const INBOX_ACCOUNTS_TIMEOUT_MS = 20_000;
/** Last resort for a run that is truly stuck; a slow login refresh ends long before this. */
export const INBOX_ACCOUNTS_HARD_LIMIT_MS = 120_000;
/** How long a good answer serves. A failure or "not installed" never does, and drops the one kept, so a change shows at once. */
export const INBOX_ACCOUNTS_CACHE_MS = 30_000;
/** The address `cswap` gives an API-key account (`api-key-3@token.local`). */
const PLACEHOLDER_EMAIL = /@token\.local$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
/** A status or error kind (`api_key`, `http-429`): a word, or nothing, so a sentence of `cswap`'s never travels in it. */
const word = (value: unknown): string | null => (typeof value === "string" && /^[\w-]{1,40}$/.test(value) ? value : null);

/** A reset time gone by: `cswap` serves its last good reading when a fetch fails, so the figure is from before that reset. */
function hasPassed(resetsAt: string | null): boolean {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(at) && at <= Date.now();
}

function usageWindow(value: unknown): InboxUsageWindow | null {
  if (!isRecord(value) || typeof value.pct !== "number" || !Number.isFinite(value.pct)) return null;
  const resetsAt = text(value.resetsAt);
  if (hasPassed(resetsAt)) return null;
  return { pct: value.pct, resetsAt, countdown: text(value.countdown), clock: text(value.clock) };
}

function accountUsage(value: unknown): InboxAccountUsage | null {
  if (!isRecord(value)) return null;
  const fiveHour = usageWindow(value.fiveHour);
  const sevenDay = usageWindow(value.sevenDay);
  const scoped = (Array.isArray(value.scoped) ? value.scoped : []).flatMap((item) => {
    const window = usageWindow(item);
    const name = isRecord(item) ? text(item.name) : null;
    return window && name ? [{ ...window, name }] : [];
  });
  return fiveHour || sevenDay || scoped.length > 0 ? { fiveHour, sevenDay, scoped } : null;
}

function account(row: unknown): InboxAccount | null {
  if (!isRecord(row) || !Number.isInteger(row.number)) return null;
  const usageStatus = word(row.usageStatus);
  const email = text(row.email);
  return {
    number: row.number as number,
    alias: text(row.alias),
    email: usageStatus === "api_key" || (email && PLACEHOLDER_EMAIL.test(email)) ? null : email,
    organizationName: text(row.organizationName),
    isOrganization: row.isOrganization === true,
    active: row.active === true,
    usageStatus,
    usageError: word(row.usageError),
    usageRetryAt: text(row.usageRetryAt),
    usage: accountUsage(row.usage),
    usageAgeSeconds: typeof row.usageAgeSeconds === "number" && Number.isFinite(row.usageAgeSeconds) && row.usageAgeSeconds >= 0 ? row.usageAgeSeconds : null,
  };
}

const FAILURES: readonly string[] = ["timed_out", "run_failed", "bad_output", "unknown_schema"] satisfies InboxAccountsFailure[];
const failed = (reason: InboxAccountsFailure): InboxAccountsRead => ({ state: "failed", reason });

function accountList(rows: unknown[]): InboxAccount[] | null {
  const accounts = rows.map(account);
  return accounts.some((row) => row === null) ? null : (accounts as InboxAccount[]);
}

/**
 * What a linked machine's door answered, picked by name here too: its Inbox
 * may be older, newer or hostile, so nothing it adds reaches this window, and
 * its failure stays a fixed code. Null: not an answer this build can read.
 */
export function parsePeerAccounts(value: unknown): InboxAccountsRead | null {
  if (!isRecord(value)) return null;
  if (value.state === "not_installed") return { state: "not_installed" };
  if (value.state === "failed") return failed(typeof value.reason === "string" && FAILURES.includes(value.reason) ? (value.reason as InboxAccountsFailure) : "run_failed");
  const accounts = value.state === "accounts" && Array.isArray(value.accounts) ? accountList(value.accounts) : null;
  return accounts && { state: "accounts", accounts };
}

/** What the window may know of `cswap list --json`'s output. */
export function parseCswapList(stdout: string): InboxAccountsRead {
  let output: unknown;
  try {
    output = JSON.parse(stdout);
  } catch {
    return failed("bad_output");
  }
  if (!isRecord(output) || typeof output.schemaVersion !== "number") return failed("bad_output");
  if (output.schemaVersion !== CSWAP_SCHEMA_VERSION) return failed("unknown_schema");
  if (!Array.isArray(output.accounts)) return failed("bad_output");
  const accounts = accountList(output.accounts);
  return accounts ? { state: "accounts", accounts } : failed("bad_output");
}

export interface InboxAccountsOptions {
  environment: AgentEnvironment;
  /** Default `INBOX_ACCOUNTS_TIMEOUT_MS`; tests give a short one. */
  timeoutMs?: number;
  /** Default `INBOX_ACCOUNTS_HARD_LIMIT_MS`; tests give a short one. */
  hardLimitMs?: number;
  /** Default `INBOX_ACCOUNTS_CACHE_MS`; 0 for a test that changes the answer between reads. */
  cacheMs?: number;
}

export function createInboxAccounts({ environment, timeoutMs = INBOX_ACCOUNTS_TIMEOUT_MS, hardLimitMs = INBOX_ACCOUNTS_HARD_LIMIT_MS, cacheMs = INBOX_ACCOUNTS_CACHE_MS }: InboxAccountsOptions) {
  const runOnce = async (): Promise<InboxAccountsRead> => {
    const cswap = environment.which("cswap");
    if (!cswap) return { state: "not_installed" };
    const run = await runUntilExit([cswap, "list", "--json"], environment.env, hardLimitMs);
    if (run.timedOut) return failed("timed_out");
    // The shell's "command not found": a shim whose tool is gone, which is not installed. The e2e stubs exit this way too.
    if (run.exitCode === 127) return { state: "not_installed" };
    if (run.exitCode !== 0) return failed("run_failed");
    return parseCswapList(run.stdout);
  };
  /** The run going now, until it has really ended. */
  let running: Promise<InboxAccountsRead> | null = null;
  let last: { at: number; answer: InboxAccountsRead } | null = null;
  return {
    /** Whether `cswap` is on this PATH. Looks only: runs nothing. */
    installed: (): boolean => environment.which("cswap") !== null,
    read({ fresh = false }: { fresh?: boolean } = {}): Promise<InboxAccountsRead> {
      if (!fresh && last && Date.now() - last.at < cacheMs) return Promise.resolve(last.answer);
      running ??= runOnce()
        .then((answer) => {
          last = answer.state === "accounts" ? { at: Date.now(), answer } : null;
          return answer;
        })
        .finally(() => {
          running = null;
        });
      // Each caller waits its own limit, so a Refresh during a slow run can still get that run's answer.
      let limit: ReturnType<typeof setTimeout>;
      const tooLong = new Promise<InboxAccountsRead>((done) => {
        limit = setTimeout(() => done(failed("timed_out")), timeoutMs);
      });
      return Promise.race([running, tooLong]).finally(() => clearTimeout(limit));
    },
  };
}
